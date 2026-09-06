import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { InstrumentSchema } from "@finbook/core";

import {
  CoinGeckoSource,
  type CoinGeckoGateway,
  type CoinGeckoHistoryPoint,
  type CoinGeckoPrice,
  type EurRateNeed,
  type FxNeed,
  type PriceNeed,
} from "../src/index.js";

const bitcoin = InstrumentSchema.parse({
  id: "BTC",
  name: "Bitcoin",
  type: "crypto",
  quoteCurrency: "EUR",
});
const ethereum = InstrumentSchema.parse({
  id: "ETH",
  name: "Ethereum",
  type: "crypto",
  quoteCurrency: "USD",
});

const fixtureDirectory = resolve(import.meta.dirname, "fixtures");
const capturedSimplePrice = readFileSync(
  resolve(fixtureDirectory, "coingecko-simple-price.json"),
  "utf8",
);
const capturedMarketChart = readFileSync(
  resolve(fixtureDirectory, "coingecko-market-chart.json"),
  "utf8",
);

function capturedResponse(body: string): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

function priceNeed(
  mode: PriceNeed["mode"],
  asOf = "2026-03-03",
  instrument = bitcoin,
  identifier = "bitcoin",
): PriceNeed {
  return { instrument, asOf, mode, identifier };
}

class FixtureGateway implements CoinGeckoGateway {
  readonly priceCalls: Array<{ ids: readonly string[]; currency: string }> = [];
  readonly historyCalls: Array<{ id: string; currency: string; asOf: string }> = [];
  readonly prices: readonly CoinGeckoPrice[];
  readonly history: readonly CoinGeckoHistoryPoint[];

  constructor(
    prices: readonly CoinGeckoPrice[] = [
      { id: "bitcoin", price: 60_000, asOf: new Date("2026-03-03T12:00:00.000Z") },
    ],
    history: readonly CoinGeckoHistoryPoint[] = [
      { timestamp: Date.parse("2026-03-01T12:00:00.000Z"), price: 58_000 },
      { timestamp: Date.parse("2026-03-02T12:00:00.000Z"), price: 59_000 },
    ],
  ) {
    this.prices = prices;
    this.history = history;
  }

  pricesFor(ids: readonly string[], currency: string): Promise<readonly CoinGeckoPrice[]> {
    this.priceCalls.push({ ids: [...ids], currency });
    return Promise.resolve(this.prices);
  }

  historyFor(
    id: string,
    currency: string,
    asOf: string,
  ): Promise<readonly CoinGeckoHistoryPoint[]> {
    this.historyCalls.push({ id, currency, asOf });
    return Promise.resolve(this.history);
  }
}

function source(gateway: CoinGeckoGateway): CoinGeckoSource {
  return new CoinGeckoSource({
    gateway,
    now: () => new Date("2026-03-03T13:00:00.000Z"),
  });
}

