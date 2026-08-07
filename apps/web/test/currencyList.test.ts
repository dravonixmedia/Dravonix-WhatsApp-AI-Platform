import { describe, expect, it } from "vitest";
import {
  isSupportedCurrencyCode,
  listSupportedCurrencies,
  SUPPORTED_CURRENCIES,
} from "../lib/currencyList.js";

describe("currencyList", () => {
  it("includes at least the required minimum set of ISO 4217 codes", () => {
    const codes = SUPPORTED_CURRENCIES.map((c) => c.code);
    for (const required of [
      "INR",
      "AED",
      "USD",
      "GBP",
      "EUR",
      "CAD",
      "AUD",
      "SAR",
      "QAR",
      "OMR",
      "KWD",
      "SGD",
    ]) {
      expect(codes).toContain(required);
    }
  });

  it("stores every code as an uppercase 3-letter ISO 4217 identifier, never a symbol or country name", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(currency.code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("has no duplicate currency codes", () => {
    const codes = SUPPORTED_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("labels each currency as 'CODE — Name' so the dropdown shows a friendly, unambiguous label", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(currency.label.startsWith(`${currency.code} — `)).toBe(true);
    }
  });

  it("listSupportedCurrencies() returns the same list", () => {
    expect(listSupportedCurrencies()).toBe(SUPPORTED_CURRENCIES);
  });

  it("isSupportedCurrencyCode accepts every listed code", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(isSupportedCurrencyCode(currency.code)).toBe(true);
    }
  });

  it("isSupportedCurrencyCode rejects garbage input -- symbols, country names, made-up codes", () => {
    for (const invalid of ["ABC", "IND", "DUBAI", "$", "", "usd", "Rs."]) {
      expect(isSupportedCurrencyCode(invalid)).toBe(false);
    }
  });
});
