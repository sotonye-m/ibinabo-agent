import { z } from "zod";
import { nextId, withCtx } from "../../lib/desk.js";
import { findRetailerByPhone, normalisePhone } from "../../lib/identity.js";
import { defineTool, phone } from "./common.js";

export const REASONS = ["dispute", "payment_not_found", "extension_request", "discount_request", "new_contact", "system_error", "other"] as const;

export default defineTool({
  name: "escalate_to_owner",
  description:
    "Log a case for the owner (dispute, payment not found, extension or discount request, new contact, system error, other). Returns a ticket_id. For a dispute with invoice_id, the invoice is marked disputed and is not chased until resolved. Call before handover_to_human.",
  inputSchema: {
    phone,
    reason: z.enum(REASONS),
    summary: z.string().describe("One line in plain words: what the person wants and any amounts, dates or names they gave."),
    invoice_id: z.string().optional().describe("Invoice the dispute is about, e.g. INV-0012"),
  },
  handler: async (args) =>
    withCtx((ctx) => {
      const norm = normalisePhone(args.phone);
      const r = findRetailerByPhone(ctx.db, norm);
      const ticket_id = nextId(ctx.db.Escalations.map((e) => e.ticket_id), "T-");
      let invoice_marked_disputed = false;
      let note: string | undefined;
      if (args.reason === "dispute" && args.invoice_id) {
        const inv = ctx.db.Invoices.find((i) => i.invoice_id.toLowerCase() === args.invoice_id!.trim().toLowerCase());
        if (!inv || !r || inv.retailer_id !== r.retailer_id) note = "Invoice not found on this trader's account; logged without marking an invoice.";
        else if (inv.status === "paid") note = "Invoice is already fully paid; logged for the owner without changing it.";
        else {
          inv.status = "disputed";
          inv.disputed_reason = args.summary;
          invoice_marked_disputed = true;
          ctx.touch("Invoices");
        }
      }
      ctx.db.Escalations.push({
        ticket_id,
        retailer_id: r?.retailer_id ?? "",
        phone: norm,
        reason: args.reason,
        summary: args.summary,
        invoice_id: args.invoice_id ?? "",
        created_at: ctx.now.toISOString(),
        status: "open",
      });
      ctx.dirty.add("Escalations");
      return { status: "escalated", ticket_id, reason: args.reason, invoice_marked_disputed, ...(note ? { note } : {}), next_step: "Tell the person the owner will follow up, then call handover_to_human if available." };
    }),
});
