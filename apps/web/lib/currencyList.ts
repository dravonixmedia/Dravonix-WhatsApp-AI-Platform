/**
 * Supported company currencies (ISO 4217 codes only -- never a symbol, a
 * country name, or a free-text label). Kept as a small curated list rather
 * than a full ISO 4217 table because there is no runtime-provided currency
 * catalog analogous to Intl.supportedValuesOf("timeZone") -- Postgres and
 * the JS Intl object both know currency *formatting* rules but not "the
 * list of real ISO 4217 codes", so an explicit, auditable list is the
 * correct source of truth here (mirrors update_company_currency's
 * server-side check in migration 15 -- the two lists must stay in sync).
 * Business timezone and business currency are independent settings: this
 * file has no relationship to timezoneList.ts and must never be used to
 * infer one from the other.
 */
export interface SupportedCurrency {
  code: string;
  label: string;
}

export const SUPPORTED_CURRENCIES: readonly SupportedCurrency[] = [
  { code: "INR", label: "INR — Indian Rupee" },
  { code: "AED", label: "AED — UAE Dirham" },
  { code: "USD", label: "USD — US Dollar" },
  { code: "GBP", label: "GBP — British Pound" },
  { code: "EUR", label: "EUR — Euro" },
  { code: "CAD", label: "CAD — Canadian Dollar" },
  { code: "AUD", label: "AUD — Australian Dollar" },
  { code: "SAR", label: "SAR — Saudi Riyal" },
  { code: "QAR", label: "QAR — Qatari Riyal" },
  { code: "OMR", label: "OMR — Omani Rial" },
  { code: "KWD", label: "KWD — Kuwaiti Dinar" },
  { code: "SGD", label: "SGD — Singapore Dollar" },
];

export function listSupportedCurrencies(): readonly SupportedCurrency[] {
  return SUPPORTED_CURRENCIES;
}

export function isSupportedCurrencyCode(code: string): boolean {
  return SUPPORTED_CURRENCIES.some((c) => c.code === code);
}
