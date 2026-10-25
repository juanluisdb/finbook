import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { InstrumentSchema } from "@finbook/core";
import {
  CoinGeckoSource,
  type CoinGeckoGateway,
  type CoinGeckoHistoryPoint,
  type PriceNeed,
} from "../src/index.js";

const instrument = InstrumentSchema.parse({
  id: "COIN",
  name: "Example coin",
  type: "crypto",
  quoteCurrency: "EUR",
});
const need: PriceNeed = { instrument, identifier: "bitcoin", asOf: "2026-03-03" };
const point = { timestamp: Date.parse("2026-03-03T00:00:00Z"), price: 60000 };
function source(snapshot: CoinGeckoHistoryPoint | undefined = point) {
  const calls: string[][] = [];
  const gateway: CoinGeckoGateway = {
    snapshotFor(id, currency, asOf) {
      calls.push([id, currency, asOf]);
      return Promise.resolve(snapshot);
    },
    historyFor() {
      return Promise.resolve([{ timestamp: Date.parse("2026-03-02T12:00:00Z"), price: 59000 }]);
    },
  };
  return {
    provider: new CoinGeckoSource({ gateway, now: () => new Date("2026-03-03T06:00:00Z") }),
    calls,
  };
}

describe("CoinGecko daily prices", () => {
  it("uses the dated snapshot endpoint through the official SDK", async () => {
    const requests: string[] = [];
    const provider = new CoinGeckoSource({
      demoApiKey: "fixture-key",
      fetchImplementation: async (input) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return Response.json({
          id: "bitcoin",
          market_data: { current_price: { eur: 60000.1234 } },
        });
      },
      now: () => new Date("2026-03-03T06:00:00Z"),
    });
    expect(await provider.fetchPrices([need])).toMatchObject([
      {
        ok: true,
        data: {
          price: { amount: "60000.1234", currency: "EUR" },
          asOf: "2026-03-03",
        },
      },
    ]);
    const url = new URL(requests[0] ?? "");
    expect(url.pathname).toBe("/api/v3/coins/bitcoin/history");
    expect(url.searchParams.get("date")).toBe("2026-03-03");
    expect(url.searchParams.get("localization")).toBe("false");
  });

  it("requests exact midnight snapshots in the instrument quote currency", async () => {
    const { provider, calls } = source();
    expect(
      await provider.fetchPrices([
        { ...need, instrument: { ...instrument, quoteCurrency: "USD" } },
      ]),
    ).toMatchObject([
      { ok: true, data: { asOf: "2026-03-03", price: { amount: "60000", currency: "USD" } } },
    ]);
    expect(calls).toEqual([["bitcoin", "usd", "2026-03-03"]]);
  });

  it.each(["2026-03-02T00:00:00Z", "2026-03-03T00:01:00Z", "2026-03-04T00:00:00Z"])(
    "rejects a snapshot at %s instead of the requested midnight",
    async (timestamp) => {
      expect(
        await source({ timestamp: Date.parse(timestamp), price: 60000 }).provider.fetchPrices([
          need,
        ]),
      ).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
    },
  );

  it("uses the same daily snapshot contract for bound crypto cash", async () => {
    const { provider, calls } = source();
    expect(
      await provider.fetchFxRates([{ currency: "BTC", identifier: "bitcoin", asOf: "2026-03-03" }]),
    ).toMatchObject([{ ok: true, data: { pair: "BTC/EUR", rate: "60000", asOf: "2026-03-03" } }]);
    expect(calls).toEqual([["bitcoin", "eur", "2026-03-03"]]);
    expect(await provider.fetchFxRates([{ currency: "BTC", asOf: "2026-03-03" }])).toMatchObject([
      { ok: false, error: { kind: "unsupported" } },
    ]);
  });

  it("keeps event historical rates separate from daily valuation snapshots", async () => {
    const { provider, calls } = source();
    expect(
      await provider.fetchHistoricalEurRates([
        { currency: "BTC", date: "2026-03-02", identifier: "bitcoin" },
      ]),
    ).toMatchObject([{ ok: true, data: { rate: "59000", effectiveDate: "2026-03-02" } }]);
    expect(calls).toEqual([]);
    expect(
      await provider.fetchHistoricalEurRates([{ currency: "BTC", date: "2026-03-02" }]),
    ).toMatchObject([{ ok: false, error: { kind: "unsupported" } }]);
  });

  it("retains the captured market-chart boundary for event rates", async () => {
    const body = readFileSync(
      resolve(import.meta.dirname, "fixtures/coingecko-market-chart.json"),
      "utf8",
    );
    const provider = new CoinGeckoSource({
      demoApiKey: "fixture-key",
      fetchImplementation: async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    });
    expect(
      await provider.fetchHistoricalEurRates([
        { currency: "BTC", date: "2026-03-02", identifier: "bitcoin" },
      ]),
    ).toMatchObject([{ ok: true, data: { rate: "59000.5", effectiveDate: "2026-03-02" } }]);
  });

  it("rejects malformed and wrong-coin snapshots", async () => {
    const provider = new CoinGeckoSource({
      demoApiKey: "fixture-key",
      fetchImplementation: async () =>
        Response.json({ id: "wrong-coin", market_data: { current_price: { eur: 1 } } }),
    });
    expect(await provider.fetchPrices([need])).toMatchObject([
      { ok: false, error: { kind: "invalid-response" } },
    ]);
  });

  it.each([
    [401, "unauthorized"],
    [404, "not-found"],
    [429, "rate-limited"],
    [503, "unavailable"],
  ] as const)("normalizes HTTP %s", async (status, kind) => {
    const provider = new CoinGeckoSource({
      demoApiKey: "fixture-key",
      fetchImplementation: async () => new Response("fixture failure", { status }),
    });
    expect(await provider.fetchPrices([need])).toMatchObject([{ ok: false, error: { kind } }]);
  });
});
