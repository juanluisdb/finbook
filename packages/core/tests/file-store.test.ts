import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
  getGlance,
  type Account,
  type BookSnapshot,
  type Instrument,
} from "../src/index.js";

const account: Account = AccountSchema.parse({
  id: "ib",
  name: "Interactive Brokers",
  platform: "interactive-brokers",
  country: "IE",
  custodial: "broker",
});
const instrument: Instrument = InstrumentSchema.parse({
  id: "HROW",
  name: "Harrow",
  type: "stock",
  quoteCurrency: "USD",
});
const event = EventSchema.parse({
  id: "deposit-1",
  date: "2026-03-01",
  source: "manual",
  externalId: "manual-1",
  type: "deposit",
  account: "ib",
  amount: { amount: "100", currency: "USD" },
  eurPerUnit: "0.9",
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStore(): FileBookStore {
  const directory = mkdtempSync(join(tmpdir(), "finbook-store-"));
  temporaryDirectories.push(directory);
  return new FileBookStore(directory);
}

function loaded(store: FileBookStore): BookSnapshot {
  const result = store.load();
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

describe("FileBookStore", () => {
  it("initializes an empty book and reloads appended data", () => {
    const store = temporaryStore();
    expect(loaded(store)).toEqual({
      accounts: [],
      instruments: [],
      events: [],
      prices: [],
      fx: [],
    });

    expect(store.appendAccount(account).ok).toBe(true);
    expect(store.appendInstrument(instrument).ok).toBe(true);
    expect(store.appendEvent(event).ok).toBe(true);
    expect(
      store.appendPrice({
        instrument: "HROW",
        price: { amount: "40", currency: "USD" },
        asOf: "2026-03-01",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    expect(
      store.appendFx({
        pair: "USD/EUR",
        rate: "0.9",
        asOf: "2026-03-01",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);

    expect(loaded(store)).toEqual({
      accounts: [account],
      instruments: [instrument],
      events: [event],
      prices: [
        {
          instrument: "HROW",
          price: { amount: "40", currency: "USD" },
          asOf: "2026-03-01",
          provenance: { kind: "manual" },
        },
      ],
      fx: [
        {
          pair: "USD/EUR",
          rate: "0.9",
          asOf: "2026-03-01",
          provenance: { kind: "manual" },
        },
      ],
    });
  });

  it("rejects a duplicate source and external ID without changing the event file", () => {
    const store = temporaryStore();
    expect(store.appendEvent(event).ok).toBe(true);
    const eventPath = join(store.dataHome, "events.jsonl");
    const before = readFileSync(eventPath, "utf8");

    const duplicate = store.appendEvent({ ...event, id: "different-id" });

    expect(duplicate).toMatchObject({ ok: false, error: { type: "invariant" } });
    expect(readFileSync(eventPath, "utf8")).toBe(before);
  });

  it("rejects a duplicate event ID even without an external ID", () => {
    const store = temporaryStore();
    const first = { ...event, externalId: undefined };
    expect(store.appendEvent(first).ok).toBe(true);

    const duplicate = store.appendEvent({ ...first, date: "2026-03-02" });

    expect(duplicate).toMatchObject({ ok: false, error: { type: "invariant" } });
  });

  it("reports the file and line for corrupt JSONL", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    writeFileSync(join(store.dataHome, "events.jsonl"), `${JSON.stringify(event)}\nnot-json\n`);

    const result = store.load();

    expect(result).toMatchObject({ ok: false, error: { type: "storage" } });
    if (result.ok) throw new Error("Expected corrupt JSONL to fail");
    expect(result.error.message).toContain("events.jsonl:2");
  });

  it("sets owner-only file modes where the filesystem supports them", () => {
    if (process.platform === "win32") return;
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);

    for (const name of [
      "meta.json",
      "accounts.json",
      "instruments.json",
      "events.jsonl",
      "prices.jsonl",
      "fx.jsonl",
    ]) {
      expect(statSync(join(store.dataHome, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("uses the last appended price stamp for the same date", () => {
    const store = temporaryStore();
    expect(store.appendInstrument(instrument).ok).toBe(true);
    expect(
      store.appendPrice({
        instrument: "HROW",
        price: { amount: "40", currency: "USD" },
        asOf: "2026-03-01",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    expect(
      store.appendPrice({
        instrument: "HROW",
        price: { amount: "41", currency: "USD" },
        asOf: "2026-03-01",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    expect(
      store.appendFx({
        pair: "USD/EUR",
        rate: "0.9",
        asOf: "2026-03-01",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);

    const result = getGlance(
      {
        ...loaded(store),
        accounts: [account],
        events: [
          event,
          EventSchema.parse({
            id: "buy-1",
            date: "2026-03-01",
            source: "manual",
            type: "buy",
            account: "ib",
            instrument: "HROW",
            qty: "1",
            price: { amount: "40", currency: "USD" },
            eurPerUnit: "0.9",
          }),
        ],
      },
      "2026-03-02",
    );

    expect(result).toMatchObject({ ok: true, data: { totalEur: { amount: "90.9" } } });
  });
});
