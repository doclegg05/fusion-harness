import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CompactTools, description, schema, type Input } from "./core.ts";

const root = process.argv[2];
if (!root) throw new Error("Usage: bun mcp.ts WORKSPACE_ROOT");
const tools = new CompactTools(root);
const server = new Server({ name: "fusion-compact-tools", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "compact_workspace", description: `${description} Workspace root: ${tools.root}. Prefer native tools for already-concise output.`,
  inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== "compact_workspace") throw new Error("Unknown tool");
  return tools.call(request.params.arguments as Input, extra.signal);
});
await server.connect(new StdioServerTransport());
