import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LosslessTrial, PREFIX, verifyTable, type TrialOptions, type ToolEvent } from "./trial.ts";
import extension from "./extension.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-trial-test-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const rows = Array.from({ length: 80 }, (_, i) => ({ path: `src/component-${i}.ts`, line: i + 1, name: "matching_function_name", enabled: i % 2 === 0 }));
const text = JSON.stringify(rows);
function opts(extra: Partial<TrialOptions> = {}): TrialOptions {
	return { mode: "apply", tools: new Set(["bash"]), python: "/missing/python", tokenizerCache: root,
		directory: fs.mkdtempSync(path.join(root, "run-")), ...extra };
}
function event(extra: Partial<ToolEvent> = {}): ToolEvent {
	return { toolName: "bash", toolCallId: "call-123", isError: false, content: [{ type: "text", text }], ...extra };
}
function validResult() {
	return { changed: true, reason: "verified-table", before: 2000, after: 1000, rows: rows.length,
		content: PREFIX + JSON.stringify({ _compaction: "table", _schema: Object.keys(rows[0]).map(name => ({ name })),
			_kept: rows.length, _total: rows.length, _rows: rows.map(Object.values) }) };
}

test("applies only independently verified data, preserving tool metadata and original artifact", async () => {
	const trial = new LosslessTrial(opts(), async () => validResult());
	const input = event();
	const snapshot = JSON.stringify(input);
	const result = await trial.handle(input);
	expect(result?.content[0].text).toStartWith(PREFIX);
	expect(JSON.stringify(input)).toBe(snapshot);
	expect(Object.keys(result!)).toEqual(["content"]);
	const files = fs.readdirSync(trial.options.directory).filter(f => f.endsWith(".original.json"));
	expect(files.length).toBe(1);
	expect(fs.readFileSync(path.join(trial.options.directory, files[0]), "utf8")).toBe(text);
	expect(fs.statSync(path.join(trial.options.directory, files[0])).mode & 0o777).toBe(0o600);
});

test("rejects a missing row, a changed value and inflated output", () => {
	const good = validResult();
	expect(verifyTable(text, good)).toBe(true);
	expect(verifyTable(text, { ...good, content: good.content.replace("component-17.ts", "different-17.ts") })).toBe(false);
	expect(verifyTable(text, { ...good, rows: 79 })).toBe(false);
	expect(verifyTable(text, { ...good, after: good.before + 1 })).toBe(false);
});

test("shadow mode records savings without changing the result", async () => {
	const trial = new LosslessTrial(opts({ mode: "shadow" }), async () => validResult());
	expect(await trial.handle(event())).toBeUndefined();
	expect(trial.totals.verified).toBe(1);
	expect(trial.totals.applied).toBe(0);
});

test("excluded tools, failed checks, mixed media and ACK messages never reach the worker", async () => {
	let calls = 0;
	const trial = new LosslessTrial(opts({ tools: new Set(["bash", "read", "edit", "write", "apply_patch"]) }), async () => { calls++; return validResult(); });
	for (const e of [event({ isError: true }), ...["read", "edit", "write", "apply_patch", "unknown"].map(toolName => event({ toolName })),
		event({ content: [{ type: "image", data: "synthetic" }] }),
		event({ content: [{ type: "text", text }, { type: "text", text }] }),
		event({ content: [{ type: "text", text: text.replace("matching_function_name", "failure") }] }),
		event({ content: [{ type: "text", text: text.replace("matching_function_name", "ERROR") }] }),
		event({ content: [{ type: "text", text: "ACK FUSION synthetic-run" }] })]) {
		expect(await trial.handle(e)).toBeUndefined();
	}
	expect(calls).toBe(0);
});

const realTest = process.env.FH_HEADROOM_PYTHON && process.env.FH_HEADROOM_TOKENIZER_CACHE ? test : test.skip;
function realOpts(extra: Partial<TrialOptions> = {}): TrialOptions {
	return opts({ python: process.env.FH_HEADROOM_PYTHON!, tokenizerCache: process.env.FH_HEADROOM_TOKENIZER_CACHE!, ...extra });
}
realTest("real worker preserves unicode, punctuation, nulls, booleans and row order", async () => {
	const data = Array.from({ length: 80 }, (_, i) => ({ longIdentifier: i,
		fullDescription: 'café 中文 "quoted", comma\nnewline\\backslash', nullableValue: i % 3 === 0 ? null : "value", enabledFlag: i % 2 === 0 }));
	const input = event({ content: [{ type: "text", text: JSON.stringify(data) }] });
	const trial = new LosslessTrial(realOpts());
	expect((await trial.handle(input))?.content[0].text).toStartWith(PREFIX);
	expect(trial.totals.verified).toBe(1);
});
realTest("real worker rejects nested data, decimals, missing fields and unsafe integers", async () => {
	for (const value of [{ nested: "value" }, 0.125, 9007199254740992]) {
		const data = rows.map(row => ({ ...row, extraValue: value }));
		const trial = new LosslessTrial(realOpts());
		expect(await trial.handle(event({ content: [{ type: "text", text: JSON.stringify(data) }] }))).toBeUndefined();
	}
	const data: any[] = rows.map(row => ({ ...row }));
	delete data[10].name;
	expect(await new LosslessTrial(realOpts()).handle(event({ content: [{ type: "text", text: JSON.stringify(data) }] }))).toBeUndefined();
});
realTest("real worker rejects duplicate keys, and timeout preserves the original", async () => {
	const duplicate = text.replace('"line":1', '"line":2,"line":1');
	expect(await new LosslessTrial(realOpts()).handle(event({ content: [{ type: "text", text: duplicate }] }))).toBeUndefined();
	expect(await new LosslessTrial(realOpts({ timeoutMs: 1 })).handle(event())).toBeUndefined();
});

test("worker rejection and exceptions return the original unchanged", async () => {
	for (const worker of [async () => ({ changed: false, reason: "timeout" }), async () => { throw Error("offline"); }, async () => ({ ...validResult(), content: "broken" })]) {
		const input = event();
		const snapshot = JSON.stringify(input);
		const trial = new LosslessTrial(opts(), worker);
		expect(await trial.handle(input)).toBeUndefined();
		expect(JSON.stringify(input)).toBe(snapshot);
	}
});

test("missing interpreter safely falls back", async () => {
	const trial = new LosslessTrial(opts());
	expect(await trial.handle(event())).toBeUndefined();
	expect(trial.totals.fallbacks).toBe(1);
});

test("extension is off without an explicit flag, and never hooks context or provider payloads", async () => {
	const handlers: Record<string, Function> = {};
	extension({ registerFlag() {}, getFlag() { return undefined; }, on(name: string, fn: Function) { handlers[name] = fn; }, registerCommand() {} } as any);
	expect(Object.keys(handlers).sort()).toEqual(["session_start", "tool_result"]);
	await handlers.session_start({}, { ui: { notify() {} } });
	expect(await handlers.tool_result(event())).toBeUndefined();
});
