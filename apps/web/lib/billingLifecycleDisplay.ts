import type { BillingInvoiceItem } from "./repositories/billingRepository.js";

/**
 * Phase 6C: pure display-derivation helpers for the Billing page. "Overdue"
 * is deliberately never stored as a DB invoice_status value -- it is a
 * UI-only label derived from the invoice's own real status (pending) plus
 * its due_date, compared against the company's own local calendar date
 * (never server/UTC "today", which could differ by up to a day depending on
 * the company's timezone). due_date and paid_date are plain SQL `date`
 * columns (no time component), so a plain string comparison against another
 * YYYY-MM-DD string is exact. Kept dependency-free (no session/Supabase
 * imports) so it can be unit-tested directly without mocking the rest of
 * the server-component import graph.
 */

export function localDateString(timezone: string | null | undefined): string {
  return toLocalDateString(new Date(), timezone);
}

export function toLocalDateString(value: Date, timezone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? "UTC" }).format(value);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(value);
  }
}

export function invoiceDisplayStatus(invoice: BillingInvoiceItem, localToday: string): string {
  if (invoice.status === "pending" && invoice.dueDate && invoice.dueDate < localToday)
    return "overdue";
  return invoice.status;
}

export function daysBetween(fromDateString: string, toDateString: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (new Date(`${toDateString}T00:00:00Z`).getTime() -
      new Date(`${fromDateString}T00:00:00Z`).getTime()) /
      msPerDay,
  );
}
