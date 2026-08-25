/**
 * Canonical decimal-to-smallest-currency-unit conversion for Razorpay
 * amounts (paise for INR, the only currency this platform currently issues
 * invoices in -- see companies.default_currency/plan_versions.currency,
 * both defaulting to 'INR'). Razorpay's minor-unit convention is 2 decimal
 * places for every currency it supports, so a flat x100 is correct without
 * a currency-specific lookup table.
 *
 * This is the one place this conversion exists in TypeScript -- both order
 * creation (apps/web's createPaymentOrderAction) and the SQL-side
 * verification comparison it mirrors (reconcile_razorpay_payment's
 * `round(amount * 100)`) are documented as deriving from this same rule, so
 * the rupees<->paise boundary is defined in exactly one place per language
 * rather than redefined ad hoc wherever an amount crosses into Razorpay's
 * API.
 */
export function toSmallestCurrencyUnit(decimalAmount: number): number {
  return Math.round(decimalAmount * 100);
}
