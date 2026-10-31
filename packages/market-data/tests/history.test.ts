import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
  getHistory,
  type Event,
} from "@finbook/core";
import {
  MarketDataConfigSchema,
  MarketDataCoordinator,
  EodhdSource,
  EcbSource,
  type FxHistorySource,
  type PriceHistorySource,
  type PriceObservation,
  type MarketDataConfig,
  type MarketDataStore,
} from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function book() {
  const home = mkdtempSync(join(tmpdir(), "finbook-history-"));
  directories.push(home);
  const store = new FileBookStore(home);
  expect(
    store.appendAccount(
      AccountSchema.parse({
        id: "broker",
        name: "Broker",
        platform: "example",
        country: "ES",
        custodial: "broker",
      }),
    ).ok,
  ).toBe(true);
  expect(
    store.appendInstrument(
      InstrumentSchema.parse({ id: "fund", name: "Fund", type: "fund", quoteCurrency: "EUR" }),
    ).ok,
  ).toBe(true);
  return store;
}

function record(store: FileBookStore, events: readonly Event[]) {
  for (const event of events) expect(store.appendEvent(event).ok).toBe(true);
}

function position(store: FileBookStore, from: string) {
  record(store, [
    EventSchema.parse({
      id: `deposit-${from}`,
      source: "manual",
      type: "deposit",
      date: from,
      account: "broker",
      amount: { amount: "1000", currency: "EUR" },
      eurPerUnit: "1",
    }),
    EventSchema.parse({
      id: `buy-${from}`,
      source: "manual",
      type: "buy",
      date: from,
      account: "broker",
      instrument: "fund",
      qty: "20",
      price: { amount: "40", currency: "EUR" },
      grossAmount: "800",
      eurPerUnit: "1",
    }),
  ]);
}

function price(asOf: string, amount: string): PriceObservation {
  return {
    instrument: "fund",
    asOf,
    price: { amount, currency: "EUR" },
    provenance: { kind: "fetched", source: "eodhd", retrievedAt: "2024-09-10T12:00:00.000Z" },
  };
}

function coordinator(
  store: MarketDataStore,
  source: PriceHistorySource,
  now: string,
  config: MarketDataConfig = MarketDataConfigSchema.parse({
    bindings: [
      { kind: "instrument", instrument: "fund", provider: "eodhd", identifier: "FUND.EUFUND" },
    ],
  }),
) {
  return new MarketDataCoordinator({
    store,
    config,
    eurRateSources: [],
    priceHistorySources: [source],
    now: () => new Date(now),
  });
}

it("checks an empty weekend durably without inventing prices or repeating completed work", async () => {
  const store = book();
  record(store, [
    EventSchema.parse({
      id: "deposit",
      source: "manual",
      type: "deposit",
      date: "2024-09-06",
      account: "broker",
      amount: { amount: "1000", currency: "EUR" },
      eurPerUnit: "1",
    }),
    EventSchema.parse({
      id: "buy",
      source: "manual",
      type: "buy",
      date: "2024-09-06",
      account: "broker",
      instrument: "fund",
      qty: "20",
      price: { amount: "40", currency: "EUR" },
      grossAmount: "800",
      eurPerUnit: "1",
    }),
  ]);
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockResolvedValueOnce({ ok: true, data: [price("2024-09-06", "42")] })
    .mockResolvedValue({ ok: true, data: [] });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  expect(await coordinator(store, source, "2024-09-07T12:00:00Z").updateHistory()).toMatchObject({
    ok: true,
    data: { saved: { prices: 1 } },
  });
  expect(await coordinator(store, source, "2024-09-09T12:00:00Z").updateHistory()).toMatchObject({
    ok: true,
    data: { empty: [{ from: "2024-09-07", through: "2024-09-08" }] },
  });
  expect(fetchPriceHistory.mock.calls[1]?.[0]).toMatchObject({
    from: "2024-09-07",
    through: "2024-09-08",
    sourceFrom: "2024-09-06",
  });
  expect(await coordinator(store, source, "2024-09-09T12:00:00Z").updateHistory()).toMatchObject({
    ok: true,
    data: { checked: [], failures: [] },
  });
  expect(fetchPriceHistory).toHaveBeenCalledTimes(2);
  const snapshot = store.load();
  expect(snapshot).toMatchObject({ data: { prices: [{ asOf: "2024-09-06" }] } });
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  expect(getHistory(snapshot.data, "2024-09-07", "2024-09-08")).toMatchObject({
    data: [{ totalEur: { amount: "1040" } }, { totalEur: { amount: "1040" } }],
  });
});

