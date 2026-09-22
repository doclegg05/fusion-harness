import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LosslessTrial } from "../headroom-lossless/trial.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const description = "Read-only compact workspace evidence: literal search, line excerpts, saved-log diagnostics, or verified JSON compression. Originals are local snapshots; retrieve omitted text by artifact and offset. Log highlights are not a test verdict. Use before large raw reads; retrieve exact code before edits. No commands or model calls.";
export const schema = {
  type: "object", additionalProperties: false,
  properties: {
    operation: { type: "string", enum: ["search", "read", "log", "json", "retrieve"] },
    path: { type: "string", description: "Workspace-relative file; search also accepts a directory (default .)." },
    query: { type: "string", description: "Literal search text." },
    startLine: { type: "integer", minimum: 1, description: "Read: first line, default 1." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Read lines or search matches, default 40." },
    budget: { type: "integer", minimum: 2000, maximum: 16000, description: "Approximate response character budget, default 6000." },
    artifact: { type: "string", description: "Retrieve: snapshot identifier from an earlier call." },
    offset: { type: "integer", minimum: 0, description: "Retrieve: use nextOffset from preceding page, default 0." },
    field: { type: "string", description: "JSON: count rows whose own field equals value, without sending all rows." },
    value: { type: ["string", "number", "boolean", "null"], description: "JSON: exact scalar value to count; requires field." },
  }, required: ["operation"],
} as const;
export type Input = { operation: string; path?: string; query?: string; startLine?: number; limit?: number; budget?: number; artifact?: string; offset?: number; field?: string; value?: string | number | boolean | null };
export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Snapshot = { version: 1; root: string; kind: string; source?: string; sourceHash?: string; content: string };

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Expected integer ${min}..${max}`);
  return value;
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function textPage(text: string, offset: number, length: number) {
  if (offset > text.length) throw new Error("Offset exceeds snapshot length");
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")) throw new Error("Offset splits a Unicode character");
  let end = Math.min(text.length, offset + length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
}

/** Bounded read with no FIFO/device access; resolve scope before opening. */
function readText(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Expected a regular file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > MAX_BYTES) throw new Error("File exceeds 2 MiB; select a smaller source");
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) throw new Error("Binary content is not supported");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally { fs.closeSync(fd); }
}

export class CompactTools {
  readonly root: string;
  readonly store: string;
  constructor(root: string, storeBase = path.join(HERE, "runtime"), readonly rg = process.env.COMPACT_RG ?? "rg") {
    this.root = fs.realpathSync(root);
    this.store = path.join(storeBase, sha(this.root));
    fs.mkdirSync(this.store, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.store).isSymbolicLink() || !fs.statSync(this.store).isDirectory()) throw new Error("Invalid artifact store");
    fs.chmodSync(this.store, 0o700);
  }
  private resolve(relative: string): string {
    if (!relative || path.isAbsolute(relative)) throw new Error("Use a workspace-relative path");
    const target = fs.realpathSync(path.resolve(this.root, relative));
    if (!within(this.root, target)) throw new Error("Path escapes workspace");
    if (within(this.store, target)) throw new Error("Use retrieve for stored artifacts");
    return target;
  }
  private save(snapshot: Omit<Snapshot, "root" | "version">): string {
    const content = JSON.stringify({ version: 1, root: this.root, ...snapshot });
    const id = sha(content);
    const file = path.join(this.store, `${id}.json`);
    try { fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 }); }
    catch (error: any) {
      if (error.code !== "EEXIST" || fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file, "utf8") !== content) throw new Error("Snapshot storage failed integrity check");
    }
    return id;
  }
  private load(id: string): Snapshot {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid artifact identifier");
    const file = path.join(this.store, `${id}.json`);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Invalid snapshot file");
    const text = fs.readFileSync(file, "utf8");
    if (sha(text) !== id) throw new Error("Snapshot integrity mismatch");
    const snapshot = JSON.parse(text) as Snapshot;
    if (snapshot.root !== this.root || snapshot.version !== 1) throw new Error("Snapshot belongs to another workspace");
    return snapshot;
  }
  async call(input: Input, signal?: AbortSignal): Promise<Result> {
    const started = performance.now();
    let inputBytes = 0;
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an argument object");
      for (const key of Object.keys(input)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown argument: ${key}`);
      const budget = boundedInt(input.budget, 6000, 2000, 16000);
      const limit = boundedInt(input.limit, 40, 1, 200);
      if (signal?.aborted) throw new Error("Cancelled");
      let output: Record<string, unknown>;
      if (input.operation === "retrieve") {
        const saved = this.load(input.artifact ?? "");
        const offset = boundedInt(input.offset, 0, 0, MAX_BYTES * 2);
        let sourceChanged: boolean | null = null;
        if (saved.source) {
          try { sourceChanged = sha(readText(this.resolve(saved.source))) !== saved.sourceHash; }
          catch { sourceChanged = true; }
        }
        output = { operation: "retrieve", artifact: input.artifact, kind: saved.kind, source: saved.source,
          sourceHash: saved.sourceHash, sourceChanged, offset, totalCharacters: saved.content.length,
          ...textPage(saved.content, offset, budget - 1500) };
        inputBytes = Buffer.byteLength(saved.content);
      } else if (input.operation === "search") {
        if (typeof input.query !== "string" || !input.query || input.query.length > 500 || /[\r\n\0]/.test(input.query)) throw new Error("Search needs a nonempty single-line literal query up to 500 characters");
        const target = this.resolve(input.path ?? ".");
        const capture = await this.search(target, input.query, signal);
        inputBytes = Buffer.byteLength(capture.stdout);
        const matches: { path: string; line: number; text: string }[] = [];
        const originalMatches: string[] = [];
        for (const line of capture.stdout.split("\n")) {
          if (!line) continue;
          try {
            const row = JSON.parse(line);
            if (row.type === "match") {
              matches.push({ path: row.data.path.text, line: row.data.line_number, text: row.data.lines.text });
              originalMatches.push(line);
            }
          } catch { /* Output cap can end inside a JSON record; completeness is false. */ }
        }
        // Retain every captured match verbatim; omit rg timing events so identical evidence reuses its snapshot.
        const evidence = originalMatches.join("\n");
        const artifact = this.save({ kind: "search-matches-jsonl", content: evidence });
        const text = matches.slice(0, limit).map(m => `${m.path}:${m.line}: ${m.text.trimEnd()}`).join("\n");
        const excerpt = textPage(text, 0, budget - 1500);
        output = { operation: "search", artifact, complete: capture.complete, exitCode: capture.code,
          capturedMatches: matches.length, omittedMatches: Math.max(0, matches.length - limit),
          excerptClipped: excerpt.nextOffset !== null, text: excerpt.text,
          scope: "Ignores hidden, ignored, binary and >2 MiB files and directory symlinks; snapshot retains captured match records, not file snapshots or rg timing events",
          diagnostic: capture.stderr.slice(0, 400), snapshotHash: sha(evidence) };
      } else {
        if (!["read", "log", "json"].includes(input.operation)) throw new Error("Unknown operation");
        const file = this.resolve(input.path ?? "");
        const text = readText(file);
        inputBytes = Buffer.byteLength(text);
        const source = path.relative(this.root, file);
        const sourceHash = sha(text);
        const artifact = this.save({ kind: input.operation, source, sourceHash, content: text });
        const base = { operation: input.operation, artifact, source, sourceHash, sourceBytes: inputBytes };
        if (input.operation === "read") {
          const start = boundedInt(input.startLine, 1, 1, MAX_BYTES);
          const lines = text.split("\n");
          const chosen = lines.slice(start - 1, start - 1 + limit).map((line, i) => `${start + i}: ${line}`).join("\n");
          const page = textPage(chosen, 0, budget - 1500);
          output = { ...base, totalLines: lines.length, startLine: start,
            endLine: Math.min(lines.length, start - 1 + limit), excerptClipped: page.nextOffset !== null,
            omitted: start > 1 || start - 1 + limit < lines.length || page.nextOffset !== null, text: page.text };
        } else if (input.operation === "log") {
          // Highlight evidence only. Never infer a passing run from an absence of errors.
          const lines = text.split("\n");
          const diagnostic = /\b(error|fail(?:ed|ure|ing)?|fatal|exception|traceback|panic|assert(?:ion)?|not ok)\b|[✗✘×]/i;
          const selected = new Set<number>();
          const hits: number[] = [];
          lines.forEach((line, i) => { if (diagnostic.test(line)) hits.push(i); });
          for (const i of hits) for (let n = Math.max(0, i - 2); n <= Math.min(lines.length - 1, i + 3); n++) selected.add(n);
          for (let i = Math.max(0, lines.length - 12); i < lines.length; i++) selected.add(i);
          const all = [...selected].sort((a, b) => a - b);
          const chosen = all.map(i => `${i + 1}: ${lines[i]}`).join("\n");
          const page = textPage(chosen, 0, budget - 1500);
          output = { ...base, verdict: "unknown: saved text only; verify the runner exit status separately", totalLines: lines.length,
            diagnosticMatches: hits.length, selectedLines: all.length, omitted: all.length < lines.length || page.nextOffset !== null,
            excerptClipped: page.nextOffset !== null, text: page.text };
        } else {
          const parsed = JSON.parse(text); // Reject invalid JSON rather than presenting it as a table.
          if (input.field !== undefined || Object.hasOwn(input, "value")) {
            if (!Array.isArray(parsed) || typeof input.field !== "string" || !input.field || !Object.hasOwn(input, "value") ||
              (input.value !== null && !["string", "number", "boolean"].includes(typeof input.value))) throw new Error("Counting needs a JSON array, field, and scalar value");
            const matches = parsed.filter(row => row && typeof row === "object" && Object.hasOwn(row, input.field!) && row[input.field!] === input.value).length;
            output = { ...base, representation: "computed-count", rowCount: parsed.length, matchingRows: matches, field: input.field, value: input.value, complete: true };
          } else {
          const trialDir = path.resolve(HERE, "../headroom-lossless");
          const trial = new LosslessTrial({ mode: "apply", tools: new Set(["compact_json"]),
            python: process.env.FH_HEADROOM_PYTHON ?? path.join(trialDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
            tokenizerCache: process.env.FH_HEADROOM_TOKENIZER_CACHE ?? path.join(trialDir, "runtime/tokenizer-cache"),
            directory: path.join(this.store, "headroom") });
          const transformed = await trial.handle({ toolName: "compact_json", toolCallId: artifact, isError: false, content: [{ type: "text", text }] });
          const compact = transformed?.content[0].text ?? text;
          const page = textPage(compact, 0, budget - 1500);
          // Never show a chopped table as if it were complete.
          output = page.nextOffset === null
            ? { ...base, representation: transformed ? "verified-lossless-table" : "original-json", rowCount: Array.isArray(parsed) ? parsed.length : null, complete: true, text: compact }
            : { ...base, representation: "snapshot-only", complete: false, note: "Full JSON exceeds response budget. Retrieve the original snapshot in pages; no partial JSON table is returned." };
          }
        }
      }
      const text = JSON.stringify(output);
      this.record(input.operation, inputBytes, Buffer.byteLength(text), performance.now() - started);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(error), operation: input?.operation }) }] };
    }
  }
  private record(operation: string, inputBytes: number, outputBytes: number, elapsedMs: number) {
    // Telemetry must not invalidate an otherwise retrievable result.
    try { fs.appendFileSync(path.join(this.store, "metrics.jsonl"), JSON.stringify({ operation, inputBytes, outputBytes, elapsedMs: Math.round(elapsedMs), unit: "bytes; not provider tokens or billing" }) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
  }
  private search(target: string, query: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null; complete: boolean }> {
    return new Promise((resolve, reject) => {
      const relative = path.relative(this.root, target) || ".";
      const proc = spawn(this.rg, ["--json", "--sort", "path", "--fixed-strings", "--max-filesize", "2M", "--", query, relative],
        { cwd: this.root, env: { PATH: process.env.PATH ?? "", HOME: this.store }, shell: false });
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), limited = false;
      const stop = () => { limited = true; proc.kill("SIGKILL"); };
      const timer = setTimeout(stop, 10000);
      signal?.addEventListener("abort", stop, { once: true });
      proc.stdout.on("data", (data: Buffer) => { stdout = Buffer.concat([stdout, data.subarray(0, Math.max(0, MAX_BYTES - stdout.length))]); if (stdout.length >= MAX_BYTES) stop(); });
      proc.stderr.on("data", (data: Buffer) => { stderr = Buffer.concat([stderr, data.subarray(0, Math.max(0, 4096 - stderr.length))]); });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
      proc.on("error", error => { cleanup(); reject(error); });
      proc.on("close", code => { cleanup(); resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code, complete: !limited && (code === 0 || code === 1) }); });
    });
  }
}
