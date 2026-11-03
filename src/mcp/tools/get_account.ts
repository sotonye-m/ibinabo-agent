import { z } from "zod";
import { balanceOf, displayDate, itemsSummary, withCtx } from "../../lib/desk.js";
import { invoiceLeft, isOpen, promiseStatus } from "../../lib/ledger.js";
import { findRetailerByPhone, isOwner, normalisePhone } from "../../lib/identity.js";
import { formatKobo, moneyFields } from "../../lib/money.js";
import { defineTool, phone, pin } from "./common.js";

const DAY = 86_400_000;

export default defineTool({
  name: "get_account",
  description:
    "Call first in every conversation with the sender's phone number. Returns role (retailer, owner or unknown) and, for a retailer, balance due, credit, credit limit, open invoices, open promises and whether a stock check is due.",
  inputSchema: { phone, pin },
  handler: async ({ phone: p, pin: ownerPin }) =>
    withCtx((ctx) => {
      const norm = normalisePhone(p);
      if (isOwner(norm, ownerPin)) {
        return { status: "ok", role: "owner", phone: norm, name: "Mr Ibinabo Briggs", retailers: ctx.db.Retailers.length };
      }
      const r = findRetailerByPhone(ctx.db, norm);
      if (!r) return { status: "ok", role: "unknown", phone: norm, message: "Number not registered. Share no account data; escalate as new_contact." };

      const bal = balanceOf(ctx, r);
      const invoices = ctx.db.Invoices.filter((i) => i.retailer_id === r.retailer_id && (isOpen(i) || i.status === "disputed"))
        .sort((a, b) => a.issued_at.localeCompare(b.issued_at));
      const promises = ctx.db.Promises.filter((x) => x.retailer_id === r.retailer_id).map((x) => ({
        ...x,
        status: promiseStatus(x, ctx.db.Payments, ctx.now),
      }));
      const brokeRecent = promises.some((x) => x.status === "broken" && Date.parse(x.due_at) >= ctx.now.getTime() - 30 * DAY);
      const lastCheck = r.last_stock_check_at ? Date.parse(r.last_stock_check_at) : 0;
      const score = ctx.score(r.retailer_id);
      return {
        status: "ok",
        role: "retailer",
        customer_id: r.retailer_id,
        name: r.name,
        shop_name: r.shop_name,
        phone: norm,
        tier: score?.tier ?? r.tier,
        ...moneyFields("balance_due", bal.balance_due_kobo),
        ...moneyFields("disputed", bal.disputed_kobo),
        ...moneyFields("credit", bal.credit_kobo),
        ...moneyFields("credit_limit", r.credit_limit_kobo),
        ...moneyFields("available_credit", Math.max(0, r.credit_limit_kobo - bal.balance_due_kobo - bal.disputed_kobo)),
        open_invoices: invoices.slice(0, 5).map((i) => ({
          invoice_id: i.invoice_id,
          issued_at: i.issued_at,
          issued_display: displayDate(i.issued_at),
          due_at: i.due_at,
          due_display: displayDate(i.due_at),
          overdue: ctx.now.getTime() > Date.parse(i.due_at) && i.status !== "disputed",
          items_summary: itemsSummary(i, ctx.db.Products),
          status: i.status,
          ...moneyFields("left", invoiceLeft(i)),
        })),
        open_invoice_count: invoices.length,
        open_promises: promises
          .filter((x) => x.status === "open")
          .map((x) => ({ promise_id: x.promise_id, due_at: x.due_at, due_display: displayDate(x.due_at), amount_kobo: x.amount_kobo, amount_display: formatKobo(x.amount_kobo) })),
        broke_recent_promise: brokeRecent,
        stock_check_due: !lastCheck || ctx.now.getTime() - lastCheck > 7 * DAY,
      };
    }),
});
