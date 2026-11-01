import { expect, it, vi } from "vitest";
import { InstrumentSchema } from "@finbook/core";
import { YahooSource, type YahooGateway } from "../src/index.js";

it("gets multiple Yahoo fund observations in one chart request using exchange dates", async () => {
  const chart = vi.fn().mockResolvedValue({
    currency: "EUR",
    timeZone: "Pacific/Auckland",
    quotes: [
      { date: new Date("2024-09-01T21:00:00Z"), close: 40 },
      { date: new Date("2024-09-02T21:00:00Z"), close: 41 },
      { date: new Date("2024-09-05T21:00:00Z"), close: 42 },
      { date: new Date("2024-09-08T21:00:00Z"), close: 99 },
    ],
  });
  const source = new YahooSource({ gateway: { chart } });
  const instrument = InstrumentSchema.parse({
    id: "fund",
    name: "Fund",
    type: "fund",
    quoteCurrency: "EUR",
  });
  expect(
    await source.fetchPriceHistory({
      instrument,
      identifier: "FUND.F",
      from: "2024-09-02",
      through: "2024-09-08",
    }),
  ).toMatchObject({
    ok: true,
    data: [
      { asOf: "2024-09-02", price: { amount: "40" } },
      { asOf: "2024-09-03", price: { amount: "41" } },
      { asOf: "2024-09-06", price: { amount: "42" } },
    ],
  });
  expect(chart).toHaveBeenCalledExactlyOnceWith("FUND.F", {
    from: "1970-01-01T00:00:00.000Z",
    to: "2024-09-10T00:00:00.000Z",
  });
  expect(
    await source.fetchPriceHistory({
      instrument: { ...instrument, type: "stock" },
      identifier: "SPLIT",
      from: "2024-09-02",
      through: "2024-09-08",
    }),
  ).toMatchObject({ ok: false, error: { kind: "unsupported" } });
  expect(chart).toHaveBeenCalledOnce();
});

it("rejects mismatched Yahoo currencies and invalid closes, and keeps empty history distinct from transport failure", async () => {
  const instrument = InstrumentSchema.parse({
    id: "fund",
    name: "Fund",
    type: "fund",
    quoteCurrency: "EUR",
  });
  const chart = vi.fn<YahooGateway["chart"]>();
  const source = new YahooSource({ gateway: { chart } });
  const need = { instrument, identifier: "FUND.F", from: "2026-03-01", through: "2026-03-03" };
  chart.mockResolvedValueOnce({ currency: "USD", timeZone: "UTC", quotes: [] });
  expect(await source.fetchPriceHistory(need)).toMatchObject({
    ok: false,
    error: { kind: "invalid-response" },
  });
  chart.mockResolvedValueOnce({
    currency: "EUR",
    timeZone: "UTC",
    quotes: [{ date: new Date("2026-03-02T00:00:00Z"), close: -9 }],
  });
  expect(await source.fetchPriceHistory(need)).toMatchObject({
    ok: false,
    error: { kind: "invalid-response" },
  });
  chart.mockResolvedValueOnce({ currency: "EUR", timeZone: "UTC", quotes: [] });
  expect(await source.fetchPriceHistory(need)).toEqual({ ok: true, data: [] });
  chart.mockRejectedValueOnce(new Error("private transport details"));
  expect(await source.fetchPriceHistory(need)).toEqual({
    ok: false,
    error: { kind: "unavailable", message: "Yahoo historical price request failed." },
  });
});
