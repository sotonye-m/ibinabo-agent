import { describe, expect, it } from "vitest";
import { applyCreditToInvoice, applyPayment, allocate, creditCheck, dueDateFor, invoicePaidAt, promiseStatus, summarise } from "../src/lib/ledger.js";
import { formatKobo } from "../src/lib/money.js";
import { normalisePhone } from "../src/lib/identity.js";
import { NOW, d, inv, pay } from "./fixtures.js";

describe("allocate", () => {
  it("pays oldest invoice first and part-pays the next", () => {
    const invoices = [inv("INV-2", -5, 50_000), inv("INV-1", -10, 30_000)];
    const r = allocate(invoices, "R1", 60_000, d(0));
    expect(r.allocations).toEqual([
      { invoice_id: "INV-1", amount_kobo: 30_000, applied_at: d(0) },
      { invoice_id: "INV-2", amount_kobo: 30_000, applied_at: d(0) },
    ]);
    expect(r.invoices.find((i) => i.invoice_id === "INV-1")!.status).toBe("paid");
    const two = r.invoices.find((i) => i.invoice_id === "INV-2")!;
    expect(two.status).toBe("part_paid");
    expect(two.paid_kobo).toBe(30_000);
    expect(r.unapplied_kobo).toBe(0);
  });

  it("skips disputed invoices and keeps leftover as unapplied credit", () => {
    const invoices = [inv("INV-1", -10, 30_000, { status: "disputed" }), inv("INV-2", -5, 20_000)];
    const r = allocate(invoices, "R1", 25_000, d(0));
    expect(r.allocations).toEqual([{ invoice_id: "INV-2", amount_kobo: 20_000, applied_at: d(0) }]);
    expect(r.unapplied_kobo).toBe(5_000);
    expect(r.invoices[0].status).toBe("disputed");
  });

  it("does not mutate inputs", () => {
    const invoices = [inv("INV-1", -10, 30_000)];
    allocate(invoices, "R1", 30_000, d(0));
    expect(invoices[0].paid_kobo).toBe(0);
  });

  it("ignores other retailers' invoices", () => {
    const invoices = [inv("INV-1", -10, 30_000, { retailer_id: "R2" })];
    expect(allocate(invoices, "R1", 10_000, d(0)).unapplied_kobo).toBe(10_000);
  });
});

describe("applyPayment", () => {
  it("is idempotent on reference", () => {
    const first = applyPayment({ invoices: [inv("INV-1", -10, 30_000)], payments: [] }, { reference: "REF1", retailer_id: "R1", amount_kobo: 30_000, paid_at: d(0), channel: "card", source: "webhook" });
    expect(first.duplicate).toBe(false);
    expect(first.invoices[0].status).toBe("paid");
    const again = applyPayment({ invoices: first.invoices, payments: first.payments }, { reference: "REF1", retailer_id: "R1", amount_kobo: 30_000, paid_at: d(0), channel: "card", source: "verify" });
    expect(again.duplicate).toBe(true);
    expect(again.payments).toHaveLength(1);
    expect(again.invoices).toBe(first.invoices);
  });

  it("starts unreported so check_payments can announce it", () => {
    const r = applyPayment({ invoices: [], payments: [] }, { reference: "R", retailer_id: "R1", amount_kobo: 100, paid_at: d(0), channel: "card", source: "webhook" });
    expect(r.payment.reported_at).toBe("");
    expect(r.payment.unapplied_kobo).toBe(100);
  });
});

describe("summarise", () => {
  it("nets credit against owed and lists disputed separately", () => {
    const invoices = [inv("INV-1", -10, 50_000, { paid_kobo: 10_000, status: "part_paid" }), inv("INV-2", -5, 20_000, { status: "disputed" }), inv("INV-3", -20, 99_000, { status: "paid", paid_kobo: 99_000 })];
    const s = summarise(invoices, [pay("P", -1, 5_000, { unapplied_kobo: 5_000 })], "R1");
    expect(s).toEqual({ owed_kobo: 40_000, disputed_kobo: 20_000, balance_due_kobo: 35_000, credit_kobo: 0 });
  });

  it("reports credit when unapplied exceeds owed", () => {
    const s = summarise([], [pay("P", -1, 5_000, { unapplied_kobo: 5_000 })], "R1");
    expect(s.balance_due_kobo).toBe(0);
    expect(s.credit_kobo).toBe(5_000);
  });
});

