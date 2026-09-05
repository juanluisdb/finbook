import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AccountSchema, EventSchema, FileBookStore, InstrumentSchema } from "@finbook/core";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPath = resolve(repositoryRoot, "packages/cli/dist/main.js");
const temporaryDirectories: string[] = [];
type LockFixture = {
  pid: number | string;
  hostname?: string;
  createdAt?: string;
  token?: string;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(create = true): string {
  const root = mkdtempSync(join(tmpdir(), "finbook-doctor-"));
  temporaryDirectories.push(root);
  const dataHome = join(root, "book");
  if (create) mkdirSync(dataHome);
  return dataHome;
}

function runDoctor(dataHome: string, json = true): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, "doctor", ...(json ? ["--json"] : [])], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FINBOOK_HOME: dataHome,
      FINBOOK_COINGECKO_DEMO_API_KEY: "must-not-appear",
    },
  });
}

function snapshotTree(root: string): string {
  if (!existsSync(root)) return "missing";
  const entries: Array<{ path: string; mode: number; content?: string }> = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const entry = { path: relative(root, path) || ".", mode: stat.mode & 0o777 };
    if (stat.isDirectory()) {
      entries.push(entry);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    entries.push({ ...entry, content: readFileSync(path, "utf8") });
  };
  visit(root);
  return JSON.stringify(entries);
}

function initializeBook(dataHome: string): FileBookStore {
  const store = new FileBookStore(dataHome);
  expect(store.load().ok).toBe(true);
  return store;
}

