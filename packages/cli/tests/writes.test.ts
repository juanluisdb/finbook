import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPath = resolve(repositoryRoot, "packages/cli/dist/main.js");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "finbook-write-"));
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

describe("write CLI", () => {
  it("adds an account and instrument from flags", () => {
    const dataHome = temporaryHome();
    const account = runCli(dataHome, [
      "account",
      "add",
      "--id",
      "ib",
      "--name",
      "Interactive Brokers",
      "--platform",
      "interactive-brokers",
      "--country",
      "IE",
      "--custodial",
      "broker",
      "--json",
    ]);
    const instrument = runCli(dataHome, [
      "instrument",
      "add",
      "--id",
      "HROW",
      "--name",
      "Harrow",
      "--type",
      "stock",
      "--quote-currency",
      "USD",
      "--json",
    ]);

    expect(account.status).toBe(0);
    expect(JSON.parse(account.stdout)).toMatchObject({
      ok: true,
      data: { id: "ib", country: "IE" },
    });
    expect(instrument.status).toBe(0);
    expect(JSON.parse(instrument.stdout)).toMatchObject({
      ok: true,
      data: { id: "HROW", quoteCurrency: "USD" },
    });
  });

  it("reports missing event flags as JSON validation with exit code 2", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, [
      "event",
      "add",
      "deposit",
      "--date",
      "2026-03-01",
      "--amount",
      "100",
      "--currency",
      "EUR",
      "--json",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { type: "validation", hint: expect.stringContaining("--account") },
    });
  });

  it("requires an event rate and rejects a non-one EUR rate", () => {
    const dataHome = temporaryHome();
    runCli(dataHome, [
      "account",
      "add",
      "--id",
      "ib",
      "--name",
      "Interactive Brokers",
      "--platform",
      "interactive-brokers",
      "--country",
      "IE",
      "--custodial",
      "broker",
    ]);

    const missingRate = runCli(dataHome, [
      "event",
      "add",
      "deposit",
      "--date",
      "2026-03-01",
      "--account",
      "ib",
      "--amount",
      "100",
      "--currency",
      "USD",
      "--json",
    ]);
    const wrongEurRate = runCli(dataHome, [
      "event",
      "add",
      "deposit",
      "--date",
      "2026-03-01",
      "--account",
      "ib",
      "--amount",
      "100",
      "--currency",
      "EUR",
      "--eur-per-unit",
      "0.9",
      "--json",
    ]);

    expect(missingRate.status).toBe(2);
    expect(JSON.parse(missingRate.stdout)).toMatchObject({
      ok: false,
      error: { type: "validation" },
    });
    expect(wrongEurRate.status).toBe(2);
    expect(JSON.parse(wrongEurRate.stdout)).toMatchObject({
      ok: false,
      error: { type: "validation" },
    });
  });

  it("accepts the same event through flags and a JSON file", () => {
    const dataHome = temporaryHome();
    runCli(dataHome, [
      "account",
      "add",
      "--id",
      "ib",
      "--name",
      "Interactive Brokers",
      "--platform",
      "interactive-brokers",
      "--country",
      "IE",
      "--custodial",
      "broker",
    ]);
    const flagEvent = runCli(dataHome, [
      "event",
      "add",
      "deposit",
      "--id",
      "deposit-flags",
      "--date",
      "2026-03-01",
      "--account",
      "ib",
      "--amount",
      "100",
      "--currency",
      "EUR",
      "--json",
    ]);
    const filePath = join(dataHome, "event.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        id: "deposit-file",
        date: "2026-03-02",
        account: "ib",
        amount: { amount: "50.00", currency: "EUR" },
        eurPerUnit: "1",
        source: "manual",
        type: "deposit",
      }),
    );
    const fileEvent = runCli(dataHome, ["event", "add", "--file", filePath, "--json"]);

    expect(flagEvent.status).toBe(0);
    expect(fileEvent.status).toBe(0);
    expect(JSON.parse(flagEvent.stdout)).toMatchObject({
      ok: true,
      data: { id: "deposit-flags", amount: { amount: "100", currency: "EUR" } },
    });
    expect(JSON.parse(fileEvent.stdout)).toMatchObject({
      ok: true,
      data: { id: "deposit-file", amount: { amount: "50", currency: "EUR" } },
    });
  });

  it("sets price and FX stamps", () => {
    const dataHome = temporaryHome();
    runCli(dataHome, [
      "account",
      "add",
      "--id",
      "ib",
      "--name",
      "Interactive Brokers",
      "--platform",
      "interactive-brokers",
      "--country",
      "IE",
      "--custodial",
      "broker",
    ]);
    runCli(dataHome, [
      "instrument",
      "add",
      "--id",
      "HROW",
      "--name",
      "Harrow",
      "--type",
      "stock",
      "--quote-currency",
      "USD",
    ]);
    const price = runCli(dataHome, [
      "price",
      "set",
      "--instrument",
      "HROW",
      "--amount",
      "40",
      "--currency",
      "USD",
      "--as-of",
      "2026-03-01",
      "--json",
    ]);
    const fx = runCli(dataHome, [
      "fx",
      "set",
      "--pair",
      "USD/EUR",
      "--rate",
      "0.9",
      "--as-of",
      "2026-03-01",
      "--json",
    ]);

    expect(price.status).toBe(0);
    expect(JSON.parse(price.stdout)).toMatchObject({
      ok: true,
      data: { instrument: "HROW", price: { amount: "40", currency: "USD" } },
    });
    expect(fx.status).toBe(0);
    expect(JSON.parse(fx.stdout)).toEqual({
      ok: true,
      data: { pair: "USD/EUR", rate: "0.9", asOf: "2026-03-01" },
    });
  });
});
