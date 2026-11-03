import "dotenv/config";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp/server.js";
import { paystackWebhook } from "./webhooks/paystack.js";

export const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ibinabo-desk", backend: process.env.DB_BACKEND ?? "sheets", time: new Date().toISOString() });
});

app.get("/paid", (_req, res) => {
  res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Payment received</title>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center">
<h1>Thank you</h1><p>Your payment is being confirmed with Ibinabo Distribution.</p>
<p>Go back to WhatsApp and send <b>"I don pay"</b>. No need to send a screenshot.</p></body>`);
});

// Raw body for signature verification — must be mounted before any JSON parser.
app.post("/webhooks/paystack", express.raw({ type: "*/*", limit: "1mb" }), paystackWebhook);

function bearer(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MCP_BEARER_TOKEN ?? "";
  const got = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = expected.length > 0 && got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) {
    console.warn(`[mcp] 401 from ${req.ip} ua=${req.header("user-agent")}`);
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  next();
}

/** Probe log: what Chord actually sends (headers minus auth, body). Answers "does Chord pass the sender's number?". */
function probe(req: Request, _res: Response, next: NextFunction) {
  if (process.env.MCP_PROBE_LOG !== "false") {
    const headers = { ...req.headers, authorization: req.headers.authorization ? "[redacted]" : undefined };
    console.log(`[mcp-probe] ${JSON.stringify({ headers, body: req.body })}`.slice(0, 4000));
  }
  next();
}

app.post("/mcp", bearer, express.json({ limit: "1mb" }), probe, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.use((_req, res) => res.status(404).json({ status: "not_found" }));

export default app;
