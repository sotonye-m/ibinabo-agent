/**
 * npm run seed — wipe and seed the Google Sheet (or data/db.json with DB_BACKEND=file).
 * Deterministic: fixed RNG seed; dates are relative to "now" so the history is always 8 weeks old.
 */
import "dotenv/config";
import { Ctx } from "../src/lib/desk.js";
import { applyPayment } from "../src/lib/ledger.js";
import { nairaToKobo } from "../src/lib/money.js";
import { emptyDb, replaceAll, sheetId, sheets } from "../src/lib/sheets.js";
import type { Db, Invoice, Product, Retailer, Tier } from "../src/lib/types.js";

const DAY = 86_400_000;
const NOW = new Date();
const at = (dayOffset: number, hour = 9) => {
  const d = new Date(NOW.getTime() + dayOffset * DAY);
  d.setUTCHours(hour - 1, 0, 0, 0); // Lagos = UTC+1
  return d.toISOString();
};

// mulberry32
let seed = 20261104;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const PRODUCTS: Product[] = [
  { sku: "IND-CTN", name: "Indomie Chicken noodles", unit: "carton", price_kobo: nairaToKobo(13_500), units_on_hand: 180, reorder_point: 40 },
  { sku: "PEAK-CTN", name: "Peak milk", unit: "carton", price_kobo: nairaToKobo(28_000), units_on_hand: 90, reorder_point: 20 },
  { sku: "GP-SPAG", name: "Golden Penny spaghetti", unit: "carton", price_kobo: nairaToKobo(16_500), units_on_hand: 120, reorder_point: 25 },
  { sku: "SUGAR-50", name: "Dangote sugar 50kg", unit: "bag", price_kobo: nairaToKobo(72_000), units_on_hand: 40, reorder_point: 10 },
  { sku: "RICE-50", name: "Rice 50kg", unit: "bag", price_kobo: nairaToKobo(78_000), units_on_hand: 35, reorder_point: 10 },
  { sku: "OIL-25L", name: "Kings vegetable oil 25L", unit: "keg", price_kobo: nairaToKobo(62_000), units_on_hand: 12, reorder_point: 15 },
  { sku: "COKE-PK", name: "Coca-Cola 50cl", unit: "pack", price_kobo: nairaToKobo(4_800), units_on_hand: 200, reorder_point: 50 },
  { sku: "EVA-PK", name: "Eva water 75cl", unit: "pack", price_kobo: nairaToKobo(3_600), units_on_hand: 30, reorder_point: 40 },
];

interface Profile {
  id: string;
  name: string;
  shop: string;
  market: string;
  limit: number; // naira
  tier: Tier;
  orderEvery: [number, number];
  payAfter: [number, number];
  partPay?: boolean;
  basket: [string, number, number][]; // sku, min, max
  stockChecks?: boolean;
  lastOrderDay?: number; // stop ordering after this day offset
  brokenPromise?: { created: number; due: number; amount: number };
  keptPromise?: { created: number; due: number; amount: number };
  dispute?: boolean;
}

