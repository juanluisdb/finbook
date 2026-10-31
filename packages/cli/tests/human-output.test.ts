import { describe, expect, it } from "vitest";

import { AccountSchema, InstrumentSchema, EventSchema, getGlance } from "@finbook/core";
import { renderHoles, renderGlance } from "../src/human-output.js";

describe("human output", () => {
  it("renders an exact manual and update remedy for a missing price", () => {
    const output = renderHoles(
      [
        {
          sourceId: "price:HROW",
          kind: "valuation",
          currency: "USD",
          message: "Missing HROW price.",
        },
      ],
      "2026-09-03",
    );

    expect(output).toContain("price HROW in USD as of 2026-09-03");
    expect(output).toContain(
      "finbook price set --instrument HROW --amount <decimal> --currency USD --as-of 2026-09-03",
    );
    expect(output).toContain("finbook update");
  });
});

it("puts dated evidence near the readable value and labels the contribution difference", () => {
  const glance = getGlance(
    {
      accounts: [
        AccountSchema.parse({
          id: "broker",
          name: "Broker",
          platform: "example",
          country: "ES",
          custodial: "broker",
        }),
      ],
      instruments: [
        InstrumentSchema.parse({ id: "fund", name: "Fund", type: "fund", quoteCurrency: "EUR" }),
      ],
      events: [
        EventSchema.parse({
          id: "cash",
          type: "deposit",
          date: "2026-02-20",
          source: "manual",
          account: "broker",
          amount: { amount: "2000", currency: "EUR" },
          eurPerUnit: "1",
        }),
        EventSchema.parse({
          id: "buy",
          type: "buy",
          date: "2026-02-20",
          source: "manual",
          account: "broker",
          instrument: "fund",
          qty: "20",
          price: { amount: "50", currency: "EUR" },
          grossAmount: "1000",
        }),
      ],
      prices: [
        {
          instrument: "fund",
          asOf: "2026-02-27",
          price: { amount: "55", currency: "EUR" },
          provenance: { kind: "manual" },
        },
      ],
      fx: [],
    },
    "2026-03-03",
  );
  if (!glance.ok) throw new Error(glance.error.message);
  const output = renderGlance(glance.data);
  expect(output).toContain("total: 2100.00 EUR");
  expect(output).toContain("value minus contributions: 100.00 EUR");
  expect(output).toContain("missing inputs: 0");
  expect(output.indexOf("2026-02-27")).toBeLessThan(output.indexOf("by platform"));
});