describe("applyCreditToInvoice", () => {
  it("auto-applies credit to a new invoice, oldest payment first", () => {
    const payments = [pay("B", -1, 8_000, { unapplied_kobo: 8_000 }), pay("A", -3, 3_000, { unapplied_kobo: 3_000 })];
    const r = applyCreditToInvoice(inv("INV-9", 0, 10_000), payments, d(0));
    expect(r.applied_kobo).toBe(10_000);
    expect(r.invoice.status).toBe("paid");
    expect(r.payments.find((p) => p.reference === "A")!.unapplied_kobo).toBe(0);
    expect(r.payments.find((p) => p.reference === "B")!.unapplied_kobo).toBe(1_000);
    expect(JSON.parse(r.payments.find((p) => p.reference === "A")!.allocations_json)).toEqual([{ invoice_id: "INV-9", amount_kobo: 3_000, applied_at: d(0) }]);
  });
});

describe("creditCheck", () => {
  it("approves when exposure is within limit (inclusive)", () => {
    expect(creditCheck({ balance_due_kobo: 60, disputed_kobo: 10, order_total_kobo: 30, credit_limit_kobo: 100 }).approved).toBe(true);
  });
  it("returns unlock amount and max order value when over", () => {
    expect(creditCheck({ balance_due_kobo: 305_500_00, disputed_kobo: 0, order_total_kobo: 123_500_00, credit_limit_kobo: 380_000_00 })).toEqual({
      approved: false, exposure_after_kobo: 429_000_00, unlock_amount_kobo: 49_000_00, max_order_value_kobo: 74_500_00,
    });
  });
  it("never returns a negative max order value", () => {
    expect(creditCheck({ balance_due_kobo: 200, disputed_kobo: 0, order_total_kobo: 1, credit_limit_kobo: 100 }).max_order_value_kobo).toBe(0);
  });
});

describe("promiseStatus", () => {
  const promise = { promise_id: "P1", retailer_id: "R1", amount_kobo: 10_000, created_at: d(-5), due_at: d(-1), status: "open" as const };
  it("kept when payments in window cover the amount", () => {
    expect(promiseStatus(promise, [pay("A", -4, 6_000), pay("B", -2, 4_000)], NOW)).toBe("kept");
  });
  it("broken when due date passed without enough", () => {
    expect(promiseStatus(promise, [pay("A", -4, 6_000), pay("B", 0, 4_000)], NOW)).toBe("broken");
  });
  it("open before due date", () => {
    expect(promiseStatus({ ...promise, due_at: d(2) }, [], NOW)).toBe("open");
  });
});

describe("misc", () => {
  it("due dates by tier", () => {
    expect(dueDateFor("A", d(0))).toBe(d(14));
    expect(dueDateFor("B", d(0))).toBe(d(10));
    expect(dueDateFor("C", d(0))).toBe(d(7));
  });
  it("invoicePaidAt uses the latest allocation", () => {
    const i = inv("INV-1", -10, 100, { status: "paid", paid_kobo: 100 });
    const ps = [pay("A", -8, 50, { allocations_json: JSON.stringify([{ invoice_id: "INV-1", amount_kobo: 50 }]) }), pay("B", -3, 50, { allocations_json: JSON.stringify([{ invoice_id: "INV-1", amount_kobo: 50, applied_at: d(-3) }]) })];
    expect(invoicePaidAt(i, ps)).toBe(d(-3));
  });
  it("formats money", () => {
    expect(formatKobo(8_450_000)).toBe("₦84,500");
    expect(formatKobo(8_450_050)).toBe("₦84,500.50");
  });
  it("normalises phones", () => {
    expect(normalisePhone("08030000001")).toBe("+2348030000001");
    expect(normalisePhone("234 803 000 0001")).toBe("+2348030000001");
    expect(normalisePhone("+234-803-000-0001")).toBe("+2348030000001");
    expect(normalisePhone("2348030000001@s.whatsapp.net")).toBe("+2348030000001");
  });
});