it("invalidates a checked range when its binding changes or a referenced observation disappears", async () => {
  const store = book();
  position(store, "2024-09-02");
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockResolvedValue({ ok: true, data: [price("2024-09-02", "41")] });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  expect((await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).ok).toBe(true);
  const changed = MarketDataConfigSchema.parse({
    bindings: [
      { kind: "instrument", instrument: "fund", provider: "eodhd", identifier: "OTHER.EUFUND" },
    ],
  });
  expect(
    (await coordinator(store, source, "2024-09-03T12:00:00Z", changed).updateHistory()).ok,
  ).toBe(true);
  expect(fetchPriceHistory.mock.calls[1]?.[0].identifier).toBe("OTHER.EUFUND");
  writeFileSync(join(store.dataHome, "prices.jsonl"), "");
  expect(
    await coordinator(store, source, "2024-09-03T12:00:00Z", changed).updateHistory(),
  ).toMatchObject({ data: { checked: [{ subject: "fund" }], saved: { prices: 1 } } });
  expect(fetchPriceHistory).toHaveBeenCalledTimes(3);
});

it("retains an interrupted append, writes no successful check, and retries without duplicating unchanged facts", async () => {
  const store = book();
  position(store, "2024-09-02");
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockResolvedValue({ ok: true, data: [price("2024-09-02", "40"), price("2024-09-03", "41")] });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  let appends = 0;
  const interrupted: MarketDataStore = {
    dataHome: store.dataHome,
    load: () => store.load(),
    appendPrice: (mark) =>
      ++appends === 2
        ? {
            ok: false,
            error: { type: "storage", message: "Controlled write failure", hint: "Retry" },
          }
        : store.appendPrice(mark),
    appendFx: (mark) => store.appendFx(mark),
  };
  expect(
    await coordinator(interrupted, source, "2024-09-04T12:00:00Z").updateHistory(),
  ).toMatchObject({ ok: false, error: { type: "storage" } });
  expect(store.load()).toMatchObject({ data: { prices: [{ asOf: "2024-09-02" }] } });
  expect(existsSync(join(store.dataHome, "market-history.jsonl"))).toBe(false);
  expect(await coordinator(store, source, "2024-09-04T12:00:00Z").updateHistory()).toMatchObject({
    data: { saved: { prices: 1 }, checked: [{ from: "2024-09-02", through: "2024-09-03" }] },
  });
  expect(
    readFileSync(join(store.dataHome, "prices.jsonl"), "utf8").trim().split("\n"),
  ).toHaveLength(2);
  expect(fetchPriceHistory).toHaveBeenCalledTimes(2);
});

it("fetches newer exposure first, retains it after an older failure, and retries only failed work", async () => {
  const store = book();
  position(store, "2024-08-01");
  record(store, [
    EventSchema.parse({
      id: "sale",
      source: "manual",
      type: "sell",
      date: "2024-08-02",
      account: "broker",
      instrument: "fund",
      qty: "20",
      price: { amount: "40", currency: "EUR" },
      grossAmount: "800",
      eurPerUnit: "1",
    }),
  ]);
  position(store, "2024-09-02");
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockImplementation(async (need) =>
      need.from === "2024-08-01"
        ? {
            ok: false,
            error: { kind: "unavailable", message: "Old range unavailable", status: 503 },
          }
        : { ok: true, data: [price("2024-09-02", "41")] },
    );
  const source = { id: "eodhd" as const, fetchPriceHistory };
  expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
    data: { checked: [{ from: "2024-09-02" }], failures: [{ from: "2024-08-01" }] },
  });
  expect(fetchPriceHistory.mock.calls.map(([need]) => need.from)).toEqual([
    "2024-09-02",
    "2024-08-01",
  ]);
  expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
    data: { checked: [], reused: [{ from: "2024-09-02" }], failures: [{ from: "2024-08-01" }] },
  });
  expect(fetchPriceHistory.mock.calls.map(([need]) => need.from)).toEqual([
    "2024-09-02",
    "2024-08-01",
    "2024-08-01",
  ]);
});

