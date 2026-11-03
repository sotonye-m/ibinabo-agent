import { describe, expect, it } from "vitest";
import { avgDaysToPay, cashReturnRate, computeScores, sellThrough, suggestedLimit, tierFor } from "../src/lib/scorecard.js";
import { NOW, d, db, inv, pay, retailer } from "./fixtures.js";

const alloc = (id: string, amt: number, day: number) => JSON.stringify([{ invoice_id: id, amount_kobo: amt, applied_at: d(day) }]);

describe("cashReturnRate", () => {
  it("cash in window ÷ goods issued in window, capped at 1", () => {
    const x = db({ Invoices: [inv("I1", -20, 100_000), inv("I2", -40, 999_999)], Payments: [pay("A", -10, 62_000), pay("B", -35, 50_000)] });
    expect(cashReturnRate(x, "R1", NOW)).toBe(0.62);
    const y = db({ Invoices: [inv("I1", -20, 100)], Payments: [pay("A", -10, 500)] });
    expect(cashReturnRate(y, "R1", NOW)).toBe(1);
  });
  it("null when no goods issued", () => {
    expect(cashReturnRate(db({ Payments: [pay("A", -1, 10)] }), "R1", NOW)).toBeNull();
  });
});

describe("avgDaysToPay", () => {
  it("averages paid invoices and counts overdue open ones as today − issued", () => {
    const x = db({
      Invoices: [inv("I1", -20, 100, { status: "paid", paid_kobo: 100 }), inv("I2", -30, 100)], // I2 due -20 → overdue, 30 days
      Payments: [pay("A", -14, 100, { allocations_json: alloc("I1", 100, -14) })],
    });
    expect(avgDaysToPay(x, "R1", NOW)).toBe(18); // (6 + 30) / 2
  });
  it("null with no samples", () => {
    expect(avgDaysToPay(db({ Invoices: [inv("I1", -2, 100)] }), "R1", NOW)).toBeNull();
  });
});

describe("sellThrough", () => {
  it("reported: (prev + received − now) ÷ days", () => {
    const x = db({
      Invoices: [inv("I1", -5, 100, { items_json: JSON.stringify([{ sku: "IND-CTN", qty: 10, unit_price_kobo: 10 }]) })],
      StockChecks: [
        { retailer_id: "R1", sku: "IND-CTN", units_left: 4, checked_at: d(-10) },
        { retailer_id: "R1", sku: "IND-CTN", units_left: 6, checked_at: d(0) },
      ],
    });
    expect(sellThrough(x, "R1", NOW)).toEqual({ rate: 0.8, source: "reported" }); // (4+10-6)/10
  });
  it("inferred from reorder interval when < 2 checks", () => {
    const items = (q: number) => JSON.stringify([{ sku: "IND-CTN", qty: q, unit_price_kobo: 1 }]);
    const x = db({ Invoices: [inv("I1", -20, 1, { items_json: items(10) }), inv("I2", -10, 1, { items_json: items(5) })] });
    expect(sellThrough(x, "R1", NOW)).toEqual({ rate: 1, source: "inferred" });
  });
  it("none without data", () => {
    expect(sellThrough(db({}), "R1", NOW)).toEqual({ rate: null, source: "none" });
  });
});

describe("tierFor", () => {
  const good = { cash_return_rate_30d: 0.9, avg_days_to_pay: 7, promise_reliability: 1, flags: [] as any[] };
  it("A for fast, full payers", () => expect(tierFor(good)).toBe("A"));
  it("C when over limit", () => expect(tierFor({ ...good, flags: ["over_limit"] })).toBe("C"));
  it("C when slow", () => expect(tierFor({ ...good, avg_days_to_pay: 22 })).toBe("C"));
  it("C when promises unreliable", () => expect(tierFor({ ...good, promise_reliability: 0.4 })).toBe("C"));
  it("B when broke a promise but otherwise good", () => expect(tierFor({ ...good, flags: ["broke_promise"] })).toBe("B"));
  it("B with no data", () => expect(tierFor({ cash_return_rate_30d: null, avg_days_to_pay: null, promise_reliability: null, flags: [] })).toBe("B"));
});

describe("suggestedLimit", () => {
  it("A: min(limit × 1.25, 2 × largest cleared on time), rounded to ₦5k, never below current", () => {
    expect(suggestedLimit("A", 400_000_00, 300_000_00)).toBe(500_000_00);
    expect(suggestedLimit("A", 400_000_00, 110_000_00)).toBe(400_000_00);
    expect(suggestedLimit("A", 400_000_00, 210_300_00)).toBe(420_000_00); // min(500k, 420.6k) → ₦420,000
  });
  it("B keeps current, C halves", () => {
    expect(suggestedLimit("B", 300_000_00, 0)).toBe(300_000_00);
    expect(suggestedLimit("C", 250_000_00, 0)).toBe(125_000_00);
  });
});

describe("computeScores", () => {
  it("flags over-limit traders, tiers them C and recommends a pause", () => {
    const x = db({ Retailers: [retailer("R1", 50_000_00)], Invoices: [inv("I1", -3, 60_000_00)] });
    const [s] = computeScores(x, NOW);
    expect(s.flags).toContain("over_limit");
    expect(s.tier).toBe("C");
    expect(s.suggested_limit_kobo).toBe(25_000_00);
    expect(s.recommendation).toMatch(/^Pause new credit for Trader R1 until ₦35,000 is cleared/);
  });
  it("flags no_reorder_21d and disputed_invoice", () => {
    const x = db({ Retailers: [retailer()], Invoices: [inv("I1", -30, 100, { status: "disputed" })] });
    const [s] = computeScores(x, NOW);
    expect(s.flags).toEqual(expect.arrayContaining(["no_reorder_21d", "disputed_invoice"]));
  });
});
