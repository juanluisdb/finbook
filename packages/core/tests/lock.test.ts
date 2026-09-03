import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fail, inspectBookLock, succeed, withBookLock, type LockOwner } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "finbook-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

function ownerPath(dataHome: string): string {
  return join(dataHome, ".finbook.lock", "owner.json");
}

function writeOwner(dataHome: string, owner: LockOwner): void {
  mkdirSync(join(dataHome, ".finbook.lock"), { mode: 0o700 });
  writeFileSync(ownerPath(dataHome), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

describe("book lock", () => {
  it("inspects lock ownership without exposing the token or changing the lock", () => {
    const dataHome = temporaryHome();
    writeOwner(dataHome, {
      pid: process.pid,
      hostname: hostname(),
      createdAt: "2026-08-31T12:00:00.000Z",
      token: "private-token",
    });
    const before = readFileSync(ownerPath(dataHome), "utf8");

    expect(inspectBookLock(dataHome)).toEqual({
      kind: "active",
      owner: {
        pid: process.pid,
        hostname: hostname(),
        createdAt: "2026-08-31T12:00:00.000Z",
      },
    });
    expect(readFileSync(ownerPath(dataHome), "utf8")).toBe(before);
  });

  it("classifies absent, stale, and malformed locks without reclaiming them", () => {
    const absentHome = temporaryHome();
    expect(inspectBookLock(absentHome)).toEqual({ kind: "absent" });

    const staleHome = temporaryHome();
    writeOwner(staleHome, {
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: "2026-08-31T12:00:00.000Z",
      token: "stale-token",
    });
    const staleBefore = readFileSync(ownerPath(staleHome), "utf8");
    expect(inspectBookLock(staleHome)).toMatchObject({ kind: "stale" });
    expect(readFileSync(ownerPath(staleHome), "utf8")).toBe(staleBefore);

    const malformedHome = temporaryHome();
    mkdirSync(join(malformedHome, ".finbook.lock"), { mode: 0o700 });
    writeFileSync(ownerPath(malformedHome), "not-json", { mode: 0o600 });
    expect(inspectBookLock(malformedHome)).toMatchObject({ kind: "uncertain" });
    expect(readFileSync(ownerPath(malformedHome), "utf8")).toBe("not-json");
  });

  it("rejects a second writer while a valid lock is held", () => {
    const dataHome = temporaryHome();

    const result = withBookLock(dataHome, () => {
      if (process.platform !== "win32") {
        expect(statSync(join(dataHome, ".finbook.lock")).mode & 0o777).toBe(0o700);
        expect(statSync(ownerPath(dataHome)).mode & 0o777).toBe(0o600);
      }
      const competing = withBookLock(dataHome, () => succeed(undefined));
      expect(competing).toMatchObject({ ok: false, error: { type: "storage" } });
      return succeed(undefined);
    });

    expect(result).toEqual({ ok: true, data: undefined });
  });

  it("reclaims a dead same-host owner once", () => {
    const dataHome = temporaryHome();
    writeOwner(dataHome, {
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: "2026-08-31T12:00:00.000Z",
      token: "stale-token",
    });

    const result = withBookLock(dataHome, () => succeed("acquired"));

    expect(result).toEqual({ ok: true, data: "acquired" });
    expect(() => readFileSync(ownerPath(dataHome), "utf8")).toThrow();
  });

  it("does not reclaim a foreign-host lock", () => {
    const dataHome = temporaryHome();
    writeOwner(dataHome, {
      pid: process.pid,
      hostname: "other-host",
      createdAt: "2026-08-31T12:00:00.000Z",
      token: "active-token",
    });

    const result = withBookLock(dataHome, () => succeed(undefined));

    expect(result).toMatchObject({ ok: false, error: { type: "storage" } });
    expect(existsSync(join(dataHome, ".finbook.lock"))).toBe(true);
  });

  it("does not reclaim a lock with a missing owner", () => {
    const dataHome = temporaryHome();
    const lock = join(dataHome, ".finbook.lock");
    mkdirSync(lock, { mode: 0o700 });

    const result = withBookLock(dataHome, () => succeed(undefined));

    expect(result).toMatchObject({ ok: false, error: { type: "storage" } });
    expect(existsSync(lock)).toBe(true);
  });

  it("does not reclaim a malformed owner lock", () => {
    const dataHome = temporaryHome();
    const lock = join(dataHome, ".finbook.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(ownerPath(dataHome), "not-json", { mode: 0o600 });

    const result = withBookLock(dataHome, () => succeed(undefined));

    expect(result).toMatchObject({ ok: false, error: { type: "storage" } });
    expect(existsSync(lock)).toBe(true);
  });

  it("releases its lock after a failed mutation", () => {
    const dataHome = temporaryHome();
    const failure = withBookLock(dataHome, () =>
      fail({ type: "invariant", message: "no", hint: "retry" }),
    );

    expect(failure).toMatchObject({ ok: false, error: { type: "invariant" } });
    expect(withBookLock(dataHome, () => succeed("retry")).data).toBe("retry");
  });

  it("releases the lock and rethrows an operation exception", () => {
    const dataHome = temporaryHome();
    const expected = new Error("programmer failure");

    expect(() =>
      withBookLock(dataHome, () => {
        throw expected;
      }),
    ).toThrow(expected);
    expect(withBookLock(dataHome, () => succeed("retry"))).toEqual({ ok: true, data: "retry" });
  });

  it("writes the documented generated owner fields", () => {
    const dataHome = temporaryHome();

    const result = withBookLock(dataHome, () => {
      // SAFETY: withBookLock writes and validates this owner record before invoking the callback.
      const owner = JSON.parse(readFileSync(ownerPath(dataHome), "utf8")) as LockOwner;
      expect(owner).toEqual({
        pid: process.pid,
        hostname: expect.any(String),
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/u),
        token: expect.any(String),
      });
      expect(owner.hostname).toBe(hostname());
      expect(Number.isFinite(Date.parse(owner.createdAt))).toBe(true);
      expect(owner.token).not.toBe("");
      if (process.platform !== "win32") {
        expect(statSync(ownerPath(dataHome)).mode & 0o777).toBe(0o600);
      }
      return succeed(undefined);
    });

    expect(result).toEqual({ ok: true, data: undefined });
  });
});
