import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InstrumentSchema } from "@finbook/core";
import {
  YahooSource,
  type PriceNeed,
  type YahooChart,
  type YahooChartWindow,
  type YahooGateway,
} from "../src/index.js";

const instrument = InstrumentSchema.parse({
  id: "EXAMPLE",
  name: "Example",
  type: "stock",
  quoteCurrency: "USD",
});
const quotes = z
  .array(z.object({ date: z.coerce.date(), close: z.number().nullable() }))
  .parse(
    JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/yahoo-chart.json"), "utf8")),
  );
const need: PriceNeed = { instrument, identifier: instrument.id, asOf: "2026-03-03" };

function setup(chart: YahooChart = { currency: "USD", timeZone: "America/New_York", quotes }) {
  const calls: Array<{ symbol: string; window: YahooChartWindow }> = [];
  const gateway: YahooGateway = {
    chart(symbol, window) {
      calls.push({ symbol, window });
      return Promise.resolve(chart);
    },
  };
  return {
    source: new YahooSource({ gateway, now: () => new Date("2026-03-04T06:00:00Z") }),
    calls,
  };
}

describe("Yahoo daily prices", () => {
  it("selects the newest eligible captured daily close and preserves its date", async () => {
    const { source, calls } = setup();
    expect(await source.fetchPrices([need])).toMatchObject([
      {
        ok: true,
        data: {
          price: { amount: "39.2", currency: "USD" },
          asOf: "2026-03-02",
          provenance: { source: "yahoo", retrievedAt: "2026-03-04T06:00:00.000Z" },
        },
      },
    ]);
    expect(calls).toEqual([
      {
        symbol: "EXAMPLE",
        window: { from: "2026-02-21T00:00:00.000Z", to: "2026-03-05T00:00:00.000Z" },
      },
    ]);
  });

  it("uses the exchange date when UTC and the trading date differ", async () => {
    const { source } = setup({
      currency: "USD",
      timeZone: "Pacific/Auckland",
      quotes: [
        { date: new Date("2026-03-01T21:00:00Z"), close: 12 },
        { date: new Date("2026-03-02T21:00:00Z"), close: 13 },
      ],
    });
    expect(await source.fetchPrices([{ ...need, asOf: "2026-03-02" }])).toMatchObject([
      { ok: true, data: { asOf: "2026-03-02", price: { amount: "12" } } },
    ]);
  });

  it("ignores future, null, and nonpositive closes", async () => {
    const { source } = setup({
      currency: "USD",
      timeZone: "UTC",
      quotes: [
        { date: new Date("2026-03-02T00:00:00Z"), close: 12 },
        { date: new Date("2026-03-03T00:00:00Z"), close: null },
        { date: new Date("2026-03-03T00:00:00Z"), close: 0 },
        { date: new Date("2026-03-04T00:00:00Z"), close: 999 },
      ],
    });
    expect(await source.fetchPrices([need])).toMatchObject([
      { ok: true, data: { asOf: "2026-03-02", price: { amount: "12" } } },
    ]);
  });

  it("rejects a quote currency mismatch", async () => {
    expect(
      await setup({ currency: "EUR", timeZone: "UTC", quotes }).source.fetchPrices([need]),
    ).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
  });

  it("reports an empty daily series and request failure", async () => {
    expect(
      await setup({ currency: "USD", timeZone: "UTC", quotes: [] }).source.fetchPrices([need]),
    ).toMatchObject([{ ok: false, error: { kind: "not-found" } }]);
    const source = new YahooSource({
      gateway: {
        chart() {
          return Promise.reject(new Error("fixture failure"));
        },
      },
    });
    expect(await source.fetchPrices([need])).toMatchObject([
      { ok: false, error: { kind: "unavailable" } },
    ]);
  });
});
