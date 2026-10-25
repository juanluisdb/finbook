import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountSchema, EventSchema, FileBookStore, InstrumentSchema } from "@finbook/core";
import { MarketDataConfigSchema, MarketDataConfigStore } from "@finbook/market-data";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "finbook-daily-cli-"));
  directories.push(home);
  const store = new FileBookStore(home);
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
  expect(
    store.appendInstrument(
      InstrumentSchema.parse({
        id: "fund",
        name: "Example fund",
        type: "fund",
        quoteCurrency: "EUR",
      }),
    ).ok,
  ).toBe(true);
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
        id: "buy",
        source: "manual",
        date: "2026-03-02",
        account: "wallet",
        instrument: "fund",
        qty: "1",
        price: { amount: "100", currency: "EUR" },
        grossAmount: "100",
        eurPerUnit: "1",
      }),
    ).ok,
  ).toBe(true);
  expect(
    new MarketDataConfigStore(home).save(
      MarketDataConfigSchema.parse({
        bindings: [
          {
            kind: "instrument",
            instrument: "fund",
            provider: "eodhd",
            identifier: "EXAMPLE.EUFUND",
          },
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
        resolve(import.meta.dirname, "fixtures/daily-fetch.mjs"),
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

describe("built CLI daily fetching", () => {
  it("keeps ordinary views offline and reuses a completed cycle across CLI processes", () => {
    const f = fixture();
    const args = ["show", "glance", "--as-of", "2026-03-04", "--json"];
    const offline = f.run(args);
    expect(offline.status).toBe(0);
    expect(JSON.parse(offline.stdout)).toMatchObject({
      ok: true,
      data: { totalEur: null, refresh: null },
    });
    expect(f.calls()).toEqual([]);
    const first = f.run([...args, "--fetch"]);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toMatchObject({
      ok: true,
      data: {
        totalEur: { amount: "1002", currency: "EUR" },
        positions: [{ priceMark: { asOf: "2026-03-04", source: "eodhd" } }],
        refresh: { prices: { requested: 1, cached: 0, fetched: [{ asOf: "2026-03-04" }] } },
      },
    });
    const second = f.run([...args, "--fetch"]);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      ok: true,
      data: { refresh: { prices: { cached: 1, fetched: [] } } },
    });
    expect(f.calls()).toEqual(["/api/eod/EXAMPLE.EUFUND"]);
  });

  it("warns on manual conflicts and replaces them from the saved candidate", () => {
    const f = fixture();
    expect(
      f.store.appendPrice({
        instrument: "fund",
        asOf: "2026-03-04",
        price: { amount: "99", currency: "EUR" },
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    const args = ["show", "positions", "--as-of", "2026-03-04", "--fetch"];
    const kept = f.run(args);
    expect(kept.status).toBe(0);
    expect(kept.stderr).toContain("kept manual 99 EUR; fetched 102 EUR");
    expect(kept.stdout).toContain("2026-03-04 / manual");
    const replaced = f.run([...args, "--replace-manual", "--json"]);
    expect(replaced.status).toBe(0);
    expect(replaced.stderr).toBe("");
    expect(JSON.parse(replaced.stdout)).toMatchObject({
      ok: true,
      data: {
        positions: [{ priceMark: { source: "eodhd" }, valueEur: { amount: "102" } }],
        refresh: { conflicts: [{ manual: "99", fetched: "102", action: "replaced" }] },
      },
    });
    expect(f.calls()).toHaveLength(1);
    const invalid = f.run(["show", "glance", "--replace-manual", "--json"]);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, error: { type: "validation" } });
  });

  it("reports failed fetching with a partial view and retries it on the next invocation", () => {
    const f = fixture();
    const args = ["show", "glance", "--as-of", "2026-03-04", "--fetch"];
    const json = f.run([...args, "--json"], true);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "external",
        details: {
          saved: { prices: 0, fx: 0 },
          partial: { totalEur: null },
          failures: [{ subject: "fund", reason: "unavailable" }],
        },
      },
    });
    const human = f.run(args, true);
    expect(human.status).toBe(1);
    expect(human.stdout).toContain("total: unknown");
    expect(human.stderr).toContain("fund via eodhd");
    expect(f.run([...args, "--json"]).status).toBe(0);
    expect(f.calls()).toHaveLength(3);
  });

  it("retains manual conflicts in JSON when another subject fails", () => {
    const f = fixture();
    const args = ["show", "glance", "--as-of", "2026-03-04", "--fetch", "--json"];
    expect(f.run(args).status).toBe(0);
    expect(
      f.store.appendPrice({
        instrument: "fund",
        asOf: "2026-03-04",
        price: { amount: "99", currency: "EUR" },
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
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
    const partial = f.run(args);
    expect(partial.status).toBe(1);
    expect(JSON.parse(partial.stdout)).toMatchObject({
      ok: false,
      error: {
        details: {
          refresh: { conflicts: [{ manual: "99", fetched: "102", action: "kept" }] },
          failures: [{ subject: "USD" }],
        },
      },
    });
    expect(f.calls()).toEqual(["/api/eod/EXAMPLE.EUFUND"]);
  });
});