it("includes the last saved observation when a new date becomes required", async () => {
  const store = book();
  position(store, "2024-09-02");
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockResolvedValueOnce({ ok: true, data: [price("2024-08-30", "40")] })
    .mockResolvedValue({ ok: true, data: [price("2024-09-02", "41"), price("2024-09-03", "42")] });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  expect((await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).ok).toBe(true);
  expect((await coordinator(store, source, "2024-09-04T12:00:00Z").updateHistory()).ok).toBe(true);
  expect(fetchPriceHistory.mock.calls[1]?.[0]).toMatchObject({
    from: "2024-09-03",
    through: "2024-09-03",
    sourceFrom: "2024-08-30",
  });
});

it("catches up a consistently delayed NAV without repeating completed same-cutoff work", async () => {
  const store = book();
  position(store, "2024-09-02");
  let published = "2024-09-02";
  const fetchPriceHistory = vi.fn<PriceHistorySource["fetchPriceHistory"]>(async (need) => ({
    ok: true,
    data: [price("2024-09-02", "40"), price("2024-09-03", "41"), price("2024-09-04", "42")].filter(
      (mark) =>
        mark.asOf <= published &&
        mark.asOf <= need.through &&
        (need.sourceFrom === undefined || mark.asOf >= need.sourceFrom),
    ),
  }));
  const source = { id: "eodhd" as const, fetchPriceHistory };
  for (const [today, latest] of [
    ["2024-09-04", "2024-09-02"],
    ["2024-09-05", "2024-09-03"],
    ["2024-09-06", "2024-09-04"],
  ]) {
    published = latest;
    expect((await coordinator(store, source, `${today}T12:00:00Z`).updateHistory()).ok).toBe(true);
    expect((await coordinator(store, source, `${today}T12:00:00Z`).updateHistory()).ok).toBe(true);
  }
  expect(store.load()).toMatchObject({
    data: {
      prices: [
        { asOf: "2024-09-02", price: { amount: "40" } },
        { asOf: "2024-09-03", price: { amount: "41" } },
        { asOf: "2024-09-04", price: { amount: "42" } },
      ],
    },
  });
  expect(fetchPriceHistory.mock.calls.map(([need]) => need.sourceFrom)).toEqual([
    undefined,
    "2024-09-02",
    "2024-09-03",
  ]);
});

it("retains every delayed date returned behind the new logical interval", async () => {
  const store = book();
  position(store, "2024-09-02");
  let published = "2024-09-02";
  const source: PriceHistorySource = {
    id: "eodhd",
    fetchPriceHistory: async (need) => ({
      ok: true,
      data: [
        price("2024-09-02", "40"),
        price("2024-09-03", "41"),
        price("2024-09-04", "42"),
      ].filter(
        (mark) =>
          mark.asOf <= published && (need.sourceFrom === undefined || mark.asOf >= need.sourceFrom),
      ),
    }),
  };
  expect((await coordinator(store, source, "2024-09-04T12:00:00Z").updateHistory()).ok).toBe(true);
  expect((await coordinator(store, source, "2024-09-05T12:00:00Z").updateHistory()).ok).toBe(true);
  published = "2024-09-04";
  expect((await coordinator(store, source, "2024-09-06T12:00:00Z").updateHistory()).ok).toBe(true);
  expect(store.load()).toMatchObject({
    data: { prices: [{ asOf: "2024-09-02" }, { asOf: "2024-09-03" }, { asOf: "2024-09-04" }] },
  });
});

