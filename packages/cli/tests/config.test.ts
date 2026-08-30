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

describe("provider configuration CLI", () => {
  it("shows deterministic defaults and persists safe overrides", () => {
    const dataHome = temporaryHome();
    const defaults = runCli(dataHome, ["config", "show", "--json"]);
    const disabled = runCli(dataHome, ["config", "provider", "disable", "yahoo", "--json"]);
    const route = runCli(dataHome, [
      "config",
      "route",
      "set",
      "price:fund",
      "yahoo",
      "coingecko",
      "--json",
    ]);
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

    expect(defaults.status).toBe(0);
    expect(JSON.parse(defaults.stdout)).toMatchObject({
      ok: true,
      data: { disabledProviders: [], routes: {}, bindings: [] },
    });
    expect(disabled.status).toBe(0);
    expect(route.status).toBe(0);
    expect(binding.status).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      ok: true,
      data: {
        disabledProviders: ["yahoo"],
        routes: { "price:fund": ["yahoo", "coingecko"] },
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
});
