import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AccountSchema, EventSchema, FileBookStore, InstrumentSchema } from "@finbook/core";
import { MarketDataConfigSchema, MarketDataConfigStore } from "@finbook/market-data";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "finbook-mixed-history-"));
  homes.push(home);
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
      InstrumentSchema.parse({ id: "BTC", name: "Bitcoin", type: "crypto", quoteCurrency: "EUR" }),
    ).ok,
  ).toBe(true);
  for (const event of [
    {
      id: "deposit",
      type: "deposit",
      date: "2026-10-20",
      amount: { amount: "2000", currency: "EUR" },
      eurPerUnit: "1",
    },
    {
      id: "buy",
      type: "buy",
      date: "2026-10-20",
      instrument: "BTC",
      qty: "0.01",
      price: { amount: "70000", currency: "EUR" },
      grossAmount: "700",
    },
    {
      id: "sell",
      type: "sell",
      date: "2026-10-23",
      instrument: "BTC",
      qty: "0.01",
      price: { amount: "71000", currency: "EUR" },
      grossAmount: "710",
    },
  ])
    expect(
      store.appendEvent(EventSchema.parse({ ...event, source: "manual", account: "broker" })).ok,
    ).toBe(true);
  expect(
    new MarketDataConfigStore(home).save(
      MarketDataConfigSchema.parse({
        bindings: [
          { kind: "instrument", instrument: "BTC", provider: "coingecko", identifier: "bitcoin" },
        ],
      }),
    ).ok,
  ).toBe(true);
  const log = join(home, "http.log");
  const run = (args: readonly string[], offline = false, failCrypto = false) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        resolve(import.meta.dirname, "fixtures/mixed-history.mjs"),
        resolve(import.meta.dirname, "../dist/main.js"),
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FINBOOK_HOME: home,
          FINBOOK_EODHD_API_KEY: "fixture-key",
          FINBOOK_COINGECKO_DEMO_API_KEY: "",
          FINBOOK_TEST_HTTP_LOG: log,
          FINBOOK_TEST_OFFLINE: String(offline),
          FINBOOK_TEST_FAIL_CRYPTO: String(failCrypto),
        },
      },
    );
  return {
    home,
    store,
    run,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

it("updates Bitcoin through the SDK range and values each recorded day at its closing midnight", () => {
  const f = fixture();
  const updated = f.run(["update", "--json"]);
  expect(updated.status, updated.stdout + updated.stderr).toBe(0);
  expect(JSON.parse(updated.stdout)).toMatchObject({
    data: { saved: { prices: 3, fx: 0 }, failures: [] },
  });
  const history = f.run(
    ["show", "history", "--from", "2026-10-20", "--to", "2026-10-23", "--json"],
    true,
  );
  expect(history.status, history.stdout + history.stderr).toBe(0);
  expect(
    JSON.parse(history.stdout).data.map(
      (row: { totalEur: { amount: string } }) => row.totalEur.amount,
    ),
  ).toEqual(["2038.8445739183653", "2048.4624990354716", "2024.7733832576385", "2010"]);
  expect(f.calls()).toEqual(["api.coingecko.com/api/v3/coins/bitcoin/market_chart/range"]);
  expect(f.run(["update", "--json"], true).status).toBe(0);
  expect(f.calls()).toHaveLength(1);
});

it("maintains a mixed fund, stock, crypto and cash history offline, including a contribution and earlier correction", () => {
  const f = fixture();
  expect(
    f.store.appendInstrument(
      InstrumentSchema.parse({
        id: "fund",
        name: "Vanguard EUR reference",
        isin: "IE00B03HD191",
        type: "fund",
        quoteCurrency: "EUR",
      }),
    ).ok,
  ).toBe(true);
  expect(
    f.store.appendInstrument(
      InstrumentSchema.parse({ id: "AAPL", name: "Apple", type: "stock", quoteCurrency: "USD" }),
    ).ok,
  ).toBe(true);
  for (const event of [
    {
      id: "fund-buy",
      type: "buy",
      date: "2026-10-20",
      instrument: "fund",
      qty: "10",
      price: { amount: "20", currency: "EUR" },
      grossAmount: "200",
    },
    {
      id: "conversion",
      type: "fx",
      date: "2026-10-20",
      from: { amount: "500", currency: "EUR" },
      to: { amount: "600", currency: "USD" },
      fee: { amount: "1.5", currency: "EUR" },
    },
    {
      id: "stock-buy",
      type: "buy",
      date: "2026-10-20",
      instrument: "AAPL",
      qty: "1",
      price: { amount: "100", currency: "USD" },
      grossAmount: "100",
      fee: { kind: "quote", amount: "1" },
    },
    {
      id: "fund-sell",
      type: "sell",
      date: "2026-10-22",
      instrument: "fund",
      qty: "10",
      price: { amount: "22", currency: "EUR" },
      grossAmount: "220",
    },
  ])
    expect(
      f.store.appendEvent(EventSchema.parse({ ...event, source: "manual", account: "broker" })).ok,
    ).toBe(true);
  expect(
    new MarketDataConfigStore(f.home).save(
      MarketDataConfigSchema.parse({
        bindings: [
          { kind: "instrument", instrument: "fund", provider: "eodhd", identifier: "FUND.EUFUND" },
          { kind: "instrument", instrument: "AAPL", provider: "eodhd", identifier: "AAPL.US" },
          { kind: "instrument", instrument: "BTC", provider: "coingecko", identifier: "bitcoin" },
        ],
      }),
    ).ok,
  ).toBe(true);
  expect(
    f.store.appendPrice({
      instrument: "BTC",
      asOf: "2026-10-21",
      price: { amount: "80000", currency: "EUR" },
      provenance: { kind: "manual" },
    }).ok,
  ).toBe(true);
  const updated = f.run(["update", "--json"]);
  expect(updated.status, updated.stdout + updated.stderr).toBe(0);
  expect(JSON.parse(updated.stdout)).toMatchObject({
    data: {
      saved: { prices: 7, fx: 1 },
      conflicts: [
        {
          subject: "BTC",
          asOf: "2026-10-21",
          manual: "80000",
          fetched: "74846.24990354716",
          action: "kept",
        },
      ],
    },
  });
  const historyArgs = ["show", "history", "--from", "2026-10-20", "--to", "2026-10-23", "--json"];
  const manual = JSON.parse(f.run(historyArgs, true).stdout).data;
  expect(manual[1].totalEur.amount).toBe("2101.7");
  expect(
    f.run(
      [
        "price",
        "set",
        "--instrument",
        "BTC",
        "--amount",
        "74846.24990354716",
        "--currency",
        "EUR",
        "--as-of",
        "2026-10-21",
        "--json",
      ],
      true,
    ).status,
  ).toBe(0);
  const history = JSON.parse(f.run(historyArgs, true).stdout).data;
  expect(history.map((row: { totalEur: { amount: string } }) => row.totalEur.amount)).toEqual([
    "2020.5445739183653",
    "2050.1624990354716",
    "2028.0733832576385",
    "2013.3",
  ]);
  expect(history[0]).toMatchObject({
    positions: expect.arrayContaining([
      expect.objectContaining({
        instrument: "fund",
        priceMark: { asOf: "2026-10-19", source: "eodhd" },
      }),
      expect.objectContaining({
        instrument: "AAPL",
        priceMark: { asOf: "2026-10-20", source: "eodhd" },
        fxMark: { asOf: "2026-10-19", source: "ecb" },
      }),
      expect.objectContaining({
        instrument: "BTC",
        priceMark: { asOf: "2026-10-20", source: "coingecko" },
      }),
    ]),
  });
  for (const command of ["glance", "positions"]) {
    const result = JSON.parse(
      f.run(["show", command, "--as-of", "2026-10-23", "--json"], true).stdout,
    ).data;
    if (command === "glance") expect(result.totalEur).toEqual(history[3].totalEur);
    expect(result.positions).toEqual(history[3].positions);
    expect(result.cash).toEqual(history[3].cash);
  }
  expect(
    f.run(
      [
        "event",
        "add",
        "deposit",
        "--id",
        "topup",
        "--date",
        "2026-10-23",
        "--account",
        "broker",
        "--amount",
        "500",
        "--currency",
        "EUR",
        "--json",
      ],
      true,
    ).status,
  ).toBe(0);
  expect(
    JSON.parse(f.run(["show", "glance", "--as-of", "2026-10-23", "--json"], true).stdout),
  ).toMatchObject({ data: { totalEur: { amount: "2513.3" }, contributedEur: { amount: "2500" } } });
  expect(
    f.run(["event", "edit", "buy", "stock-buy", "--gross-amount", "101", "--json"], true).status,
  ).toBe(0);
  expect(
    JSON.parse(f.run(["show", "glance", "--as-of", "2026-10-23", "--json"], true).stdout),
  ).toMatchObject({ data: { totalEur: { amount: "2512.5" }, contributedEur: { amount: "2500" } } });
  expect(f.run(["update", "--json"], true).status).toBe(0);
  expect(f.calls()).toHaveLength(4);
  expect(existsSync(join(f.home, "market-refresh.jsonl"))).toBe(false);
});

it("keeps available history when crypto fails and retries only that subject", () => {
  const f = fixture();
  expect(
    f.store.appendInstrument(
      InstrumentSchema.parse({ id: "fund", name: "Fund", type: "fund", quoteCurrency: "EUR" }),
    ).ok,
  ).toBe(true);
  expect(
    f.store.appendEvent(
      EventSchema.parse({
        id: "fund-buy",
        date: "2026-10-20",
        type: "buy",
        source: "manual",
        account: "broker",
        instrument: "fund",
        qty: "1",
        price: { amount: "20", currency: "EUR" },
        grossAmount: "20",
      }),
    ).ok,
  ).toBe(true);
  expect(
    new MarketDataConfigStore(f.home).save(
      MarketDataConfigSchema.parse({
        bindings: [
          { kind: "instrument", instrument: "BTC", provider: "coingecko", identifier: "bitcoin" },
          { kind: "instrument", instrument: "fund", provider: "eodhd", identifier: "FUND.EUFUND" },
        ],
      }),
    ).ok,
  ).toBe(true);
  const failed = f.run(["update", "--json"], false, true);
  expect(failed.status).toBe(1);
  expect(JSON.parse(failed.stdout)).toMatchObject({
    error: {
      details: {
        saved: { prices: 2, fx: 0 },
        failures: [{ subject: "BTC", error: { kind: "unavailable" } }],
      },
    },
  });
  expect(
    JSON.parse(f.run(["show", "glance", "--as-of", "2026-10-20", "--json"], true).stdout),
  ).toMatchObject({
    data: {
      totalEur: null,
      positions: expect.arrayContaining([
        expect.objectContaining({
          instrument: "fund",
          valueEur: { amount: "20", currency: "EUR" },
        }),
      ]),
    },
  });
  expect(f.run(["update", "--json"]).status).toBe(0);
  expect(f.calls()).toHaveLength(3);
});

it("leaves unavailable early crypto values unknown while later dates use saved observations", () => {
  const f = fixture();
  for (const event of [
    {
      id: "early-cash",
      type: "deposit",
      amount: { amount: "100", currency: "EUR" },
      eurPerUnit: "1",
    },
    {
      id: "early-buy",
      type: "buy",
      instrument: "BTC",
      qty: "0.001",
      price: { amount: "50000", currency: "EUR" },
      grossAmount: "50",
    },
  ])
    expect(
      f.store.appendEvent(
        EventSchema.parse({ ...event, date: "2020-01-01", source: "manual", account: "broker" }),
      ).ok,
    ).toBe(true);
  expect(f.run(["update", "--json"]).status).toBe(0);
  const early = f.run(["show", "glance", "--as-of", "2020-01-01", "--json"], true);
  expect(JSON.parse(early.stdout)).toMatchObject({
    data: { totalEur: null, holes: [{ sourceId: "price:BTC" }] },
  });
  const later = JSON.parse(
    f.run(["show", "glance", "--as-of", "2026-10-21", "--json"], true).stdout,
  ).data;
  expect(later.totalEur.amount).toBe("2173.30874893901876");
  expect(f.calls()).toHaveLength(1);
});

it("keeps view commands offline and rejects their removed fetching flags", () => {
  const f = fixture();
  const rejected = f.run(["show", "glance", "--fetch", "--json"]);
  expect(rejected.status).toBe(2);
  expect(JSON.parse(rejected.stdout)).toMatchObject({
    ok: false,
    error: { type: "validation", message: expect.stringContaining("unknown option") },
  });
  expect(f.calls()).toEqual([]);
  expect(f.run(["show", "positions", "--replace-manual", "--json"]).status).toBe(2);
});