const PROFILES: Profile[] = [
  { id: "R001", name: "Mama Tobi", shop: "Mama Tobi Provisions", market: "Mile 1 Market", limit: 400_000, tier: "B", orderEvery: [6, 8], payAfter: [9, 12], basket: [["IND-CTN", 3, 5], ["PEAK-CTN", 1, 2], ["GP-SPAG", 1, 3]], stockChecks: true },
  { id: "R002", name: "Iya Basira", shop: "Iya Basira Stores", market: "Mile 1 Market", limit: 250_000, tier: "C", orderEvery: [9, 11], payAfter: [22, 30], basket: [["RICE-50", 1, 1], ["IND-CTN", 2, 4], ["OIL-25L", 0, 1]], brokenPromise: { created: -16, due: -9, amount: 60_000 } },
  { id: "R003", name: "Emeka Okafor", shop: "Emeka & Sons", market: "Rumuola", limit: 600_000, tier: "A", orderEvery: [6, 7], payAfter: [5, 8], basket: [["IND-CTN", 4, 6], ["PEAK-CTN", 2, 3], ["SUGAR-50", 0, 1]], stockChecks: true },
  { id: "R004", name: "Blessing Nwosu", shop: "Blessing Mini-Mart", market: "D-Line", limit: 300_000, tier: "A", orderEvery: [6, 8], payAfter: [5, 7], basket: [["COKE-PK", 10, 15], ["EVA-PK", 8, 12], ["IND-CTN", 3, 5]], stockChecks: true },
  { id: "R005", name: "Alhaji Musa", shop: "Alhaji Musa Ventures", market: "Mile 1 Market", limit: 700_000, tier: "B", orderEvery: [8, 10], payAfter: [11, 15], partPay: true, basket: [["RICE-50", 1, 2], ["SUGAR-50", 1, 1], ["OIL-25L", 0, 1]], keptPromise: { created: -10, due: -3, amount: 50_000 } },
  { id: "R006", name: "Ngozi Eze", shop: "Ngozi Supermarket", market: "Diobu", limit: 350_000, tier: "B", orderEvery: [7, 9], payAfter: [10, 14], basket: [["PEAK-CTN", 2, 4], ["GP-SPAG", 3, 5], ["COKE-PK", 5, 10]], dispute: true },
  { id: "R007", name: "Tamuno George", shop: "Tamuno Enterprises", market: "Rumuola", limit: 200_000, tier: "C", orderEvery: [10, 12], payAfter: [24, 30], basket: [["IND-CTN", 3, 5], ["GP-SPAG", 2, 3], ["EVA-PK", 4, 6]], lastOrderDay: -24, brokenPromise: { created: -14, due: -7, amount: 40_000 } },
  { id: "R008", name: "Chief Dokubo", shop: "Chief Dokubo Stores", market: "D-Line", limit: 500_000, tier: "B", orderEvery: [8, 10], payAfter: [12, 16], partPay: true, basket: [["IND-CTN", 3, 6], ["SUGAR-50", 1, 1], ["COKE-PK", 5, 8]] },
];

