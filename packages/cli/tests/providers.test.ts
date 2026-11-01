import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ProviderPackages } from "@finbook/market-data";
import { afterEach, expect, it } from "vitest";
import { AccountSchema, EventSchema, FileBookStore, InstrumentSchema } from "@finbook/core";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("installs an import-only local provider with a runtime dependency, values offline, and replaces only on re-add", () => {
  const root = mkdtempSync(join(tmpdir(), "finbook-provider-cli-"));
  directories.push(root);
  const home = join(root, "book");
  const providers = join(root, "providers");
  const source = join(root, "source");
  const dependency = join(source, "node_modules", "fixture-nav");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "fixture-nav",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    }),
  );
  writeFileSync(join(dependency, "index.js"), 'export const nav = "105";\n');
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "example-fund-navs",
      version: "0.1.0",
      type: "module",
      exports: { import: "./index.js" },
      dependencies: { "fixture-nav": "1.0.0" },
      bundleDependencies: ["fixture-nav"],
      finbook: { id: "fund-navs", capabilities: ["price:fund"], environment: [] },
    }),
  );
  const implementation = (amount: string) =>
    `import { nav } from "fixture-nav"; export default () => ({ ok: true, data: { async fetchPriceHistory(need) { return { ok: true, data: [{ asOf: "2024-09-02", price: { amount: ${amount}, currency: "EUR" } }] }; } } });\n`;
  writeFileSync(join(source, "index.js"), implementation("nav"));
  const run = (args: readonly string[]) =>
    spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../dist/main.js"), ...args, "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FINBOOK_HOME: home,
          FINBOOK_PROVIDERS_HOME: providers,
          npm_config_cache: join(root, "npm-cache"),
          npm_config_offline: "true",
        },
      },
    );

  const added = run(["provider", "add", source]);
  expect(added.status, added.stdout + added.stderr).toBe(0);
  const unchanged = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "../dist/main.js"),
      "provider",
      "add",
      "example-fund-navs",
      "--json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/no-package-tool",
        FINBOOK_HOME: home,
        FINBOOK_PROVIDERS_HOME: providers,
      },
    },
  );
  expect(unchanged.status, unchanged.stdout + unchanged.stderr).toBe(0);
  expect(existsSync(home)).toBe(false);
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
    store.appendInstrument(
      InstrumentSchema.parse({ id: "fund", name: "Fund", type: "fund", quoteCurrency: "EUR" }),
    ).ok,
  ).toBe(true);
  expect(
    store.appendEvent(
      EventSchema.parse({
        id: "deposit",
        type: "deposit",
        account: "broker",
        date: "2024-09-01",
        source: "manual",
        amount: { amount: "1000", currency: "EUR" },
        eurPerUnit: "1",
      }),
    ).ok,
  ).toBe(true);
  expect(
    store.appendEvent(
      EventSchema.parse({
        id: "buy",
        type: "buy",
        account: "broker",
        date: "2024-09-02",
        source: "manual",
        instrument: "fund",
        qty: "4",
        price: { amount: "100", currency: "EUR" },
        grossAmount: "400",
      }),
    ).ok,
  ).toBe(true);
  const bound = run([
    "config",
    "source",
    "set",
    "--instrument",
    "fund",
    "--provider",
    "fund-navs",
    "--identifier",
    "EXAMPLE",
  ]);
  expect(bound.status, bound.stdout + bound.stderr).toBe(0);
  const update = run(["update"]);
  expect(update.status, update.stdout + update.stderr).toBe(0);
  const value = run(["show", "glance", "--as-of", "2024-09-02"]);
  expect(JSON.parse(value.stdout)).toMatchObject({
    ok: true,
    data: { totalEur: { amount: "1020", currency: "EUR" } },
  });
  const prices = readFileSync(join(home, "prices.jsonl"), "utf8");
  expect(JSON.parse(prices.trim())).toMatchObject({
    instrument: "fund",
    price: { amount: "105" },
    provenance: { kind: "fetched", source: "fund-navs", retrievedAt: expect.any(String) },
  });
  writeFileSync(join(source, "index.js"), implementation('"107"'));
  expect(
    readFileSync(join(providers, "node_modules/example-fund-navs/index.js"), "utf8"),
  ).toContain("amount: nav");
  const replaced = run(["provider", "add", source]);
  expect(replaced.status, replaced.stdout + replaced.stderr).toBe(0);
  expect(
    readFileSync(join(providers, "node_modules/example-fund-navs/index.js"), "utf8"),
  ).toContain('amount: "107"');
  const removed = run(["provider", "remove", "example-fund-navs"]);
  expect(removed.status, removed.stdout + removed.stderr).toBe(0);
  expect(readFileSync(join(home, "prices.jsonl"), "utf8")).toBe(prices);
  expect(
    JSON.parse(run(["show", "glance", "--as-of", "2024-09-02"]).stdout).data.totalEur.amount,
  ).toBe("1020");
  const reused = run(["update"]);
  expect(reused.status, reused.stdout + reused.stderr).toBe(0);
  expect(JSON.parse(reused.stdout).data.reused).not.toEqual([]);
}, 30000);

it("lists an absent installation without initializing it or requiring a valid book", () => {
  const root = mkdtempSync(join(tmpdir(), "finbook-provider-inspection-"));
  directories.push(root);
  const providers = join(root, "absent");
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "../dist/main.js"), "provider", "list", "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, FINBOOK_HOME: "", FINBOOK_PROVIDERS_HOME: providers },
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: { providers: [], problems: [] } });
  expect(existsSync(providers)).toBe(false);
});

it("keeps offline book reads available while shared provider code is locked", async () => {
  const root = mkdtempSync(join(tmpdir(), "finbook-provider-busy-"));
  directories.push(root);
  const code = join(root, "code");
  const book = join(root, "book");
  const packages = new ProviderPackages(code, {});
  await packages.withSession(async () => {
    const run = (args: readonly string[]) =>
      spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "../dist/main.js"), ...args, "--json"],
        {
          encoding: "utf8",
          env: { ...process.env, FINBOOK_HOME: book, FINBOOK_PROVIDERS_HOME: code },
        },
      );
    const busy = run(["provider", "remove", "example-provider"]);
    expect(busy.status).toBe(1);
    expect(JSON.parse(busy.stdout)).toMatchObject({
      error: { type: "storage", hint: expect.stringContaining("Retry") },
    });
    expect(run(["show", "glance"]).status).toBe(0);
    return { ok: true, data: undefined };
  });
});

it("contains package-tool failures and preserves book bytes without leaking subprocess output", () => {
  const root = mkdtempSync(join(tmpdir(), "finbook-provider-npm-failure-"));
  directories.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const secret = "private-package-fixture-token";
  const executable = join(bin, "npm");
  writeFileSync(
    executable,
    `#!${process.execPath}\nprocess.stdout.write("${secret}");process.stderr.write("${secret}");process.exitCode=1;\n`,
  );
  chmodSync(executable, 0o700);
  const book = join(root, "book");
  const store = new FileBookStore(book);
  expect(store.load().ok).toBe(true);
  const before = readFileSync(join(book, "events.jsonl"), "utf8");
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "../dist/main.js"),
      "provider",
      "add",
      "example-provider@latest",
      "--json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}`,
        FINBOOK_HOME: book,
        FINBOOK_PROVIDERS_HOME: join(root, "providers"),
      },
    },
  );
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { type: "external", hint: expect.stringContaining("reinstall") },
  });
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(readFileSync(join(book, "events.jsonl"), "utf8")).toBe(before);
});
