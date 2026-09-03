import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
  type Event,
} from "@finbook/core";
import type { EurRateNeed, EurRateResolution } from "@finbook/market-data";

import { CliFailure } from "../src/errors.js";
import { addEvent, editEvent } from "../src/event-input.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStore(): FileBookStore {
  const directory = mkdtempSync(join(tmpdir(), "finbook-event-input-"));
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

function seedInstrument(store: FileBookStore): void {
  expect(
    store.appendInstrument(
      InstrumentSchema.parse({
        id: "HROW",
        name: "Harrow",
        type: "stock",
        quoteCurrency: "USD",
      }),
    ).ok,
  ).toBe(true);
}

function seedSecondAccount(store: FileBookStore): void {
  expect(
    store.appendAccount(
      AccountSchema.parse({
        id: "other",
        name: "Other",
        platform: "other",
        country: "ES",
        custodial: "cash",
      }),
    ).ok,
  ).toBe(true);
}

function appendEvent(store: FileBookStore, event: Parameters<typeof EventSchema.parse>[0]): Event {
  const parsed = EventSchema.parse(event);
  expect(store.appendEvent(parsed).ok).toBe(true);
  return parsed;
}

function loadEvent(store: FileBookStore, id: string): Event {
  const snapshot = store.load();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const event = snapshot.data.events.find((candidate) => candidate.id === id);
  if (event === undefined) throw new Error(`Missing test event ${id}`);
  return event;
}

function successfulRate(rate: string): EurRateResolution {
  return {
    ok: true,
    data: {
      rate,
      effectiveDate: "2026-03-01",
      provenance: {
        kind: "fetched",
        source: "ecb",
        retrievedAt: "2026-03-02T12:00:00.000Z",
      },
    },
  };
}