function build(): Db {
  const db = emptyDb();
  db.Products = PRODUCTS.map((p) => ({ ...p }));
  const price = new Map(PRODUCTS.map((p) => [p.sku, p.price_kobo]));

  db.Retailers = PROFILES.map((p, i) => ({
    retailer_id: p.id,
    name: p.name,
    shop_name: p.shop,
    phone: `+2348030000${String(i + 1).padStart(3, "0")}`,
    market: p.market,
    credit_limit_kobo: nairaToKobo(p.limit),
    tier: p.tier,
    dva_bank: "",
    dva_account_number: "",
    paystack_customer_code: "",
    email: `${p.id.toLowerCase()}@ibinabo.test`,
    last_stock_check_at: "",
  }));

  type Ev = { t: string; kind: "order"; inv: Invoice } | { t: string; kind: "pay"; rid: string; amount: number; ref: string };
  const events: Ev[] = [];
  let invN = 0;
  let payN = 0;

  for (const p of PROFILES) {
    let day = -56 + between(0, 3);
    const stop = p.lastOrderDay ?? -1;
    while (day <= stop) {
      const items = p.basket
        .map(([sku, a, b]) => ({ sku, qty: between(a, b), unit_price_kobo: price.get(sku)! }))
        .filter((x) => x.qty > 0);
      const amount = items.reduce((s, x) => s + x.qty * x.unit_price_kobo, 0);
      const issued = at(day, between(8, 12));
      const termDays = p.tier === "A" ? 14 : p.tier === "B" ? 10 : 7;
      const inv: Invoice = {
        invoice_id: `INV-${String(++invN).padStart(4, "0")}`,
        retailer_id: p.id,
        issued_at: issued,
        due_at: new Date(Date.parse(issued) + termDays * DAY).toISOString(),
        items_json: JSON.stringify(items),
        amount_kobo: amount,
        paid_kobo: 0,
        status: "open",
        disputed_reason: "",
      };
      events.push({ t: issued, kind: "order", inv });

      const payDay = day + between(...p.payAfter);
      const pays: [number, number][] =
        p.partPay && rand() < 0.6
          ? [[payDay - 4, Math.round(amount * 0.5)], [payDay + 1, amount - Math.round(amount * 0.5)]]
          : [[payDay, amount]];
      for (let [d, amt] of pays) {
        // Broken promise: no money arrives inside the promise window.
        const bp = p.brokenPromise;
        if (bp && d >= bp.created && d <= bp.due) d = bp.due + 2;
        if (d < 0) events.push({ t: at(d, between(10, 18)), kind: "pay", rid: p.id, amount: amt, ref: `SEED-${p.id}-${String(++payN).padStart(3, "0")}` });
      }
      day += between(...p.orderEvery);
    }
    if (p.keptPromise) {
      const k = p.keptPromise;
      events.push({ t: at(k.due - 1, 15), kind: "pay", rid: p.id, amount: nairaToKobo(k.amount), ref: `SEED-${p.id}-${String(++payN).padStart(3, "0")}` });
    }
  }

  events.sort((a, b) => a.t.localeCompare(b.t));
  for (const e of events) {
    if (e.kind === "order") db.Invoices.push(e.inv);
    else {
      const res = applyPayment({ invoices: db.Invoices, payments: db.Payments }, {
        reference: e.ref, retailer_id: e.rid, amount_kobo: e.amount, paid_at: e.t, channel: "bank_transfer", source: "seed",
      });
      db.Invoices = res.invoices;
      db.Payments = res.payments.map((x) => (x.reference === e.ref ? { ...x, reported_at: e.t } : x));
    }
  }

  // Promises.
  let pN = 0;
  for (const p of PROFILES) {
    for (const pr of [p.brokenPromise, p.keptPromise]) {
      if (!pr) continue;
      db.Promises.push({ promise_id: `P-${String(++pN).padStart(4, "0")}`, retailer_id: p.id, amount_kobo: nairaToKobo(pr.amount), due_at: at(pr.due, 23), created_at: at(pr.created, 11), status: "open" });
    }
  }

  // Dispute on Ngozi's most recent unpaid invoice.
  const ngozi = db.Invoices.filter((i) => i.retailer_id === "R006" && i.status !== "paid").sort((a, b) => a.issued_at.localeCompare(b.issued_at));
  const disputed = ngozi[ngozi.length - 1];
  if (disputed) {
    disputed.status = "disputed";
    disputed.disputed_reason = "Received 2 cartons Peak milk, invoice says 3.";
    db.Escalations.push({ ticket_id: "T-0001", retailer_id: "R006", phone: db.Retailers[5].phone, reason: "dispute", summary: `Ngozi says ${disputed.invoice_id} is wrong: received 2 cartons Peak milk, invoiced 3.`, invoice_id: disputed.invoice_id, created_at: at(-2, 14), status: "open" });
  }

  // Stock checks: simulate shop inventory for retailers who report.
  for (const p of PROFILES.filter((x) => x.stockChecks)) {
    const skus = p.basket.slice(0, 2).map((b) => b[0]);
    const rates = new Map(skus.map((s) => [s, 0.3 + rand() * (p.tier === "A" ? 1.2 : 0.5)]));
    const lastCheck = p.id === "R001" ? -9 : -2; // Mama Tobi's check-in is due (demo)
    for (const sku of skus) {
      let onHand = between(2, 5);
      let lastT = -56;
      for (let d = -42; d <= lastCheck; d += 7) {
        const received = db.Invoices.filter((i) => i.retailer_id === p.id && Date.parse(i.issued_at) > Date.parse(at(lastT)) && Date.parse(i.issued_at) <= Date.parse(at(d, 17)))
          .flatMap((i) => JSON.parse(i.items_json) as { sku: string; qty: number }[])
          .filter((x) => x.sku === sku)
          .reduce((s, x) => s + x.qty, 0);
        onHand = Math.max(0, Math.round(onHand + received - rates.get(sku)! * (d - lastT)));
        db.StockChecks.push({ retailer_id: p.id, sku, units_left: onHand, checked_at: at(d, 17) });
        lastT = d;
      }
    }
    db.Retailers.find((r) => r.retailer_id === p.id)!.last_stock_check_at = at(lastCheck, 17);
  }

  // Demo positioning: Mama Tobi sits ₦70,000 under her limit so "5 Indomie + 2 Peak" (₦123,500) is blocked.
  const ctx = new Ctx(db, NOW);
  const tobi = db.Retailers[0];
  const tobiBal = ctx.score(tobi.retailer_id)!;
  tobi.credit_limit_kobo = Math.ceil((tobiBal.balance_due_kobo + nairaToKobo(70_000)) / 500_000) * 500_000;

  const final = new Ctx(db, NOW);
  final.recompute();
  return final.db;
}