it("serializes updates while releasing the book lock during provider waits", async () => {
  const store = book();
  position(store, "2024-09-02");
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const fetchPriceHistory = vi.fn<PriceHistorySource["fetchPriceHistory"]>(async () => {
    started.resolve();
    await finish.promise;
    return { ok: true, data: [price("2024-09-02", "41")] };
  });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  const first = coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory();
  await started.promise;
  try {
    expect(store.load().ok).toBe(true);
    expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
      ok: false,
      error: { type: "storage" },
    });
  } finally {
    finish.resolve();
  }
  expect(await first).toMatchObject({ ok: true });
  expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
    ok: true,
    data: { saved: { prices: 0, fx: 0 } },
  });
  expect(fetchPriceHistory).toHaveBeenCalledOnce();
});

it("uses fallback routes but never falls back from an explicit binding", async () => {
  const store = book();
  position(store, "2024-09-02");
  const unavailable = vi.fn<PriceHistorySource["fetchPriceHistory"]>().mockResolvedValue({
    ok: false,
    error: { kind: "unavailable", message: "Controlled failure" },
  });
  const fallback = vi.fn<PriceHistorySource["fetchPriceHistory"]>().mockResolvedValue({
    ok: true,
    data: [
      {
        ...price("2024-09-02", "41"),
        provenance: { kind: "fetched", source: "yahoo", retrievedAt: "2024-09-03T12:00:00Z" },
      },
    ],
  });
  const create = (config: MarketDataConfig) =>
    new MarketDataCoordinator({
      store,
      config,
      eurRateSources: [],
      priceHistorySources: [
        { id: "eodhd", fetchPriceHistory: unavailable },
        { id: "yahoo", fetchPriceHistory: fallback },
      ],
      now: () => new Date("2024-09-03T12:00:00Z"),
    });
  expect(
    await create(
      MarketDataConfigSchema.parse({
        bindings: [
          { kind: "instrument", instrument: "fund", provider: "eodhd", identifier: "FUND.EUFUND" },
        ],
        routes: { "price:fund": ["eodhd", "yahoo"] },
      }),
    ).updateHistory(),
  ).toMatchObject({ data: { failures: [{ provider: "eodhd" }] } });
  expect(fallback).not.toHaveBeenCalled();
  expect(
    await create(
      MarketDataConfigSchema.parse({ routes: { "price:fund": ["eodhd", "yahoo"] } }),
    ).updateHistory(),
  ).toMatchObject({ data: { checked: [{ provider: "yahoo" }], failures: [] } });
  expect(fallback).toHaveBeenCalledOnce();
});

it.each([
  { instrument: "other" },
  { asOf: "2024-09-04" },
  { price: { amount: "41", currency: "USD" } },
  { price: { amount: "-41", currency: "EUR" } },
])(
  "rejects invalid normalized price facts without committing marks or successful checks: %o",
  async (fields) => {
    const store = book();
    position(store, "2024-09-02");
    const source: PriceHistorySource = {
      id: "eodhd",
      fetchPriceHistory: async () => ({
        ok: true,
        data: [{ ...price("2024-09-02", "41"), ...fields }],
      }),
    };
    expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
      data: { checked: [], failures: [{ error: { kind: "invalid-response" } }] },
    });
    expect(store.load()).toMatchObject({ data: { prices: [] } });
  },
);

it("advances the completed-date cutoff at 06:00 UTC without point receipt state", async () => {
  const store = book();
  position(store, "2024-09-02");
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockResolvedValue({ ok: true, data: [] });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  expect((await coordinator(store, source, "2024-09-04T05:59:00Z").updateHistory()).ok).toBe(true);
  expect((await coordinator(store, source, "2024-09-04T06:00:00Z").updateHistory()).ok).toBe(true);
  expect(fetchPriceHistory.mock.calls.map(([need]) => [need.from, need.through])).toEqual([
    ["2024-09-02", "2024-09-02"],
    ["2024-09-03", "2024-09-03"],
  ]);
  expect(existsSync(join(store.dataHome, "market-refresh.jsonl"))).toBe(false);
});

