import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
  getPositions,
} from "@finbook/core";
import {
  MarketDataConfigSchema,
  MarketDataCoordinator,
  dailyCycle,
  dailyTarget,
  type PriceNeed,
  type PriceSource,
  type FxSource,
} from "../src/index.js";

const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "finbook-daily-"));
  directories.push(directory);
  const store = new FileBookStore(directory);
  const instrument = InstrumentSchema.parse({
    id: "fund",
    name: "Example fund",
    type: "fund",
    quoteCurrency: "EUR",
  });
  expect(
    store.appendAccount(
      AccountSchema.parse({
        id: "wallet",
        name: "Wallet",
        platform: "example",
        country: "ES",
        custodial: "broker",
      }),
    ).ok,
  ).toBe(true);
  expect(store.appendInstrument(instrument).ok).toBe(true);
  expect(
    store.appendEvent(
      EventSchema.parse({
        type: "deposit",
        id: "deposit",
        source: "manual",
        date: "2026-03-01",
        account: "wallet",
        amount: { amount: "1000", currency: "EUR" },
        eurPerUnit: "1",
      }),
    ).ok,
  ).toBe(true);
  expect(
    store.appendEvent(
      EventSchema.parse({
        type: "buy",
        id: "purchase",
        source: "manual",
        date: "2026-03-01",
        account: "wallet",
        instrument: "fund",
        qty: "1",
        price: { amount: "100", currency: "EUR" },
        grossAmount: "100",
        eurPerUnit: "1",
      }),
    ).ok,
  ).toBe(true);
  let instant = "2026-03-04T08:00:00Z";
  const calls: PriceNeed[][] = [];
  let response: PriceSource["fetchPrices"] = (needs) =>
    Promise.resolve(
      needs.map((need) => ({
        need,
        ok: true,
        data: {
          instrument: need.instrument.id,
          price: { amount: "102", currency: need.instrument.quoteCurrency },
          asOf: need.asOf,
          provenance: { kind: "fetched", source: "yahoo", retrievedAt: instant },
        },
      })),
    );
  const source: PriceSource = {
    id: "yahoo",
    fetchPrices(needs) {
      calls.push([...needs]);
      return response(needs);
    },
  };
  const config = MarketDataConfigSchema.parse({ routes: { "price:crypto": ["yahoo"] } });
  const create = (fxSources: readonly FxSource[] = []) =>
    new MarketDataCoordinator({
      store,
      config,
      priceSources: [source],
      fxSources,
      eurRateSources: [],
      now: () => new Date(instant),
    });
  return {
    store,
    instrument,
    calls,
    config,
    create,
    setTime(value: string) {
      instant = value;
    },
    setResponse(value: PriceSource["fetchPrices"]) {
      response = value;
    },
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("daily refresh", () => {
  it.each([
    ["2026-03-29T05:59:59Z", "2026-03-28", "2026-03-27"],
    ["2026-03-29T06:00:00Z", "2026-03-29", "2026-03-28"],
    ["2026-10-25T05:59:59Z", "2026-10-24", "2026-10-23"],
    ["2026-10-25T06:00:00Z", "2026-10-25", "2026-10-24"],
  ])("keeps the UTC cutoff stable at %s", (instant, cycle, target) => {
    expect(dailyCycle(new Date(instant))).toBe(cycle);
    expect(dailyTarget("2026-12-31", false, new Date(instant))).toBe(target);
    expect(dailyTarget("2026-12-31", true, new Date(instant))).toBe(cycle);
  });

  it("keeps current holdings but freezes target dates throughout the cycle", async () => {
    const f = fixture();
    expect(
      f.store.appendInstrument(
        InstrumentSchema.parse({
          id: "coin",
          name: "Example coin",
          type: "crypto",
          quoteCurrency: "EUR",
        }),
      ).ok,
    ).toBe(true);
    expect(
      f.store.appendEvent(
        EventSchema.parse({
          type: "buy",
          id: "coin-buy",
          source: "manual",
          date: "2026-03-04",
          account: "wallet",
          instrument: "coin",
          qty: "1",
          price: { amount: "10", currency: "EUR" },
          grossAmount: "10",
          eurPerUnit: "1",
        }),
      ).ok,
    ).toBe(true);
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({ ok: true });
    f.setTime("2026-03-04T23:00:00Z");
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({
      ok: true,
      data: { report: { prices: { cached: 2, fetched: [] } } },
    });
    expect(f.calls.map((batch) => batch.map((need) => [need.instrument.id, need.asOf]))).toEqual([
      [
        ["fund", "2026-03-03"],
        ["coin", "2026-03-04"],
      ],
    ]);
  });

  it("opens the next cycle at 06:00 and never requests after a historical view date", async () => {
    const f = fixture();
    f.setTime("2026-03-04T05:59:59Z");
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({ ok: true });
    f.setTime("2026-03-04T06:00:00Z");
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({ ok: true });
    expect(await f.create().refreshValuation("2026-03-01")).toMatchObject({ ok: true });
    expect(f.calls.map((batch) => batch.map((need) => need.asOf))).toEqual([
      ["2026-03-02"],
      ["2026-03-03"],
      ["2026-03-01"],
    ]);
  });

  it("reuses an exact historical observation in later cycles", async () => {
    const f = fixture();
    expect(await f.create().refreshValuation("2026-03-03")).toMatchObject({ ok: true });
    f.setTime("2026-03-05T08:00:00Z");
    expect(await f.create().refreshValuation("2026-03-03")).toMatchObject({
      ok: true,
      data: { report: { prices: { cached: 1, fetched: [] } } },
    });
    expect(f.calls).toHaveLength(1);
  });

  it("keeps the accepted candidate selected when another fetched value was saved later", async () => {
    const f = fixture();
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({ ok: true });
    expect(
      f.store.appendPrice({
        instrument: "fund",
        asOf: "2026-03-03",
        price: { amount: "110", currency: "EUR" },
        provenance: { kind: "fetched", source: "other", retrievedAt: "2026-03-04T09:00:00Z" },
      }).ok,
    ).toBe(true);
    expect(
      f.store.appendPrice({
        instrument: "fund",
        asOf: "2026-03-03",
        price: { amount: "99", currency: "EUR" },
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    const result = await f.create().refreshValuation("2026-03-04", { replaceManual: true });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error.message);
    expect(getPositions(result.data.snapshot, "2026-03-04")).toMatchObject({
      ok: true,
      data: { positions: [{ valueEur: { amount: "102" } }] },
    });
    expect(f.calls).toHaveLength(1);
  });

  it("retains an observation if saving its resolution is interrupted, then safely retries", async () => {
    const f = fixture();
    let interrupted = true;
    f.setResponse((needs) => {
      if (interrupted) mkdirSync(join(f.store.dataHome, "market-refresh.jsonl"));
      return Promise.resolve(
        needs.map((need) => ({
          need,
          ok: true,
          data: {
            instrument: "fund",
            price: { amount: "102", currency: "EUR" },
            asOf: need.asOf,
            provenance: { kind: "fetched", source: "yahoo", retrievedAt: "2026-03-04T08:00:00Z" },
          },
        })),
      );
    });
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({
      ok: false,
      error: { type: "storage" },
    });
    const saved = f.store.load();
    expect(saved).toMatchObject({ ok: true, data: { prices: [{ asOf: "2026-03-03" }] } });
    rmSync(join(f.store.dataHome, "market-refresh.jsonl"), { recursive: true });
    interrupted = false;
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({ ok: true });
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({
      ok: true,
      data: { report: { prices: { cached: 1 } } },
    });
    expect(f.calls).toHaveLength(2);
  });

  it("fetches a new subject or changed binding without repeating successful work", async () => {
    const f = fixture();
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({ ok: true });
    expect(
      f.store.appendInstrument(
        InstrumentSchema.parse({ id: "coin", name: "Coin", type: "crypto", quoteCurrency: "EUR" }),
      ).ok,
    ).toBe(true);
    expect(
      f.store.appendEvent(
        EventSchema.parse({
          type: "buy",
          id: "new-holding",
          source: "manual",
          date: "2026-03-04",
          account: "wallet",
          instrument: "coin",
          qty: "1",
          price: { amount: "10", currency: "EUR" },
          grossAmount: "10",
          eurPerUnit: "1",
        }),
      ).ok,
    ).toBe(true);
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({
      ok: true,
      data: { report: { prices: { cached: 1 } } },
    });
    f.config.bindings.push({
      kind: "instrument",
      instrument: "fund",
      provider: "yahoo",
      identifier: "NEW-SYMBOL",
    });
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({ ok: true });
    expect(f.calls.map((batch) => batch.map((need) => need.identifier))).toEqual([
      ["fund"],
      ["coin"],
      ["NEW-SYMBOL"],
    ]);
  });

  it("keeps a manual FX rate until explicitly accepting its cached provider candidate", async () => {
    const f = fixture();
    expect(
      f.store.appendEvent(
        EventSchema.parse({
          type: "deposit",
          id: "usd",
          source: "manual",
          date: "2026-03-01",
          account: "wallet",
          amount: { amount: "1", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      ).ok,
    ).toBe(true);
    expect(
      f.store.appendFx({
        pair: "USD/EUR",
        asOf: "2026-03-03",
        rate: "0.9",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    let calls = 0;
    const source: FxSource = {
      id: "ecb",
      fetchFxRates(needs) {
        calls += 1;
        return Promise.resolve(
          needs.map((need) => ({
            need,
            ok: true,
            data: {
              pair: "USD/EUR",
              asOf: need.asOf,
              rate: "0.8",
              provenance: { kind: "fetched", source: "ecb", retrievedAt: "2026-03-04T08:00:00Z" },
            },
          })),
        );
      },
    };
    expect(await f.create([source]).refreshValuation("2026-03-04")).toMatchObject({
      ok: true,
      data: {
        report: { conflicts: [{ kind: "fx", action: "kept", manual: "0.9", fetched: "0.8" }] },
      },
    });
    expect(
      f.store.appendFx({
        pair: "USD/EUR",
        asOf: "2026-03-03",
        rate: "0.7",
        provenance: { kind: "fetched", source: "other", retrievedAt: "2026-03-04T09:00:00Z" },
      }).ok,
    ).toBe(true);
    const result = await f.create([source]).refreshValuation("2026-03-04", { replaceManual: true });
    expect(result).toMatchObject({
      ok: true,
      data: { report: { fx: { cached: 1 }, conflicts: [{ kind: "fx", action: "replaced" }] } },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(getPositions(result.data.snapshot, "2026-03-04")).toMatchObject({
      ok: true,
      data: {
        cash: expect.arrayContaining([
          {
            account: "wallet",
            currency: "USD",
            balance: { amount: "1", currency: "USD" },
            valueEur: { amount: "0.8", currency: "EUR" },
            fxMark: { asOf: "2026-03-03", source: "ecb" },
          },
        ]),
      },
    });
    expect(calls).toBe(1);
  });

  it("retries failed FX without repeating a successful price request", async () => {
    const f = fixture();
    expect(
      f.store.appendEvent(
        EventSchema.parse({
          type: "deposit",
          id: "dollars",
          source: "manual",
          date: "2026-03-01",
          account: "wallet",
          amount: { amount: "1", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      ).ok,
    ).toBe(true);
    let fail = true;
    let fxCalls = 0;
    const source: FxSource = {
      id: "ecb",
      fetchFxRates(needs) {
        fxCalls += 1;
        return Promise.resolve(
          needs.map((need) =>
            fail
              ? { need, ok: false, error: { kind: "unavailable", message: "fixture interruption" } }
              : {
                  need,
                  ok: true,
                  data: {
                    pair: "USD/EUR",
                    rate: "0.9",
                    asOf: need.asOf,
                    provenance: {
                      kind: "fetched",
                      source: "ecb",
                      retrievedAt: "2026-03-04T08:00:00Z",
                    },
                  },
                },
          ),
        );
      },
    };
    expect(await f.create([source]).refreshValuation("2026-03-04")).toMatchObject({
      ok: true,
      data: { report: { fx: { failures: [{ need: { currency: "USD" } }] } } },
    });
    fail = false;
    expect(await f.create([source]).refreshValuation("2026-03-04")).toMatchObject({
      ok: true,
      data: { report: { prices: { cached: 1 }, fx: { failures: [] } } },
    });
    expect(f.calls).toHaveLength(1);
    expect(fxCalls).toBe(2);
  });

  it("warns about manual conflicts and accepts the saved candidate without another request", async () => {
    const f = fixture();
    expect(
      f.store.appendPrice({
        instrument: "fund",
        asOf: "2026-03-03",
        price: { amount: "99", currency: "EUR" },
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    const kept = await f.create().refreshValuation("2026-03-04");
    expect(kept).toMatchObject({
      ok: true,
      data: {
        report: { conflicts: [{ kind: "price", manual: "99", fetched: "102", action: "kept" }] },
      },
    });
    if (!kept.ok) throw new Error(kept.error.message);
    expect(getPositions(kept.data.snapshot, "2026-03-04")).toMatchObject({
      ok: true,
      data: { positions: [{ valueEur: { amount: "99" } }] },
    });
    const replaced = await f.create().refreshValuation("2026-03-04", { replaceManual: true });
    expect(replaced).toMatchObject({
      ok: true,
      data: { report: { prices: { cached: 1 }, conflicts: [{ action: "replaced" }] } },
    });
    if (!replaced.ok) throw new Error(replaced.error.message);
    expect(getPositions(replaced.data.snapshot, "2026-03-04")).toMatchObject({
      ok: true,
      data: { positions: [{ valueEur: { amount: "102" }, priceMark: { source: "yahoo" } }] },
    });
    expect(f.calls).toHaveLength(1);
  });

  it("rejects replacement when a manual mark changed during the request", async () => {
    const f = fixture();
    f.setResponse((needs) => {
      expect(
        f.store.appendPrice({
          instrument: "fund",
          asOf: "2026-03-03",
          price: { amount: "77", currency: "EUR" },
          provenance: { kind: "manual" },
        }).ok,
      ).toBe(true);
      return Promise.resolve(
        needs.map((need) => ({
          need,
          ok: true,
          data: {
            instrument: "fund",
            price: { amount: "102", currency: "EUR" },
            asOf: "2026-03-03",
            provenance: { kind: "fetched", source: "yahoo", retrievedAt: "2026-03-04T08:00:00Z" },
          },
        })),
      );
    });
    expect(await f.create().refreshValuation("2026-03-04", { replaceManual: true })).toMatchObject({
      ok: false,
      error: { type: "conflict" },
    });
  });

  it("serializes refreshes without holding the book lock over the network request", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.setResponse(async (needs) => {
      started.resolve();
      await finish.promise;
      return needs.map((need) => ({
        need,
        ok: true,
        data: {
          instrument: "fund",
          price: { amount: "102", currency: "EUR" },
          asOf: need.asOf,
          provenance: { kind: "fetched", source: "yahoo", retrievedAt: "2026-03-04T08:00:00Z" },
        },
      }));
    });
    const first = f.create().refreshValuation("2026-03-04");
    await started.promise;
    try {
      expect(f.store.load().ok).toBe(true);
      expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({
        ok: false,
        error: { type: "storage" },
      });
    } finally {
      finish.resolve();
    }
    expect(await first).toMatchObject({ ok: true });
    expect(await f.create().refreshValuation("2026-03-04")).toMatchObject({
      ok: true,
      data: { report: { prices: { cached: 1 } } },
    });
    expect(f.calls).toHaveLength(1);
  });
  it("reuses a successful lagging observation across coordinator restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "finbook-daily-"));
    directories.push(directory);
    const store = new FileBookStore(directory);
    const instrument = InstrumentSchema.parse({
      id: "fund",
      name: "Example fund",
      type: "fund",
      quoteCurrency: "EUR",
    });
    expect(store.appendInstrument(instrument).ok).toBe(true);
    let calls = 0;
    const source: PriceSource = {
      id: "yahoo",
      fetchPrices(needs) {
        calls += 1;
        return Promise.resolve(
          needs.map((need) => ({
            need,
            ok: true,
            data: {
              instrument: instrument.id,
              price: { amount: "102", currency: "EUR" },
              asOf: "2026-03-01",
              provenance: { kind: "fetched", source: "yahoo", retrievedAt: "2026-03-04T08:00:00Z" },
            },
          })),
        );
      },
    };
    const create = () =>
      new MarketDataCoordinator({
        store,
        config: MarketDataConfigSchema.parse({}),
        priceSources: [source],
        fxSources: [],
        eurRateSources: [],
        now: () => new Date("2026-03-04T08:00:00Z"),
      });
    const need: PriceNeed = { instrument, identifier: instrument.id, asOf: "2026-03-03" };

    expect(await create().resolvePrices([need])).toMatchObject({
      ok: true,
      data: { fetched: [{ asOf: "2026-03-01" }] },
    });
    expect(await create().resolvePrices([need])).toMatchObject({
      ok: true,
      data: { cached: 1, fetched: [] },
    });
    expect(calls).toBe(1);
  });
});
