import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AccountSchema, EventSchema, FileBookStore, InstrumentSchema } from "@finbook/core";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "finbook-optional-rates-"));
  directories.push(home);
  const store = new FileBookStore(home);
  expect(
    store.appendAccount(
      AccountSchema.parse({
        id: "ib",
        name: "IB",
        platform: "ib",
        country: "IE",
        custodial: "broker",
      }),
    ).ok,
  ).toBe(true);
  expect(
    store.appendInstrument(
      InstrumentSchema.parse({ id: "AAPL", name: "Apple", type: "stock", quoteCurrency: "USD" }),
    ).ok,
  ).toBe(true);
  for (const fields of [
    { id: "eur", type: "deposit", amount: { amount: "1000", currency: "EUR" }, eurPerUnit: "1" },
    {
      id: "conversion",
      type: "fx",
      from: { amount: "500", currency: "EUR" },
      to: { amount: "600", currency: "USD" },
    },
  ])
    expect(
      store.appendEvent(
        EventSchema.parse({ ...fields, source: "manual", date: "2026-03-01", account: "ib" }),
      ).ok,
    ).toBe(true);
  const run = (args: readonly string[]) =>
    spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../dist/main.js"), ...args, "--json"],
      { encoding: "utf8", env: { ...process.env, FINBOOK_HOME: home } },
    );
  return { home, store, run };
}

it("records an IB conversion then rate-free trade, values it from market FX, and edits rates explicitly", () => {
  const f = fixture();
  const bought = f.run([
    "event",
    "add",
    "buy",
    "--id",
    "buy",
    "--date",
    "2026-03-02",
    "--account",
    "ib",
    "--instrument",
    "AAPL",
    "--qty",
    "1",
    "--price-amount",
    "500",
    "--price-currency",
    "USD",
    "--gross-amount",
    "500",
  ]);
  expect(bought.status, bought.stdout + bought.stderr).toBe(0);
  expect(JSON.parse(bought.stdout).data).not.toHaveProperty("eurPerUnit");
  const missing = f.run(["show", "glance", "--as-of", "2026-03-02"]);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    data: {
      totalEur: null,
      cash: [
        { currency: "EUR", balance: { amount: "500" } },
        { currency: "USD", balance: { amount: "100" } },
      ],
      positions: [{ quantity: "1" }],
    },
  });
  expect(
    f.store.appendPrice({
      instrument: "AAPL",
      asOf: "2026-03-02",
      price: { amount: "500.04", currency: "USD" },
      provenance: { kind: "manual" },
    }).ok,
  ).toBe(true);
  expect(
    f.store.appendFx({
      pair: "USD/EUR",
      asOf: "2026-03-01",
      rate: "0.8",
      provenance: { kind: "manual" },
    }).ok,
  ).toBe(true);
  expect(JSON.parse(f.run(["show", "glance", "--as-of", "2026-03-02"]).stdout)).toMatchObject({
    data: { totalEur: { amount: "980.032" }, contributedEur: { amount: "1000" } },
  });
  expect(f.run(["event", "edit", "buy", "buy", "--date", "2026-03-03"]).status).toBe(0);
  expect(f.run(["event", "edit", "buy", "buy", "--eur-per-unit", "0.9"]).status).toBe(0);
  const before = readFileSync(join(f.home, "events.jsonl"), "utf8");
  expect(f.run(["event", "edit", "buy", "buy", "--date", "2026-03-04"]).status).toBe(2);
  expect(readFileSync(join(f.home, "events.jsonl"), "utf8")).toBe(before);
  expect(
    JSON.parse(f.run(["event", "edit", "buy", "buy", "--note", "keep rate"]).stdout),
  ).toMatchObject({ data: { eurPerUnit: "0.9" } });
  const cleared = f.run([
    "event",
    "edit",
    "buy",
    "buy",
    "--date",
    "2026-03-04",
    "--clear-eur-rate",
  ]);
  expect(cleared.status, cleared.stdout + cleared.stderr).toBe(0);
  expect(JSON.parse(cleared.stdout).data).not.toHaveProperty("eurPerUnit");
  expect(JSON.parse(cleared.stdout).data).not.toHaveProperty("eurRateProvenance");
  const file = join(f.home, "fee.json");
  writeFileSync(
    file,
    JSON.stringify({
      id: "fee",
      type: "fee",
      source: "manual",
      date: "2026-03-04",
      account: "ib",
      amount: { amount: "2", currency: "USD" },
    }),
  );
  expect(f.run(["event", "add", "--file", file]).status).toBe(0);
  expect(
    f.run([
      "event",
      "add",
      "deposit",
      "--date",
      "2026-03-05",
      "--account",
      "ib",
      "--amount",
      "5",
      "--currency",
      "USD",
    ]).status,
  ).toBe(2);
  expect(f.run(["event", "edit", "deposit", "eur", "--clear-eur-rate"]).status).toBe(2);
  expect(
    f.run(["event", "edit", "buy", "buy", "--clear-eur-rate", "--eur-per-unit", "0.8"]).status,
  ).toBe(2);
});
