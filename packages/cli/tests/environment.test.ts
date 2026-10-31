import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/environment.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPath = resolve(repositoryRoot, "packages/cli/dist/main.js");
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "finbook-location-"));
  directories.push(path);
  return path;
}

describe("runtime configuration", () => {
  it("resolves relative user paths against the caller's directory", () => {
    expect(loadRuntimeConfig({ FINBOOK_HOME: "../finbook-data" }, "/work/finbook")).toEqual({
      dataHome: "/work/finbook-data",
    });
  });

  it("permits the default location when invoked from the owner's home", () => {
    expect(loadRuntimeConfig({}, homedir())).toEqual({ dataHome: join(homedir(), ".finbook") });
  });

  it("rejects a location inside the actual checkout when invoked from a package directory", () => {
    expect(() =>
      loadRuntimeConfig(
        { FINBOOK_HOME: join(repositoryRoot, "private-book") },
        join(repositoryRoot, "packages/cli"),
      ),
    ).toThrow("outside the checkout");
  });

  it("rejects a symlinked parent into the checkout even when the book does not exist", () => {
    const root = temporaryDirectory();
    const caller = join(root, "caller");
    mkdirSync(caller);
    symlinkSync(repositoryRoot, join(root, "alias"), "dir");
    expect(() => loadRuntimeConfig({ FINBOOK_HOME: "../alias/not-created/book" }, caller)).toThrow(
      "outside the checkout",
    );
    expect(existsSync(join(repositoryRoot, "not-created/book"))).toBe(false);
  });

  it("allows an external caller's own directory and rejects checkout storage through the built CLI", () => {
    const caller = temporaryDirectory();
    const allowed = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: caller,
      encoding: "utf8",
      env: { ...process.env, FINBOOK_HOME: "./book" },
    });
    expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({ ok: true });
    expect(existsSync(join(caller, "book"))).toBe(false);
    const blocked = join(repositoryRoot, "book-guard-not-created");
    const rejected = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: join(repositoryRoot, "packages/cli"),
      encoding: "utf8",
      env: { ...process.env, FINBOOK_HOME: blocked },
    });
    expect(rejected.status).toBe(2);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, error: { type: "validation" } });
    expect(existsSync(blocked)).toBe(false);
  });
});
