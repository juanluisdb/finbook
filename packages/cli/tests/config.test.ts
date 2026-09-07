import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const directory = mkdtempSync(join(tmpdir(), "finbook-config-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(
  dataHome: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, FINBOOK_HOME: dataHome, ...extraEnv },
  });
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

function addInstrument(dataHome: string, id: string): void {
  const result = runCli(dataHome, [
    "instrument",
    "add",
    "--id",
    id,
    "--name",
    "Test instrument",
    "--type",
    "fund",
    "--quote-currency",
    "EUR",
    "--json",
  ]);
  expect(result.status).toBe(0);
}

describe("provider configuration CLI", () => {
  it("shows deterministic defaults", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["config", "show", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        book: { timeZone: "Europe/Madrid" },
        marketData: { disabledProviders: [], routes: {}, bindings: [] },
      },
    });
  });

  it("persists a canonical book timezone and rejects invalid updates", () => {
    const dataHome = temporaryHome();
    const updated = runCli(dataHome, ["config", "timezone", "set", "atlantic/canary", "--json"]);

    expect(updated.status).toBe(0);
    expect(JSON.parse(updated.stdout)).toEqual({
      ok: true,
      data: { timeZone: "Atlantic/Canary" },
    });
    const metaPath = join(dataHome, "meta.json");
    const beforeInvalid = readFileSync(metaPath, "utf8");

    const invalid = runCli(dataHome, ["config", "timezone", "set", "Mars/Olympus", "--json"]);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "validation",
        message: expect.stringContaining("Invalid time zone"),
        hint: expect.stringContaining("IANA"),
      },
    });
    expect(readFileSync(metaPath, "utf8")).toBe(beforeInvalid);

    const shown = runCli(dataHome, ["config", "show", "--json"]);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      ok: true,
      data: { book: { timeZone: "Atlantic/Canary" } },
    });
  });

  it("uses the book timezone instead of the machine timezone for current views", () => {
    const dataHome = temporaryHome();
    expect(
      runCli(dataHome, ["config", "timezone", "set", "Pacific/Honolulu", "--json"]).status,
    ).toBe(0);
    const expected = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Pacific/Honolulu",
    }).format(new Date());

    const implicit = runCli(dataHome, ["show", "glance", "--json"], {
      TZ: "Europe/Madrid",
    });
    expect(JSON.parse(implicit.stdout)).toMatchObject({ ok: true, data: { asOf: expected } });

    const explicit = runCli(dataHome, ["show", "glance", "--as-of", "2026-02-28", "--json"]);
    expect(JSON.parse(explicit.stdout)).toMatchObject({
      ok: true,
      data: { asOf: "2026-02-28" },
    });
  });

  it("persists safe provider, route, and binding overrides", () => {
    const dataHome = temporaryHome();
    addInstrument(dataHome, "fund-x");
    const disabled = runCli(dataHome, ["config", "provider", "disable", "yahoo", "--json"]);
    const route = runCli(dataHome, ["config", "route", "set", "price:fund", "yahoo", "--json"]);
    const binding = runCli(dataHome, [
      "config",
      "source",
      "set",
      "--instrument",
      "fund-x",
      "--provider",
      "yahoo",
      "--identifier",
      "FUND.X",
      "--json",
    ]);
    const shown = runCli(dataHome, ["config", "show", "--json"]);

    expect(disabled.status).toBe(0);
    expect(route.status).toBe(0);
    expect(binding.status).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      ok: true,
      data: {
        book: { timeZone: "Europe/Madrid" },
        marketData: {
          disabledProviders: ["yahoo"],
          routes: { "price:fund": ["yahoo"] },
          bindings: [
            {
              kind: "instrument",
              instrument: "fund-x",
              provider: "yahoo",
              identifier: "FUND.X",
            },
          ],
        },
      },
    });
  });

  it("lists EODHD as an explicitly bound fund provider", () => {
    const dataHome = temporaryHome();
    addInstrument(dataHome, "fund-x");

    const listed = runCli(dataHome, ["config", "provider", "list", "--json"]);
    const binding = runCli(dataHome, [
      "config",
      "source",
      "set",
      "--instrument",
      "fund-x",
      "--provider",
      "eodhd",
      "--identifier",
      "FUND.X.EUFUND",
      "--json",
    ]);

    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).data).toEqual(
      expect.arrayContaining([
        {
          id: "eodhd",
          enabled: true,
          credentialEnv: "FINBOOK_EODHD_API_KEY",
          routes: [],
        },
      ]),
    );
    expect(binding.status).toBe(0);
    expect(JSON.parse(binding.stdout)).toMatchObject({
      ok: true,
      data: { provider: "eodhd", identifier: "FUND.X.EUFUND" },
    });
  });

  it("rejects an unknown instrument binding without changing configuration bytes", () => {
    const dataHome = temporaryHome();
    expect(runCli(dataHome, ["config", "show", "--json"]).status).toBe(0);
    const path = join(dataHome, "market-data.json");
    const before = readFileSync(path, "utf8");

    const result = runCli(dataHome, [
      "config",
      "source",
      "set",
      "--instrument",
      "missing",
      "--provider",
      "yahoo",
      "--identifier",
      "MISSING",
      "--json",
    ]);

    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { type: "not-found", message: "Unknown instrument ID: missing." },
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("allows a currency binding without a local registry entry", () => {
    const dataHome = temporaryHome();

    const result = runCli(dataHome, [
      "config",
      "source",
      "set",
      "--currency",
      "BTC",
      "--provider",
      "coingecko",
      "--identifier",
      "bitcoin",
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { kind: "currency", currency: "BTC", provider: "coingecko" },
    });
  });

  it("never writes or prints an environment credential", () => {
    const dataHome = temporaryHome();
    const secret = "coingecko-secret-that-must-not-appear";
    const eodhdSecret = "eodhd-secret-that-must-not-appear";
    const result = runCli(dataHome, ["config", "show", "--json"], {
      FINBOOK_COINGECKO_DEMO_API_KEY: secret,
      FINBOOK_EODHD_API_KEY: eodhdSecret,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(eodhdSecret);
    expect(result.stdout).not.toContain("apiKey");
  });

  it("rejects an unknown provider and an incomplete source binding", () => {
    const dataHome = temporaryHome();
    const unknown = runCli(dataHome, ["config", "provider", "disable", "unknown", "--json"]);
    const incomplete = runCli(dataHome, [
      "config",
      "source",
      "set",
      "--instrument",
      "fund-x",
      "--provider",
      "yahoo",
      "--json",
    ]);

    expect(unknown.status).toBe(2);
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      ok: false,
      error: { type: "validation" },
    });
    expect(incomplete.status).toBe(2);
    expect(JSON.parse(incomplete.stdout)).toMatchObject({
      ok: false,
      error: { type: "validation" },
    });
  });

  it("does not lose one of two concurrent configuration updates", async () => {
    const dataHome = temporaryHome();
    const results = await Promise.all([
      runCliAsync(dataHome, ["config", "provider", "disable", "yahoo", "--json"]),
      runCliAsync(dataHome, ["config", "provider", "disable", "coingecko", "--json"]),
    ]);
    const successful = results.filter((result) => result.status === 0);
    const failed = results.filter((result) => result.status !== 0);

    expect(successful.length).toBeGreaterThanOrEqual(1);
    expect(successful.length).toBeLessThanOrEqual(2);
    if (successful.length === 2) {
      expect(failed).toHaveLength(0);
    } else {
      expect(failed).toHaveLength(1);
      expect(failed[0]?.status).toBe(1);
      expect(JSON.parse(failed[0]?.stdout ?? "")).toMatchObject({
        ok: false,
        error: { type: "storage" },
      });
    }

    const shown = runCli(dataHome, ["config", "show", "--json"]);
    expect(shown.status).toBe(0);
    const disabled = JSON.parse(shown.stdout).data.marketData.disabledProviders;
    if (successful.length === 2) {
      expect([...disabled].sort((left, right) => left.localeCompare(right))).toEqual([
        "coingecko",
        "yahoo",
      ]);
    } else {
      const winner = JSON.parse(successful[0]?.stdout ?? "").data.disabledProviders[0];
      expect(disabled).toEqual([winner]);
    }
  });
});
