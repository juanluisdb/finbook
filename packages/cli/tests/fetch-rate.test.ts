import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AccountSchema, FileBookStore } from "@finbook/core";
import type { EurRateNeed, EurRateResolution, ResolvePriceOptions } from "@finbook/market-data";

import { CliFailure } from "../src/errors.js";
import { addEvent, type EventWriteOptions } from "../src/writes.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStore(): FileBookStore {
  const directory = mkdtempSync(join(tmpdir(), "finbook-fetch-rate-"));
  temporaryDirectories.push(directory);
  return new FileBookStore(directory);
}

function seedAccount(store: FileBookStore): void {
  expect(
    store.appendAccount(
      AccountSchema.parse({
        id: "ib",
        name: "Interactive Brokers",
        platform: "interactive-brokers",
        country: "IE",
        custodial: "broker",
      }),
    ).ok,
  ).toBe(true);
}

type RateResolver = {
  resolveHistoricalEurRate(
    need: EurRateNeed,
    options?: ResolvePriceOptions,
  ): Promise<EurRateResolution>;
};

function depositOptions(): EventWriteOptions {
  return {
    id: "deposit-1",
    date: "2026-03-03",
    account: "ib",
    amount: "100",
    currency: "USD",
    fetchRate: true,
  };
}

describe("event historical-rate fetching", () => {
  it("fetches before append and stores the returned rate on the event", async () => {
    const store = temporaryStore();
    seedAccount(store);
    const calls: EurRateNeed[] = [];
    const resolver: RateResolver = {
      resolveHistoricalEurRate: async (need) => {
        calls.push(need);
        return {
          ok: true,
          data: {
            rate: "0.9",
            effectiveDate: "2026-03-02",
            provenance: {
              kind: "fetched",
              source: "ecb",
              retrievedAt: "2026-03-03T12:00:00.000Z",
            },
          },
        };
      },
    };

    await addEvent(store, "deposit", depositOptions(), true, () => "deposit-1", resolver);

    const snapshot = store.load();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(calls).toEqual([{ currency: "USD", date: "2026-03-03" }]);
    expect(snapshot.data.events[0]).toMatchObject({
      id: "deposit-1",
      eurPerUnit: "0.9",
      eurRateProvenance: {
        source: "ecb",
        effectiveDate: "2026-03-02",
      },
    });
  });

  it("does not append an event when the explicit rate fetch fails", async () => {
    const store = temporaryStore();
    seedAccount(store);
    const resolver: RateResolver = {
      resolveHistoricalEurRate: async () => ({
        ok: false,
        error: { kind: "unavailable", message: "ECB is offline" },
      }),
    };

    await expect(
      addEvent(store, "deposit", depositOptions(), true, () => "deposit-1", resolver),
    ).rejects.toBeInstanceOf(CliFailure);
    const snapshot = store.load();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.data.events).toEqual([]);
  });
});
