import { describe, expect, it } from "vitest";

import { InstrumentSchema } from "@finbook/core";

import {
  YahooSource,
  type PriceNeed,
  type YahooGateway,
  type YahooChartWindow,
  type YahooHistoryPoint,
  type YahooQuote,
} from "../src/index.js";

const stock = InstrumentSchema.parse({
  id: "HROW",
  name: "Harrow",
  type: "stock",
  quoteCurrency: "USD",
});

function need(mode: PriceNeed["mode"], asOf = "2026-03-03"): PriceNeed {
  return { instrument: stock, asOf, mode, identifier: "HROW" };
}

class FixtureGateway implements YahooGateway {
  readonly quotedSymbols: string[][] = [];
  readonly chartedSymbols: string[] = [];
  readonly chartWindows: YahooChartWindow[] = [];
  readonly quotes: readonly YahooQuote[];
  readonly history: readonly YahooHistoryPoint[];

  constructor(
    quotes: readonly YahooQuote[] = [
      {
        symbol: "HROW",
        currency: "USD",
        regularMarketPrice: 40.5,
        regularMarketTime: new Date("2026-03-03T21:00:00.000Z"),
      },
    ],
    history: readonly YahooHistoryPoint[] = [
      { date: new Date("2026-03-01T21:00:00.000Z"), close: 39 },
      { date: new Date("2026-03-02T21:00:00.000Z"), close: 39.2 },
    ],
  ) {
    this.quotes = quotes;
    this.history = history;
  }

  quote(symbols: readonly string[]): Promise<readonly YahooQuote[]> {
    this.quotedSymbols.push([...symbols]);
    return Promise.resolve(this.quotes);
  }

  chart(symbol: string, window: YahooChartWindow): Promise<readonly YahooHistoryPoint[]> {
    this.chartedSymbols.push(symbol);
    this.chartWindows.push(window);
    return Promise.resolve(this.history);
  }
}

function source(gateway: YahooGateway): YahooSource {
  return new YahooSource({
    gateway,
    now: () => new Date("2026-03-03T22:00:00.000Z"),
  });
}

describe("Yahoo source", () => {
  it("normalizes current quotes into price marks", async () => {
    const gateway = new FixtureGateway();

    const result = await source(gateway).fetchPrices([need("latest")]);

    expect(result).toMatchObject([
      {
        need: need("latest"),
        ok: true,
        data: {
          instrument: "HROW",
          price: { amount: "40.5", currency: "USD" },
          asOf: "2026-03-03",
          provenance: {
            kind: "fetched",
            source: "yahoo",
            retrievedAt: "2026-03-03T22:00:00.000Z",
          },
        },
      },
    ]);
    expect(gateway.quotedSymbols).toEqual([["HROW"]]);
  });

  it("selects the latest historical close on or before the requested date", async () => {
    const gateway = new FixtureGateway();

    const result = await source(gateway).fetchPrices([need("historical", "2026-03-02")]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: {
          price: { amount: "39.2", currency: "USD" },
          asOf: "2026-03-02",
        },
      },
    ]);
    expect(gateway.chartedSymbols).toEqual(["HROW"]);
  });

  it("searches a ten-calendar-day window for a prior close", async () => {
    const gateway = new FixtureGateway(
      [
        {
          symbol: "HROW",
          currency: "USD",
          regularMarketPrice: 40.5,
          regularMarketTime: new Date("2026-03-03T21:00:00.000Z"),
        },
      ],
      [{ date: new Date("2026-03-06T21:00:00.000Z"), close: 39.8 }],
    );

    const result = await source(gateway).fetchPrices([need("historical", "2026-03-07")]);

    expect(result).toMatchObject([
      { ok: true, data: { asOf: "2026-03-06", price: { amount: "39.8" } } },
    ]);
    expect(gateway.chartWindows).toEqual([
      { from: "2026-02-26T00:00:00.000Z", to: "2026-03-08T00:00:00.000Z" },
    ]);
  });

  it("ignores future history and reports not-found when no prior close exists", async () => {
    const gateway = new FixtureGateway(
      [],
      [{ date: new Date("2026-03-08T21:00:00.000Z"), close: 40 }],
    );

    const result = await source(gateway).fetchPrices([need("historical", "2026-03-07")]);

    expect(result).toMatchObject([{ ok: false, error: { kind: "not-found" } }]);
  });

  it("reports missing and mismatched provider data per quote", async () => {
    const missing = new FixtureGateway([
      {
        symbol: "OTHER",
        currency: "USD",
        regularMarketPrice: 40,
        regularMarketTime: new Date("2026-03-03T21:00:00.000Z"),
      },
    ]);
    const wrongCurrency = new FixtureGateway([
      {
        symbol: "HROW",
        currency: "EUR",
        regularMarketPrice: 40,
        regularMarketTime: new Date("2026-03-03T21:00:00.000Z"),
      },
    ]);

    const missingResult = await source(missing).fetchPrices([need("latest")]);
    const wrongCurrencyResult = await source(wrongCurrency).fetchPrices([need("latest")]);

    expect(missingResult).toMatchObject([{ ok: false, error: { kind: "not-found" } }]);
    expect(wrongCurrencyResult).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
  });
});
