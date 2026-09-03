import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
  type Account,
  type Instrument,
} from "@finbook/core";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPath = resolve(repositoryRoot, "packages/cli/dist/main.js");
const account: Account = AccountSchema.parse({
  id: "ib",
  name: "Interactive Brokers",
  platform: "interactive-brokers",
  country: "IE",
  custodial: "broker",
});
const instrument: Instrument = InstrumentSchema.parse({
  id: "HROW",
  name: "Harrow",
  type: "stock",
  quoteCurrency: "USD",
});
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "finbook-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(
  dataHome: string,
  args: readonly string[],
  cwd: string = repositoryRoot,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FINBOOK_HOME: dataHome },
  });
}

function seedAccount(store: FileBookStore): void {
  expect(store.appendAccount(account).ok).toBe(true);
  expect(store.appendInstrument(instrument).ok).toBe(true);
}

describe("read CLI", () => {
  it("lists and gets configured accounts as JSON", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);

    const list = runCli(dataHome, ["account", "list", "--json"]);
    const get = runCli(dataHome, ["account", "get", "ib", "--json"]);

    expect(list.status).toBe(0);
    expect(list.stderr).toBe("");
    expect(JSON.parse(list.stdout)).toEqual({ ok: true, data: [account] });
    expect(get.status).toBe(0);
    expect(JSON.parse(get.stdout)).toEqual({ ok: true, data: account });
  });

  it("filters events with inclusive account and date bounds", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
    const first = EventSchema.parse({
      id: "deposit-1",
      date: "2026-03-01",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "100", currency: "EUR" },
      eurPerUnit: "1",
    });
    const second = EventSchema.parse({
      id: "deposit-2",
      date: "2026-03-02",
      source: "manual",
      type: "deposit",
      account: "ib",
      amount: { amount: "50", currency: "EUR" },
      eurPerUnit: "1",
    });
    expect(store.appendEvent(first).ok).toBe(true);
    expect(store.appendEvent(second).ok).toBe(true);

    const result = runCli(dataHome, [
      "event",
      "list",
      "--account",
      "ib",
      "--from",
      "2026-03-01",
      "--to",
      "2026-03-01",
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: [first] });
  });

  it("summarizes every event family in human history", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
    expect(
      store.appendAccount(
        AccountSchema.parse({
          id: "other",
          name: "Other account",
          platform: "cash",
          country: "ES",
          custodial: "cash",
        }),
      ).ok,
    ).toBe(true);
    const events = [
      {
        id: "deposit-1",
        date: "2026-03-01",
        source: "manual",
        type: "deposit",
        account: "ib",
        amount: { amount: "1000", currency: "EUR" },
        eurPerUnit: "1",
      },
      {
        id: "withdrawal-1",
        date: "2026-03-02",
        source: "manual",
        type: "withdrawal",
        account: "ib",
        amount: { amount: "10", currency: "EUR" },
        eurPerUnit: "1",
      },
      {
        id: "transfer-1",
        date: "2026-03-03",
        source: "manual",
        type: "transfer",
        from: "ib",
        to: "other",
        amount: { amount: "20", currency: "EUR" },
      },
      {
        id: "fx-1",
        date: "2026-03-04",
        source: "manual",
        type: "fx",
        account: "ib",
        from: { amount: "100", currency: "EUR" },
        to: { amount: "120", currency: "USD" },
        fee: { amount: "1", currency: "EUR" },
      },
      {
        id: "buy-1",
        date: "2026-03-05",
        source: "manual",
        type: "buy",
        account: "ib",
        instrument: "HROW",
        qty: "2",
        price: { amount: "10", currency: "USD" },
        fee: { amount: "1", currency: "USD" },
        eurPerUnit: "0.9",
      },
      {
        id: "sell-1",
        date: "2026-03-06",
        source: "manual",
        type: "sell",
        account: "ib",
        instrument: "HROW",
        qty: "1",
        price: { amount: "12", currency: "USD" },
        fee: { amount: "1", currency: "USD" },
        eurPerUnit: "0.9",
      },
      {
        id: "dividend-1",
        date: "2026-03-07",
        source: "manual",
        type: "dividend",
        account: "ib",
        instrument: "HROW",
        gross: { amount: "10", currency: "USD" },
        withholdingForeign: { amount: "2", currency: "USD" },
        eurPerUnit: "0.9",
      },
      {
        id: "interest-1",
        date: "2026-03-08",
        source: "manual",
        type: "interest",
        account: "ib",
        gross: { amount: "5", currency: "EUR" },
        withholdingDomestic: { amount: "1", currency: "EUR" },
        eurPerUnit: "1",
      },
      {
        id: "fee-1",
        date: "2026-03-09",
        source: "manual",
        type: "fee",
        account: "ib",
        amount: { amount: "2", currency: "EUR" },
        eurPerUnit: "1",
      },
    ].map((event) => EventSchema.parse(event));
    for (const event of events) expect(store.appendEvent(event).ok).toBe(true);

    const result = runCli(dataHome, ["event", "list"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const summary of [
      "+1000 EUR → ib",
      "-10 EUR ← ib",
      "20 EUR ib → other",
      "ib: 100 EUR → 120 USD; fee 1 EUR",
      "ib: buy 2 HROW @ 10 USD; fee 1 USD",
      "ib: sell 1 HROW @ 12 USD; fee 1 USD",
      "ib: HROW gross 10 USD; net 8 USD",
      "ib: gross 5 EUR; net 4 EUR",
      "ib: -2 EUR",
    ]) {
      expect(result.stdout).toContain(summary);
    }
  });

  it("returns not-found errors with exit code 3", () => {
    const dataHome = temporaryHome();
    const jsonResult = runCli(dataHome, ["account", "get", "missing", "--json"]);
    const humanResult = runCli(dataHome, ["account", "get", "missing"]);

    expect(jsonResult.status).toBe(3);
    expect(jsonResult.stderr).toBe("");
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      ok: false,
      error: { type: "not-found" },
    });
    expect(humanResult.status).toBe(3);
    expect(humanResult.stdout).toBe("");
    expect(humanResult.stderr).toBe(
      "error: Unknown account ID: missing.\nhint: Add or select an existing account.\n",
    );
  });

  it("shows a complete glance using current cash valuation", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "deposit-eur",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "EUR" },
          eurPerUnit: "1",
        }),
      ).ok,
    ).toBe(true);

    const result = runCli(dataHome, ["show", "glance", "--as-of", "2026-03-05", "--json"]);
    const body = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(body).toMatchObject({
      ok: true,
      data: {
        asOf: "2026-03-05",
        totalEur: { amount: "100", currency: "EUR" },
        contributedEur: { amount: "100", currency: "EUR" },
        pnlEur: { amount: "0", currency: "EUR" },
        holes: [],
        byPlatform: [{ key: "interactive-brokers", valueEur: { amount: "100" }, weight: "1" }],
      },
    });
  });

  it("renders reachable valuation holes with exact remedies in both human views", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
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

    for (const view of ["glance", "positions"] as const) {
      const result = runCli(dataHome, ["show", view, "--as-of", "2026-03-05"]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("as of: 2026-03-05");
      expect(result.stdout).toContain("missing data");
      expect(result.stdout).toContain("FX USD/EUR as of 2026-03-05");
      expect(result.stdout).toContain(
        "finbook fx set --pair USD/EUR --rate <decimal> --as-of 2026-03-05",
      );
      expect(result.stdout).toContain(`finbook show ${view} --as-of 2026-03-05 --fetch`);
    }

    const json = runCli(dataHome, ["show", "glance", "--as-of", "2026-03-05", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      data: { asOf: "2026-03-05", holes: [{ sourceId: "fx:USD/EUR" }] },
    });
  });

  it("does not initialize the book for root help", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: finbook");
    expect(readdirSync(dataHome)).toEqual([]);
  });

  it("does not initialize the book for the version path", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["--version"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("0.1.0");
    expect(readdirSync(dataHome)).toEqual([]);
  });

  it("does not use the working directory for a positional --help argument", () => {
    const dataHome = temporaryHome();
    const workingDirectory = temporaryHome();
    const result = runCli(dataHome, ["account", "get", "--", "--help"], workingDirectory);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Unknown account ID: --help.\nhint: Add or select an existing account.\n",
    );
    expect(readdirSync(workingDirectory)).toEqual([]);
  });

  it("reports an invalid FINBOOK_HOME as a validation failure", () => {
    const jsonResult = runCli("", ["account", "list", "--json"]);
    const humanResult = runCli("", ["account", "list"]);

    expect(jsonResult.status).toBe(2);
    expect(jsonResult.stderr).toBe("");
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      ok: false,
      error: { type: "validation", message: "FINBOOK_HOME must not be empty." },
    });
    expect(humanResult.status).toBe(2);
    expect(humanResult.stdout).toBe("");
    expect(humanResult.stderr).toBe(
      "error: FINBOOK_HOME must not be empty.\n" +
        "hint: Set FINBOOK_HOME to a writable path outside the checkout.\n",
    );
  });

  it("keeps help and version available with an invalid FINBOOK_HOME", () => {
    const help = runCli("", ["--help"]);
    const shortVersion = runCli("", ["-V"]);
    const version = runCli("", ["--version"]);

    expect(help.status).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: finbook");
    expect(shortVersion.status).toBe(0);
    expect(shortVersion.stderr).toBe("");
    expect(shortVersion.stdout.trim()).toBe("0.1.0");
    expect(version.status).toBe(0);
    expect(version.stderr).toBe("");
    expect(version.stdout.trim()).toBe("0.1.0");
  });

  it("shows help without initializing the book when no command is provided", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, []);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: finbook");
    expect(readdirSync(dataHome)).toEqual([]);
  });

  it("returns one validation envelope for root JSON mode", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["--json"]);
    const body = JSON.parse(result.stdout);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(body).toMatchObject({ ok: false, error: { type: "validation" } });
    expect(readdirSync(dataHome)).toEqual([]);
  });

  it("shows the resolved local date for an omitted view date", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["show", "glance", "--json"]);
    const expected = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const body = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(body).toMatchObject({ ok: true, data: { asOf: expected } });
  });

  it("returns a partial JSON view and nonzero status when a price fetch fails", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
    expect(
      store.appendInstrument(
        InstrumentSchema.parse({
          id: "EUROW",
          name: "Euro instrument",
          type: "stock",
          quoteCurrency: "EUR",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "deposit-eur",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "EUR" },
          eurPerUnit: "1",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "buy-hrow",
          date: "2026-03-02",
          source: "manual",
          type: "buy",
          account: "ib",
          instrument: "EUROW",
          qty: "1",
          price: { amount: "40", currency: "EUR" },
          eurPerUnit: "1",
        }),
      ).ok,
    ).toBe(true);
    const disabled = runCli(dataHome, ["config", "provider", "disable", "yahoo", "--json"]);
    const result = runCli(dataHome, [
      "show",
      "glance",
      "--as-of",
      "2026-03-03",
      "--fetch",
      "--json",
    ]);
    const body = JSON.parse(result.stdout);

    expect(disabled.status).toBe(0);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(body).toMatchObject({
      ok: false,
      error: {
        type: "external",
        details: {
          requested: { prices: 1, fx: 0 },
          saved: { prices: 0, fx: 0 },
          failures: [{ kind: "price", subject: "EUROW", reason: "unavailable" }],
          partial: { asOf: "2026-03-03" },
        },
      },
    });
  });

  it("keeps a human partial view on stdout and grouped failures on stderr", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
    expect(
      store.appendInstrument(
        InstrumentSchema.parse({
          id: "EUROW",
          name: "Euro instrument",
          type: "stock",
          quoteCurrency: "EUR",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "deposit-eur",
          date: "2026-03-01",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount: "100", currency: "EUR" },
          eurPerUnit: "1",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "buy-hrow",
          date: "2026-03-02",
          source: "manual",
          type: "buy",
          account: "ib",
          instrument: "EUROW",
          qty: "1",
          price: { amount: "40", currency: "EUR" },
          eurPerUnit: "1",
        }),
      ).ok,
    ).toBe(true);
    expect(runCli(dataHome, ["config", "provider", "disable", "yahoo", "--json"]).status).toBe(0);

    const result = runCli(dataHome, ["show", "glance", "--as-of", "2026-03-03", "--fetch"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("as of: 2026-03-03");
    expect(result.stderr).toBe(
      "error: Could not fetch every requested market-data observation.\n" +
        "- price EUROW via none: unavailable: No enabled provider is configured for price:stock.\n" +
        "hint: Retry the command or add the missing marks manually.\n",
    );
  });

  it("rejects an inverted event date range as validation", () => {
    const result = runCli(temporaryHome(), [
      "event",
      "list",
      "--from",
      "2026-03-02",
      "--to",
      "2026-03-01",
      "--json",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { type: "validation" },
    });
  });

  it("lists stamps and shows as-of positions as JSON", () => {
    const dataHome = temporaryHome();
    const store = new FileBookStore(dataHome);
    seedAccount(store);
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
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: "buy-hrow",
          date: "2026-03-02",
          source: "manual",
          type: "buy",
          account: "ib",
          instrument: "HROW",
          qty: "1",
          price: { amount: "40", currency: "USD" },
          eurPerUnit: "0.9",
        }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendPrice({
        instrument: "HROW",
        price: { amount: "45", currency: "USD" },
        asOf: "2026-03-03",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);
    expect(
      store.appendFx({
        pair: "USD/EUR",
        rate: "0.9",
        asOf: "2026-03-03",
        provenance: { kind: "manual" },
      }).ok,
    ).toBe(true);

    const prices = runCli(dataHome, ["price", "list", "--json"]);
    const fx = runCli(dataHome, ["fx", "list", "--json"]);
    const positions = runCli(dataHome, ["show", "positions", "--as-of", "2026-03-04", "--json"]);
    const humanPositions = runCli(dataHome, ["show", "positions", "--as-of", "2026-03-04"]);

    expect(prices.status).toBe(0);
    expect(JSON.parse(prices.stdout)).toMatchObject({ ok: true, data: [{ instrument: "HROW" }] });
    expect(fx.status).toBe(0);
    expect(JSON.parse(fx.stdout)).toMatchObject({ ok: true, data: [{ pair: "USD/EUR" }] });
    expect(positions.status).toBe(0);
    expect(JSON.parse(positions.stdout)).toMatchObject({
      ok: true,
      data: {
        positions: [{ instrument: "HROW", quantity: "1", valueEur: { amount: "40.5" } }],
        cash: [{ currency: "USD", balance: { amount: "60" }, valueEur: { amount: "54" } }],
      },
    });
    expect(humanPositions.status).toBe(0);
    expect(humanPositions.stdout).toContain("as of: 2026-03-04");
  });

  it("keeps JSON data on stdout and diagnostics on stderr", () => {
    const dataHome = temporaryHome();
    const result = runCli(dataHome, ["account", "list", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: [] });
  });
});