it("keeps the manual mark selected and reports a saved conflicting candidate", async () => {
  const store = book();
  record(store, [
    EventSchema.parse({
      id: "deposit",
      source: "manual",
      type: "deposit",
      date: "2024-09-02",
      account: "broker",
      amount: { amount: "1000", currency: "EUR" },
      eurPerUnit: "1",
    }),
    EventSchema.parse({
      id: "buy",
      source: "manual",
      type: "buy",
      date: "2024-09-02",
      account: "broker",
      instrument: "fund",
      qty: "20",
      price: { amount: "40", currency: "EUR" },
      grossAmount: "800",
      eurPerUnit: "1",
    }),
  ]);
  expect(
    store.appendPrice({
      instrument: "fund",
      asOf: "2024-09-02",
      price: { amount: "39", currency: "EUR" },
      provenance: { kind: "manual" },
    }).ok,
  ).toBe(true);
  const source: PriceHistorySource = {
    id: "eodhd",
    fetchPriceHistory: async () => ({ ok: true, data: [price("2024-09-02", "41")] }),
  };
  expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
    data: { conflicts: [{ subject: "fund", manual: "39", fetched: "41", action: "kept" }] },
  });
  const snapshot = store.load();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  expect(snapshot.data.prices).toHaveLength(2);
  expect(getHistory(snapshot.data, "2024-09-02", "2024-09-02")).toMatchObject({
    data: [{ totalEur: { amount: "980" }, positions: [{ priceMark: { source: "manual" } }] }],
  });
});

it("values raw pre-split stock units and requests FX while sale proceeds remain in USD", async () => {
  const store = book();
  expect(
    store.appendInstrument(
      InstrumentSchema.parse({ id: "apple", name: "Apple", type: "stock", quoteCurrency: "USD" }),
    ).ok,
  ).toBe(true);
  record(store, [
    EventSchema.parse({
      id: "deposit",
      source: "manual",
      type: "deposit",
      date: "2020-08-27",
      account: "broker",
      amount: { amount: "1000", currency: "EUR" },
      eurPerUnit: "1",
    }),
    EventSchema.parse({
      id: "exchange",
      source: "manual",
      type: "fx",
      date: "2020-08-27",
      account: "broker",
      from: { amount: "500", currency: "EUR" },
      to: { amount: "600", currency: "USD" },
    }),
    EventSchema.parse({
      id: "buy",
      source: "manual",
      type: "buy",
      date: "2020-08-27",
      account: "broker",
      instrument: "apple",
      qty: "1",
      price: { amount: "500", currency: "USD" },
      grossAmount: "500",
      eurPerUnit: "0.8",
    }),
    EventSchema.parse({
      id: "sell",
      source: "manual",
      type: "sell",
      date: "2020-08-28",
      account: "broker",
      instrument: "apple",
      qty: "1",
      price: { amount: "499.23", currency: "USD" },
      grossAmount: "499.23",
      eurPerUnit: "0.8",
    }),
    EventSchema.parse({
      id: "exchange-back",
      source: "manual",
      type: "fx",
      date: "2020-09-02",
      account: "broker",
      from: { amount: "599.23", currency: "USD" },
      to: { amount: "479.384", currency: "EUR" },
    }),
  ]);
  const priceFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json([{ date: "2020-08-27", close: 500.04, adjusted_close: 121.1519 }]),
    );
  const eodhd = new EodhdSource({ apiKey: "fixture", fetchImplementation: priceFetch });
  const fxFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        '<gesmes:Envelope><Cube><Cube time="2020-08-26"><Cube currency="USD" rate="1.25"/></Cube><Cube time="2020-08-31"><Cube currency="USD" rate="1.25"/></Cube><Cube time="2020-09-02"><Cube currency="USD" rate="2"/></Cube></Cube></gesmes:Envelope>',
      ),
    );
  const ecb = new EcbSource({ fetchImplementation: fxFetch });
  const updater = new MarketDataCoordinator({
    store,
    config: MarketDataConfigSchema.parse({
      bindings: [
        { kind: "instrument", instrument: "apple", provider: "eodhd", identifier: "AAPL.US" },
      ],
    }),
    eurRateSources: [],
    priceHistorySources: [eodhd],
    fxHistorySources: [ecb],
    now: () => new Date("2020-09-03T12:00:00Z"),
  });
  expect(await updater.updateHistory()).toMatchObject({
    ok: true,
    data: {
      checked: [
        { kind: "fx", from: "2020-08-27", through: "2020-09-01" },
        { kind: "price", subject: "apple", through: "2020-08-27" },
      ],
      failures: [],
    },
  });
  const snapshot = store.load();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const history = getHistory(snapshot.data, "2020-08-27", "2020-09-02");
  if (!history.ok) throw new Error(history.error.message);
  expect(history.data.map((row) => row.totalEur?.amount)).toEqual([
    "980.032",
    "979.384",
    "979.384",
    "979.384",
    "979.384",
    "979.384",
    "979.384",
  ]);
  expect(snapshot.data.fx.map((mark) => mark.asOf)).toEqual(["2020-08-26", "2020-08-31"]);
  expect(fxFetch).toHaveBeenCalledTimes(1);
  expect(priceFetch).toHaveBeenCalledTimes(1);
});

