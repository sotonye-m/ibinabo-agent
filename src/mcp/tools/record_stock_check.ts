import { z } from "zod";
import { withCtx } from "../../lib/desk.js";
import { sellThrough } from "../../lib/scorecard.js";
import { defineTool, isResult, matchProduct, phone, retailerOr } from "./common.js";

export default defineTool({
  name: "record_stock_check",
  description:
    "Call when a trader says how many units of a product they have left in their shop. Records it and returns their sell-through (units sold per day) when it can be computed; unknown_product with suggestions if the product isn't recognised.",
  inputSchema: {
    phone,
    sku: z.string().optional().describe("Product SKU if known"),
    name: z.string().optional().describe("Product name as the trader said it"),
    units_left: z.coerce.number().int().min(0).describe("Units (cartons, bags, kegs, packs) left in the shop"),
  },
  handler: async (args) =>
    withCtx((ctx) => {
      const r = retailerOr(ctx, args.phone);
      if (isResult(r)) return r;
      const q = (args.sku || args.name || "").trim();
      const m = matchProduct(ctx.db.Products, q);
      if (!("product" in m)) return { status: "unknown_product", query: q, suggestions: m.suggestions };
      const at = ctx.now.toISOString();
      ctx.db.StockChecks.push({ retailer_id: r.retailer_id, sku: m.product.sku, units_left: args.units_left, checked_at: at });
      r.last_stock_check_at = at;
      ctx.touch("StockChecks", "Retailers");
      const st = sellThrough(ctx.db, r.retailer_id, ctx.now);
      return {
        status: "recorded",
        sku: m.product.sku,
        name: m.product.name,
        units_left: args.units_left,
        unit: m.product.unit,
        sell_through_units_per_day: st.rate,
        sell_through_source: st.source,
      };
    }),
});
