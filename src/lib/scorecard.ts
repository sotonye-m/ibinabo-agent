/**
 * Retailer scorecard (SPEC §7). Pure functions over a Db snapshot.
 */
import { formatKobo, roundTo5k } from "./money.js";
import { invoicePaidAt, isOpen, promiseStatus, summarise } from "./ledger.js";
import type { Db, Invoice, Retailer, ScorecardRow, Tier } from "./types.js";

const DAY = 86_400_000;

export type Flag = "over_limit" | "overdue_>7d" | "broke_promise" | "no_reorder_21d" | "slow_seller" | "disputed_invoice";

/** Order used to pick the "top flag" (most serious first). */
export const FLAG_PRIORITY: Flag[] = [
  "over_limit",
  "broke_promise",
  "overdue_>7d",
  "disputed_invoice",
  "no_reorder_21d",
  "slow_seller",
];

export interface RetailerScore {
  retailer_id: string;
  name: string;
  shop_name: string;
  tier: Tier;
  balance_due_kobo: number;
  disputed_kobo: number;
  credit_kobo: number;
  credit_limit_kobo: number;
  cash_return_rate_30d: number | null;
  avg_days_to_pay: number | null;
  sell_through_units_per_day: number | null;
  sell_through_source: "reported" | "inferred" | "none";
  promise_reliability: number | null;
  broken_promises_30d: number;
  max_overdue_days: number;
  days_since_last_order: number | null;
  flags: Flag[];
  flag_labels: string[];
  top_flag: Flag | null;
  suggested_limit_kobo: number;
  recommendation: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const days = (a: number, b: number) => (b - a) / DAY;

function items(inv: Invoice): { sku: string; qty: number }[] {
  try {
    const a = JSON.parse(inv.items_json || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function cashReturnRate(db: Db, retailerId: string, now: Date, windowDays = 30): number | null {
  const start = now.getTime() - windowDays * DAY;
  const goods = db.Invoices.filter((i) => i.retailer_id === retailerId && Date.parse(i.issued_at) >= start).reduce(
    (s, i) => s + i.amount_kobo,
    0,
  );
  if (goods <= 0) return null;
  const cash = db.Payments.filter((p) => p.retailer_id === retailerId && Date.parse(p.paid_at) >= start).reduce(
    (s, p) => s + p.amount_kobo,
    0,
  );
  return r2(Math.min(1, cash / goods));
}

export function avgDaysToPay(db: Db, retailerId: string, now: Date): number | null {
  const t = now.getTime();
  const start = t - 60 * DAY;
  const samples: number[] = [];
  for (const inv of db.Invoices) {
    if (inv.retailer_id !== retailerId) continue;
    const issued = Date.parse(inv.issued_at);
    if (inv.status === "paid") {
      const paidAt = invoicePaidAt(inv, db.Payments);
      if (paidAt && Date.parse(paidAt) >= start) samples.push(days(issued, Date.parse(paidAt)));
    } else if (isOpen(inv) && t > Date.parse(inv.due_at)) {
      samples.push(days(issued, t));
    }
  }
  if (!samples.length) return null;
  return r1(samples.reduce((s, x) => s + x, 0) / samples.length);
}

export function sellThrough(
  db: Db,
  retailerId: string,
  now: Date,
): { rate: number | null; source: "reported" | "inferred" | "none" } {
  const start = now.getTime() - 60 * DAY;
  const invs = db.Invoices.filter((i) => i.retailer_id === retailerId && i.status !== "disputed");

  // Reported: consecutive stock checks per SKU.
  const bySku = new Map<string, { units_left: number; t: number }[]>();
  for (const c of db.StockChecks) {
    if (c.retailer_id !== retailerId) continue;
    const arr = bySku.get(c.sku) ?? [];
    arr.push({ units_left: c.units_left, t: Date.parse(c.checked_at) });
    bySku.set(c.sku, arr);
  }
  let reportedTotal = 0;
  let reportedAny = false;
  for (const [sku, checks] of bySku) {
    checks.sort((a, b) => a.t - b.t);
    let used = 0;
    let span = 0;
    for (let k = 1; k < checks.length; k++) {
      const prev = checks[k - 1];
      const cur = checks[k];
      if (cur.t < start || cur.t <= prev.t) continue;
      const received = invs
        .filter((i) => {
          const it = Date.parse(i.issued_at);
          return it > prev.t && it <= cur.t;
        })
        .flatMap(items)
        .filter((x) => x.sku === sku)
        .reduce((s, x) => s + x.qty, 0);
      used += Math.max(0, prev.units_left + received - cur.units_left);
      span += days(prev.t, cur.t);
    }
    if (span > 0) {
      reportedTotal += used / span;
      reportedAny = true;
    }
  }
  if (reportedAny) return { rate: r1(reportedTotal), source: "reported" };

  // Inferred: units in an order ÷ days until the next order.
  const orders = invs
    .filter((i) => Date.parse(i.issued_at) >= start)
    .sort((a, b) => a.issued_at.localeCompare(b.issued_at));
  let units = 0;
  let span = 0;
  for (let k = 0; k + 1 < orders.length; k++) {
    const gap = days(Date.parse(orders[k].issued_at), Date.parse(orders[k + 1].issued_at));
    if (gap <= 0) continue;
    units += items(orders[k]).reduce((s, x) => s + x.qty, 0);
    span += gap;
  }
  if (span > 0) return { rate: r1(units / span), source: "inferred" };
  return { rate: null, source: "none" };
}

export function promiseStats(db: Db, retailerId: string, now: Date) {
  const t = now.getTime();
  let kept = 0;
  let broken = 0;
  let broken30 = 0;
  for (const p of db.Promises) {
    if (p.retailer_id !== retailerId) continue;
    const created = Date.parse(p.created_at);
    if (created < t - 60 * DAY) continue;
    const st = promiseStatus(p, db.Payments, now);
    if (st === "kept") kept++;
    if (st === "broken") {
      broken++;
      if (Date.parse(p.due_at) >= t - 30 * DAY) broken30++;
    }
  }
  return { reliability: kept + broken ? r2(kept / (kept + broken)) : null, broken30 };
}

export function tierFor(s: {
  cash_return_rate_30d: number | null;
  avg_days_to_pay: number | null;
  promise_reliability: number | null;
  flags: Flag[];
}): Tier {
  const f = new Set(s.flags);
  if (
    (s.cash_return_rate_30d !== null && s.cash_return_rate_30d < 0.6) ||
    (s.avg_days_to_pay !== null && s.avg_days_to_pay > 21) ||
    f.has("over_limit") ||
    (s.promise_reliability !== null && s.promise_reliability < 0.5)
  )
    return "C";
  if (
    s.cash_return_rate_30d !== null &&
    s.cash_return_rate_30d >= 0.85 &&
    s.avg_days_to_pay !== null &&
    s.avg_days_to_pay <= 10 &&
    !f.has("broke_promise") &&
    !f.has("over_limit")
  )
    return "A";
  return "B";
}

/** Largest invoice that was fully paid on or before its due date. */
export function largestClearedOnTime(db: Db, retailerId: string): number {
  let max = 0;
  for (const inv of db.Invoices) {
    if (inv.retailer_id !== retailerId || inv.status !== "paid") continue;
    const paidAt = invoicePaidAt(inv, db.Payments);
    if (paidAt && paidAt <= inv.due_at) max = Math.max(max, inv.amount_kobo);
  }
  return max;
}

export function suggestedLimit(tier: Tier, limit: number, largestOnTime: number): number {
  if (tier === "A") {
    if (largestOnTime <= 0) return limit;
    return Math.max(limit, roundTo5k(Math.min(limit * 1.25, 2 * largestOnTime)));
  }
  if (tier === "C") return roundTo5k(limit * 0.5);
  return limit;
}

function quartile1(values: number[]): number | null {
  if (values.length < 4) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * 0.25)];
}

function labelFor(flag: Flag, s: Omit<RetailerScore, "flag_labels" | "recommendation" | "top_flag">): string {
  switch (flag) {
    case "over_limit":
      return "over credit limit";
    case "broke_promise":
      return s.broken_promises_30d === 1 ? "broke 1 promise" : `broke ${s.broken_promises_30d} promises`;
    case "overdue_>7d":
      return `invoice overdue ${Math.floor(s.max_overdue_days)} days`;
    case "disputed_invoice":
      return "has a disputed invoice";
    case "no_reorder_21d":
      return `no reorder in ${Math.floor(s.days_since_last_order ?? 0)} days`;
    case "slow_seller":
      return "slow seller";
  }
}

export function recommendationFor(s: Omit<RetailerScore, "recommendation">): string {
  const reasons = s.flag_labels.slice(0, 2);
  if (s.avg_days_to_pay !== null && s.avg_days_to_pay > 10) reasons.push(`${Math.round(s.avg_days_to_pay)} days to pay`);
  const why = reasons.length ? ` — ${reasons.join(", ")}.` : ".";
  if (s.tier === "C") {
    const toClear = Math.max(0, s.balance_due_kobo + s.disputed_kobo - s.suggested_limit_kobo);
    const clear = toClear > 0 ? ` until ${formatKobo(toClear)} is cleared (balance below ${formatKobo(s.suggested_limit_kobo)})` : "";
    return `Pause new credit for ${s.name}${clear}; suggested limit ${formatKobo(s.suggested_limit_kobo)}${why}`;
  }
  if (s.tier === "A" && s.suggested_limit_kobo > s.credit_limit_kobo) {
    const cr = s.cash_return_rate_30d !== null ? `returns ${Math.round(s.cash_return_rate_30d * 100)}% of goods value` : "";
    const dp = s.avg_days_to_pay !== null ? `pays in ${Math.round(s.avg_days_to_pay)} days` : "";
    const good = [cr, dp].filter(Boolean).join(", ");
    return `Consider raising ${s.name}'s limit from ${formatKobo(s.credit_limit_kobo)} to ${formatKobo(s.suggested_limit_kobo)}${good ? ` — ${good}.` : "."}`;
  }
  if (s.flags.length) return `Watch ${s.name}; keep limit at ${formatKobo(s.credit_limit_kobo)}${why}`;
  return `Keep ${s.name} at ${formatKobo(s.credit_limit_kobo)} — steady payer.`;
}

/** Compute scores for every retailer (slow_seller needs the whole portfolio). */
export function computeScores(db: Db, now: Date): RetailerScore[] {
  const t = now.getTime();
  const base = db.Retailers.map((r: Retailer) => {
    const bal = summarise(db.Invoices, db.Payments, r.retailer_id);
    const st = sellThrough(db, r.retailer_id, now);
    const ps = promiseStats(db, r.retailer_id, now);
    const mine = db.Invoices.filter((i) => i.retailer_id === r.retailer_id);
    const lastOrder = mine.reduce((m, i) => Math.max(m, Date.parse(i.issued_at)), 0);
    const maxOverdue = mine
      .filter((i) => isOpen(i) && t > Date.parse(i.due_at))
      .reduce((m, i) => Math.max(m, days(Date.parse(i.due_at), t)), 0);
    return {
      r,
      bal,
      st,
      ps,
      lastOrderDays: lastOrder ? days(lastOrder, t) : null,
      maxOverdue,
      hasDispute: mine.some((i) => i.status === "disputed"),
    };
  });
  const q1 = quartile1(base.map((b) => b.st.rate).filter((x): x is number => x !== null));

  return base.map(({ r, bal, st, ps, lastOrderDays, maxOverdue, hasDispute }) => {
    const flags: Flag[] = [];
    if (bal.balance_due_kobo + bal.disputed_kobo > r.credit_limit_kobo) flags.push("over_limit");
    if (maxOverdue > 7) flags.push("overdue_>7d");
    if (ps.broken30 > 0) flags.push("broke_promise");
    if (lastOrderDays === null || lastOrderDays > 21) flags.push("no_reorder_21d");
    if (q1 !== null && st.rate !== null && st.rate <= q1) flags.push("slow_seller");
    if (hasDispute) flags.push("disputed_invoice");
    flags.sort((a, b) => FLAG_PRIORITY.indexOf(a) - FLAG_PRIORITY.indexOf(b));

    const cash = cashReturnRate(db, r.retailer_id, now);
    const avg = avgDaysToPay(db, r.retailer_id, now);
    const tier = tierFor({ cash_return_rate_30d: cash, avg_days_to_pay: avg, promise_reliability: ps.reliability, flags });
    const partial = {
      retailer_id: r.retailer_id,
      name: r.name,
      shop_name: r.shop_name,
      tier,
      balance_due_kobo: bal.balance_due_kobo,
      disputed_kobo: bal.disputed_kobo,
      credit_kobo: bal.credit_kobo,
      credit_limit_kobo: r.credit_limit_kobo,
      cash_return_rate_30d: cash,
      avg_days_to_pay: avg,
      sell_through_units_per_day: st.rate,
      sell_through_source: st.source,
      promise_reliability: ps.reliability,
      broken_promises_30d: ps.broken30,
      max_overdue_days: maxOverdue,
      days_since_last_order: lastOrderDays === null ? null : r1(lastOrderDays),
      flags,
      suggested_limit_kobo: suggestedLimit(tier, r.credit_limit_kobo, largestClearedOnTime(db, r.retailer_id)),
    };
    const flag_labels = flags.map((f) => labelFor(f, partial));
    const withLabels = { ...partial, flag_labels, top_flag: flags[0] ?? null };
    return { ...withLabels, recommendation: recommendationFor(withLabels) };
  });
}

/** Severity used to rank lagging traders (higher = worse). */
export function severity(s: RetailerScore): number {
  const tierW = s.tier === "C" ? 1000 : s.tier === "B" ? 0 : -1000;
  const flagW = s.flags.reduce((w, f) => w + (FLAG_PRIORITY.length - FLAG_PRIORITY.indexOf(f)) * 10, 0);
  return tierW + flagW + (s.avg_days_to_pay ?? 0);
}

export function isLagging(s: RetailerScore): boolean {
  return (
    s.tier === "C" ||
    s.flags.some((f) => f === "over_limit" || f === "broke_promise" || f === "overdue_>7d" || f === "no_reorder_21d")
  );
}

export function toRow(s: RetailerScore, now: Date): ScorecardRow {
  return {
    retailer_id: s.retailer_id,
    name: s.name,
    tier: s.tier,
    balance_kobo: s.balance_due_kobo,
    credit_limit_kobo: s.credit_limit_kobo,
    cash_return_rate_30d: s.cash_return_rate_30d ?? "",
    avg_days_to_pay: s.avg_days_to_pay ?? "",
    sell_through_units_per_day: s.sell_through_units_per_day ?? "",
    sell_through_source: s.sell_through_source,
    promise_reliability: s.promise_reliability ?? "",
    flags: s.flags.join(", "),
    suggested_limit_kobo: s.suggested_limit_kobo,
    recommendation: s.recommendation,
    updated_at: now.toISOString(),
  };
}
