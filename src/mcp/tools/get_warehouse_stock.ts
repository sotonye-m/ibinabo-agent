import { z } from "zod";
import { withCtx } from "../../lib/desk.js";
import { formatKobo } from "../../lib/money.js";
import { defineTool, matchProduct, ownerCheck, phone, pin } from "./common.js";

export default defineTool({
  name: "get_warehouse_stock",
  description: "Owner only. Returns warehouse stock per product (units on hand, reorder point, low flag, price). Pass sku or a product name to get one product.",
  inputSchema: { phone, pin, sku: z.string().optional().describe("SKU or product name; omit for all products") },
  handler: async (args) => {
    const denied = ownerCheck(args.phone, args.pin);
    if (denied) return denied;
    return withCtx((ctx) => {
      let list = ctx.db.Products;
      if (args.sku) {
        const m = matchProduct(list, args.sku);
        if (!("product" in m)) return { status: "unknown_product", query: args.sku, suggestions: m.suggestions };
        list = [m.product];
      }
      return {
        status: "ok",
        items: list.map((p) => ({ sku: p.sku, name: p.name, unit: p.unit, units_on_hand: p.units_on_hand, reorder_point: p.reorder_point, low: p.units_on_hand <= p.reorder_point, price_kobo: p.price_kobo, price_display: formatKobo(p.price_kobo) })),
      };
    });
  },
});