it("reports cached conflicts against manual marks added after an earlier update", async () => {
  const store = book();
  position(store, "2024-09-02");
  const source: PriceHistorySource = {
    id: "eodhd",
    fetchPriceHistory: async () => ({ ok: true, data: [price("2024-09-02", "41")] }),
  };
  expect((await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).ok).toBe(true);
  expect(
    store.appendPrice({
      instrument: "fund",
      asOf: "2024-09-02",
      price: { amount: "39", currency: "EUR" },
      provenance: { kind: "manual" },
    }).ok,
  ).toBe(true);
  expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
    data: { checked: [], conflicts: [{ subject: "fund", manual: "39", fetched: "41" }] },
  });
});

it("appends a returning provider value when a later saved candidate differs", async () => {
  const store = book();
  position(store, "2024-09-02");
  expect(store.appendPrice(price("2024-09-02", "41")).ok).toBe(true);
  expect(store.appendPrice(price("2024-09-02", "42")).ok).toBe(true);
  const source: PriceHistorySource = {
    id: "eodhd",
    fetchPriceHistory: async () => ({ ok: true, data: [price("2024-09-02", "41")] }),
  };
  expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
    data: { saved: { prices: 1 } },
  });
  const snapshot = store.load();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  expect(getHistory(snapshot.data, "2024-09-02", "2024-09-02")).toMatchObject({
    data: [{ totalEur: { amount: "1020" } }],
  });
});

it("does not mark a semantically invalid response as an empty successful check", async () => {
  const store = book();
  position(store, "2024-09-02");
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockResolvedValue({ ok: true, data: [price("2024-09-03", "41")] });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  expect(await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).toMatchObject({
    data: { checked: [], empty: [], failures: [{ error: { kind: "invalid-response" } }] },
  });
  expect((await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).ok).toBe(true);
  expect(fetchPriceHistory).toHaveBeenCalledTimes(2);
});

