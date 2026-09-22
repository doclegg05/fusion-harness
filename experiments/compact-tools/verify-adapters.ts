/** Run identical requests through real Pi loading, MCP stdio and CLI. No LLM. */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CompactTools, description, schema, type Input } from "./core.ts";

const root = path.resolve(import.meta.dir, "../..");
const runtime = path.join(import.meta.dir, "runtime");
fs.mkdirSync(runtime, {recursive: true});
const loaderPath = process.env.PI_EXTENSION_LOADER;
if (!loaderPath) throw new Error("Set PI_EXTENSION_LOADER to the installed Pi dist/core/extensions/loader.js");
const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
const validatorPath = path.resolve(path.dirname(loaderPath), "../../../node_modules/@earendil-works/pi-ai/dist/utils/validation.js");
const { validateToolArguments } = await import(pathToFileURL(validatorPath).href);
const loaded = await loadExtensions([path.join(import.meta.dir, "extension.ts")], root);
assert.deepEqual(loaded.errors, []);
const piTool = loaded.extensions[0].tools.get("compact_workspace").definition;
const tests = spawnSync(process.execPath, ["test", "extensions/fusion-harness/tests"], {cwd: root, encoding: "utf8"});
assert.equal(tests.status, 0, "Existing harness tests must pass");
const log = tests.stdout + tests.stderr;
fs.writeFileSync(path.join(runtime, "harness-tests.log"), log);
const rows = Array.from({length: 100}, (_, i) => ({id: i, group: i % 3 === 0 ? "alpha" : "beta", label: `Synthetic public item ${i}`, active: true}));
fs.writeFileSync(path.join(runtime, "rows.json"), JSON.stringify(rows, null, 2));
const requests: {name: string; input: Input; baseline: string; check: (data: any) => void}[] = [
  {name: "find ACK references in real harness source", input: {operation: "search", path: "extensions/fusion-harness", query: "ACK FUSION", limit: 8},
    baseline: spawnSync("rg", ["-n", "-F", "--", "ACK FUSION", "extensions/fusion-harness"], {cwd: root, encoding: "utf8"}).stdout,
    check: data => { assert.ok(data.complete); assert.ok(data.capturedMatches > 0); assert.ok(data.text.includes("ACK FUSION")); }},
  {name: "inspect real child isolation flags", input: {operation: "read", path: "extensions/fusion-harness/modules/child-runner.ts", startLine: 55, limit: 20},
    baseline: fs.readFileSync(path.join(root, "extensions/fusion-harness/modules/child-runner.ts"), "utf8"),
    check: data => { for (const flag of ["--no-skills", "--no-extensions", "--no-context-files"]) assert.ok(data.text.includes(flag)); }},
  {name: "inspect actual harness test summary", input: {operation: "log", path: "experiments/compact-tools/runtime/harness-tests.log"}, baseline: log,
    check: data => { assert.ok(data.verdict.startsWith("unknown")); assert.match(data.text, /0 fail/); assert.match(data.text, /pass/); }},
  {name: "count synthetic JSON rows without LLM arithmetic", input: {operation: "json", path: "experiments/compact-tools/runtime/rows.json", field: "group", value: "alpha"},
    baseline: JSON.stringify(rows, null, 2), check: data => assert.equal(data.matchingRows, 34)},
  {name: "compress complete synthetic JSON table", input: {operation: "json", path: "experiments/compact-tools/runtime/rows.json", budget: 16000},
    baseline: JSON.stringify(rows, null, 2), check: data => { assert.equal(data.complete, true); assert.equal(data.rowCount, 100); assert.equal(data.representation, "verified-lossless-table"); }},
];
const client = new Client({name: "compact-adapter-check", version: "0.1.0"});
await client.connect(new StdioClientTransport({command: process.execPath, args: [path.join(import.meta.dir, "mcp.ts"), root], stderr: "pipe"}));
const results: any[] = [];
try {
  const listing = await client.listTools();
  assert.equal(listing.tools.length, 1);
  assert.equal(listing.tools[0].name, "compact_workspace");
  for (const task of requests) {
    const validated = validateToolArguments(piTool, {name: piTool.name, arguments: task.input});
    const pi = await piTool.execute("test", validated, undefined, undefined, {cwd: root});
    const mcp: any = await client.callTool({name: "compact_workspace", arguments: task.input});
    assert.ok(!mcp.isError);
    const cli = spawnSync(process.execPath, [path.join(import.meta.dir, "cli.ts"), root], {input: JSON.stringify(task.input), encoding: "utf8"});
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(pi.content[0].text, mcp.content[0].text);
    assert.equal(pi.content[0].text, cli.stdout.trimEnd());
    const data = JSON.parse(pi.content[0].text);
    task.check(data);
    const retrieval: any = await client.callTool({name: "compact_workspace", arguments: {operation: "retrieve", artifact: data.artifact, budget: 2000}});
    assert.ok(!retrieval.isError);
    results.push({name: task.name, parity: "Pi loader = MCP stdio = CLI", taskEvidencePassed: true,
      baseline: task.baseline, compact: pi.content[0].text, retrievalFirstPage: retrieval.content[0].text});
  }
} finally { await client.close(); }
const resultFile = path.join(runtime, "adapter-results.json");
fs.writeFileSync(resultFile, JSON.stringify({kind: "tool-output comparison; no model inference or provider billing", root,
  baseline: "Full source/log/JSON and normal rg -n output; not an optimized native-tool baseline",
  toolDefinition: JSON.stringify({name: "compact_workspace", description, inputSchema: schema}), results}, null, 2));
console.log(JSON.stringify({tasks: results.length, allAdaptersEqual: true, resultFile}, null, 2));
