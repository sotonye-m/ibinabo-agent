/**
 * Request context + shared operations used by MCP tools and the Paystack webhook.
 */
import { applyPayment, parseAllocations, promiseStatus, summarise, type NewPayment } from "./ledger.js";
import { formatKobo } from "./money.js";
import { computeScores, toRow, type RetailerScore } from "./scorecard.js";
import { loadDb, saveDb } from "./sheets.js";
import type { Db, Invoice, Payment, Product, Retailer, TabName } from "./types.js";

export class Ctx {
  dirty = new Set<TabName>();
  ledgerChanged = false;
  private scores: RetailerScore[] | null = null;
  constructor(public db: Db, public now: Date = new Date()) {}

  touch(...tabs: TabName[]) {
    tabs.forEach((t) => this.dirty.add(t));
    if (tabs.some((t) => t === "Invoices" || t === "Payments" || t === "Promises" || t === "StockChecks" || t === "Retailers")) {
      this.ledgerChanged = true;
      this.scores = null;
    }
  }

  allScores(): RetailerScore[] {
    if (!this.scores) this.scores = computeScores(this.db, this.now);
    return this.scores;
  }

  score(retailerId: string): RetailerScore | undefined {
    return this.allScores().find((s) => s.retailer_id === retailerId);
  }

  /** Rewrite Scorecard tab, retailer tiers and stored promise statuses from current data. */
  recompute() {
    const scores = this.allScores();
    this.db.Scorecard = scores.map((s) => toRow(s, this.now));
    for (const r of this.db.Retailers) {
      const s = scores.find((x) => x.retailer_id === r.retailer_id);
      if (s) r.tier = s.tier;
    }
    for (const p of this.db.Promises) p.status = promiseStatus(p, this.db.Payments, this.now);
    this.dirty.add("Scorecard").add("Retailers").add("Promises");
  }
}

export async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = new Ctx(await loadDb());
  const result = await fn(ctx);
  if (ctx.ledgerChanged) ctx.recompute();
  await saveDb(ctx.db, ctx.dirty);
  return result;
}

// ---------- helpers ----------

export function nextId(existing: string[], prefix: string, width = 4): string {
  let max = 0;
  for (const id of existing) {
    const m = id.match(/(\d+)$/);
    if (m && id.startsWith(prefix)) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

/** YYYY-MM-DD in Africa/Lagos (UTC+1, no DST). */
export function lagosDate(d: Date): string {
  return new Date(d.getTime() + 3_600_000).toISOString().slice(0, 10);
}

/** End of the given Lagos calendar day as an ISO timestamp (UTC). */
export function endOfLagosDay(ymd: string): string {
  return new Date(`${ymd}T23:59:59+01:00`).toISOString();
}

export function displayDate(iso: string): string {
  const d = new Date(Date.parse(iso) + 3_600_000);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function itemsSummary(inv: Invoice, products: Product[]): string {
  try {
    const items = JSON.parse(inv.items_json || "[]") as { sku: string; qty: number }[];
    return items
      .map((i) => {
        const p = products.find((x) => x.sku === i.sku);
        return `${i.qty} ${p ? p.name : i.sku}`;
      })
      .join(", ");
  } catch {
    return "";
  }
}

export function balanceOf(ctx: Ctx, r: Retailer) {
  return summarise(ctx.db.Invoices, ctx.db.Payments, r.retailer_id);
}

/** Record a confirmed Paystack payment (idempotent on reference). */
export function recordPayment(ctx: Ctx, p: NewPayment): { duplicate: boolean; payment: Payment } {
  const res = applyPayment({ invoices: ctx.db.Invoices, payments: ctx.db.Payments }, p);
  if (!res.duplicate) {
    ctx.db.Invoices = res.invoices;
    ctx.db.Payments = res.payments;
    ctx.touch("Invoices", "Payments");
  }
  const req = ctx.db.PaymentRequests.find((r) => r.reference === p.reference);
  if (req && req.status !== "paid") {
    req.status = "paid";
    ctx.touch("PaymentRequests");
  }
  return { duplicate: res.duplicate, payment: res.payment };
}

export function describePayment(p: Payment) {
  return {
    reference: p.reference,
    amount_kobo: p.amount_kobo,
    amount_display: formatKobo(p.amount_kobo),
    paid_at: p.paid_at,
    channel: p.channel,
    allocations: parseAllocations(p).map((a) => ({
      invoice_id: a.invoice_id,
      amount_kobo: a.amount_kobo,
      amount_display: formatKobo(a.amount_kobo),
    })),
    credit_kobo: p.unapplied_kobo,
    credit_display: formatKobo(p.unapplied_kobo),
  };
}
