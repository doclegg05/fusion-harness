import { CompactTools, type Input } from "./core.ts";

// One JSON request avoids shell interpolation of queries and file contents.
try {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: bun cli.ts WORKSPACE_ROOT < request.json");
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 32000) throw new Error("Request too large"); }
  const result = await new CompactTools(root).call(JSON.parse(input) as Input);
  process.stdout.write(result.content[0].text + "\n");
  if (result.isError) process.exitCode = 1;
} catch (error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }
