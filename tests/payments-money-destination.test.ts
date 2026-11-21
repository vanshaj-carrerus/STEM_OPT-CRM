import { describe, expect, it } from "vitest";
import { MoneyError, convertMinor, formatMinor, formatMinorPlain, normalizeRate, parseAmountToMinor, parseSignedAmountToMinor } from "@/lib/payments/money";
import { containsCardNumber, luhnValid, maskSensitiveNumbers, validateDestinationReference, validateProviderReference } from "@/lib/payments/destination";
import { buildPaymentFields, readinessIssues, paymentInputSchema } from "@/lib/payments/schema";

describe("money: integer minor units", () => {
  it("parses exact decimals without float error", () => {
    expect(parseAmountToMinor("1,234.56", "USD")).toBe(123456);
    expect(parseAmountToMinor("0.10", "USD")).toBe(10);
    expect(parseAmountToMinor("19.99", "USD")).toBe(1999);
    expect(parseAmountToMinor("500", "JPY")).toBe(500);
    expect(parseAmountToMinor("1.234", "KWD")).toBe(1234);
  });
  it("rejects negatives, too many decimals, junk and absurd sizes", () => {
    expect(() => parseAmountToMinor("-5", "USD")).toThrow(MoneyError);
    expect(() => parseAmountToMinor("1.005", "USD")).toThrow(/decimal/);
    expect(() => parseAmountToMinor("1e3", "USD")).toThrow(MoneyError);
    expect(() => parseAmountToMinor("12.5", "JPY")).toThrow(MoneyError);
    expect(() => parseAmountToMinor("999999999999999", "USD")).toThrow(MoneyError);
    expect(() => parseAmountToMinor("5", "usd1")).toThrow(MoneyError);
  });
  it("signed corrections", () => {
    expect(parseSignedAmountToMinor("-25.50", "USD")).toBe(-2550);
    expect(parseSignedAmountToMinor("+3", "USD")).toBe(300);
  });
  it("converts FX with integer math and half-up rounding", () => {
    expect(convertMinor(100000, "USD", "INR", "83.25")).toBe(8325000); // 1000.00 USD -> 83,250.00 INR
    expect(convertMinor(1, "USD", "INR", "0.5")).toBe(1); // 0.01 * 0.5 = 0.005 -> half-up to 0.01
    expect(convertMinor(10, "USD", "INR", "0.04")).toBe(0); // 0.1*0.04=0.0040 -> 0.00
    expect(convertMinor(10, "USD", "INR", "0.05")).toBe(1); // 0.0050 -> 0.01
    // currency exponent change: 1.00 USD (100) -> JPY 0 decimals at 150.4 = 150
    expect(convertMinor(100, "USD", "JPY", "150.4")).toBe(150);
    // 8 decimal places of rate are honoured exactly (no float drift)
    expect(convertMinor(100000000, "USD", "BTC", "0.00001234")).toBe(1234);
  });
  it("validates rates", () => {
    expect(normalizeRate("83.2500")).toBe("83.25");
    expect(() => normalizeRate("0")).toThrow(MoneyError);
    expect(() => normalizeRate("1.123456789")).toThrow(MoneyError);
    expect(() => normalizeRate("-2")).toThrow(MoneyError);
  });
  it("formats exactly", () => {
    expect(formatMinorPlain(123450, "USD")).toBe("1234.50");
    expect(formatMinorPlain(-5, "USD")).toBe("-0.05");
    expect(formatMinor(123456789, "USD")).toBe("1,234,567.89 USD");
    expect(formatMinor(500, "JPY")).toBe("500 JPY");
  });
});

