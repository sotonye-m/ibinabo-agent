import { z } from "zod";
import { balanceOf, displayDate, nextId, withCtx } from "../../lib/desk.js";
import { applyCreditToInvoice, creditCheck, dueDateFor } from "../../lib/ledger.js";
import { formatKobo, moneyFields } from "../../lib/money.js";
import type { Invoice, Product } from "../../lib/types.js";
import { defineTool, isResult, matchProduct, phone, retailerOr } from "./common.js";

export default defineTool({
  name: "place_reorder",
  description:
    "Call after the trader confirms the product list. Checks stock and credit limit in code and either creates the invoice (approved) or returns over_limit (with unlock_amount to pay now or max_order_value), insufficient_stock, or unknown_product with suggestions. Never approve an order yourself.",
  inputSchema: {
    phone,
    items: z
      .array(
        z.object({
          sku: z.string().optional().describe("Product SKU if known, e.g. IND-CTN"),
          name: z.string().optional().describe("Product name as the trader said it, e.g. 'Indomie' or 'Peak milk'"),
          qty: z.coerce.number().int().positive().describe("Quantity in the product's unit (carton, bag, keg, pack)"),
        }),
      )
      .min(1),
  },
  handler: async (args) =>
    withCtx((ctx) => {
      const r = retailerOr(ctx, args.phone);
      if (isResult(r)) return r;

      const lines: { product: Product; qty: number }[] = [];
      for (const it of args.items) {
        const q = (it.sku || it.name || "").trim();
        const m = matchProduct(ctx.db.Products, q);
        if (!("product" in m)) return { status: "unknown_product", query: q, suggestions: m.suggestions };
        const existing = lines.find((l) => l.product.sku === m.product.sku);
        if (existing) existing.qty += it.qty;
        else lines.push({ product: m.product, qty: it.qty });
      }
      for (const l of lines) {
        if (l.qty > l.product.units_on_hand) {
          return {
            status: "insufficient_stock",
            sku: l.product.sku,
            name: l.product.name,
            requested: l.qty,
            available_units: l.product.units_on_hand,
            unit: l.product.unit,
          };
        }
      }
      const priced = lines.map((l) => ({
        sku: l.product.sku,
        name: l.product.name,
        unit: l.product.unit,
        qty: l.qty,
        unit_price_kobo: l.product.price_kobo,
        unit_price_display: formatKobo(l.product.price_kobo),
        line_total_kobo: l.qty * l.product.price_kobo,
        line_total_display: formatKobo(l.qty * l.product.price_kobo),
      }));
      const total = priced.reduce((s, l) => s + l.line_total_kobo, 0);
      const bal = balanceOf(ctx, r);
      const cc = creditCheck({ balance_due_kobo: bal.balance_due_kobo, disputed_kobo: bal.disputed_kobo, order_total_kobo: total, credit_limit_kobo: r.credit_limit_kobo });
      if (!cc.approved) {
        return {
          status: "over_limit",
          lines: priced,
          ...moneyFields("order_total", total),
          ...moneyFields("unlock_amount", cc.unlock_amount_kobo),
          ...moneyFields("max_order_value", cc.max_order_value_kobo),
          ...moneyFields("current_balance", bal.balance_due_kobo),
          ...moneyFields("disputed", bal.disputed_kobo),
          ...moneyFields("limit", r.credit_limit_kobo),
          message: `Order would take exposure to ${formatKobo(cc.exposure_after_kobo)}, above the ${formatKobo(r.credit_limit_kobo)} limit. Pay ${formatKobo(cc.unlock_amount_kobo)} now to unlock it, or reduce the order to ${formatKobo(cc.max_order_value_kobo)}.`,
        };
      }

      const issued = ctx.now.toISOString();
      let inv: Invoice = {
        invoice_id: nextId(ctx.db.Invoices.map((i) => i.invoice_id), "INV-"),
        retailer_id: r.retailer_id,
        issued_at: issued,
        due_at: dueDateFor(ctx.score(r.retailer_id)?.tier ?? r.tier, issued),
        items_json: JSON.stringify(priced.map((l) => ({ sku: l.sku, qty: l.qty, unit_price_kobo: l.unit_price_kobo }))),
        amount_kobo: total,
        paid_kobo: 0,
        status: "open",
        disputed_reason: "",
      };
      const credit = applyCreditToInvoice(inv, ctx.db.Payments, issued);
      inv = credit.invoice;
      ctx.db.Payments = credit.payments;
      ctx.db.Invoices.push(inv);
      for (const l of lines) l.product.units_on_hand -= l.qty;
      ctx.touch("Invoices", "Payments", "Products");
      const after = balanceOf(ctx, r);
      return {
        status: "approved",
        invoice_id: inv.invoice_id,
        lines: priced,
        ...moneyFields("total", total),
        ...moneyFields("credit_applied", credit.applied_kobo),
        due_at: inv.due_at,
        due_display: displayDate(inv.due_at),
        ...moneyFields("new_balance", after.balance_due_kobo),
        ...moneyFields("available_credit", Math.max(0, r.credit_limit_kobo - after.balance_due_kobo - after.disputed_kobo)),
        note: "Delivery is arranged by the warehouse.",
      };
    }),
});
