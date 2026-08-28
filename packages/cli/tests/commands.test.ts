import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
  type Account,
  type Instrument,
} from "@finbook/core";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPath = resolve(repositoryRoot, "packages/cli/dist/main.js");
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
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "finbook-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(dataHome: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, FINBOOK_HOME: dataHome },
  });
}

function seedAccount(store: FileBookStore): void {
  expect(store.appendAccount(account).ok).toBe(true);
  expect(store.appendInstrument(instrument).ok).toBe(true);
}

describe("read CLI", () => {
  it("lists and gets configured accounts as JSON", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);

    const list = runCli(dataHome, ["account", "list", "--json"]);
    const get = runCli(dataHome, ["account", "get", "ib", "--json"]);

    expect(list.status).toBe(0);
    expect(list.stderr).toBe("");
    expect(JSON.parse(list.stdout)).toEqual({ ok: true, data: [account] });
    expect(get.status).toBe(0);
    expect(JSON.parse(get.stdout)).toEqual({ ok: true, data: account });
  });

  it("filters events with inclusive account and date bounds", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
    const first = EventSchema.parse({
      id: "deposit-1",
      date: "2026-03-01",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "EUR" },
    });
    const second = EventSchema.parse({
      id: "deposit-2",
      date: "2026-03-02",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "50", currency: "EUR" },
    });
    expect(store.appendEvent(first).ok).toBe(true);
    expect(store.appendEvent(second).ok).toBe(true);

    const result = runCli(dataHome, [
      "event",
      "list",
      "--account",
      "ib",
      "--from",
      "2026-03-01",
      "--to",
      "2026-03-01",
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: [first] });
  });

  it("returns not-found errors with exit code 3", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["account", "get", "missing", "--json"]);

    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { type: "not-found" },
    });
  });

  it("shows a complete glance using current cash valuation", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "deposit-eur",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "EUR" },
        }),
      ).ok,
    ).toBe(true);

    const result = runCli(dataHome, ["show", "glance", "--as-of", "2026-03-05", "--json"]);
    const body = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(body).toMatchObject({
      ok: true,
      data: {
        asOf: "2026-03-05",
        totalEur: { amount: "100", currency: "EUR" },
        contributedEur: { amount: "100", currency: "EUR" },
        pnlEur: { amount: "0", currency: "EUR" },
        holes: [],
        byPlatform: [{ key: "interactive-brokers", valueEur: { amount: "100" }, weight: "1" }],
      },
    });
  });

  it("lists stamps and shows as-of positions as JSON", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "deposit-usd",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "buy-hrow",
          date: "2026-03-02",
          source: "manual",
          type: "buy",
          account: "ib",
          instrument: "HROW",
          qty: "1",
          price: { amount: "40", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendPrice({
        instrument: "HROW",
        price: { amount: "45", currency: "USD" },
        asOf: "2026-03-03",
      }).ok,
    ).toBe(true);
    expect(store.appendFx({ pair: "USD/EUR", rate: "0.9", asOf: "2026-03-03" }).ok).toBe(true);

    const prices = runCli(dataHome, ["price", "list", "--json"]);
    const fx = runCli(dataHome, ["fx", "list", "--json"]);
    const positions = runCli(dataHome, ["show", "positions", "--as-of", "2026-03-04", "--json"]);

    expect(prices.status).toBe(0);
    expect(JSON.parse(prices.stdout)).toMatchObject({ ok: true, data: [{ instrument: "HROW" }] });
    expect(fx.status).toBe(0);
    expect(JSON.parse(fx.stdout)).toMatchObject({ ok: true, data: [{ pair: "USD/EUR" }] });
    expect(positions.status).toBe(0);
    expect(JSON.parse(positions.stdout)).toMatchObject({
      ok: true,
      data: {
        positions: [{ instrument: "HROW", quantity: "1", valueEur: { amount: "40.5" } }],
        cash: [{ currency: "USD", balance: { amount: "60" }, valueEur: { amount: "54" } }],
      },
    });
  });

  it("keeps JSON data on stdout and diagnostics on stderr", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["account", "list", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: [] });
  });
});
