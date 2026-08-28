import { describe, expect, it } from "vitest";

import { AccountSchema, InstrumentSchema, MetaSchema, MoneySchema } from "../src/index.js";

describe("core schemas", () => {
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
