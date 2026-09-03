import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("provider configuration CLI", () => {
  it("shows deterministic defaults", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["config", "show", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { disabledProviders: [], routes: {}, bindings: [] },
    });
  });

  it("persists safe provider, route, and binding overrides", () => {
    const dataHome = temporaryHome();
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
        disabledProviders: ["yahoo"],
        routes: { "price:fund": ["yahoo"] },
        bindings: [
          { kind: "instrument", instrument: "fund-x", provider: "yahoo", identifier: "FUND.X" },
        ],
      },
    });
  });

  it("never writes or prints an environment credential", () => {
    const dataHome = temporaryHome();
    const secret = "coingecko-secret-that-must-not-appear";
    const result = runCli(dataHome, ["config", "show", "--json"], {
      FINBOOK_COINGECKO_DEMO_API_KEY: secret,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(secret);
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
    const disabled = JSON.parse(shown.stdout).data.disabledProviders;
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