describe("CoinGecko source", () => {
  it("normalizes a captured CoinGecko simple-price response through the SDK gateway", async () => {
    const provider = new CoinGeckoSource({
      demoApiKey: "fixture-key",
      fetchImplementation: capturedResponse(capturedSimplePrice),
      now: () => new Date("2026-03-03T13:00:00.000Z"),
    });

    const result = await provider.fetchPrices([priceNeed("latest")]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: {
          instrument: "BTC",
          price: { amount: "60000.1234", currency: "EUR" },
          asOf: "2026-03-03",
          provenance: { kind: "fetched", source: "coingecko" },
        },
      },
    ]);
  });

  it("uses the latest need date when the provider timestamp crosses the local boundary", async () => {
    const gateway = new FixtureGateway([
      { id: "bitcoin", price: 60_000, asOf: new Date("2026-03-01T00:30:00.000Z") },
    ]);

    const provider = new CoinGeckoSource({
      gateway,
      now: () => new Date("2026-03-01T00:31:00.000Z"),
    });

    const result = await provider.fetchPrices([priceNeed("latest", "2026-02-28")]);

    expect(result).toMatchObject([{ ok: true, data: { asOf: "2026-02-28" } }]);
  });

  it.each([
    ["missing", undefined],
    ["stale", new Date("2026-03-02T12:59:59.999Z")],
  ])("rejects a %s timestamp for a latest price", async (_reason, asOf) => {
    const gateway = new FixtureGateway([{ id: "bitcoin", price: 60_000, asOf }]);

    const result = await source(gateway).fetchPrices([priceNeed("latest")]);

    expect(result).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
  });

  it("normalizes a captured CoinGecko market-chart response through the SDK gateway", async () => {
    const provider = new CoinGeckoSource({
      demoApiKey: "fixture-key",
      fetchImplementation: capturedResponse(capturedMarketChart),
      now: () => new Date("2026-03-03T13:00:00.000Z"),
    });

    const result = await provider.fetchPrices([priceNeed("historical", "2026-03-02")]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: { price: { amount: "59000.5", currency: "EUR" }, asOf: "2026-03-02" },
      },
    ]);
  });

  it("partitions current prices by quote currency", async () => {
    const gateway = new FixtureGateway([
      { id: "bitcoin", price: 60_000, asOf: new Date("2026-03-03T12:00:00.000Z") },
      { id: "ethereum", price: 3_000, asOf: new Date("2026-03-03T12:00:00.000Z") },
    ]);

    const result = await source(gateway).fetchPrices([
      priceNeed("latest"),
      priceNeed("latest", "2026-03-03", ethereum, "ethereum"),
    ]);

    expect(result).toMatchObject([
      { ok: true, data: { instrument: "BTC", price: { amount: "60000", currency: "EUR" } } },
      { ok: true, data: { instrument: "ETH", price: { amount: "3000", currency: "USD" } } },
    ]);
    expect(gateway.priceCalls).toEqual([
      { ids: ["bitcoin"], currency: "eur" },
      { ids: ["ethereum"], currency: "usd" },
    ]);
  });

  it("returns crypto FX marks for configured coin identifiers", async () => {
    const gateway = new FixtureGateway();
    const need: FxNeed = {
      currency: "BTC",
      asOf: "2026-03-03",
      mode: "latest",
      identifier: "bitcoin",
    };

    const result = await source(gateway).fetchFxRates([need]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: {
          pair: "BTC/EUR",
          rate: "60000",
          asOf: "2026-03-03",
          provenance: { kind: "fetched", source: "coingecko" },
        },
      },
    ]);
  });

  it("uses the latest FX need date when the provider timestamp crosses the local boundary", async () => {
    const gateway = new FixtureGateway([
      { id: "bitcoin", price: 60_000, asOf: new Date("2026-03-01T00:30:00.000Z") },
    ]);
    const need: FxNeed = {
      currency: "BTC",
      asOf: "2026-02-28",
      mode: "latest",
      identifier: "bitcoin",
    };

    const provider = new CoinGeckoSource({
      gateway,
      now: () => new Date("2026-03-01T00:31:00.000Z"),
    });
    const result = await provider.fetchFxRates([need]);

    expect(result).toMatchObject([{ ok: true, data: { asOf: "2026-02-28" } }]);
  });

  it("rejects a stale timestamp for a latest crypto FX rate", async () => {
    const gateway = new FixtureGateway([
      { id: "bitcoin", price: 60_000, asOf: new Date("2026-03-02T12:59:59.999Z") },
    ]);
    const need: FxNeed = {
      currency: "BTC",
      asOf: "2026-03-03",
      mode: "latest",
      identifier: "bitcoin",
    };

    const result = await source(gateway).fetchFxRates([need]);

    expect(result).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
  });

  it("uses historical EUR prices for event rates", async () => {
    const gateway = new FixtureGateway();

    const result = await source(gateway).fetchHistoricalEurRates([
      { currency: "BTC", date: "2026-03-02", identifier: "bitcoin" },
    ]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: {
          rate: "59000",
          effectiveDate: "2026-03-02",
          provenance: { kind: "fetched", source: "coingecko" },
        },
      },
    ]);
  });

  it("rejects a historical observation that is genuinely in the future", async () => {
    const gateway = new FixtureGateway(
      [],
      [{ timestamp: Date.parse("2026-03-01T00:30:00.000Z"), price: 60_000 }],
    );

    const result = await source(gateway).fetchPrices([priceNeed("historical", "2026-02-28")]);

    expect(result).toMatchObject([{ ok: false, error: { kind: "not-found" } }]);
  });

  it("requires a provider identifier for historical crypto rates", async () => {
    const result = await source(new FixtureGateway()).fetchHistoricalEurRates([
      { currency: "BTC", date: "2026-03-02" } satisfies EurRateNeed,
    ]);

    expect(result).toMatchObject([{ ok: false, error: { kind: "unsupported" } }]);
  });
});
