/**
 * Chord control script (API: https://api.chordhq.xyz). Env: CHORD_API_KEY, CHORD_WORKSPACE_ID,
 * CHORD_TEAMMATE_ID, PUBLIC_URL, MCP_BEARER_TOKEN, optional CHORD_MCP_SERVER_ID.
 *
 *   npm run chord -- ids                   print teammate + workspace ids for your API key
 *   npm run chord -- register              register (or update) the MCP server, then discover + health
 *   npm run chord -- check                 discover tools + health for CHORD_MCP_SERVER_ID
 *   npm run chord -- skills                upload every skills/<name>/SKILL.md as a draft and publish it
 *   npm run chord -- chat <phone> <session> "<text>"   one external-chat turn; prints reply + tool steps
 *   npm run chord -- get <path>            raw GET (e.g. /v1/teammates/<id>/skills)
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

const API = process.env.CHORD_API_URL ?? "https://api.chordhq.xyz";
const KEY = process.env.CHORD_API_KEY ?? "";
const WS = process.env.CHORD_WORKSPACE_ID ?? "";
const TM = process.env.CHORD_TEAMMATE_ID ?? "";

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  const rid = res.headers.get("x-request-id") ?? res.headers.get("x-amzn-requestid") ?? "";
  if (!res.ok) {
    console.error(`✗ ${method} ${p} → ${res.status} ${rid ? `(request ${rid})` : ""}\n${typeof json === "string" ? json : JSON.stringify(json, null, 2)}`);
    process.exit(1);
  }
  return json;
}

async function check(id: string) {
  const tools = await api("POST", `/v1/workspaces/${WS}/mcp-servers/${id}/tools`);
  const list = Array.isArray(tools) ? tools : tools.tools ?? tools.data ?? [];
  console.log(`tools (${list.length}): ${list.map((t: any) => t.name).join(", ")}`);
  const health = await api("POST", `/v1/workspaces/${WS}/mcp-servers/${id}/health`);
  console.log("health:", JSON.stringify(health));
}

async function register() {
  const url = `${process.env.PUBLIC_URL!.replace(/\/$/, "")}/mcp`;
  const body = { name: "Ibinabo desk", url, auth_type: "bearer", auth_token: process.env.MCP_BEARER_TOKEN, transport: "streamable_http", enabled: true };
  let id = process.env.CHORD_MCP_SERVER_ID;
  if (id) {
    await api("PUT", `/v1/workspaces/${WS}/mcp-servers/${id}`, body);
    console.log(`updated ${id} → ${url}`);
  } else {
    const created = await api("POST", `/v1/workspaces/${WS}/mcp-servers`, body);
    id = created.id;
    console.log(`created ${id} → ${url}\nAdd CHORD_MCP_SERVER_ID=${id} to .env`);
  }
  if (TM) {
    await api("PUT", `/v1/teammates/${TM}`, { add_mcp_server_ids: [id] });
    console.log(`attached to teammate ${TM}`);
  }
  await check(id!);
}

async function skills() {
  const dir = path.join(process.cwd(), "skills");
  const existing = await api("GET", `/v1/teammates/${TM}/skills`);
  const list: any[] = Array.isArray(existing) ? existing : existing.skills ?? existing.items ?? [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const file = path.join(dir, name, "SKILL.md");
    const content = await fs.readFile(file, "utf8").catch(() => null);
    if (!content) continue;
    const files = [{ path: "SKILL.md", content, media_type: "text/markdown" }];
    const key = `${name}-${Date.now()}`;
    const found = list.find((s) => s.name === name);
    const skill = found
      ? await api("PUT", `/v1/teammates/${TM}/skills/${found.id}/draft`, { files, entrypoint: "SKILL.md", idempotency_key: key, expected_version: found.version ?? found.current_version })
      : await api("POST", `/v1/teammates/${TM}/skills`, { name, entrypoint: "SKILL.md", files, idempotency_key: key });
    const id = skill.id ?? found?.id;
    const version = skill.draft_version ?? skill.version ?? skill.current_version ?? 1;
    const pub = await api("POST", `/v1/teammates/${TM}/skills/${id}/publish`, { expected_version: version, idempotency_key: `pub-${key}`, summary: "Sync from repo" });
    console.log(`published ${name} (${id}) → ${JSON.stringify(pub).slice(0, 200)}`);
  }
}

async function chat(phone: string, session: string, text: string) {
  const t0 = Date.now();
  const r = await api("POST", "/v1/external-chat/messages", { workspace_id: WS, teammate_id: TM || undefined, sender_id: phone, session_id: session, display_name: phone, text });
  console.log(`[${Date.now() - t0}ms] thread ${r.thread_id}`);
  for (const s of r.steps ?? []) console.log(`  · ${s.tool ?? s.name ?? s.type} ${s.success === false ? "✗" : "✓"} ${s.latency_ms ?? ""}ms ${String(s.instruction ?? "").slice(0, 160)}`);
  console.log(`\n${r.reply ?? `(no reply: ${r.reason})`}\n`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!KEY || (!WS && cmd !== "ids" && cmd !== "get")) {
  console.error(KEY ? "Set CHORD_WORKSPACE_ID in .env (run: npm run chord -- ids)" : "Set CHORD_API_KEY in .env");
  process.exit(1);
}
if (cmd === "ids") {
  const r = await api("GET", "/v1/teammates");
  const list: any[] = Array.isArray(r) ? r : r.teammates ?? r.items ?? r.data ?? [];
  if (!list.length) console.log("No teammates yet. Create one in the Chord app first.\n", JSON.stringify(r).slice(0, 500));
  for (const t of list) console.log(`CHORD_TEAMMATE_ID=${t.id}   # ${t.display_name ?? t.email ?? ""} (${t.status ?? ""})\nCHORD_WORKSPACE_ID=${t.workspace_id ?? "?"}\n`);
} else if (cmd === "register") await register();
else if (cmd === "check") await check(process.env.CHORD_MCP_SERVER_ID!);
else if (cmd === "skills") await skills();
else if (cmd === "chat") await chat(rest[0], rest[1], rest.slice(2).join(" "));
else if (cmd === "get") console.log(JSON.stringify(await api("GET", rest[0]), null, 2));
else console.log("usage: register | check | skills | chat <phone> <session> <text> | get <path>");
