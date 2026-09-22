/** Offline paired replay: no provider credentials, model calls, or client settings. */
import * as fs from "node:fs";
import * as path from "node:path";
import { LosslessTrial } from "./trial.ts";

const directory = process.env.FH_HEADROOM_ARTIFACTS;
if (!directory || !path.isAbsolute(directory)) throw Error("Set absolute FH_HEADROOM_ARTIFACTS");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const trial = new LosslessTrial({ mode: "apply", tools: new Set(["synthetic_search"]),
	python: process.env.FH_HEADROOM_PYTHON ?? "", tokenizerCache: process.env.FH_HEADROOM_TOKENIZER_CACHE ?? "",
	directory: fs.mkdtempSync(path.join(directory, "evaluation-")), timeoutMs: 3000 });
const results: unknown[] = [];
for (let n = 0; n < 20; n++) {
	const data = Array.from({ length: 60 + n * 3 }, (_, i) => ({
		filePath: `src/area-${n}/component-${i}.ts`, lineNumber: i * 7 + 1,
		symbolName: `synthetic_match_${i}`, category: ["module", "function", "constant"][i % 3],
		visible: i % 2 === 0, annotation: i % 5 === 0 ? null : `sample-${i}`,
	}));
	const content = JSON.stringify(data, null, n % 2 === 0 ? 2 : undefined);
	const event = { toolName: "synthetic_search", toolCallId: `synthetic-${n}`, isError: false, content: [{ type: "text", text: content }] };
	const original = JSON.stringify(event);
	const started = performance.now();
	const result = await trial.handle(event);
	if (JSON.stringify(event) !== original) throw Error("input mutated");
	if (!result) throw Error(`case ${n}: expected verified compression`);
	results.push({ case: n + 1, rows: data.length, preserved: true, latencyMs: Math.round(performance.now() - started) });
}
const report = { kind: "offline synthetic replay; not an LLM quality or billing benchmark", tokenizer: "o200k_base",
	totals: trial.totals, reductionPercent: 100 * (1 - trial.totals.after / trial.totals.before), cases: results,
	artifacts: trial.options.directory };
fs.writeFileSync(path.join(trial.options.directory, "results.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
