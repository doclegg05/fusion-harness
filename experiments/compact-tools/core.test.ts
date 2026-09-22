import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CompactTools } from "./core.ts";

const base = fs.mkdtempSync(path.join(import.meta.dir, "runtime-test-"));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
function fixture() {
  const root = fs.mkdtempSync(path.join(base, "project-"));
  return { root, tool: new CompactTools(root, path.join(base, "artifacts")) };
}
async function data(tool: CompactTools, input: any) {
  const result = await tool.call(input);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

test("exact original can be reconstructed through bounded Unicode pages", async () => {
  const {root, tool} = fixture();
  const original = "\uFEFF" + "one 🙂 two\n".repeat(3000);
  fs.writeFileSync(path.join(root, "long.txt"), original);
  const first = await data(tool, {operation: "read", path: "long.txt", limit: 2});
  expect(first.omitted).toBe(true);
  let joined = "", offset = 0;
  do {
    const page = await data(tool, {operation: "retrieve", artifact: first.artifact, offset, budget: 2000});
    expect(page.sourceChanged).toBe(false);
    joined += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  expect(joined).toBe(original);
});

test("snapshots remain stable while changed or removed sources are flagged", async () => {
  const {root, tool} = fixture();
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "original");
  const a = await data(tool, {operation: "read", path: "a.txt"});
  fs.writeFileSync(file, "updated");
  const b = await data(tool, {operation: "read", path: "a.txt"});
  expect(b.artifact).not.toBe(a.artifact);
  const prior = await data(tool, {operation: "retrieve", artifact: a.artifact});
  expect(prior.text).toBe("original");
  expect(prior.sourceChanged).toBe(true);
  fs.unlinkSync(file);
  expect((await data(tool, {operation: "retrieve", artifact: a.artifact})).sourceChanged).toBe(true);
});

test("workspace escape, symlink escape, binary files, oversized files and malformed inputs fail", async () => {
  const {root, tool} = fixture();
  fs.writeFileSync(path.join(base, "outside.txt"), "outside");
  fs.symlinkSync(path.join(base, "outside.txt"), path.join(root, "escape"));
  fs.writeFileSync(path.join(root, "binary"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, "big"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  for (const input of [
    {operation: "read", path: "../outside.txt"}, {operation: "read", path: "/etc/passwd"},
    {operation: "read", path: "escape"}, {operation: "read", path: "binary"}, {operation: "read", path: "big"},
    {operation: "read", path: "missing"}, {operation: "read", path: "binary", budget: -1},
    {operation: "search", query: ""}, {operation: "shell", command: "echo hi"},
  ]) expect((await tool.call(input)).isError).toBe(true);
});

test("cross-project artifact access and corrupt snapshots fail", async () => {
  const {root, tool} = fixture();
  fs.writeFileSync(path.join(root, "a"), "one");
  const a = await data(tool, {operation: "read", path: "a"});
  expect((await fixture().tool.call({operation: "retrieve", artifact: a.artifact})).isError).toBe(true);
  fs.writeFileSync(path.join(tool.store, `${a.artifact}.json`), "{}");
  expect((await tool.call({operation: "retrieve", artifact: a.artifact})).isError).toBe(true);
});

test("literal search reports omitted matches and snapshot retains all captured matches", async () => {
  const {root, tool} = fixture();
  fs.writeFileSync(path.join(root, "file.txt"), "a.* literal\n".repeat(60));
  fs.writeFileSync(path.join(root, "other.txt"), "abbbbb\n");
  const result = await data(tool, {operation: "search", query: "a.*", limit: 2});
  expect(result.complete).toBe(true);
  expect(result.capturedMatches).toBe(60);
  expect(result.omittedMatches).toBe(58);
  const snapshot = JSON.parse(fs.readFileSync(path.join(tool.store, `${result.artifact}.json`), "utf8"));
  expect(snapshot.content.split('\n').filter((s: string) => s.includes('"type":"match"')).length).toBe(60);
  expect((await data(tool, {operation: "search", query: "absent"})).capturedMatches).toBe(0);
});

test("failed search is explicitly incomplete, cancellation is not clean success", async () => {
  const {root} = fixture();
  const tool = new CompactTools(root, path.join(base, "artifacts"), "/usr/bin/false");
  // Exit 1 is rg's no-matches status; use a real process returning 2 for operational failure.
  const script = path.join(root, "bad-rg");
  fs.writeFileSync(script, "#!/bin/sh\nexit 2\n", {mode: 0o700});
  expect((await data(new CompactTools(root, path.join(base, "artifacts"), script), {operation: "search", query: "x"})).complete).toBe(false);
  const abort = new AbortController(); abort.abort();
  expect((await tool.call({operation: "search", query: "x"}, abort.signal)).isError).toBe(true);
});

test("log diagnostics preserve failure context and never claim a test verdict", async () => {
  const {root, tool} = fixture();
  fs.writeFileSync(path.join(root, "test.log"), "passed repetitive output\n".repeat(1000) + "FAIL crucial_case\nexpected: true\nreceived: false\n" + "more routine output\n".repeat(1000));
  const result = await data(tool, {operation: "log", path: "test.log"});
  expect(result.text).toContain("FAIL crucial_case");
  expect(result.text).toContain("received: false");
  expect(result.verdict).toStartWith("unknown");
  expect(result.omitted).toBe(true);
});

test("JSON count is computed locally; oversized JSON is not returned as a broken table", async () => {
  const {root, tool} = fixture();
  fs.writeFileSync(path.join(root, "data.json"), JSON.stringify(Array.from({length: 50}, (_, i) => ({id: i, done: i % 2 === 0, note: "large row ".repeat(40)}))));
  const count = await data(tool, {operation: "json", path: "data.json", field: "done", value: true});
  expect(count.rowCount).toBe(50); expect(count.matchingRows).toBe(25);
  const result = await data(tool, {operation: "json", path: "data.json", budget: 2000});
  expect(result.representation).toBe("snapshot-only");
  expect(result.text).toBeUndefined();
  expect(result.complete).toBe(false);
});

test("Headroom preserves every admitted table value or falls back to original", async () => {
  const {root, tool} = fixture();
  const rows = Array.from({length: 40}, (_, i) => ({id: i, name: `sample ${i}`, group: "public", note: "ordinary content", active: true}));
  const text = JSON.stringify(rows, null, 4);
  fs.writeFileSync(path.join(root, "data.json"), text);
  const result = await data(tool, {operation: "json", path: "data.json", budget: 16000});
  expect(result.complete).toBe(true);
  if (result.representation === "verified-lossless-table") {
    const table = JSON.parse(result.text.split("\n").slice(1).join("\n"));
    expect(table._rows.map((r: any[]) => Object.fromEntries(table._schema.map((c: any, i: number) => [c.name, r[i]])))).toEqual(rows);
  } else { expect(result.text).toBe(text); }
});
