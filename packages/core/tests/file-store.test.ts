import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
  getGlance,
  getPositions,
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

function seedBook(store: FileBookStore): void {
  expect(store.appendAccount(account).ok).toBe(true);
  expect(store.appendInstrument(instrument).ok).toBe(true);
}

describe("FileBookStore", () => {
  it("inspects a missing book without initializing it", () => {
    const root = mkdtempSync(join(tmpdir(), "finbook-inspect-"));
    temporaryDirectories.push(root);
    const dataHome = join(root, "missing");
    const store = new FileBookStore(dataHome);

    expect(store.inspect()).toEqual({ ok: true, data: { initialized: false } });
    expect(existsSync(dataHome)).toBe(false);
  });

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
    seedBook(store);
    expect(store.appendEvent(event).ok).toBe(true);
    const eventPath = join(store.dataHome, "events.jsonl");
    const before = readFileSync(eventPath, "utf8");

    const duplicate = store.appendEvent({ ...event, id: "different-id" });

    expect(duplicate).toMatchObject({ ok: false, error: { type: "invariant" } });
    expect(readFileSync(eventPath, "utf8")).toBe(before);
  });

  it("rejects a duplicate event ID even without an external ID", () => {
    const store = temporaryStore();
    seedBook(store);
    const first = { ...event, externalId: undefined };
    expect(store.appendEvent(first).ok).toBe(true);

    const duplicate = store.appendEvent({ ...first, date: "2026-03-02" });

    expect(duplicate).toMatchObject({ ok: false, error: { type: "invariant" } });
  });

  it.each([
    ["unknown account", { ...event, id: "unknown-account", account: "missing" }],
    [
      "insufficient cash",
      {
        id: "buy-without-cash",
        date: "2026-03-01",
        source: "manual",
        type: "buy",
        account: "ib",
        instrument: "HROW",
        qty: "1",
        price: { amount: "1", currency: "USD" },
        eurPerUnit: "0.9",
      },
    ],
    [
      "oversell",
      {
        id: "sell-without-holding",
        date: "2026-03-01",
        source: "manual",
        type: "sell",
        account: "ib",
        instrument: "HROW",
        qty: "1",
        price: { amount: "1", currency: "USD" },
        eurPerUnit: "0.9",
      },
    ],
  ] as const)("rejects a direct %s event and preserves the event file", (_name, input) => {
    const store = temporaryStore();
    seedBook(store);
    const before = readFileSync(join(store.dataHome, "events.jsonl"), "utf8");

    const result = store.appendEvent(EventSchema.parse(input));

    expect(result).toMatchObject({ ok: false });
    expect(readFileSync(join(store.dataHome, "events.jsonl"), "utf8")).toBe(before);
  });

  it("rejects an append while an active book lock is held", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const lock = join(store.dataHome, ".finbook.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: "2026-08-31T12:00:00.000Z",
        token: "active-lock-token",
      }),
      { mode: 0o600 },
    );

    const result = store.appendAccount({ ...account, id: "cash" });

    expect(result).toMatchObject({ ok: false, error: { type: "storage" } });
    expect(readFileSync(join(store.dataHome, "accounts.json"), "utf8")).toBe("[]\n");
  });

  it("rejects a complete load while an active book lock is held", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const lock = join(store.dataHome, ".finbook.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: "2026-08-31T12:00:00.000Z",
        token: "active-load-token",
      }),
      { mode: 0o600 },
    );

    expect(store.load()).toMatchObject({ ok: false, error: { type: "storage" } });
  });

  it("routes every book mutator through the active lock", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const lock = join(store.dataHome, ".finbook.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: "2026-08-31T12:00:00.000Z",
        token: "active-lock-token",
      }),
      { mode: 0o600 },
    );

    const mutations = [
      store.appendAccount({ ...account, id: "cash" }),
      store.appendInstrument({ ...instrument, id: "OTHER" }),
      store.appendEvent({ ...event, id: "locked-event", externalId: undefined }),
      store.appendPrice({
        instrument: "HROW",
        price: { amount: "40", currency: "USD" },
        asOf: "2026-03-01",
        provenance: { kind: "manual" },
      }),
      store.appendFx({
        pair: "USD/EUR",
        rate: "0.9",
        asOf: "2026-03-01",
        provenance: { kind: "manual" },
      }),
      store.replaceEvent("missing", event, event),
      store.deleteEvent("missing"),
    ];

    for (const result of mutations) {
      expect(result).toMatchObject({ ok: false, error: { type: "storage" } });
    }
  });

  it("persists a valid event only after replaying the complete candidate", () => {
    const store = temporaryStore();
    seedBook(store);
    const deposit = EventSchema.parse({
      id: "deposit-usd",
      date: "2026-03-01",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "USD" },
      eurPerUnit: "0.9",
    });
    const buy = EventSchema.parse({
      id: "buy-hrow",
      date: "2026-03-02",
      source: "manual",
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "2",
      price: { amount: "10", currency: "USD" },
      eurPerUnit: "0.9",
    });

    expect(store.appendEvent(deposit).ok).toBe(true);
    expect(store.appendEvent(buy).ok).toBe(true);

    const snapshot = loaded(store);
    expect(snapshot.events).toEqual([deposit, buy]);
    expect(getGlance(snapshot, "2026-03-02")).toMatchObject({ ok: true });
  });

  it("rejects replacing a funding buy below a later sale and preserves bytes", () => {
    const store = temporaryStore();
    seedBook(store);
    const deposit = EventSchema.parse({
      id: "deposit-usd",
      date: "2026-03-01",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "USD" },
      eurPerUnit: "0.9",
    });
    const buy = EventSchema.parse({
      id: "buy-hrow",
      date: "2026-03-02",
      source: "manual",
      externalId: "broker-buy",
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "20",
      price: { amount: "2", currency: "USD" },
      eurPerUnit: "0.9",
    });
    const sell = EventSchema.parse({
      id: "sell-hrow",
      date: "2026-03-03",
      source: "manual",
      type: "sell",
      account: "ib",
      instrument: "HROW",
      qty: "20",
      price: { amount: "2", currency: "USD" },
      eurPerUnit: "0.9",
    });
    expect(store.appendEvent(deposit).ok).toBe(true);
    expect(store.appendEvent(buy).ok).toBe(true);
    expect(store.appendEvent(sell).ok).toBe(true);
    const eventPath = join(store.dataHome, "events.jsonl");
    const before = readFileSync(eventPath, "utf8");

    const result = store.replaceEvent("buy-hrow", { ...buy, qty: "15" }, buy);

    expect(result).toMatchObject({
      ok: false,
      error: { type: "invariant", message: expect.stringContaining("sell-hrow") },
    });
    expect(readFileSync(eventPath, "utf8")).toBe(before);
    expect(loaded(store).events[1]).toEqual(buy);
  });

  it("rejects deleting funding for a later operation and preserves bytes", () => {
    const store = temporaryStore();
    seedBook(store);
    const deposit = EventSchema.parse({
      id: "deposit-usd",
      date: "2026-03-01",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "USD" },
      eurPerUnit: "0.9",
    });
    const buy = EventSchema.parse({
      id: "buy-hrow",
      date: "2026-03-02",
      source: "manual",
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "2",
      price: { amount: "10", currency: "USD" },
      eurPerUnit: "0.9",
    });
    expect(store.appendEvent(deposit).ok).toBe(true);
    expect(store.appendEvent(buy).ok).toBe(true);
    const eventPath = join(store.dataHome, "events.jsonl");
    const before = readFileSync(eventPath, "utf8");

    const result = store.deleteEvent("deposit-usd");

    expect(result).toMatchObject({
      ok: false,
      error: { type: "invariant", message: expect.stringContaining("buy-hrow") },
    });
    expect(readFileSync(eventPath, "utf8")).toBe(before);
  });

  it("preserves identity and line position for a valid replacement", () => {
    const store = temporaryStore();
    seedBook(store);
    const deposit = EventSchema.parse({
      id: "deposit-usd",
      date: "2026-03-01",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "USD" },
      eurPerUnit: "0.9",
    });
    const buy = EventSchema.parse({
      id: "buy-hrow",
      date: "2026-03-02",
      source: "broker",
      externalId: "broker-buy",
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "2",
      price: { amount: "10", currency: "USD" },
      eurPerUnit: "0.9",
    });
    const independent = EventSchema.parse({
      id: "deposit-eur",
      date: "2026-03-03",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "5", currency: "EUR" },
      eurPerUnit: "1",
    });
    expect(store.appendEvent(deposit).ok).toBe(true);
    expect(store.appendEvent(buy).ok).toBe(true);
    expect(store.appendEvent(independent).ok).toBe(true);

    const replacement = { ...buy, price: { amount: "12", currency: "USD" } };
    const result = store.replaceEvent("buy-hrow", replacement, buy);

    expect(result).toEqual({ ok: true, data: replacement });
    expect(loaded(store).events).toEqual([deposit, replacement, independent]);
  });

  it.each([
    ["id", { id: "different-id" }],
    ["type", { type: "sell" }],
    ["source", { source: "different-source" }],
    ["external ID", { externalId: undefined }],
  ] as const)("rejects a changed event %s and preserves bytes", (_field, change) => {
    const store = temporaryStore();
    seedBook(store);
    const funding = EventSchema.parse({
      id: "funding",
      date: "2026-02-28",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "USD" },
      eurPerUnit: "0.9",
    });
    expect(store.appendEvent(funding).ok).toBe(true);
    const original = EventSchema.parse({
      id: "replace-me",
      date: "2026-03-01",
      source: "broker",
      externalId: "broker-1",
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "1",
      price: { amount: "10", currency: "USD" },
      eurPerUnit: "0.9",
    });
    expect(store.appendEvent(original).ok).toBe(true);
    const before = readFileSync(join(store.dataHome, "events.jsonl"), "utf8");
    const replacement = EventSchema.parse({ ...original, ...change });

    const result = store.replaceEvent(original.id, replacement, original);

    expect(result).toMatchObject({ ok: false, error: { type: "invariant" } });
    expect(readFileSync(join(store.dataHome, "events.jsonl"), "utf8")).toBe(before);
  });

  it("deletes one independent event and reports missing targets without rewriting", () => {
    const store = temporaryStore();
    seedBook(store);
    const first = EventSchema.parse({
      id: "deposit-one",
      date: "2026-03-01",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "EUR" },
      eurPerUnit: "1",
    });
    const second = EventSchema.parse({
      id: "deposit-two",
      date: "2026-03-02",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "5", currency: "EUR" },
      eurPerUnit: "1",
    });
    expect(store.appendEvent(first).ok).toBe(true);
    expect(store.appendEvent(second).ok).toBe(true);
    const eventPath = join(store.dataHome, "events.jsonl");

    const deleted = store.deleteEvent("deposit-one");
    const beforeMissing = readFileSync(eventPath, "utf8");
    const missing = store.deleteEvent("missing");

    expect(deleted).toEqual({ ok: true, data: first });
    expect(loaded(store).events).toEqual([second]);
    expect(missing).toMatchObject({ ok: false, error: { type: "not-found" } });
    expect(readFileSync(eventPath, "utf8")).toBe(beforeMissing);
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

  it("reports the exact line for schema-invalid JSONL and preserves bytes", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const eventPath = join(store.dataHome, "events.jsonl");
    const invalidEvent = { ...event, amount: { amount: "0", currency: "USD" } };
    writeFileSync(eventPath, `${JSON.stringify(event)}\n${JSON.stringify(invalidEvent)}\n`);
    const before = readFileSync(eventPath, "utf8");

    const result = store.load();

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected schema-invalid JSONL to fail");
    expect(result.error.message).toContain("events.jsonl:2");
    expect(readFileSync(eventPath, "utf8")).toBe(before);
  });

  it("rejects a blank interior JSONL line without rewriting the ledger", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const eventPath = join(store.dataHome, "events.jsonl");
    writeFileSync(eventPath, `${JSON.stringify(event)}\n\n${JSON.stringify(event)}\n`);
    const before = readFileSync(eventPath, "utf8");

    const result = store.load();

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected blank JSONL line to fail");
    expect(result.error.message).toContain("events.jsonl:2");
    expect(readFileSync(eventPath, "utf8")).toBe(before);
  });

  it("rejects an unsupported schema version without rewriting metadata", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const metaPath = join(store.dataHome, "meta.json");
    writeFileSync(metaPath, '{"schemaVersion":3,"timeZone":"Europe/Madrid"}\n');
    const before = readFileSync(metaPath, "utf8");

    expect(store.load()).toMatchObject({
      ok: false,
      error: { type: "storage", message: expect.stringContaining("schema version: 3") },
    });
    expect(readFileSync(metaPath, "utf8")).toBe(before);
  });

  it("persists a default timezone and updates it atomically", () => {
    const store = temporaryStore();

    expect(store.loadMetadata()).toEqual({
      ok: true,
      data: { schemaVersion: 2, timeZone: "Europe/Madrid" },
    });
    expect(store.setTimeZone("atlantic/canary")).toEqual({
      ok: true,
      data: { schemaVersion: 2, timeZone: "Atlantic/Canary" },
    });

    const metaPath = join(store.dataHome, "meta.json");
    const beforeInvalid = readFileSync(metaPath, "utf8");
    expect(store.setTimeZone("Mars/Olympus")).toMatchObject({
      ok: false,
      error: { type: "validation" },
    });
    expect(readFileSync(metaPath, "utf8")).toBe(beforeInvalid);
  });

  it.each([
    ["account", "accounts.json", account],
    ["instrument", "instruments.json", instrument],
  ] as const)("rejects duplicate %s IDs loaded from disk", (kind, name, value) => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const path = join(store.dataHome, name);
    writeFileSync(path, `${JSON.stringify([value, value])}\n`);
    const before = readFileSync(path, "utf8");

    const result = store.load();

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(`Duplicate ${kind} ID`) },
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("rejects a price for an unknown instrument without appending it", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const pricePath = join(store.dataHome, "prices.jsonl");
    const before = readFileSync(pricePath, "utf8");

    const result = store.appendPrice({
      instrument: "UNKNOWN",
      price: { amount: "41", currency: "USD" },
      asOf: "2026-03-01",
      provenance: { kind: "manual" },
    });

    expect(result).toMatchObject({ ok: false, error: { type: "not-found" } });
    expect(readFileSync(pricePath, "utf8")).toBe(before);
  });

  it("rejects a price outside the instrument quote currency without appending it", () => {
    const store = temporaryStore();
    expect(store.appendInstrument(instrument).ok).toBe(true);
    const pricePath = join(store.dataHome, "prices.jsonl");
    const before = readFileSync(pricePath, "utf8");

    const result = store.appendPrice({
      instrument: "HROW",
      price: { amount: "41", currency: "EUR" },
      asOf: "2026-03-01",
      provenance: { kind: "manual" },
    });

    expect(result).toMatchObject({ ok: false, error: { type: "invariant" } });
    expect(readFileSync(pricePath, "utf8")).toBe(before);
  });

  it("inspects corrupt JSONL without changing its bytes", () => {
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);
    const eventPath = join(store.dataHome, "events.jsonl");
    writeFileSync(eventPath, `${JSON.stringify(event)}\nnot-json\n`);
    const before = readFileSync(eventPath, "utf8");

    const result = store.inspect();

    expect(result).toMatchObject({ ok: false, error: { type: "storage" } });
    if (result.ok) throw new Error("Expected corrupt JSONL to fail inspection");
    expect(result.error.message).toContain("events.jsonl:2");
    expect(readFileSync(eventPath, "utf8")).toBe(before);
  });

  it("reports a replay failure while preserving a parseable ledger", () => {
    const store = temporaryStore();
    seedBook(store);
    const invalidEvent = EventSchema.parse({
      id: "buy-without-cash",
      date: "2026-03-01",
      source: "manual",
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "1",
      price: { amount: "10", currency: "USD" },
      eurPerUnit: "0.9",
    });
    const eventPath = join(store.dataHome, "events.jsonl");
    writeFileSync(eventPath, `${JSON.stringify(invalidEvent)}\n`);
    const before = readFileSync(eventPath, "utf8");

    const result = store.inspect();

    expect(result).toMatchObject({
      ok: true,
      data: {
        initialized: true,
        metadata: { schemaVersion: 2, timeZone: "Europe/Madrid" },
        replay: {
          ok: false,
          error: { message: expect.stringContaining("buy-without-cash") },
        },
      },
    });
    expect(readFileSync(eventPath, "utf8")).toBe(before);
  });

  it("sets owner-only file modes where the filesystem supports them", () => {
    if (process.platform === "win32") return;
    const store = temporaryStore();
    expect(store.load().ok).toBe(true);

    chmodSync(store.dataHome, 0o755);
    expect(store.load().ok).toBe(true);
    expect(statSync(store.dataHome).mode & 0o777).toBe(0o700);

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

  it("preserves derived positions and glance values after reload", () => {
    const store = temporaryStore();
    seedBook(store);
    expect(store.appendEvent(event).ok).toBe(true);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "buy-1",
          date: "2026-03-02",
          source: "manual",
          type: "buy",
          account: "ib",
          instrument: "HROW",
          qty: "2",
          price: { amount: "20", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendPrice({
        instrument: "HROW",
        price: { amount: "25", currency: "USD" },
        asOf: "2026-03-03",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    expect(
      store.appendFx({
        pair: "USD/EUR",
        rate: "0.8",
        asOf: "2026-03-03",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);

    const reloaded = loaded(new FileBookStore(store.dataHome));

    expect(getGlance(reloaded, "2026-03-03")).toMatchObject({
      ok: true,
      data: {
        totalEur: { amount: "88", currency: "EUR" },
        contributedEur: { amount: "90", currency: "EUR" },
        pnlEur: { amount: "-2", currency: "EUR" },
      },
    });
    expect(getPositions(reloaded, "2026-03-03")).toMatchObject({
      ok: true,
      data: {
        positions: [{ instrument: "HROW", quantity: "2", valueEur: { amount: "40" } }],
        cash: [{ currency: "USD", balance: { amount: "60" }, valueEur: { amount: "48" } }],
      },
    });
  });
});
