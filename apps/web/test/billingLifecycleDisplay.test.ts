import { describe, expect, it } from "vitest";
import {
  daysBetween,
  invoiceDisplayStatus,
  toLocalDateString,
} from "../lib/billingLifecycleDisplay.js";
import type { BillingInvoiceItem } from "../lib/repositories/billingRepository.js";

function makeInvoice(overrides: Partial<BillingInvoiceItem> = {}): BillingInvoiceItem {
  return {
    id: "inv-1",
    invoiceNumber: "DRV-2026-000001",
    status: "pending",
    total: 999,
    currency: "INR",
    dueDate: "2026-08-30",
    paidDate: null,
    createdAt: "2026-08-20T00:00:00Z",
    ...overrides,
  };
}

describe("invoiceDisplayStatus", () => {
  it("labels a pending invoice as overdue once its due_date is strictly before company-local today", () => {
    expect(
      invoiceDisplayStatus(makeInvoice({ status: "pending", dueDate: "2026-08-29" }), "2026-08-30"),
    ).toBe("overdue");
  });

  it("does NOT label a pending invoice as overdue when due_date is exactly today", () => {
    expect(
      invoiceDisplayStatus(makeInvoice({ status: "pending", dueDate: "2026-08-30" }), "2026-08-30"),
    ).toBe("pending");
  });

  it("does NOT label a pending invoice as overdue when due_date is in the future", () => {
    expect(
      invoiceDisplayStatus(makeInvoice({ status: "pending", dueDate: "2026-09-01" }), "2026-08-30"),
    ).toBe("pending");
  });

  it("never labels a paid invoice as overdue, regardless of due_date", () => {
    expect(
      invoiceDisplayStatus(makeInvoice({ status: "paid", dueDate: "2026-01-01" }), "2026-08-30"),
    ).toBe("paid");
  });

  it("never labels a void/refunded invoice as overdue", () => {
    expect(
      invoiceDisplayStatus(makeInvoice({ status: "void", dueDate: "2026-01-01" }), "2026-08-30"),
    ).toBe("void");
    expect(
      invoiceDisplayStatus(
        makeInvoice({ status: "refunded", dueDate: "2026-01-01" }),
        "2026-08-30",
      ),
    ).toBe("refunded");
  });

  it("does not throw and returns the real status when due_date is null", () => {
    expect(
      invoiceDisplayStatus(makeInvoice({ status: "pending", dueDate: null }), "2026-08-30"),
    ).toBe("pending");
  });
});

describe("daysBetween", () => {
  it("computes a positive count of days into the future", () => {
    expect(daysBetween("2026-08-20", "2026-08-27")).toBe(7);
  });

  it("computes zero for the same date", () => {
    expect(daysBetween("2026-08-20", "2026-08-20")).toBe(0);
  });

  it("computes a negative count for a date in the past (already lapsed)", () => {
    expect(daysBetween("2026-08-20", "2026-08-13")).toBe(-7);
  });
});

describe("toLocalDateString", () => {
  it("respects a non-UTC timezone rather than always returning the UTC calendar date", () => {
    // 2026-01-01T02:00:00Z is still 2025-12-31 in America/New_York (UTC-5 in January).
    const value = new Date("2026-01-01T02:00:00Z");
    expect(toLocalDateString(value, "America/New_York")).toBe("2025-12-31");
    expect(toLocalDateString(value, "UTC")).toBe("2026-01-01");
  });

  it("falls back to UTC for a null/invalid timezone instead of throwing", () => {
    const value = new Date("2026-01-01T12:00:00Z");
    expect(toLocalDateString(value, null)).toBe("2026-01-01");
    expect(toLocalDateString(value, "Not/ARealTimezone")).toBe("2026-01-01");
  });
});