describe("event input preparation", () => {
  it("rejects invalid local input before invoking the historical-rate resolver", async () => {
    const store = temporaryStore();
    seedAccount(store);
    let calls = 0;
    const resolver = {
      resolveHistoricalEurRate: async (_need: EurRateNeed): Promise<EurRateResolution> => {
        calls += 1;
        return successfulRate("0.9");
      },
    };

    await expect(
      addEvent(
        store,
        {
          type: "deposit",
          id: "invalid-deposit",
          date: "not-a-date",
          account: "ib",
          amount: "100",
          currency: "USD",
          fetchRate: true,
        },
        true,
        () => "invalid-deposit",
        resolver,
      ),
    ).rejects.toBeInstanceOf(CliFailure);

    expect(calls).toBe(0);
  });

  it("rejects an unknown account before invoking the historical-rate resolver", async () => {
    const store = temporaryStore();
    seedAccount(store);
    let calls = 0;
    const resolver = {
      resolveHistoricalEurRate: async (_need: EurRateNeed): Promise<EurRateResolution> => {
        calls += 1;
        return successfulRate("0.9");
      },
    };

    await expect(
      addEvent(
        store,
        {
          type: "deposit",
          id: "unknown-account",
          date: "2026-03-01",
          account: "missing",
          amount: "100",
          currency: "USD",
          fetchRate: true,
        },
        true,
        () => "unknown-account",
        resolver,
      ),
    ).rejects.toMatchObject({ domainError: { type: "not-found" } });

    expect(calls).toBe(0);
  });

  it("rejects an edit when the event changes while its rate is being fetched", async () => {
    const store = temporaryStore();
    seedAccount(store);
    const original = EventSchema.parse({
      id: "deposit-1",
      date: "2026-03-01",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "USD" },
      eurPerUnit: "0.9",
    });
    expect(store.appendEvent(original).ok).toBe(true);

    let requested!: () => void;
    let releaseRate!: (resolution: EurRateResolution) => void;
    const requestedPromise = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const ratePromise = new Promise<EurRateResolution>((resolve) => {
      releaseRate = resolve;
    });
    const editPromise = editEvent(
      store,
      { type: "deposit", date: "2026-03-02", fetchRate: true },
      original.id,
      true,
      {
        resolveHistoricalEurRate: async () => {
          requested();
          return ratePromise;
        },
      },
    );

    await requestedPromise;
    const concurrent = EventSchema.parse({
      ...original,
      amount: { amount: "80", currency: "USD" },
    });
    expect(store.replaceEvent(original.id, concurrent, original).ok).toBe(true);
    releaseRate(successfulRate("0.8"));

    await expect(editPromise).rejects.toMatchObject({
      domainError: { type: "conflict" },
    });
    expect(loadEvent(store, original.id)).toEqual(concurrent);
  });

  it("preserves omitted withholding currencies and rejects an incompatible gross-currency change", async () => {
    const store = temporaryStore();
    seedAccount(store);
    seedInstrument(store);
    const income = EventSchema.parse({
      id: "dividend-1",
      date: "2026-03-01",
      source: "manual",
      type: "dividend",
      account: "ib",
      instrument: "HROW",
      gross: { amount: "100", currency: "USD" },
      withholdingForeign: { amount: "2", currency: "USD" },
      withholdingDomestic: { amount: "1", currency: "USD" },
      eurPerUnit: "0.9",
    });
    expect(store.appendEvent(income).ok).toBe(true);

    await editEvent(store, { type: "dividend", grossAmount: "110" }, income.id, true);
    expect(loadEvent(store, income.id)).toMatchObject({
      gross: { amount: "110", currency: "USD" },
      withholdingForeign: { amount: "2", currency: "USD" },
      withholdingDomestic: { amount: "1", currency: "USD" },
    });

    await expect(
      editEvent(
        store,
        { type: "dividend", grossAmount: "110", grossCurrency: "EUR", eurPerUnit: "1" },
        income.id,
        true,
      ),
    ).rejects.toMatchObject({ domainError: { type: "validation" } });
    expect(loadEvent(store, income.id)).toMatchObject({
      gross: { amount: "110", currency: "USD" },
      withholdingForeign: { amount: "2", currency: "USD" },
    });
  });

  it.each([
    {
      name: "deposit",
      setup: (store: FileBookStore) =>
        appendEvent(store, {
          id: "deposit-1",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "EUR" },
          eurPerUnit: "1",
        }),
      input: { type: "deposit", amount: "90" },
      verify: (event: Event) => expect(event).toMatchObject({ amount: { amount: "90" } }),
    },
    {
      name: "withdrawal",
      setup: (store: FileBookStore) => {
        appendEvent(store, {
          id: "funding",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "EUR" },
          eurPerUnit: "1",
        });
        return appendEvent(store, {
          id: "withdrawal-1",
          date: "2026-03-02",
          source: "manual",
          type: "withdrawal",
          account: "ib",
          amount: { amount: "10", currency: "EUR" },
          eurPerUnit: "1",
        });
      },
      input: { type: "withdrawal", amount: "5" },
      verify: (event: Event) => expect(event).toMatchObject({ amount: { amount: "5" } }),
    },
    {
      name: "fee",
      setup: (store: FileBookStore) => {
        appendEvent(store, {
          id: "funding",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "EUR" },
          eurPerUnit: "1",
        });
        return appendEvent(store, {
          id: "fee-1",
          date: "2026-03-02",
          source: "manual",
          type: "fee",
          account: "ib",
          amount: { amount: "2", currency: "EUR" },
          eurPerUnit: "1",
        });
      },
      input: { type: "fee", amount: "1" },
      verify: (event: Event) => expect(event).toMatchObject({ amount: { amount: "1" } }),
    },
    {
      name: "transfer",
      setup: (store: FileBookStore) => {
        seedSecondAccount(store);
        appendEvent(store, {
          id: "funding",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "EUR" },
          eurPerUnit: "1",
        });
        return appendEvent(store, {
          id: "transfer-1",
          date: "2026-03-02",
          source: "manual",
          type: "transfer",
          from: "ib",
          to: "other",
          amount: { amount: "10", currency: "EUR" },
        });
      },
      input: { type: "transfer", amount: "5" },
      verify: (event: Event) => expect(event).toMatchObject({ amount: { amount: "5" } }),
    },
    {
      name: "FX fee clear",
      setup: (store: FileBookStore) => {
        appendEvent(store, {
          id: "funding",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "USD" },
          eurPerUnit: "0.9",
        });
        return appendEvent(store, {
          id: "fx-1",
          date: "2026-03-02",
          source: "manual",
          type: "fx",
          account: "ib",
          from: { amount: "10", currency: "USD" },
          to: { amount: "9", currency: "EUR" },
          fee: { amount: "1", currency: "USD" },
        });
      },
      input: { type: "fx", clearFee: true },
      verify: (event: Event) => expect(event).not.toHaveProperty("fee"),
    },
    {
      name: "buy fee preservation",
      setup: (store: FileBookStore) => {
        appendEvent(store, {
          id: "funding",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "USD" },
          eurPerUnit: "0.9",
        });
        return appendEvent(store, {
          id: "buy-1",
          date: "2026-03-02",
          source: "manual",
          type: "buy",
          account: "ib",
          instrument: "HROW",
          qty: "1",
          price: { amount: "10", currency: "USD" },
          fee: { amount: "1", currency: "USD" },
          eurPerUnit: "0.9",
        });
      },
      input: { type: "buy", qty: "2" },
      verify: (event: Event) => expect(event).toMatchObject({ qty: "2", fee: { amount: "1" } }),
    },
    {
      name: "sell fee clear",
      setup: (store: FileBookStore) => {
        appendEvent(store, {
          id: "funding",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "USD" },
          eurPerUnit: "0.9",
        });
        appendEvent(store, {
          id: "buy-1",
          date: "2026-03-02",
          source: "manual",
          type: "buy",
          account: "ib",
          instrument: "HROW",
          qty: "2",
          price: { amount: "10", currency: "USD" },
          eurPerUnit: "0.9",
        });
        return appendEvent(store, {
          id: "sell-1",
          date: "2026-03-03",
          source: "manual",
          type: "sell",
          account: "ib",
          instrument: "HROW",
          qty: "1",
          price: { amount: "10", currency: "USD" },
          fee: { amount: "1", currency: "USD" },
          eurPerUnit: "0.9",
        });
      },
      input: { type: "sell", clearFee: true },
      verify: (event: Event) => expect(event).not.toHaveProperty("fee"),
    },
    {
      name: "dividend foreign withholding clear",
      setup: (store: FileBookStore) =>
        appendEvent(store, {
          id: "dividend-1",
          date: "2026-03-01",
          source: "manual",
          type: "dividend",
          account: "ib",
          instrument: "HROW",
          gross: { amount: "10", currency: "USD" },
          withholdingForeign: { amount: "2", currency: "USD" },
          withholdingDomestic: { amount: "1", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      input: { type: "dividend", clearWithholdingForeign: true },
      verify: (event: Event) => {
        expect(event).not.toHaveProperty("withholdingForeign");
        expect(event).toMatchObject({ withholdingDomestic: { amount: "1" } });
      },
    },
    {
      name: "interest domestic withholding clear",
      setup: (store: FileBookStore) =>
        appendEvent(store, {
          id: "interest-1",
          date: "2026-03-01",
          source: "manual",
          type: "interest",
          account: "ib",
          gross: { amount: "10", currency: "USD" },
          withholdingForeign: { amount: "2", currency: "USD" },
          withholdingDomestic: { amount: "1", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      input: { type: "interest", clearWithholdingDomestic: true },
      verify: (event: Event) => {
        expect(event).not.toHaveProperty("withholdingDomestic");
        expect(event).toMatchObject({ withholdingForeign: { amount: "2" } });
      },
    },
  ])("edits the complete %s event family", async ({ setup, input, verify }) => {
    const store = temporaryStore();
    seedAccount(store);
    seedInstrument(store);
    const current = setup(store);

    await editEvent(store, input, current.id, true);

    verify(loadEvent(store, current.id));
  });
});
