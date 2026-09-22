import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PREFIX = "Lossless JSON table: map each row to the ordered schema names; all rows retained.\n";
const workerPath = fileURLToPath(new URL("./worker.py", import.meta.url));
const protectedWords = /\b(error|fail|failed|failing|failure|fatal|exception|traceback|policy|instructions?)\b|ACK FUSION|^diff --git/im;
const forbiddenTools = new Set(["read", "edit", "write", "apply_patch"]);

export interface ToolEvent {
	toolName: string;
	toolCallId: string;
	isError: boolean;
	content: { type: string; text?: string; data?: string; mimeType?: string }[];
}
export interface WorkerResult {
	changed: boolean;
	reason: string;
	content?: string;
	before?: number;
	after?: number;
	rows?: number;
}
export interface TrialOptions {
	mode: "shadow" | "apply";
	tools: Set<string>;
	python: string;
	tokenizerCache: string;
	directory: string;
	timeoutMs?: number;
}

function canonical(value: any): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
	return JSON.stringify(value);
}

/** Independently check the worker output before changing a model-visible result. */
export function verifyTable(originalText: string, result: WorkerResult): boolean {
	try {
		if (!result.changed || !result.content?.startsWith(PREFIX)) return false;
		if (!Number.isInteger(result.before) || !Number.isInteger(result.after) || result.after! < 1 || result.after! >= result.before!) return false;
		const original = JSON.parse(originalText);
		const table = JSON.parse(result.content.slice(PREFIX.length));
		if (!Array.isArray(original) || table._compaction !== "table" || !Array.isArray(table._schema) || !Array.isArray(table._rows)) return false;
		const names = table._schema.map((f: any) => f.name);
		if (!names.every((n: unknown) => typeof n === "string") || new Set(names).size !== names.length) return false;
		if (table._kept !== original.length || table._total !== original.length || table._rows.length !== original.length || result.rows !== original.length) return false;
		const restored = table._rows.map((row: unknown[]) => {
			if (!Array.isArray(row) || row.length !== names.length) throw new Error("invalid row");
			return Object.fromEntries(names.map((name: string, i: number) => [name, row[i]]));
		});
		return canonical(restored) === canonical(original);
	} catch { return false; }
}

export function runWorker(text: string, opts: TrialOptions): Promise<WorkerResult> {
	return new Promise(resolve => {
		let settled = false;
		let output = "";
		const proc = spawn(opts.python, [workerPath], {
			cwd: opts.directory, shell: false, stdio: ["pipe", "pipe", "ignore"],
			// Do not inherit provider credentials, client settings, or upload configuration.
			env: { PATH: process.env.PATH ?? "", HOME: opts.directory, TMPDIR: opts.directory,
				TIKTOKEN_CACHE_DIR: opts.tokenizerCache, HEADROOM_OFFLINE: "1", HEADROOM_BEACON: "off",
				DO_NOT_TRACK: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
				LITELLM_LOCAL_MODEL_COST_MAP: "True" },
		});
		const finish = (result: WorkerResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			finish({ changed: false, reason: "timeout" });
		}, opts.timeoutMs ?? 2000);
		proc.on("error", () => finish({ changed: false, reason: "worker-unavailable" }));
		proc.stdin.on("error", () => finish({ changed: false, reason: "worker-input-failed" }));
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", chunk => {
			output += chunk;
			if (output.length > 500_000) { proc.kill("SIGKILL"); finish({ changed: false, reason: "worker-output-limit" }); }
		});
		proc.on("close", code => {
			try {
				if (code !== 0) throw new Error("worker exit");
				finish(JSON.parse(output));
			} catch { finish({ changed: false, reason: "worker-invalid-response" }); }
		});
		proc.stdin.end(JSON.stringify({ text }));
	});
}

export class LosslessTrial {
	readonly totals = { seen: 0, eligible: 0, verified: 0, applied: 0, before: 0, after: 0, fallbacks: 0 };
	constructor(readonly options: TrialOptions, private worker = runWorker) {
		for (const p of [options.python, options.tokenizerCache, options.directory]) {
			if (!path.isAbsolute(p)) throw new Error("trial paths must be absolute");
		}
		fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
	}
	async handle(event: ToolEvent): Promise<{ content: { type: "text"; text: string }[] } | undefined> {
		this.totals.seen++;
		// Only new successful tool results. Never touch historical messages or prompts.
		if (!this.options.tools.has(event.toolName) || forbiddenTools.has(event.toolName) || event.isError || event.content.length !== 1) return;
		const part = event.content[0];
		if (part.type !== "text" || typeof part.text !== "string") return;
		const text = part.text;
		const bytes = Buffer.byteLength(text);
		if (bytes < 4096 || bytes > 131072 || protectedWords.test(text) || !text.trimStart().startsWith("[")) return;
		try {
			const rows = JSON.parse(text);
			if (!Array.isArray(rows) || rows.some(row => row && typeof row === "object" && (
				row.passed === false || row.success === false || row.ok === false ||
				(typeof row.exitCode === "number" && row.exitCode !== 0)
			))) return;
		} catch { return; }
		this.totals.eligible++;
		const started = performance.now();
		let result: WorkerResult;
		try { result = await this.worker(text, this.options); }
		catch { result = { changed: false, reason: "worker-failed" }; }
		const verified = verifyTable(text, result);
		if (result.changed && !verified) result = { changed: false, reason: "verification-failed" };
		let applied = false;
		try {
			if (verified) {
				// Content-addressed originals are private artifacts, never source-controlled.
				const hash = createHash("sha256").update(text).digest("hex");
				const originalPath = path.join(this.options.directory, `${hash}.original.json`);
				try { fs.writeFileSync(originalPath, text, { flag: "wx", mode: 0o600 }); }
				catch (error: any) { if (error.code !== "EEXIST" || fs.readFileSync(originalPath, "utf8") !== text) throw error; }
				this.totals.verified++;
				this.totals.before += result.before!;
				this.totals.after += result.after!;
				applied = this.options.mode === "apply";
			}
			fs.appendFileSync(path.join(this.options.directory, "metrics.jsonl"), JSON.stringify({
				tool: event.toolName, mode: this.options.mode, reason: result.reason,
				verified, applied, before: result.before, after: result.after,
				elapsedMs: Math.round(performance.now() - started), tokenizer: "o200k_base",
			}) + "\n", { mode: 0o600 });
		} catch { this.totals.fallbacks++; return; }
		if (!verified) { this.totals.fallbacks++; return; }
		if (applied) {
			this.totals.applied++;
			return { content: [{ ...part, type: "text", text: result.content! }] };
		}
	}
}