it("batches FX needs and falls through to the next configured history source", async () => {
  const store = book();
  record(store, [
    EventSchema.parse({
      id: "usd",
      source: "manual",
      type: "deposit",
      date: "2024-09-02",
      account: "broker",
      amount: { amount: "100", currency: "USD" },
      eurPerUnit: "0.8",
    }),
    EventSchema.parse({
      id: "gbp",
      source: "manual",
      type: "deposit",
      date: "2024-09-02",
      account: "broker",
      amount: { amount: "100", currency: "GBP" },
      eurPerUnit: "1.1",
    }),
  ]);
  const first = vi.fn<FxHistorySource["fetchFxHistory"]>().mockImplementation(async (needs) =>
    needs.map((need) => ({
      need: { ...need },
      ok: false,
      error: { kind: "unavailable", message: "Unavailable" },
    })),
  );
  const second = vi.fn<FxHistorySource["fetchFxHistory"]>().mockImplementation(async (needs) =>
    needs.map((need) => ({
      need: { ...need },
      ok: true,
      data: [
        {
          pair: `${need.currency}/EUR`,
          asOf: "2024-09-02",
          rate: need.currency === "USD" ? "0.8" : "1.1",
          provenance: { kind: "fetched", source: "ecb", retrievedAt: "2024-09-03T12:00:00.000Z" },
        },
      ],
    })),
  );
  const updater = new MarketDataCoordinator({
    store,
    config: MarketDataConfigSchema.parse({ routes: { fx: ["coingecko", "ecb"] } }),
    eurRateSources: [],
    fxHistorySources: [
      { id: "coingecko", fetchFxHistory: first },
      { id: "ecb", fetchFxHistory: second },
    ],
    now: () => new Date("2024-09-03T12:00:00Z"),
  });
  expect(await updater.updateHistory()).toMatchObject({ data: { failures: [], saved: { fx: 2 } } });
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(second.mock.calls[0]?.[0].map((need) => need.currency)).toEqual(["GBP", "USD"]);
});

it("reports the current binding's candidate rather than an old source check", async () => {
  const store = book();
  position(store, "2024-09-02");
  expect(
    store.appendPrice({
      instrument: "fund",
      asOf: "2024-09-02",
      price: { amount: "39", currency: "EUR" },
      provenance: { kind: "manual" },
    }).ok,
  ).toBe(true);
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockResolvedValueOnce({ ok: true, data: [price("2024-09-02", "41")] })
    .mockResolvedValue({ ok: true, data: [price("2024-09-02", "42")] });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  expect((await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).ok).toBe(true);
  const changed = MarketDataConfigSchema.parse({
    bindings: [
      { kind: "instrument", instrument: "fund", provider: "eodhd", identifier: "OTHER.EUFUND" },
    ],
  });
  const result = await coordinator(store, source, "2024-09-03T12:00:00Z", changed).updateHistory();
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.conflicts.map((conflict) => conflict.fetched)).toEqual(["42"]);
});

it("reports only the latest candidate when an unchecked request incidentally corrects its predecessor", async () => {
  const store = book();
  position(store, "2024-09-02");
  expect(
    store.appendPrice({
      instrument: "fund",
      asOf: "2024-08-30",
      price: { amount: "39", currency: "EUR" },
      provenance: { kind: "manual" },
    }).ok,
  ).toBe(true);
  const fetchPriceHistory = vi
    .fn<PriceHistorySource["fetchPriceHistory"]>()
    .mockResolvedValueOnce({ ok: true, data: [price("2024-08-30", "40")] })
    .mockResolvedValue({ ok: true, data: [price("2024-08-30", "42"), price("2024-09-03", "44")] });
  const source = { id: "eodhd" as const, fetchPriceHistory };
  expect((await coordinator(store, source, "2024-09-03T12:00:00Z").updateHistory()).ok).toBe(true);
  const result = await coordinator(store, source, "2024-09-04T12:00:00Z").updateHistory();
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.conflicts.map((conflict) => conflict.fetched)).toEqual(["42"]);
  fetchPriceHistory.mockResolvedValueOnce({
    ok: true,
    data: [price("2024-08-30", "39"), price("2024-09-04", "45")],
  });
  expect(await coordinator(store, source, "2024-09-05T12:00:00Z").updateHistory()).toMatchObject({
    data: { conflicts: [] },
  });
});
