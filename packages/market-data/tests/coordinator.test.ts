import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBookStore } from "@finbook/core";
import {
  MarketDataConfigSchema,
  MarketDataCoordinator,
  type EurRateNeed,
  type EurRateOutcome,
  type HistoricalEurRateSource,
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

describe("historical event-rate coordination", () => {
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
      eurRateSources: [source],
    });

    const result = await coordinator.resolveHistoricalEurRate(
      { currency: "USD", date: "2026-03-03" },
      { provider: "coingecko" },
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(source.calls).toHaveLength(0);
  });
});
