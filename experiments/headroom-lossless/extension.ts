import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { LosslessTrial } from "./trial.ts";

/** Explicitly loaded on Main only; clean-room children do not inherit extensions. */
export default function (pi: ExtensionAPI) {
	pi.registerFlag("fh-headroom", { type: "string", description: "Opt-in Main-role JSON tool-output trial: shadow or apply. Off when omitted." });
	pi.registerFlag("fh-headroom-tools", { type: "string", description: "Comma-separated tool allowlist for the trial, e.g. bash. No default tools." });
	let trial: LosslessTrial | undefined;
	pi.on("session_start", async (_event, ctx) => {
		const mode = pi.getFlag("fh-headroom");
		if (!mode) return;
		try {
			if (mode !== "shadow" && mode !== "apply") throw new Error("use shadow or apply");
			const tools = new Set(String(pi.getFlag("fh-headroom-tools") ?? "").split(",").map(s => s.trim()).filter(Boolean));
			if (!tools.size) throw new Error("set --fh-headroom-tools explicitly");
			const root = process.env.FH_HEADROOM_ARTIFACTS ?? "";
			if (!path.isAbsolute(root)) throw new Error("set absolute FH_HEADROOM_ARTIFACTS");
			fs.mkdirSync(root, { recursive: true, mode: 0o700 });
			trial = new LosslessTrial({ mode, tools,
				python: process.env.FH_HEADROOM_PYTHON ?? "",
				tokenizerCache: process.env.FH_HEADROOM_TOKENIZER_CACHE ?? "",
				directory: fs.mkdtempSync(path.join(root, "main-")),
			});
			ctx.ui.notify(`Headroom ${mode}: Main only; verified JSON tables; metrics in ${trial.options.directory}`, "info");
		} catch (error) { trial = undefined; ctx.ui.notify(`Headroom trial disabled: ${String(error)}`, "warning"); }
	});
	pi.on("tool_result", async event => trial?.handle(event));
	pi.registerCommand("fh-headroom-status", {
		description: "Show Main-role lossless trial metrics (token estimates, not billing).",
		handler: async (_args, ctx) => {
			ctx.ui.notify(trial ? JSON.stringify(trial.totals) : "Headroom trial is off", "info");
		},
	});
}