describe("destination masking & card detection", () => {
  it("Luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
  it("rejects card numbers in any common formatting", () => {
    for (const c of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "card 5555555555554444 exp"]) {
      expect(containsCardNumber(c)).toBe(true);
      expect(validateDestinationReference(c).ok).toBe(false);
    }
  });
  it("masks 9+ consecutive digits (account / routing numbers) on save", () => {
    const r = validateDestinationReference("Acct 123456789012");
    expect(r.ok).toBe(true);
    expect(r.masked).toBe("Acct ****9012");
    expect(r.wasMasked).toBe(true);
    expect(validateDestinationReference("021000021").masked).toBe("****0021");
    expect(validateDestinationReference("1234 5678 9012").masked).toBe("****9012");
  });
  it("keeps already-masked or short references", () => {
    expect(validateDestinationReference("****1234")).toMatchObject({ ok: true, masked: "****1234", wasMasked: false });
    expect(validateDestinationReference("HDFC savings ending 4821").masked).toBe("HDFC savings ending 4821");
    expect(validateDestinationReference("").masked).toBe("");
  });
  it("masks IBAN-like values and never leaves 9+ digits behind", () => {
    const m = maskSensitiveNumbers("GB29NWBK60161331926819");
    expect(m).not.toMatch(/\d{9,}/);
    expect(m.endsWith("6819")).toBe(true);
  });
  it("provider references: tokens only", () => {
    expect(validateProviderReference("RIA-2026-0001").ok).toBe(true);
    expect(validateProviderReference("").ok).toBe(false);
    expect(validateProviderReference("ab").ok).toBe(false);
    expect(validateProviderReference("4111111111111111").ok).toBe(false);
    expect(validateProviderReference("has space").ok).toBe(false);
  });
});

describe("payment input → ledger fields", () => {
  const base = { candidateId: "c1", type: "ria_transfer", amount: "1000.00", currency: "usd", reason: "Payroll 1-15 Nov", recipientName: "A B", recipientDestination: "****1234" };
  it("computes the converted amount server-side with a quote timestamp", () => {
    const f = buildPaymentFields(paymentInputSchema.parse({ ...base, fxRate: "83.25", convertedCurrency: "INR", fxQuotedAt: "2026-11-20T10:00:00.000Z" }), new Date("2026-11-21T00:00:00Z"));
    expect(f.amountMinor).toBe(100000);
    expect(f.currency).toBe("USD");
    expect(f.convertedAmountMinor).toBe(8325000);
    expect(f.fxQuotedAt?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });
  it("requires quote time + destination currency when a rate is given; blocks future quotes", () => {
    expect(() => buildPaymentFields(paymentInputSchema.parse({ ...base, fxRate: "83.25" }))).toThrow(/highlighted/);
    expect(() => buildPaymentFields(paymentInputSchema.parse({ ...base, fxRate: "83.25", convertedCurrency: "INR", fxQuotedAt: "2999-01-01T00:00:00Z" }))).toThrow();
  });
  it("masks long digit runs in the destination and rejects card numbers", () => {
    expect(buildPaymentFields(paymentInputSchema.parse({ ...base, recipientDestination: "000123456789" })).recipientDestination).toBe("****6789");
    expect(() => buildPaymentFields(paymentInputSchema.parse({ ...base, recipientDestination: "4111 1111 1111 1111" }))).toThrow();
    expect(() => buildPaymentFields(paymentInputSchema.parse({ ...base, reason: "pay 4111111111111111" }))).toThrow();
  });
  it("readiness: payee + destination required for Ria/wires, amount > 0", () => {
    expect(readinessIssues({ type: "ria_transfer", amountMinor: 100, reason: "x", recipientName: "A", recipientDestination: "****1" })).toEqual([]);
    expect(readinessIssues({ type: "domestic_wire", amountMinor: 100, reason: "x", recipientName: "A" }).length).toBe(1);
    expect(readinessIssues({ type: "payroll_settlement", amountMinor: 100, reason: "x" })).toEqual([]);
    expect(readinessIssues({ type: "ria_transfer", amountMinor: 0, reason: "" }).length).toBeGreaterThan(2);
  });
});
