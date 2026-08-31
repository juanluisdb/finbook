import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileBookStore, InstrumentSchema, type Instrument } from "@finbook/core";

import {
  MarketDataConfigSchema,
  MarketDataCoordinator,
  type EurRateNeed,
  type EurRateOutcome,
  type FxNeed,
  type FxOutcome,
  type FxSource,
  type HistoricalEurRateSource,
  type PriceNeed,
  type PriceOutcome,
  type PriceSource,
  type ProviderId,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStore(): FileBookStore {
  const directory = mkdtempSync(join(tmpdir(), "finbook-market-data-coordinator-"));
  temporaryDirectories.push(directory);
  return new FileBookStore(directory);
}

function instrument(id: string): Instrument {
  return InstrumentSchema.parse({
    id,
    name: id,
    type: "stock",
    quoteCurrency: "USD",
  });
}

function priceNeed(value: Instrument, asOf = "2026-03-01"): PriceNeed {
  return { instrument: value, asOf, mode: "historical", identifier: value.id };
}

function success(need: PriceNeed): PriceOutcome {
  return {
    need,
    ok: true,
    data: {
      instrument: need.instrument.id,
      price: { amount: "100", currency: need.instrument.quoteCurrency },
      asOf: need.asOf,
      provenance: {
        kind: "fetched",
        source: "fixture",
        retrievedAt: "2026-03-01T12:00:00.000Z",
      },
    },
  };
}

class FixtureRateSource implements HistoricalEurRateSource {
  readonly id: ProviderId;
  readonly calls: EurRateNeed[][] = [];
  private readonly behavior: (needs: readonly EurRateNeed[]) => readonly EurRateOutcome[];

  constructor(
    id: ProviderId,
    behavior: (needs: readonly EurRateNeed[]) => readonly EurRateOutcome[],
  ) {
    this.id = id;
    this.behavior = behavior;
  }

  fetchHistoricalEurRates(needs: readonly EurRateNeed[]): Promise<readonly EurRateOutcome[]> {
    this.calls.push([...needs]);
    return Promise.resolve(this.behavior(needs));
  }
}

class FixtureFxSource implements FxSource {
  readonly id: ProviderId;
  readonly calls: FxNeed[][] = [];
  private readonly behavior: (needs: readonly FxNeed[]) => readonly FxOutcome[];

  constructor(id: ProviderId, behavior: (needs: readonly FxNeed[]) => readonly FxOutcome[]) {
    this.id = id;
    this.behavior = behavior;
  }

  fetchFxRates(needs: readonly FxNeed[]): Promise<readonly FxOutcome[]> {
    this.calls.push([...needs]);
    return Promise.resolve(this.behavior(needs));
  }
}

class FixturePriceSource implements PriceSource {
  readonly id: ProviderId;
  readonly calls: PriceNeed[][] = [];
  private readonly behavior: (needs: readonly PriceNeed[]) => readonly PriceOutcome[];

  constructor(id: ProviderId, behavior: (needs: readonly PriceNeed[]) => readonly PriceOutcome[]) {
    this.id = id;
    this.behavior = behavior;
  }

  fetchPrices(needs: readonly PriceNeed[]): Promise<readonly PriceOutcome[]> {
    this.calls.push([...needs]);
    return Promise.resolve(this.behavior(needs));
  }
}

describe("market-data coordinator", () => {
  it("persists each result and resumes an interrupted batch from cache", async () => {
    const store = temporaryStore();
    const instruments = Array.from({ length: 50 }, (_, index) => instrument(`stock-${index}`));
    for (const value of instruments) expect(store.appendInstrument(value).ok).toBe(true);
    let firstAttempt = true;
    const source = new FixturePriceSource("yahoo", (needs) => {
      if (!firstAttempt) return needs.map((need) => success(need));
      firstAttempt = false;
      return needs.map((need, index) =>
        index < 40
          ? success(need)
          : {
              need,
              ok: false,
              error: { kind: "unavailable", message: "interrupted fixture" },
            },
      );
    });
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({}),
      priceSources: [source],
      fxSources: [],
      eurRateSources: [],
    });
    const needs = instruments.map((value) => priceNeed(value));

    const first = await coordinator.resolvePrices(needs);
    expect(first).toMatchObject({
      ok: true,
      data: { fetched: expect.any(Array), failures: expect.any(Array) },
    });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.data.fetched).toHaveLength(40);
    expect(first.data.failures).toHaveLength(10);
    expect(store.load()).toMatchObject({ ok: true, data: { prices: expect.any(Array) } });
    const afterFirst = store.load();
    if (!afterFirst.ok) throw new Error(afterFirst.error.message);
    expect(afterFirst.data.prices).toHaveLength(40);

    const second = await coordinator.resolvePrices(needs);

    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error(second.error.message);
    expect(second.data.cached).toBe(40);
    expect(second.data.fetched).toHaveLength(10);
    expect(second.data.failures).toHaveLength(0);
    expect(source.calls.map((call) => call.length)).toEqual([50, 10]);
    const afterSecond = store.load();
    if (!afterSecond.ok) throw new Error(afterSecond.error.message);
    expect(afterSecond.data.prices).toHaveLength(50);
  });

  it("persists FX marks and skips cached historical needs", async () => {
    const store = temporaryStore();
    const source = new FixtureFxSource("ecb", (needs) =>
      needs.map((need) => ({
        need,
        ok: true,
        data: {
          pair: `${need.currency}/EUR`,
          rate: "0.9",
          asOf: need.asOf,
          provenance: {
            kind: "fetched",
            source: "ecb",
            retrievedAt: "2026-03-01T12:00:00.000Z",
          },
        },
      })),
    );
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({}),
      priceSources: [],
      fxSources: [source],
      eurRateSources: [],
    });
    const needs: FxNeed[] = [{ currency: "USD", asOf: "2026-03-01", mode: "historical" }];

    const first = await coordinator.resolveFxRates(needs);
    const second = await coordinator.resolveFxRates(needs);

    expect(first).toMatchObject({ ok: true, data: { fetched: [{ pair: "USD/EUR" }] } });
    expect(second).toMatchObject({ ok: true, data: { cached: 1, fetched: [] } });
    expect(source.calls).toHaveLength(1);
  });

  it("does not let a historical mark retrieved today satisfy a latest price need", async () => {
    const store = temporaryStore();
    const value = instrument("stock-latest");
    expect(store.appendInstrument(value).ok).toBe(true);
    expect(
      store.appendPrice({
        instrument: value.id,
        price: { amount: "99", currency: "USD" },
        asOf: "2026-03-01",
        provenance: {
          kind: "fetched",
          source: "yahoo",
          retrievedAt: "2026-03-03T12:00:00.000Z",
        },
      }).ok,
    ).toBe(true);
    const source = new FixturePriceSource("yahoo", (needs) => needs.map((need) => success(need)));
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({}),
      priceSources: [source],
      fxSources: [],
      eurRateSources: [],
    });
    const need: PriceNeed = {
      instrument: value,
      asOf: "2026-03-03",
      mode: "latest",
      identifier: value.id,
    };

    const result = await coordinator.resolvePrices([need]);

    expect(result).toMatchObject({ ok: true, data: { cached: 0, fetched: [success(need).data] } });
    expect(source.calls).toEqual([[need]]);
  });

  it("does not let a historical mark retrieved today satisfy a latest FX need", async () => {
    const store = temporaryStore();
    expect(
      store.appendFx({
        pair: "USD/EUR",
        rate: "0.9",
        asOf: "2026-03-01",
        provenance: {
          kind: "fetched",
          source: "ecb",
          retrievedAt: "2026-03-03T12:00:00.000Z",
        },
      }).ok,
    ).toBe(true);
    const source = new FixtureFxSource("ecb", (needs) =>
      needs.map((need) => ({
        need,
        ok: true,
        data: {
          pair: `${need.currency}/EUR`,
          rate: "0.91",
          asOf: need.asOf,
          provenance: {
            kind: "fetched",
            source: "ecb",
            retrievedAt: "2026-03-03T13:00:00.000Z",
          },
        },
      })),
    );
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({}),
      priceSources: [],
      fxSources: [source],
      eurRateSources: [],
    });
    const need: FxNeed = { currency: "USD", asOf: "2026-03-03", mode: "latest" };

    const result = await coordinator.resolveFxRates([need]);

    expect(result).toMatchObject({
      ok: true,
      data: { cached: 0, fetched: [{ pair: "USD/EUR", rate: "0.91" }] },
    });
    expect(source.calls).toEqual([[need]]);
  });

  it("resolves a historical EUR rate through the configured source", async () => {
    const store = temporaryStore();
    const source = new FixtureRateSource("ecb", (needs) =>
      needs.map((need) => ({
        need,
        ok: true,
        data: {
          rate: "0.9",
          effectiveDate: need.date,
          provenance: {
            kind: "fetched",
            source: "ecb",
            retrievedAt: "2026-03-01T12:00:00.000Z",
          },
        },
      })),
    );
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({}),
      priceSources: [],
      fxSources: [],
      eurRateSources: [source],
    });

    const result = await coordinator.resolveHistoricalEurRate({
      currency: "USD",
      date: "2026-03-01",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        rate: "0.9",
        effectiveDate: "2026-03-01",
        provenance: { kind: "fetched", source: "ecb" },
      },
    });
    expect(source.calls).toHaveLength(1);
  });

  it("selects a crypto binding and rejects it before I/O when disabled", async () => {
    const store = temporaryStore();
    const source = new FixtureRateSource("coingecko", (needs) =>
      needs.map((need) => ({
        need,
        ok: true,
        data: {
          rate: "60000",
          effectiveDate: need.date,
          provenance: {
            kind: "fetched",
            source: "coingecko",
            retrievedAt: "2026-03-03T12:00:00.000Z",
          },
        },
      })),
    );
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({
        disabledProviders: ["coingecko"],
        bindings: [
          { kind: "currency", currency: "BTC", provider: "coingecko", identifier: "bitcoin" },
        ],
      }),
      priceSources: [],
      fxSources: [],
      eurRateSources: [source],
    });

    const result = await coordinator.resolveHistoricalEurRate({
      currency: "BTC",
      date: "2026-03-03",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(result.ok ? "" : result.error.message).toContain("disabled");
    expect(source.calls).toHaveLength(0);
  });

  it("explains how to bind an unsupported unbound currency", async () => {
    const store = temporaryStore();
    const source = new FixtureRateSource("ecb", (needs) =>
      needs.map((need) => ({
        need,
        ok: false,
        error: { kind: "unsupported", message: "ECB only supports fiat currencies." },
      })),
    );
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({}),
      priceSources: [],
      fxSources: [],
      eurRateSources: [source],
    });

    const result = await coordinator.resolveHistoricalEurRate({
      currency: "BTC",
      date: "2026-03-03",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(result.ok ? "" : result.error.message).toContain("config source set --currency BTC");
  });

  it("rejects an incapable historical-rate pin before I/O", async () => {
    const store = temporaryStore();
    const source = new FixtureRateSource("coingecko", (needs) =>
      needs.map((need) => ({
        need,
        ok: false,
        error: { kind: "unavailable", message: "should not be called" },
      })),
    );
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({}),
      priceSources: [],
      fxSources: [],
      eurRateSources: [source],
    });

    const result = await coordinator.resolveHistoricalEurRate(
      { currency: "USD", date: "2026-03-03" },
      { provider: "coingecko" },
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(source.calls).toHaveLength(0);
  });

  it("does not call an incapable provider selected by an explicit price pin", async () => {
    const store = temporaryStore();
    const value = instrument("stock-pinned");
    expect(store.appendInstrument(value).ok).toBe(true);
    const source = new FixturePriceSource("ecb", (needs) => needs.map((need) => success(need)));
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({}),
      priceSources: [source],
      fxSources: [],
      eurRateSources: [],
    });

    const result = await coordinator.resolvePrices([priceNeed(value)], { provider: "ecb" });

    expect(result).toMatchObject({
      ok: true,
      data: { failures: [{ provider: "ecb", error: { kind: "unsupported" } }] },
    });
    expect(source.calls).toHaveLength(0);
  });

  it("uses configured fallback providers but honors an explicit provider pin", async () => {
    const store = temporaryStore();
    const value = InstrumentSchema.parse({
      id: "crypto-1",
      name: "Crypto 1",
      type: "crypto",
      quoteCurrency: "USD",
    });
    expect(store.appendInstrument(value).ok).toBe(true);
    const primary = new FixturePriceSource("yahoo", (needs) =>
      needs.map((need) => ({
        need,
        ok: false,
        error: { kind: "unsupported", message: "fixture does not support it" },
      })),
    );
    const backup = new FixturePriceSource("coingecko", (needs) =>
      needs.map((need) => success(need)),
    );
    const coordinator = new MarketDataCoordinator({
      store,
      config: MarketDataConfigSchema.parse({ routes: { "price:crypto": ["yahoo", "coingecko"] } }),
      priceSources: [primary, backup],
      fxSources: [],
      eurRateSources: [],
    });

    const fallback = await coordinator.resolvePrices([priceNeed(value)]);
    const pinned = await coordinator.resolvePrices([priceNeed(value, "2026-02-01")], {
      provider: "yahoo",
    });

    expect(fallback).toMatchObject({
      ok: true,
      data: { cached: 0, fetched: [success(priceNeed(value)).data] },
    });
    expect(primary.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(1);
    expect(pinned).toMatchObject({
      ok: true,
      data: { fetched: [], failures: [{ provider: "yahoo" }] },
    });
    expect(primary.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(1);
  });
});
