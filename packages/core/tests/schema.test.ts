import { describe, expect, it } from "vitest";

import {
  AccountSchema,
  DecimalStringSchema,
  EurRateProvenanceSchema,
  FxStampSchema,
  InstrumentSchema,
  IsoDateSchema,
  MetaSchema,
  MoneySchema,
  PriceStampSchema,
} from "../src/index.js";

describe("core schemas", () => {
  it("canonicalizes non-default positive and signed decimals", () => {
    expect(DecimalStringSchema.parse("123.4500")).toBe("123.45");
    expect(DecimalStringSchema.parse("-12.3400")).toBe("-12.34");
  });

  it("rejects impossible calendar dates and malformed UTC instants", () => {
    expect(() => IsoDateSchema.parse("2026-02-29")).toThrow(/real calendar date/u);
    expect(IsoDateSchema.parse("2024-02-29")).toBe("2024-02-29");
    expect(() =>
      EurRateProvenanceSchema.parse({
        source: "ecb",
        effectiveDate: "2026-03-02",
        retrievedAt: "2026-03-03 12:00:00Z",
      }),
    ).toThrow(/UTC ISO instant/u);
  });

  it("canonicalizes a decimal money amount without changing its type", () => {
    const money = MoneySchema.parse({ amount: "800.00", currency: "EUR" });

    expect(money).toEqual({ amount: "800", currency: "EUR" });
  });

  it("rejects a JSON number as a money amount", () => {
    expect(() => MoneySchema.parse({ amount: 800, currency: "EUR" })).toThrow();
  });

  it("rejects exponent notation and non-canonical currencies", () => {
    expect(() => MoneySchema.parse({ amount: "8e2", currency: "EUR" })).toThrow();
    expect(() => MoneySchema.parse({ amount: "800", currency: "eur" })).toThrow();
  });

  it("requires an instrument quote currency", () => {
    expect(
      InstrumentSchema.parse({
        id: "VWCE",
        name: "Vanguard FTSE All-World",
        type: "etf",
        quoteCurrency: "EUR",
      }),
    ).toMatchObject({ id: "VWCE", quoteCurrency: "EUR" });
  });

  it("requires compact provenance on valuation stamps", () => {
    const manual = PriceStampSchema.parse({
      instrument: "VWCE",
      price: { amount: "100", currency: "EUR" },
      asOf: "2026-03-01",
      provenance: { kind: "manual" },
    });
    const fetched = FxStampSchema.parse({
      pair: "USD/EUR",
      rate: "0.9",
      asOf: "2026-03-01",
      provenance: {
        kind: "fetched",
        source: "ecb",
        retrievedAt: "2026-03-01T12:00:00.000Z",
      },
    });

    expect(manual.provenance).toEqual({ kind: "manual" });
    expect(fetched.provenance).toMatchObject({ kind: "fetched", source: "ecb" });
    expect(() =>
      PriceStampSchema.parse({
        instrument: "VWCE",
        price: { amount: "100", currency: "EUR" },
        asOf: "2026-03-01",
      }),
    ).toThrow();
    expect(() =>
      FxStampSchema.parse({
        pair: "USD/EUR",
        rate: "0.9",
        asOf: "2026-03-01",
        provenance: { kind: "fetched", source: "ecb" },
      }),
    ).toThrow();
  });

  it("parses config and meta values at the boundary", () => {
    expect(
      AccountSchema.parse({
        id: "ib",
        name: "Interactive Brokers",
        platform: "interactive-brokers",
        country: "IE",
        custodial: "broker",
      }),
    ).toMatchObject({ id: "ib", country: "IE" });
    expect(MetaSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
  });
});
