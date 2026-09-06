import { mkdtempSync, rmSync } from "node:fs";
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
  const directory = mkdtempSync(join(tmpdir(), "finbook-workflow-"));
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

function runSuccessfully(dataHome: string, args: readonly string[]) {
  const result = runCli(dataHome, [...args, "--json"]);
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
  }
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

describe("normal week workflow", () => {
  it("records a transfer, FX, trade, income, and current marks", () => {
    const dataHome = temporaryHome();
    runSuccessfully(dataHome, [
      "account",
      "add",
      "--id",
      "myinvestor",
      "--name",
      "MyInvestor",
      "--platform",
      "myinvestor",
      "--country",
      "ES",
      "--custodial",
      "broker",
    ]);
    runSuccessfully(dataHome, [
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
    runSuccessfully(dataHome, [
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
    runSuccessfully(dataHome, [
      "instrument",
      "add",
      "--id",
      "META",
      "--name",
      "Meta Platforms",
      "--type",
      "stock",
      "--quote-currency",
      "USD",
    ]);
    runSuccessfully(dataHome, [
      "event",
      "add",
      "deposit",
      "--id",
      "deposit-1",
      "--date",
      "2026-03-03",
      "--account",
      "myinvestor",
      "--amount",
      "800",
      "--currency",
      "EUR",
    ]);
    runSuccessfully(dataHome, [
      "event",
      "add",
      "transfer",
      "--id",
      "transfer-1",
      "--date",
      "2026-03-03",
      "--from",
      "myinvestor",
      "--to",
      "ib",
      "--amount",
      "800",
      "--currency",
      "EUR",
    ]);
    runSuccessfully(dataHome, [
      "event",
      "add",
      "fx",
      "--id",
      "fx-1",
      "--date",
      "2026-03-03",
      "--account",
      "ib",
      "--from-amount",
      "798",
      "--from-currency",
      "EUR",
      "--to-amount",
      "927.04",
      "--to-currency",
      "USD",
      "--fee-amount",
      "1.71",
      "--fee-currency",
      "EUR",
    ]);
    runSuccessfully(dataHome, [
      "event",
      "add",
      "buy",
      "--id",
      "buy-1",
      "--date",
      "2026-03-03",
      "--account",
      "ib",
      "--instrument",
      "HROW",
      "--qty",
      "20",
      "--price-amount",
      "40.45",
      "--price-currency",
      "USD",
      "--gross-amount",
      "809",
      "--fee-in",
      "quote",
      "--fee-amount",
      "0.28",
      "--eur-per-unit",
      "0.861",
    ]);
    runSuccessfully(dataHome, [
      "event",
      "add",
      "dividend",
      "--id",
      "dividend-1",
      "--date",
      "2026-06-25",
      "--account",
      "ib",
      "--instrument",
      "META",
      "--gross-amount",
      "1.07",
      "--gross-currency",
      "USD",
      "--withholding-foreign-amount",
      "0.16",
      "--eur-per-unit",
      "0.925",
    ]);
    runSuccessfully(dataHome, [
      "event",
      "add",
      "sell",
      "--id",
      "sell-1",
      "--date",
      "2026-08-05",
      "--account",
      "ib",
      "--instrument",
      "HROW",
      "--qty",
      "12",
      "--price-amount",
      "39.83",
      "--price-currency",
      "USD",
      "--gross-amount",
      "477.96",
      "--fee-in",
      "quote",
      "--fee-amount",
      "0.37",
      "--eur-per-unit",
      "0.866",
    ]);
    runSuccessfully(dataHome, [
      "price",
      "set",
      "--instrument",
      "HROW",
      "--amount",
      "42",
      "--currency",
      "USD",
      "--as-of",
      "2026-08-05",
    ]);
    runSuccessfully(dataHome, [
      "fx",
      "set",
      "--pair",
      "USD/EUR",
      "--rate",
      "0.9",
      "--as-of",
      "2026-08-05",
    ]);

    const glance = runSuccessfully(dataHome, ["show", "glance", "--as-of", "2026-08-05"]);
    const events = runSuccessfully(dataHome, ["event", "list", "--account", "myinvestor"]);
    const doctor = runSuccessfully(dataHome, ["doctor"]);

    expect(glance).toMatchObject({
      ok: true,
      data: {
        totalEur: { amount: "839.324", currency: "EUR" },
        contributedEur: { amount: "800", currency: "EUR" },
        pnlEur: { amount: "39.324", currency: "EUR" },
        holes: [],
      },
    });
    expect(events).toMatchObject({
      ok: true,
      data: [
        { id: "deposit-1", type: "deposit" },
        { id: "transfer-1", type: "transfer" },
      ],
    });
    expect(doctor).toMatchObject({
      ok: true,
      data: { status: "ok", eventCount: 6, holeCount: 0 },
    });
  });
});