function writeLock(dataHome: string, owner: LockFixture): void {
  const lockPath = join(dataHome, ".finbook.lock");
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

describe("finbook doctor", () => {
  it("reports an uninitialized home without creating it", () => {
    const dataHome = temporaryHome(false);
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: true,
      data: {
        status: "ok",
        schemaVersion: null,
        timeZone: "Europe/Madrid",
        eventCount: 0,
        holeCount: 0,
        dataPath: resolve(dataHome),
      },
    });
    expect(body.data.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "book", status: "ok" })]),
    );
    expect(snapshotTree(dataHome)).toBe(before);
  });

  it("reports valuation holes as a successful warning without changing the book", () => {
    const dataHome = temporaryHome();
    const store = initializeBook(dataHome);
    expect(
      store.appendAccount(
        AccountSchema.parse({
          id: "ib",
          name: "Interactive Brokers",
          platform: "interactive-brokers",
          country: "IE",
          custodial: "broker",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "deposit-usd",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      ).ok,
    ).toBe(true);
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);
    const body = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(body).toMatchObject({
      ok: true,
      data: {
        status: "warning",
        schemaVersion: 2,
        timeZone: "Europe/Madrid",
        eventCount: 1,
        holeCount: 1,
      },
    });
    expect(body.data.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "valuation", status: "warning" })]),
    );
    expect(result.stdout).not.toContain("must-not-appear");
    expect(result.stdout).not.toContain("deposit-usd");
    expect(snapshotTree(dataHome)).toBe(before);
  });

  it("returns a structured failure for corrupt JSONL without changing it", () => {
    const dataHome = temporaryHome();
    initializeBook(dataHome);
    writeFileSync(join(dataHome, "events.jsonl"), "not-json\n", { mode: 0o600 });
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);
    const body = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(body).toMatchObject({
      ok: false,
      error: {
        type: "storage",
        details: {
          report: {
            status: "error",
          },
        },
      },
    });
    expect(body.error.details.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "schema",
          status: "error",
          message: expect.stringContaining("events.jsonl:1"),
        }),
      ]),
    );
    expect(result.stdout).not.toContain("not-json");
    expect(snapshotTree(dataHome)).toBe(before);

    const human = runDoctor(dataHome, false);
    expect(human.status).toBe(1);
    expect(human.stdout).toContain("schema");
    expect(human.stdout).toContain("events.jsonl:1");
    expect(human.stderr).toContain("error: Book health check failed.");
  });

  it("reports an invalid persisted timezone without rewriting metadata", () => {
    const dataHome = temporaryHome();
    initializeBook(dataHome);
    const metaPath = join(dataHome, "meta.json");
    writeFileSync(metaPath, '{"schemaVersion":2,"timeZone":"Mars/Olympus"}\n', {
      mode: 0o600,
    });
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);
    const body = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(body).toMatchObject({
      ok: false,
      error: {
        details: {
          report: { status: "error", timeZone: null },
        },
      },
    });
    expect(body.error.details.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "schema",
          status: "error",
          message: expect.stringContaining("IANA time zone"),
        }),
      ]),
    );
    expect(snapshotTree(dataHome)).toBe(before);
  });

  it("reports a parseable ledger that fails replay", () => {
    const dataHome = temporaryHome();
    const store = initializeBook(dataHome);
    expect(
      store.appendAccount(
        AccountSchema.parse({
          id: "ib",
          name: "Interactive Brokers",
          platform: "interactive-brokers",
          country: "IE",
          custodial: "broker",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendInstrument(
        InstrumentSchema.parse({
          id: "HROW",
          name: "Harrow",
          type: "stock",
          quoteCurrency: "USD",
        }),
      ).ok,
    ).toBe(true);
    const invalidBookEvent = EventSchema.parse({
      id: "buy-without-cash",
      date: "2026-03-01",
      source: "manual",
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "1",
      price: { amount: "10", currency: "USD" },
      eurPerUnit: "0.9",
    });
    writeFileSync(join(dataHome, "events.jsonl"), `${JSON.stringify(invalidBookEvent)}\n`, {
      mode: 0o600,
    });
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);

    expect(result.status).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: false,
      error: {
        details: {
          report: {
            eventCount: 1,
          },
        },
      },
    });
    expect(body.error.details.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "replay",
          status: "error",
          message: expect.stringContaining("buy-without-cash"),
        }),
      ]),
    );
    expect(snapshotTree(dataHome)).toBe(before);
  });

  it.each([
    ["active", process.pid],
    ["stale", 2_147_483_647],
  ] as const)("reports a same-host %s lock without removing it", (kind, pid) => {
    const dataHome = temporaryHome();
    initializeBook(dataHome);
    writeLock(dataHome, {
      pid,
      hostname: hostname(),
      createdAt: "2026-09-03T10:00:00.000Z",
      token: `${kind}-token`,
    });
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: true,
      data: {
        status: "warning",
      },
    });
    expect(body.data.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "lock", status: "warning" })]),
    );
    expect(snapshotTree(dataHome)).toBe(before);
  });

  it("reports an uncertain lock as an error without removing it", () => {
    const dataHome = temporaryHome();
    initializeBook(dataHome);
    writeLock(dataHome, { pid: "unknown" });
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);

    expect(result.status).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: false,
      error: {
        details: {
          report: { status: "error" },
        },
      },
    });
    expect(body.error.details.report.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "lock", status: "error" })]),
    );
    expect(snapshotTree(dataHome)).toBe(before);
  });

  it("reports unsafe permissions without repairing them", () => {
    if (process.platform === "win32") return;
    const dataHome = temporaryHome();
    initializeBook(dataHome);
    chmodSync(dataHome, 0o755);
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);

    expect(result.status).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: false,
      error: {
        details: {
          report: { status: "error" },
        },
      },
    });
    expect(body.error.details.report.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "permissions", status: "error" })]),
    );
    expect(snapshotTree(dataHome)).toBe(before);
  });

  it("validates an existing market-data configuration without rewriting it", () => {
    const dataHome = temporaryHome();
    initializeBook(dataHome);
    writeFileSync(
      join(dataHome, "market-data.json"),
      `${JSON.stringify({ routes: { "price:stock": ["ecb"] } })}\n`,
      { mode: 0o600 },
    );
    const before = snapshotTree(dataHome);

    const result = runDoctor(dataHome);

    expect(result.status).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: false,
      error: {
        details: {
          report: { status: "error" },
        },
      },
    });
    expect(body.error.details.report.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "market-config", status: "error" })]),
    );
    expect(snapshotTree(dataHome)).toBe(before);
  });
});
