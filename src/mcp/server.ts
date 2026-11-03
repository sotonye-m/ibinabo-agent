import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS } from "./tools/index.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "ibinabo-desk", version: "0.1.0" },
    { instructions: "Ibinabo Distribution credit & stock desk. Every tool takes the sender's phone. All money and scores are computed by these tools; repeat the *_display values exactly." },
  );
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, async (args: any) => {
      const started = Date.now();
      let result: unknown;
      try {
        result = await t.handler(args);
      } catch (e: any) {
        console.error(`[tool] ${t.name} failed`, e);
        result = { status: "system_error", message: String(e?.message ?? e).slice(0, 300) };
      }
      console.log(`[tool] ${t.name} ${JSON.stringify(args)} → ${(result as any)?.status} (${Date.now() - started}ms)`);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  }
  return server;
}
