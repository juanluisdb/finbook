import { expect, it, vi } from "vitest";
import { InstrumentSchema } from "@finbook/core";
import { EcbSource, EodhdSource, YahooSource } from "../src/index.js";

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

it("distinguishes a valid empty EODHD window from unavailable or malformed history", async () => {
  const request = {
    instrument: InstrumentSchema.parse({
      id: "apple",
      name: "Apple",
      type: "stock",
      quoteCurrency: "USD",
    }),
    identifier: "AAPL.US",
    from: "2024-09-07",
    sourceFrom: "2024-09-07",
    through: "2024-09-08",
  };
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
    .mockResolvedValueOnce(Response.json([{ date: "2024-09-07", close: -10 }]));
  const source = new EodhdSource({ apiKey: "fixture", fetchImplementation });
  expect(await source.fetchPriceHistory(request)).toEqual({ ok: true, data: [] });
  expect(await source.fetchPriceHistory(request)).toMatchObject({
    ok: false,
    error: { kind: "not-found", status: 404 },
  });
  expect(await source.fetchPriceHistory(request)).toMatchObject({
    ok: false,
    error: { kind: "invalid-response" },
  });
  expect(fetchImplementation).toHaveBeenCalledTimes(3);
  const url = fetchImplementation.mock.calls[0]?.[0];
  if (!(url instanceof URL)) throw new Error("Expected a URL");
  expect(url.searchParams.get("from")).toBe("2024-09-07");
  expect(url.searchParams.get("to")).toBe("2024-09-08");
});

it("gets Friday context for a weekend, inverts native ECB rates and batches currencies", async () => {
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        '<gesmes:Envelope><Cube><Cube time="2024-09-06"><Cube currency="USD" rate="1.25"/><Cube currency="GBP" rate="0.8"/></Cube><Cube time="2024-09-09"><Cube currency="USD" rate="2"/></Cube></Cube></gesmes:Envelope>',
      ),
    );
  const source = new EcbSource({ fetchImplementation });
  expect(
    await source.fetchFxHistory([
      { currency: "USD", from: "2024-09-07", through: "2024-09-08" },
      { currency: "GBP", from: "2024-09-07", through: "2024-09-08" },
    ]),
  ).toMatchObject([
    { ok: true, data: [{ asOf: "2024-09-06", pair: "USD/EUR", rate: "0.8" }] },
    { ok: true, data: [{ asOf: "2024-09-06", pair: "GBP/EUR", rate: "1.25" }] },
  ]);
  expect(fetchImplementation).toHaveBeenCalledOnce();
});
