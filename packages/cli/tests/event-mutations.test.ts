import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const directory = mkdtempSync(join(tmpdir(), "finbook-events-"));
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

function runJson(dataHome: string, args: readonly string[]) {
  const result = runCli(dataHome, [...args, "--json"]);
  if (result.status !== 0)
    throw new Error(`${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

function runCliAsync(
  dataHome: string,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, FINBOOK_HOME: dataHome },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolveResult({ status, stdout, stderr }));
  });
}

function seedBook(dataHome: string): void {
  runJson(dataHome, [
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
  runJson(dataHome, [
    "account",
    "add",
    "--id",
    "other",
    "--name",
    "Other",
    "--platform",
    "other",
    "--country",
    "ES",
    "--custodial",
    "cash",
  ]);
  runJson(dataHome, [
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
}

function addDeposit(dataHome: string, id: string, amount = "100"): void {
  runJson(dataHome, [
    "event",
    "add",
    "deposit",
    "--id",
    id,
    "--date",
    "2026-03-01",
    "--account",
    "ib",
    "--amount",
    amount,
    "--currency",
    "USD",
    "--eur-per-unit",
    "0.9",
  ]);
}

describe("typed event CLI", () => {
  it("rejects an irrelevant deposit fee and narrows type help", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    const result = runCli(dataHome, [
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
      "--fee-amount",
      "9",
      "--json",
    ]);
    const depositHelp = runCli(dataHome, ["event", "add", "deposit", "--help"]);
    const buyHelp = runCli(dataHome, ["event", "add", "buy", "--help"]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { type: "validation" } });
    expect(depositHelp.status).toBe(0);
    expect(depositHelp.stdout).not.toContain("--fee-amount");
    expect(buyHelp.stdout).toContain("--qty");
    expect(buyHelp.stdout).toContain("--fee-amount");
  });

  it("keeps one valid command shape for every event type", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    addDeposit(dataHome, "deposit-usd", "100");

    const commands: readonly (readonly string[])[] = [
      [
        "withdrawal",
        "--account",
        "ib",
        "--amount",
        "1",
        "--currency",
        "USD",
        "--eur-per-unit",
        "0.9",
      ],
      ["transfer", "--from", "ib", "--to", "other", "--amount", "1", "--currency", "USD"],
      [
        "fx",
        "--account",
        "ib",
        "--from-amount",
        "1",
        "--from-currency",
        "USD",
        "--to-amount",
        "0.9",
        "--to-currency",
        "EUR",
      ],
      [
        "buy",
        "--account",
        "ib",
        "--instrument",
        "HROW",
        "--qty",
        "1",
        "--price-amount",
        "10",
        "--price-currency",
        "USD",
        "--eur-per-unit",
        "0.9",
      ],
      [
        "sell",
        "--account",
        "ib",
        "--instrument",
        "HROW",
        "--qty",
        "0.5",
        "--price-amount",
        "10",
        "--price-currency",
        "USD",
        "--eur-per-unit",
        "0.9",
      ],
      [
        "dividend",
        "--account",
        "ib",
        "--instrument",
        "HROW",
        "--gross-amount",
        "1",
        "--gross-currency",
        "USD",
        "--eur-per-unit",
        "0.9",
      ],
      [
        "interest",
        "--account",
        "ib",
        "--gross-amount",
        "1",
        "--gross-currency",
        "USD",
        "--eur-per-unit",
        "0.9",
      ],
      ["fee", "--account", "ib", "--amount", "1", "--currency", "USD", "--eur-per-unit", "0.9"],
    ];

    for (const [index, command] of commands.entries()) {
      const result = runJson(dataHome, [
        "event",
        "add",
        ...command,
        "--id",
        `event-${index}`,
        "--date",
        "2026-03-04",
      ]);
      expect(result).toMatchObject({ ok: true, data: { type: command[0] } });
    }
  });

  it("keeps file add canonical and rejects malformed files without writing", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    const path = join(dataHome, "bad-event.json");
    writeFileSync(path, "{not-json");

    const result = runCli(dataHome, ["event", "add", "--file", path, "--json"]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { type: "validation" } });
    expect(JSON.parse(runCli(dataHome, ["event", "list", "--json"]).stdout)).toMatchObject({
      ok: true,
      data: [],
    });
  });

  it("edits only supplied fields and explicitly clears a fee", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    addDeposit(dataHome, "deposit-usd");
    runJson(dataHome, [
      "event",
      "add",
      "buy",
      "--id",
      "buy-1",
      "--date",
      "2026-03-02",
      "--account",
      "ib",
      "--instrument",
      "HROW",
      "--qty",
      "2",
      "--price-amount",
      "10",
      "--price-currency",
      "USD",
      "--fee-amount",
      "1",
      "--eur-per-unit",
      "0.9",
    ]);

    const result = runJson(dataHome, [
      "event",
      "edit",
      "buy",
      "buy-1",
      "--qty",
      "1",
      "--clear-fee",
    ]);

    expect(result).toMatchObject({
      ok: true,
      data: {
        id: "buy-1",
        type: "buy",
        qty: "1",
        price: { amount: "10", currency: "USD" },
      },
    });
    expect(result.data).not.toHaveProperty("fee");
  });

  it("rejects no-op, conflicting, and wrong-type edits", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    addDeposit(dataHome, "deposit-usd");
    runJson(dataHome, [
      "event",
      "add",
      "buy",
      "--id",
      "buy-1",
      "--date",
      "2026-03-02",
      "--account",
      "ib",
      "--instrument",
      "HROW",
      "--qty",
      "2",
      "--price-amount",
      "10",
      "--price-currency",
      "USD",
      "--eur-per-unit",
      "0.9",
    ]);

    const noOp = runCli(dataHome, ["event", "edit", "buy", "buy-1", "--json"]);
    const conflicting = runCli(dataHome, [
      "event",
      "edit",
      "buy",
      "buy-1",
      "--fee-amount",
      "1",
      "--clear-fee",
      "--json",
    ]);
    const wrongType = runCli(dataHome, ["event", "edit", "sell", "buy-1", "--qty", "1", "--json"]);

    expect(noOp.status).toBe(2);
    expect(conflicting.status).toBe(2);
    expect(wrongType.status).toBe(2);
    expect(JSON.parse(runCli(dataHome, ["event", "get", "buy-1", "--json"]).stdout)).toMatchObject({
      data: { qty: "2" },
    });
  });

  it("requires a fresh rate when editing a rate-bearing date", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    addDeposit(dataHome, "deposit-usd");

    const rejected = runCli(dataHome, [
      "event",
      "edit",
      "deposit",
      "deposit-usd",
      "--date",
      "2026-03-02",
      "--json",
    ]);
    const accepted = runJson(dataHome, [
      "event",
      "edit",
      "deposit",
      "deposit-usd",
      "--date",
      "2026-03-02",
      "--eur-per-unit",
      "0.8",
    ]);

    expect(rejected.status).toBe(2);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, error: { type: "validation" } });
    expect(accepted).toMatchObject({ ok: true, data: { date: "2026-03-02", eurPerUnit: "0.8" } });
    expect(accepted.data).not.toHaveProperty("eurRateProvenance");
  });

  it("rejects a dependent edit and delete without changing the book", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    addDeposit(dataHome, "deposit-usd");
    runJson(dataHome, [
      "event",
      "add",
      "buy",
      "--id",
      "buy-1",
      "--date",
      "2026-03-02",
      "--account",
      "ib",
      "--instrument",
      "HROW",
      "--qty",
      "20",
      "--price-amount",
      "2",
      "--price-currency",
      "USD",
      "--eur-per-unit",
      "0.9",
    ]);
    runJson(dataHome, [
      "event",
      "add",
      "sell",
      "--id",
      "sell-1",
      "--date",
      "2026-03-03",
      "--account",
      "ib",
      "--instrument",
      "HROW",
      "--qty",
      "20",
      "--price-amount",
      "2",
      "--price-currency",
      "USD",
      "--eur-per-unit",
      "0.9",
    ]);

    const human = runCli(dataHome, ["event", "edit", "buy", "buy-1", "--qty", "15"]);
    const json = runCli(dataHome, ["event", "edit", "buy", "buy-1", "--qty", "15", "--json"]);
    const original = JSON.parse(runCli(dataHome, ["event", "get", "buy-1", "--json"]).stdout);

    expect(human.status).toBe(2);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("buy-1");
    expect(human.stderr).toContain("sell-1");
    expect(human.stderr).toContain("no changes were written");
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "invariant",
        details: { blockingEvent: { id: "sell-1" } },
      },
    });
    expect(original).toMatchObject({ data: { qty: "20" } });
  });

  it("deletes an independent event and returns its canonical value", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    addDeposit(dataHome, "deposit-one", "100");
    addDeposit(dataHome, "deposit-two", "5");

    const result = runJson(dataHome, ["event", "delete", "deposit-one"]);

    expect(result).toMatchObject({ ok: true, data: { id: "deposit-one", type: "deposit" } });
    expect(JSON.parse(runCli(dataHome, ["event", "list", "--json"]).stdout)).toMatchObject({
      data: [{ id: "deposit-two" }],
    });
  });

  it("reports an active lock through the built CLI", () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    const lock = join(dataHome, ".finbook.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: "2026-08-31T12:00:00.000Z",
        token: "active-token",
      }),
      { mode: 0o600 },
    );

    const result = runCli(dataHome, ["event", "delete", "missing", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { type: "storage" } });
    expect(readFileSync(join(dataHome, "events.jsonl"), "utf8")).toBe("");
  });

  it("serializes competing withdrawals at the process boundary", async () => {
    const dataHome = temporaryHome();
    seedBook(dataHome);
    runJson(dataHome, [
      "event",
      "add",
      "deposit",
      "--id",
      "deposit-eur",
      "--date",
      "2026-03-01",
      "--account",
      "ib",
      "--amount",
      "100",
      "--currency",
      "EUR",
      "--eur-per-unit",
      "1",
    ]);

    const withdrawal = (id: string) => [
      "event",
      "add",
      "withdrawal",
      "--id",
      id,
      "--date",
      "2026-03-02",
      "--account",
      "ib",
      "--amount",
      "75",
      "--currency",
      "EUR",
      "--eur-per-unit",
      "1",
      "--json",
    ];
    const results = await Promise.all([
      runCliAsync(dataHome, withdrawal("withdrawal-one")),
      runCliAsync(dataHome, withdrawal("withdrawal-two")),
    ]);

    expect(results.filter((result) => result.status === 0)).toHaveLength(1);
    expect(results.filter((result) => result.status !== 0)).toHaveLength(1);
    expect(results.find((result) => result.status !== 0)).toMatchObject({ status: 1 });
    const events = runJson(dataHome, ["event", "list"]);
    expect(
      events.data.filter((event: { type: string }) => event.type === "withdrawal"),
    ).toHaveLength(1);
    expect(runCli(dataHome, ["show", "glance", "--as-of", "2026-03-02", "--json"]).status).toBe(0);
  });
});
