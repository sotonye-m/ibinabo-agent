/**
 * npm run smoke [-- <base_url>] — calls the MCP endpoint like Chord would and walks the demo flow.
 * Locally: DB_BACKEND=file + PAYSTACK_SECRET_KEY=sk_test_mock… so the webhook step can be signed here.
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sign } from "../src/lib/paystack.js";

const base = process.argv[2] ?? "http://localhost:3000";
const token = process.env.MCP_BEARER_TOKEN!;
const TOBI = "08030000001";
const OWNER = (process.env.OWNER_PHONES ?? "").split(",")[0];

const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  const out = JSON.parse(r.content[0].text);
  console.log(`\n▶ ${name} ${JSON.stringify(args)}\n  ${JSON.stringify(out).slice(0, 700)}`);
  return out;
};

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const acct = await call("get_account", { phone: TOBI });
const order = await call("place_reorder", { phone: TOBI, items: [{ name: "Indomie", qty: 5 }, { name: "peak milk", qty: 2 }] });
if (order.status !== "over_limit") throw new Error("expected over_limit");
const pd = await call("get_payment_details", { phone: TOBI, amount_naira: order.unlock_amount_kobo / 100 });
await call("check_payments", { phone: TOBI });

if (process.env.PAYSTACK_SECRET_KEY?.startsWith("sk_test_mock")) {
  const body = JSON.stringify({ event: "charge.success", data: { reference: pd.reference, amount: pd.amount_kobo, paid_at: new Date().toISOString(), channel: "bank_transfer", metadata: { retailer_id: acct.customer_id }, customer: { email: "r001@ibinabo.test" } } });
  for (const label of ["first", "duplicate"]) {
    const res = await fetch(`${base}/webhooks/paystack`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": sign(body) }, body });
    console.log(`\n▶ webhook (${label}) → ${res.status} ${await res.text()}`);
  }
  const bad = await fetch(`${base}/webhooks/paystack`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": "nope" }, body });
  console.log(`▶ webhook (bad signature) → ${bad.status}`);
  const paid = await call("check_payments", { phone: TOBI });
  if (paid.status !== "paid") throw new Error("expected paid");
  await call("check_payments", { phone: TOBI });
  const again = await call("place_reorder", { phone: TOBI, items: [{ name: "Indomie", qty: 5 }, { name: "peak milk", qty: 2 }] });
  if (again.status !== "approved") throw new Error("expected approved");
}

await call("place_reorder", { phone: TOBI, items: [{ name: "kings oil", qty: 50 }] });
await call("place_reorder", { phone: TOBI, items: [{ name: "garri", qty: 1 }] });
await call("record_promise", { phone: TOBI, amount_naira: 40000, due_date: new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10) });
await call("record_promise", { phone: TOBI, amount_naira: 40000, due_date: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) });
await call("record_stock_check", { phone: TOBI, name: "indomie", units_left: 3 });
await call("escalate_to_owner", { phone: TOBI, reason: "discount_request", summary: "Asked to remove ₦10,000 from balance." });
await call("get_account", { phone: "08099999999" });
await call("get_portfolio_report", { phone: TOBI, period: "7d" });
await call("get_portfolio_report", { phone: OWNER, period: "7d" });
await call("get_retailer_scorecard", { phone: OWNER, retailer: "iya basira" });
await call("get_warehouse_stock", { phone: OWNER });
await call("update_credit_limit", { phone: OWNER, retailer: "Iya Basira", new_limit_naira: 100000 });
await call("update_credit_limit", { phone: OWNER, retailer: "Iya Basira", new_limit_naira: 100000, approved_by: "owner" });
await client.close();
console.log("\nsmoke OK");