async function formatSheet() {
  if ((process.env.DB_BACKEND ?? "sheets") === "file") return;
  const api = sheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: sheetId(), fields: "sheets(properties,conditionalFormats)" });
  const byTitle = new Map((meta.data.sheets ?? []).map((s) => [s.properties?.title, s]));
  const requests: any[] = [];
  for (const s of meta.data.sheets ?? []) {
    requests.push({ updateSheetProperties: { properties: { sheetId: s.properties!.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } });
    requests.push({ repeatCell: { range: { sheetId: s.properties!.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } });
    for (let i = (s.conditionalFormats ?? []).length - 1; i >= 0; i--) requests.push({ deleteConditionalFormatRule: { sheetId: s.properties!.sheetId, index: i } });
  }
  const green = { backgroundColor: { red: 0.8, green: 0.94, blue: 0.8 } };
  const red = { backgroundColor: { red: 0.98, green: 0.8, blue: 0.8 } };
  const rule = (sid: number, col: number, value: string, format: object) => ({
    addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId: sid, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 }], booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: value }] }, format } } },
  });
  const num0 = (sid: number, col: number) => ({
    addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId: sid, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 }], booleanRule: { condition: { type: "NUMBER_EQ", values: [{ userEnteredValue: "0" }] }, format: green } } },
  });
  for (const title of ["Scorecard", "Dashboard"]) {
    const sid = byTitle.get(title)?.properties?.sheetId;
    if (sid === undefined || sid === null) continue;
    // Tier is column C (2) in both; balance is D (3).
    requests.push(rule(sid, 2, "A", green), rule(sid, 2, "C", red), num0(sid, 3));
  }
  await api.spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests } });
}

/** A human-friendly Dashboard tab: naira and % via formulas over Scorecard (updates live). */
async function writeDashboard() {
  if ((process.env.DB_BACKEND ?? "sheets") === "file") return;
  const api = sheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: sheetId() });
  if (!(meta.data.sheets ?? []).some((s) => s.properties?.title === "Dashboard")) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ addSheet: { properties: { title: "Dashboard", index: 0 } } }] } });
  }
  const col = (src: string, expr: (r: string) => string) => `=ARRAYFORMULA(IF(Scorecard!A2:A="",,${expr(`Scorecard!${src}2:${src}`)}))`;
  const naira = (r: string) => `TEXT(${r}/100,"₦#,##0")`;
  const pct = (r: string) => `IF(${r}="","—",TEXT(${r},"0%"))`;
  const header = ["Trader", "ID", "Tier", "Balance (kobo)", "Balance", "Limit", "Cash return 30d", "Days to pay", "Sell-through /day", "Promise reliability", "Flags", "Suggested limit", "Recommendation", "Updated"];
  const formulas = [
    col("B", (r) => r), col("A", (r) => r), col("C", (r) => r), col("D", (r) => r), col("D", naira), col("E", naira), col("F", pct),
    col("G", (r) => `IF(${r}="","—",${r})`), col("H", (r) => `IF(${r}="","—",${r}&" ("&Scorecard!I2:I&")")`), col("J", pct), col("K", (r) => r), col("L", naira), col("M", (r) => r), col("N", (r) => r),
  ];
  await api.spreadsheets.values.batchClear({ spreadsheetId: sheetId(), requestBody: { ranges: ["Dashboard!A:Z"] } });
  await api.spreadsheets.values.update({ spreadsheetId: sheetId(), range: "Dashboard!A1", valueInputOption: "USER_ENTERED", requestBody: { values: [header, formulas] } });
}

async function main() {
  const db = build();
  await replaceAll(db);
  await writeDashboard();
  await formatSheet();
  console.log(`Seeded ${db.Retailers.length} retailers, ${db.Invoices.length} invoices, ${db.Payments.length} payments, ${db.StockChecks.length} stock checks.`);
  for (const s of db.Scorecard) {
    console.log(`${s.retailer_id} ${s.name.padEnd(15)} tier ${s.tier}  bal ₦${(s.balance_kobo / 100).toLocaleString()}  limit ₦${(s.credit_limit_kobo / 100).toLocaleString()}  cash ${s.cash_return_rate_30d}  days ${s.avg_days_to_pay}  st ${s.sell_through_units_per_day}(${s.sell_through_source})  flags [${s.flags}]`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
