import { z } from "zod";
import { withCtx } from "../../lib/desk.js";
import { moneyFields } from "../../lib/money.js";
import { isLagging, severity } from "../../lib/scorecard.js";
import { defineTool, ownerCheck, phone, pin } from "./common.js";

const DAY = 86_400_000;

export default defineTool({
  name: "get_portfolio_report",
  description:
    "Owner only. Business summary for the last 7 or 30 days: cash collected, cash outstanding, lagging traders ranked worst first (max 5) with their main flag, the top recommendation, low-stock products and open escalations.",
  inputSchema: { phone, pin, period: z.enum(["7d", "30d"]).default("7d") },
  handler: async (args) => {
    const denied = ownerCheck(args.phone, args.pin);
    if (denied) return denied;
    return withCtx((ctx) => {
      const days = args.period === "30d" ? 30 : 7;
      const since = ctx.now.getTime() - days * DAY;
      const collected = ctx.db.Payments.filter((p) => Date.parse(p.paid_at) >= since).reduce((s, p) => s + p.amount_kobo, 0);
      const scores = ctx.allScores();
      const outstanding = scores.reduce((s, x) => s + x.balance_due_kobo, 0);
      const disputed = scores.reduce((s, x) => s + x.disputed_kobo, 0);
      const lagging = scores.filter(isLagging).sort((a, b) => severity(b) - severity(a));
      const names = new Map(ctx.db.Retailers.map((r) => [r.retailer_id, r.name]));
      return {
        status: "ok",
        period: args.period,
        ...moneyFields("cash_collected", collected),
        ...moneyFields("cash_outstanding", outstanding),
        ...moneyFields("disputed", disputed),
        traders: scores.length,
        lagging_count: lagging.length,
        lagging: lagging.slice(0, 5).map((s) => ({
          retailer_id: s.retailer_id,
          name: s.name,
          tier: s.tier,
          ...moneyFields("balance", s.balance_due_kobo),
          avg_days_to_pay: s.avg_days_to_pay,
          top_flag: s.top_flag,
          top_flag_label: s.flag_labels[0] ?? null,
        })),
        top_recommendation: lagging[0]?.recommendation ?? "No trader is lagging. Keep limits as they are.",
        low_stock: ctx.db.Products.filter((p) => p.units_on_hand <= p.reorder_point).map((p) => ({ sku: p.sku, name: p.name, units_on_hand: p.units_on_hand, reorder_point: p.reorder_point, unit: p.unit })),
        open_escalations: ctx.db.Escalations.filter((e) => e.status === "open").map((e) => ({ ticket_id: e.ticket_id, name: names.get(e.retailer_id) ?? e.phone, reason: e.reason, summary: e.summary, invoice_id: e.invoice_id || null, created_at: e.created_at })),
      };
    });
  },
});
