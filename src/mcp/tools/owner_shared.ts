import type { Ctx } from "../../lib/desk.js";
import { matchRetailers } from "../../lib/identity.js";
import { moneyFields } from "../../lib/money.js";
import type { RetailerScore } from "../../lib/scorecard.js";
import type { Retailer } from "../../lib/types.js";
import type { Result } from "./common.js";

export function findOne(ctx: Ctx, query: string): Retailer | Result {
  const m = matchRetailers(ctx.db, query);
  if (!m.length) return { status: "not_found", query, known: ctx.db.Retailers.map((r) => `${r.name} (${r.retailer_id})`) };
  if (m.length > 1) return { status: "ambiguous", query, matches: m.map((r) => ({ retailer_id: r.retailer_id, name: r.name, shop_name: r.shop_name })) };
  return m[0];
}

const pct = (x: number | null) => (x === null ? null : `${Math.round(x * 100)}%`);

export function scoreView(s: RetailerScore) {
  return {
    retailer_id: s.retailer_id,
    name: s.name,
    shop_name: s.shop_name,
    tier: s.tier,
    ...moneyFields("balance", s.balance_due_kobo),
    ...moneyFields("disputed", s.disputed_kobo),
    ...moneyFields("credit_limit", s.credit_limit_kobo),
    cash_return_rate_30d: s.cash_return_rate_30d,
    cash_return_rate_30d_display: pct(s.cash_return_rate_30d),
    avg_days_to_pay: s.avg_days_to_pay,
    sell_through_units_per_day: s.sell_through_units_per_day,
    sell_through_source: s.sell_through_source,
    promise_reliability: s.promise_reliability,
    promise_reliability_display: pct(s.promise_reliability),
    days_since_last_order: s.days_since_last_order,
    flags: s.flags,
    flag_labels: s.flag_labels,
    ...moneyFields("suggested_limit", s.suggested_limit_kobo),
    recommendation: s.recommendation,
  };
}
