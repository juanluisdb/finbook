import { describe, expect, it } from "vitest";

import { EventSchema } from "../src/index.js";

const base = {
  id: "event-1",
  date: "2026-03-03",
  source: "manual",
};

describe("event schemas", () => {
  it("accepts a transfer without an account field", () => {
    const event = EventSchema.parse({
      ...base,
      type: "transfer",
      from: "myinvestor",
      to: "ib",
      amount: { amount: "800.00", currency: "EUR" },
    });

    expect(event).toEqual({
      ...base,
      type: "transfer",
      from: "myinvestor",
      to: "ib",
      amount: { amount: "800", currency: "EUR" },
    });
  });

  it("rejects invalid transfer currencies and endpoints", () => {
    expect(() =>
      EventSchema.parse({
        ...base,
        type: "transfer",
        from: "myinvestor",
        to: "ib",
        amount: { amount: "800", currency: "EUR" },
        account: "ib",
      }),
    ).toThrow();

    expect(() =>
      EventSchema.parse({
        ...base,
        type: "transfer",
        from: "ib",
        to: "ib",
        amount: { amount: "800", currency: "EUR" },
      }),
    ).toThrow();
  });

  it("rejects FX with equal currencies or a third-currency fee", () => {
    const valid = {
      ...base,
      type: "fx",
      account: "ib",
      from: { amount: "798", currency: "EUR" },
      to: { amount: "927.04", currency: "USD" },
      fee: { amount: "1.71", currency: "EUR" },
    };

    expect(EventSchema.parse(valid)).toMatchObject({ type: "fx", account: "ib" });
    expect(() =>
      EventSchema.parse({
        ...valid,
        to: { amount: "927.04", currency: "EUR" },
      }),
    ).toThrow();
    expect(() =>
      EventSchema.parse({
        ...valid,
        fee: { amount: "1", currency: "GBP" },
      }),
    ).toThrow();
  });

  it("keeps a trade fee attached to the trade and in its price currency", () => {
    const buy = EventSchema.parse({
      ...base,
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "20.000",
      price: { amount: "40.45", currency: "USD" },
      fee: { amount: "0.28", currency: "USD" },
      eurPerUnit: "0.861",
    });

    expect(buy).toMatchObject({
      type: "buy",
      qty: "20",
      fee: { amount: "0.28", currency: "USD" },
    });
    expect(() =>
      EventSchema.parse({
        ...buy,
        fee: { amount: "0.28", currency: "EUR" },
      }),
    ).toThrow();
  });

  it("requires withholding to use the gross currency", () => {
    expect(
      EventSchema.parse({
        ...base,
        type: "dividend",
        account: "ib",
        instrument: "META",
        gross: { amount: "1.07", currency: "USD" },
        withholdingForeign: { amount: "0.16", currency: "USD" },
      }),
    ).toMatchObject({ type: "dividend", gross: { currency: "USD" } });

    expect(() =>
      EventSchema.parse({
        ...base,
        type: "interest",
        account: "ib",
        gross: { amount: "1.07", currency: "USD" },
        withholdingDomestic: { amount: "0.16", currency: "EUR" },
      }),
    ).toThrow();
  });
});
