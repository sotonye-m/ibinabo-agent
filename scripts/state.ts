/** npm run state [-- R001] — print one trader's live scorecard, non-seed payments, key invoices, stock. */
import "dotenv/config";
import { loadDb } from "../src/lib/sheets.js";
const db = await loadDb();
const id = process.argv[2] ?? "R001";
const r = db.Scorecard.find((s) => s.retailer_id === id)!;
console.log("Scorecard R001:", r.tier, r.balance_kobo / 100, r.credit_limit_kobo / 100, r.flags, r.updated_at);
console.log("Payments:", JSON.stringify(db.Payments.filter((p) => p.retailer_id === id && p.source !== "seed").map((p) => ({ ref: p.reference, amt: p.amount_kobo / 100, src: p.source, ch: p.channel, alloc: p.allocations_json, reported: p.reported_at }))));
console.log("Requests:", JSON.stringify(db.PaymentRequests.map((p) => ({ ref: p.reference, amt: p.amount_kobo / 100, st: p.status }))));
console.log("Invoices:", JSON.stringify(db.Invoices.filter((i) => ["INV-0007", "INV-0056"].includes(i.invoice_id)).map((i) => ({ id: i.invoice_id, amt: i.amount_kobo / 100, paid: i.paid_kobo / 100, st: i.status, due: i.due_at }))));
console.log("Stock:", JSON.stringify(db.Products.filter((p) => ["IND-CTN", "PEAK-CTN"].includes(p.sku)).map((p) => ({ sku: p.sku, on_hand: p.units_on_hand }))));
