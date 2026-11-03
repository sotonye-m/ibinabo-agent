/**
 * Chord control script (API: https://api.chordhq.xyz).
 *
 *   npm run chord -- setup      everything below in one go (idempotent; safe to re-run)
 *                               1. find workspace id  2. find or create the teammate
 *                               3. upload + publish + include the 3 skills
 *                               4. register/update the MCP server (needs PUBLIC_URL), attach, discover, health
 *                               5. activate the teammate   6. write the ids into .env
 *   npm run chord -- ids        print teammate + workspace ids for your API key
 *   npm run chord -- skills     only step 3
 *   npm run chord -- register   only step 4
 *   npm run chord -- check      discover tools + health for CHORD_MCP_SERVER_ID
 *   npm run chord -- chat <phone> <session> "<text>"   one external-chat turn; prints reply + tool steps
 *   npm run chord -- get <path> raw GET (e.g. /v1/teammates/<id>/skills)
 *
 * Only CHORD_API_KEY must be set by hand (create it in the Chord app). Everything else is discovered.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

const API = process.env.CHORD_API_URL ?? "https://api.chordhq.xyz";
const KEY = process.env.CHORD_API_KEY ?? "";
let WS = process.env.CHORD_WORKSPACE_ID ?? "";
let TM = process.env.CHORD_TEAMMATE_ID ?? "";
let MCP = process.env.CHORD_MCP_SERVER_ID ?? "";

const TEAMMATE_EMAIL = process.env.CHORD_TEAMMATE_EMAIL ?? "ibinabo-desk@ibinabo.test";
const MCP_NAME = "Ibinabo desk";

type Res = { ok: boolean; status: number; json: any };

async function raw(method: string, p: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, json };
}

async function api(method: string, p: string, body?: unknown) {
  const r = await raw(method, p, body);
  if (!r.ok) {
    console.error(`✗ ${method} ${p} → ${r.status}\n${typeof r.json === "string" ? r.json : JSON.stringify(r.json, null, 2)}`);
    if (r.status === 403) console.error("  → The API key is missing a permission for this call. See the list at the top of README › Chord.");
    process.exit(1);
  }
  return r.json;
}

const arr = (x: any, ...keys: string[]): any[] => (Array.isArray(x) ? x : keys.map((k) => x?.[k]).find(Array.isArray) ?? []);

/** Upsert KEY=value lines in .env. */
async function saveEnv(vals: Record<string, string>) {
  const file = path.join(process.cwd(), ".env");
  let text = await fs.readFile(file, "utf8").catch(() => "");
  for (const [k, v] of Object.entries(vals)) {
    if (!v) continue;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\n?$/, "\n")}${k}=${v}\n`;
  }
  await fs.writeFile(file, text);
  console.log(`  .env updated: ${Object.keys(vals).filter((k) => vals[k]).join(", ")}`);
}

// ---------- steps ----------

async function teammates(): Promise<any[]> {
  return arr(await api("GET", "/v1/teammates"), "teammates", "items", "data", "content");
}

async function findWorkspace() {
  if (WS) return console.log(`1. workspace ${WS} (from .env)`);
  const list = await teammates();
  WS = list.find((t) => t.workspace_id)?.workspace_id ?? "";
  if (!WS) {
    const usage = await raw("GET", "/v1/usage");
    WS = usage.json?.workspace_id ?? arr(usage.json, "allocations", "items").find((a) => a.workspace_id)?.workspace_id ?? "";
  }
  if (!WS) {
    console.error("1. ✗ Could not discover the workspace id. Copy it from the Chord app (Admin → Workspace) into .env as CHORD_WORKSPACE_ID and re-run.");
    process.exit(1);
  }
  console.log(`1. workspace ${WS}`);
}

async function findOrCreateTeammate() {
  const list = await teammates();
  const found = TM ? list.find((t) => t.id === TM) : list.find((t) => t.email === TEAMMATE_EMAIL || t.display_name === "Ibinabo Desk");
  if (found) {
    TM = found.id;
    return console.log(`2. teammate ${TM} (${found.display_name ?? found.email}, ${found.status ?? found.lifecycle_state ?? "?"})`);
  }
  if (TM) return console.log(`2. teammate ${TM} (from .env)`);
  const created = await api("POST", "/v1/teammates", {
    email: TEAMMATE_EMAIL,
    workspace_id: WS,
    display_name: "Ibinabo Desk",
    first_name: "Ibinabo",
    last_name: "Desk",
    role: "customer_support",
    autonomy: "collaborative",
    escalation_policy: "escalate_to_human",
    persona:
      "You are the WhatsApp desk for Ibinabo Distribution Ltd, an FMCG distributor at Mile 1 Market, Port Harcourt. Follow the published skills. All numbers come from tools; never calculate money yourself.",
    creation_request_id: `ibinabo-desk-${WS}`,
  });
  TM = created.id;
  console.log(`2. teammate created ${TM}`);
}

async function syncSkills() {
  let set = await api("GET", `/v1/teammates/${TM}/skills`);
  if (set.enabled === false) {
    console.log("3. enabling skills runtime for this teammate");
    set = await api("POST", `/v1/teammates/${TM}/skills/migrate`, {});
  }
  const existing = arr(set, "skills");
  const dir = path.join(process.cwd(), "skills");
  for (const name of (await fs.readdir(dir)).sort()) {
    const content = await fs.readFile(path.join(dir, name, "SKILL.md"), "utf8").catch(() => null);
    if (!content) continue;
    const files = [{ path: "SKILL.md", content, media_type: "text/markdown" }];
    const key = `${name}-${Date.now()}`;
    const found = existing.find((s) => s.name === name);
    if (found && found.published?.files?.[0]?.content === content) {
      console.log(`3. skill ${name}: already published and unchanged (v${found.published_version})`);
      await include(found);
      continue;
    }
    const draft = found
      ? await api("PUT", `/v1/teammates/${TM}/skills/${found.id}/draft`, { name, entrypoint: "SKILL.md", files, expected_version: found.version, idempotency_key: key })
      : await api("POST", `/v1/teammates/${TM}/skills`, { name, entrypoint: "SKILL.md", files, idempotency_key: key });
    const id = draft.id ?? found?.id;
    const version = draft.version ?? draft.draft?.version;
    const pub = await api("POST", `/v1/teammates/${TM}/skills/${id}/publish`, { expected_version: version, idempotency_key: `pub-${key}`, summary: "Sync from repo" });
    console.log(`3. skill ${name}: published v${pub.published_version ?? pub.version ?? "?"}`);
    await include(pub);
  }
}

async function include(skill: any) {
  if (skill.included !== false) return;
  await api("PATCH", `/v1/teammates/${TM}/skills/${skill.id}`, { included: true, expected_version: skill.version, idempotency_key: `inc-${skill.id}-${Date.now()}` });
  console.log(`   included ${skill.name}`);
}

async function check() {
  const tools = arr(await api("POST", `/v1/workspaces/${WS}/mcp-servers/${MCP}/tools`), "tools", "items", "data");
  console.log(`   tools (${tools.length}): ${tools.map((t: any) => t.name).join(", ")}`);
  const health = await api("POST", `/v1/workspaces/${WS}/mcp-servers/${MCP}/health`);
  console.log(`   health: ${health.status}${health.latency_ms ? ` ${health.latency_ms}ms` : ""}${health.error ? ` — ${health.error}` : ""}`);
  if (health.status !== "ok") console.log("   ⚠ health not ok even if HTTP 200 — check the URL, MCP_BEARER_TOKEN in Vercel, and Vercel logs");
}

async function registerMcp() {
  if (!process.env.PUBLIC_URL) return console.log("4. skipped MCP registration: set PUBLIC_URL (the Vercel URL) and re-run");
  if (!process.env.MCP_BEARER_TOKEN) return console.log("4. skipped: MCP_BEARER_TOKEN is empty");
  const url = `${process.env.PUBLIC_URL.replace(/\/$/, "")}/mcp`;
  const body = { name: MCP_NAME, url, auth_type: "bearer", auth_token: process.env.MCP_BEARER_TOKEN, transport: "streamable_http", enabled: true };
  if (!MCP) {
    const list = arr(await api("GET", `/v1/workspaces/${WS}/mcp-servers`), "servers", "items", "data", "mcp_servers");
    MCP = list.find((s) => s.name === MCP_NAME || s.url === url)?.id ?? "";
  }
  if (MCP) {
    await api("PUT", `/v1/workspaces/${WS}/mcp-servers/${MCP}`, body);
    console.log(`4. MCP server ${MCP} updated → ${url}`);
  } else {
    MCP = (await api("POST", `/v1/workspaces/${WS}/mcp-servers`, body)).id;
    console.log(`4. MCP server ${MCP} created → ${url}`);
  }
  await api("PUT", `/v1/teammates/${TM}`, { add_mcp_server_ids: [MCP] });
  console.log(`   attached to teammate ${TM}`);
  await check();
}

async function activate() {
  const r = await raw("POST", `/v1/teammates/${TM}/lifecycle`, { action: "activate" });
  if (r.ok) return console.log("5. teammate activated");
  const r2 = await raw("POST", `/v1/teammates/${TM}/lifecycle`, { action: "resume" });
  console.log(r2.ok ? "5. teammate resumed" : `5. activate → ${r.status} (probably already active): ${JSON.stringify(r.json).slice(0, 160)}`);
}

async function chat(phone: string, session: string, text: string) {
  const t0 = Date.now();
  const r = await api("POST", "/v1/external-chat/messages", { workspace_id: WS, teammate_id: TM || undefined, sender_id: phone, session_id: session, display_name: phone, text });
  console.log(`[${Date.now() - t0}ms] thread ${r.thread_id}`);
  for (const s of r.steps ?? []) console.log(`  · ${s.tool_name ?? s.title} ${s.success === false ? "✗" : "✓"} ${s.latency_ms ?? ""}ms ${String(s.instruction ?? "").slice(0, 160)}`);
  console.log(`\n${r.reply ?? `(no reply: ${r.reason})`}\n`);
}

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
if (!KEY) {
  console.error("Set CHORD_API_KEY in .env first (Chord app → API keys).");
  process.exit(1);
}
switch (cmd) {
  case "setup":
    await findWorkspace();
    await findOrCreateTeammate();
    await saveEnv({ CHORD_WORKSPACE_ID: WS, CHORD_TEAMMATE_ID: TM });
    await syncSkills();
    await registerMcp();
    await activate();
    await saveEnv({ CHORD_WORKSPACE_ID: WS, CHORD_TEAMMATE_ID: TM, CHORD_MCP_SERVER_ID: MCP });
    console.log("\nDone. Next: in the Chord app enable Connected Apps → Allow Approved Apps and create a simulator chat link.");
    break;
  case "ids":
    for (const t of await teammates()) console.log(`CHORD_TEAMMATE_ID=${t.id}   # ${t.display_name ?? t.email ?? ""}\nCHORD_WORKSPACE_ID=${t.workspace_id ?? "?"}\n`);
    break;
  case "skills":
    await findWorkspace();
    await findOrCreateTeammate();
    await syncSkills();
    break;
  case "register":
    await findWorkspace();
    await findOrCreateTeammate();
    await registerMcp();
    await saveEnv({ CHORD_MCP_SERVER_ID: MCP });
    break;
  case "check":
    await check();
    break;
  case "chat":
    await chat(rest[0], rest[1], rest.slice(2).join(" "));
    break;
  case "get":
    console.log(JSON.stringify(await api("GET", rest[0]), null, 2));
    break;
  default:
    console.log("usage: setup | ids | skills | register | check | chat <phone> <session> <text> | get <path>");
}
