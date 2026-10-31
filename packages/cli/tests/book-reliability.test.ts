import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AccountSchema, EventSchema, FileBookStore } from "@finbook/core";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "finbook-reliability-"));
  homes.push(home);
  const store = new FileBookStore(home);
  expect(
    store.appendAccount(
      AccountSchema.parse({
        id: "broker",
        name: "Broker",
        platform: "example",
        country: "ES",
        custodial: "broker",
      }),
    ).ok,
  ).toBe(true);
  expect(
    store.appendEvent(
      EventSchema.parse({
        id: "deposit",
        type: "deposit",
        source: "manual",
        date: "2026-03-01",
        account: "broker",
        amount: { amount: "100", currency: "EUR" },
        eurPerUnit: "1",
      }),
    ).ok,
  ).toBe(true);
  const run = (args: readonly string[]) =>
    spawnSync(process.execPath, [resolve(import.meta.dirname, "../dist/main.js"), ...args], {
      encoding: "utf8",
      env: { ...process.env, FINBOOK_HOME: home },
    });
  return { home, run };
}

it("reports missing history through human and JSON views without manufacturing an empty book", () => {
  const f = fixture();
  rmSync(join(f.home, "events.jsonl"));
  const before = readFileSync(join(f.home, "accounts.json"), "utf8");
  const json = f.run(["show", "glance", "--json"]);
  expect(json.status).toBe(1);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: false,
    error: { type: "storage", message: expect.stringContaining("events.jsonl") },
  });
  const human = f.run(["show", "glance"]);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("missing required files: events.jsonl");
  expect(human.stderr).toContain("restore a complete");
  expect(f.run(["doctor", "--json"]).status).toBe(1);
  expect(existsSync(join(f.home, "events.jsonl"))).toBe(false);
  expect(readFileSync(join(f.home, "accounts.json"), "utf8")).toBe(before);
});

it("explains abandoned book and refresh locks while leaving their owner records intact", () => {
  const f = fixture();
  const owner = JSON.stringify({
    pid: 2_147_483_647,
    hostname: hostname(),
    createdAt: "2026-03-01T12:00:00Z",
    token: "private-owner-token",
  });
  const bookLock = join(f.home, ".finbook.lock");
  mkdirSync(bookLock);
  writeFileSync(join(bookLock, "owner.json"), owner);
  const json = f.run(["show", "glance", "--json"]);
  expect(json.status).toBe(1);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: false,
    error: { type: "storage", message: expect.stringContaining("abandoned") },
  });
  expect(json.stdout).not.toContain("private-owner-token");
  const human = f.run(["show", "positions"]);
  expect(human.stderr).toContain("confirming no process is using the book");
  expect(readFileSync(join(bookLock, "owner.json"), "utf8")).toBe(owner);
  rmSync(bookLock, { recursive: true });
  const refreshLock = join(f.home, ".finbook.refresh.lock");
  mkdirSync(refreshLock);
  writeFileSync(join(refreshLock, "owner.json"), owner);
  const update = f.run(["update", "--json"]);
  expect(update.status).toBe(1);
  expect(JSON.parse(update.stdout)).toMatchObject({
    ok: false,
    error: { type: "storage", message: expect.stringContaining(".finbook.refresh.lock") },
  });
  expect(readFileSync(join(refreshLock, "owner.json"), "utf8")).toBe(owner);
});

it("rejects the previous book format on reads and FX appends without rewriting its files", () => {
  const f = fixture();
  const path = join(f.home, "meta.json");
  const metadata = '{"schemaVersion":3,"timeZone":"Europe/Madrid"}\n';
  writeFileSync(path, metadata);
  const events = readFileSync(join(f.home, "events.jsonl"), "utf8");
  for (const args of [
    ["show", "positions", "--json"],
    ["fx", "set", "--pair", "USD/EUR", "--rate", "0.8", "--as-of", "2026-03-02", "--json"],
  ]) {
    const result = f.run(args);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "storage",
        message: expect.stringContaining("Unsupported book schema version: 3"),
      },
    });
  }
  expect(readFileSync(path, "utf8")).toBe(metadata);
  expect(readFileSync(join(f.home, "events.jsonl"), "utf8")).toBe(events);
  expect(readFileSync(join(f.home, "fx.jsonl"), "utf8")).toBe("");
});
