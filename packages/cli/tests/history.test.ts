import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AccountSchema, EventSchema, FileBookStore, InstrumentSchema } from "@finbook/core";
import { MarketDataConfigSchema, MarketDataConfigStore } from "@finbook/market-data";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "finbook-history-cli-"));
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
  for (const event of [
    {
      type: "deposit",
      id: "deposit",
      date: "2024-09-01",
      amount: { amount: "1000", currency: "EUR" },
    },
    {
      type: "buy",
      id: "buy",
      date: "2024-09-02",
      instrument: "fund",
      qty: "20",
      price: { amount: "40", currency: "EUR" },
      grossAmount: "800",
    },
    {
      type: "sell",
      id: "sell",
      date: "2024-09-09",
      instrument: "fund",
      qty: "20",
      price: { amount: "43", currency: "EUR" },
      grossAmount: "860",
    },
  ])
    expect(
      store.appendEvent(
        EventSchema.parse({ ...event, account: "broker", source: "manual", eurPerUnit: "1" }),
      ).ok,
    ).toBe(true);
  expect(
    new MarketDataConfigStore(home).save(
      MarketDataConfigSchema.parse({
        bindings: [
          { kind: "instrument", instrument: "fund", provider: "eodhd", identifier: "FUND.EUFUND" },
        ],
      }),
    ).ok,
  ).toBe(true);
  const log = join(home, "http.log");
  const run = (args: readonly string[], fail = false) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        resolve(import.meta.dirname, "fixtures/history.mjs"),
        resolve(import.meta.dirname, "../dist/main.js"),
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FINBOOK_HOME: home,
          FINBOOK_EODHD_API_KEY: "fixture-key",
          FINBOOK_TEST_HTTP_LOG: log,
          FINBOOK_TEST_FAIL: String(fail),
        },
      },
    );
  return {
    store,
    run,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

it("updates sold-fund history once and reads eleven daily values offline across processes", () => {
  const f = fixture();
  const args = ["show", "history", "--from", "2024-09-01", "--to", "2024-09-11", "--json"];
  const before = f.run(args);
  expect(before.status, before.stdout + before.stderr).toBe(0);
  expect(JSON.parse(before.stdout).data[1].totalEur).toBeNull();
  expect(f.calls()).toEqual([]);
  const updated = f.run(["update", "--json"]);
  expect(updated.status, updated.stdout + updated.stderr).toBe(0);
  expect(JSON.parse(updated.stdout)).toMatchObject({
    ok: true,
    data: {
      checked: [{ subject: "fund", from: "2024-09-02", through: "2024-09-08" }],
      saved: { prices: 3, fx: 0 },
      failures: [],
    },
  });
  const after = f.run(args);
  expect(after.status).toBe(0);
  expect(
    JSON.parse(after.stdout).data.map(
      (row: { totalEur: { amount: string } }) => row.totalEur.amount,
    ),
  ).toEqual([
    "1000",
    "1000",
    "1020",
    "1020",
    "1020",
    "1040",
    "1040",
    "1040",
    "1060",
    "1060",
    "1060",
  ]);
  expect(JSON.parse(after.stdout).data[7].positions[0].priceMark).toEqual({
    asOf: "2024-09-06",
    source: "eodhd",
  });
  const reused = f.run(["update", "--json"], true);
  expect(reused.status).toBe(0);
  expect(JSON.parse(reused.stdout)).toMatchObject({
    data: { saved: { prices: 0, fx: 0 }, reused: [{ subject: "fund" }] },
  });
  expect(f.calls()).toHaveLength(1);
  const human = f.run(args.slice(0, -1));
  expect(human.stdout).toContain("1040.00 EUR");
  expect(human.stdout).toContain("fund price 2024-09-06");
});

it("reports provider failures, retries unchecked history, and rejects invalid intervals", () => {
  const f = fixture();
  const failed = f.run(["update", "--json"], true);
  expect(failed.status).toBe(1);
  expect(JSON.parse(failed.stdout)).toMatchObject({
    ok: false,
    error: {
      type: "external",
      details: {
        failures: [{ subject: "fund", error: { kind: "unavailable" } }],
        saved: { prices: 0, fx: 0 },
      },
    },
  });
  expect(f.run(["update", "--json"]).status).toBe(0);
  expect(f.calls()).toHaveLength(2);
  const invalid = f.run([
    "show",
    "history",
    "--from",
    "2024-09-11",
    "--to",
    "2024-09-01",
    "--json",
  ]);
  expect(invalid.status).toBe(2);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, error: { type: "validation" } });
});

it("returns a failed JSON envelope with saved newer work and retries only the older failure", () => {
  const f = fixture();
  expect(
    f.store.appendInstrument(
      InstrumentSchema.parse({ id: "old", name: "Old fund", type: "fund", quoteCurrency: "EUR" }),
    ).ok,
  ).toBe(true);
  for (const event of [
    {
      type: "deposit",
      id: "old-deposit",
      date: "2024-01-01",
      amount: { amount: "1000", currency: "EUR" },
    },
    {
      type: "buy",
      id: "old-buy",
      date: "2024-01-02",
      instrument: "old",
      qty: "20",
      price: { amount: "40", currency: "EUR" },
      grossAmount: "800",
    },
    {
      type: "sell",
      id: "old-sell",
      date: "2024-01-03",
      instrument: "old",
      qty: "20",
      price: { amount: "40", currency: "EUR" },
      grossAmount: "800",
    },
  ])
    expect(
      f.store.appendEvent(
        EventSchema.parse({ ...event, account: "broker", source: "manual", eurPerUnit: "1" }),
      ).ok,
    ).toBe(true);
  expect(
    new MarketDataConfigStore(f.store.dataHome).save(
      MarketDataConfigSchema.parse({
        bindings: [
          { kind: "instrument", instrument: "old", provider: "eodhd", identifier: "OLD.EUFUND" },
          { kind: "instrument", instrument: "fund", provider: "eodhd", identifier: "FUND.EUFUND" },
        ],
      }),
    ).ok,
  ).toBe(true);
  const first = f.run(["update", "--json"]);
  expect(first.status).toBe(1);
  expect(JSON.parse(first.stdout)).toMatchObject({
    ok: false,
    error: {
      type: "external",
      details: {
        checked: [{ subject: "fund" }],
        saved: { prices: 3, fx: 0 },
        failures: [{ subject: "old" }],
      },
    },
  });
  const second = f.run(["update", "--json"]);
  expect(second.status).toBe(1);
  expect(JSON.parse(second.stdout)).toMatchObject({
    error: {
      details: {
        reused: [{ subject: "fund" }],
        saved: { prices: 0, fx: 0 },
        failures: [{ subject: "old" }],
      },
    },
  });
  expect(f.calls()).toEqual(["/api/eod/FUND.EUFUND", "/api/eod/OLD.EUFUND", "/api/eod/OLD.EUFUND"]);
});
