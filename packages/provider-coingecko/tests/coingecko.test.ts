import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { InstrumentSchema } from "@finbook/core";
import { CoinGeckoSource, type CoinGeckoGateway } from "../src/index.js";

const instrument = InstrumentSchema.parse({
  id: "BTC",
  name: "Bitcoin",
  type: "crypto",
  quoteCurrency: "EUR",
});
const need = {
  instrument,
  identifier: "bitcoin",
  from: "2026-10-20",
  through: "2026-10-22",
  sourceFrom: "2026-10-20",
};
const now = () => new Date("2026-10-31T12:00:00Z");

it("maps captured public midnight rows to the preceding day through the official SDK without credentials", async () => {
  const requests: Request[] = [];
  const provider = new CoinGeckoSource({
    now,
    fetchImplementation: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        readFileSync(
          resolve(import.meta.dirname, "fixtures/coingecko-bitcoin-eur-daily.json"),
          "utf8",
        ),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  expect(await provider.fetchPriceHistory(need)).toMatchObject({
    ok: true,
    data: [
      { asOf: "2026-10-20", price: { amount: "73884.45739183653", currency: "EUR" } },
      { asOf: "2026-10-21", price: { amount: "74846.24990354716", currency: "EUR" } },
      { asOf: "2026-10-22", price: { amount: "72477.33832576385", currency: "EUR" } },
    ],
  });
  const request = requests[0];
  if (request === undefined) throw new Error("Expected SDK request");
  const url = new URL(request.url);
  expect(url.pathname).toBe("/api/v3/coins/bitcoin/market_chart/range");
  expect(url.searchParams.get("from")).toBe("2026-10-21");
  expect(url.searchParams.get("to")).toBe("2026-10-23");
  expect(url.searchParams.get("interval")).toBe("daily");
  expect(request.headers.has("x-cg-demo-api-key")).toBe(false);
  expect(request.headers.has("x-cg-pro-api-key")).toBe(false);
});

it("requests only accessible Demo context and leaves entirely unavailable old windows empty", async () => {
  const rangeFor = vi.fn<CoinGeckoGateway["rangeFor"]>().mockResolvedValue([]);
  const provider = new CoinGeckoSource({ now, gateway: { rangeFor } });
  expect(
    await provider.fetchPriceHistory({ ...need, from: "2020-01-01", sourceFrom: "2020-01-01" }),
  ).toEqual({ ok: true, data: [] });
  expect(rangeFor).toHaveBeenCalledExactlyOnceWith("bitcoin", "eur", "2025-11-01", "2026-10-23");
  expect(
    await provider.fetchPriceHistory({
      ...need,
      from: "2020-01-01",
      through: "2020-01-03",
      sourceFrom: "2020-01-01",
    }),
  ).toEqual({ ok: true, data: [] });
  expect(rangeFor).toHaveBeenCalledOnce();
});

it("uses closing dates for bound crypto cash and keeps historical event-rate dates independent", async () => {
  const rangeFor = vi.fn<CoinGeckoGateway["rangeFor"]>().mockResolvedValue([
    { timestamp: Date.parse("2026-10-21T00:00:00Z"), price: 74000 },
    { timestamp: Date.parse("2026-10-22T00:00:00Z"), price: 75000 },
  ]);
  const provider = new CoinGeckoSource({ now, gateway: { rangeFor } });
  expect(
    await provider.fetchFxHistory([
      {
        currency: "BTC",
        identifier: "bitcoin",
        from: "2026-10-20",
        through: "2026-10-21",
        sourceFrom: "2026-10-20",
      },
    ]),
  ).toMatchObject([
    {
      ok: true,
      data: [
        { asOf: "2026-10-20", pair: "BTC/EUR", rate: "74000" },
        { asOf: "2026-10-21", rate: "75000" },
      ],
    },
  ]);
  expect(
    await provider.fetchHistoricalEurRates([
      { currency: "BTC", identifier: "bitcoin", date: "2026-10-21" },
    ]),
  ).toMatchObject([{ ok: true, data: { effectiveDate: "2026-10-21", rate: "74000" } }]);
  expect(
    await provider.fetchFxHistory([{ currency: "BTC", from: "2026-10-20", through: "2026-10-21" }]),
  ).toMatchObject([{ ok: false, error: { kind: "unsupported" } }]);
});

it("does not turn an intraday point into a daily close or retain a future closing point", async () => {
  const rangeFor = vi
    .fn<CoinGeckoGateway["rangeFor"]>()
    .mockResolvedValueOnce([{ timestamp: Date.parse("2026-10-22T12:00:00Z"), price: 70000 }])
    .mockResolvedValueOnce([{ timestamp: Date.parse("2026-10-24T00:00:00Z"), price: 71000 }]);
  const provider = new CoinGeckoSource({ now, gateway: { rangeFor } });
  expect(await provider.fetchPriceHistory(need)).toMatchObject({
    ok: false,
    error: { kind: "invalid-response" },
  });
  expect(await provider.fetchPriceHistory(need)).toEqual({ ok: true, data: [] });
});

it.each([
  [401, "unauthorized"],
  [404, "not-found"],
  [429, "rate-limited"],
  [503, "unavailable"],
] as const)("normalizes HTTP %s without exposing the credential", async (status, kind) => {
  const provider = new CoinGeckoSource({
    now,
    demoApiKey: "private-demo-key",
    fetchImplementation: async () =>
      new Response("private-demo-key", { status, headers: { "retry-after": "60" } }),
  });
  const result = await provider.fetchPriceHistory(need);
  expect(result).toMatchObject({ ok: false, error: { kind } });
  expect(JSON.stringify(result)).not.toContain("private-demo-key");
});

it("rejects malformed payloads for both valuation history and event-rate lookup", async () => {
  const provider = new CoinGeckoSource({
    now,
    fetchImplementation: async () => Response.json({ prices: [["bad-time", -4]] }),
  });
  expect(await provider.fetchPriceHistory(need)).toMatchObject({
    ok: false,
    error: { kind: "invalid-response" },
  });
  expect(
    await provider.fetchHistoricalEurRates([
      { currency: "BTC", identifier: "bitcoin", date: "2026-10-21" },
    ]),
  ).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
});

it("does not surface transport exception contents", async () => {
  const provider = new CoinGeckoSource({
    now,
    gateway: {
      rangeFor: async () => {
        throw new Error("URL carried private-demo-key");
      },
    },
  });
  const result = await provider.fetchPriceHistory(need);
  expect(result).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  expect(JSON.stringify(result)).not.toContain("private-demo-key");
});

it("keeps the captured event-rate SDK window and effective date independent of closing normalization", async () => {
  const requests: string[] = [];
  const provider = new CoinGeckoSource({
    fetchImplementation: async (input) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return new Response(
        readFileSync(resolve(import.meta.dirname, "fixtures/coingecko-market-chart.json"), "utf8"),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  expect(
    await provider.fetchHistoricalEurRates([
      { currency: "BTC", identifier: "bitcoin", date: "2026-03-02" },
    ]),
  ).toMatchObject([{ ok: true, data: { rate: "59000.5", effectiveDate: "2026-03-02" } }]);
  const url = new URL(requests[0] ?? "");
  expect(url.pathname).toBe("/api/v3/coins/bitcoin/market_chart/range");
  expect(url.searchParams.get("from")).toBe("2026-03-01");
  expect(url.searchParams.get("to")).toBe("2026-03-03");
});
