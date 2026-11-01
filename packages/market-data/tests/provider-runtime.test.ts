import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  succeed,
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
} from "@finbook/core";
import {
  MarketDataCoordinator,
  MarketDataConfigSchema,
  ProviderPackages,
  ProviderRuntime,
} from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(body: string, environment: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "finbook-provider-boundary-"));
  roots.push(home);
  const source = join(home, "node_modules", "example-provider");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(home, "package.json"),
    JSON.stringify({
      name: "finbook-providers",
      private: true,
      dependencies: { "example-provider": "0.1.0" },
    }),
  );
  writeFileSync(
    join(home, "load-provider.mjs"),
    "export const resolveEntry = name => import.meta.resolve(name); export const load = name => import(name);",
  );
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "example-provider",
      version: "0.1.0",
      type: "module",
      exports: { import: "./index.js" },
      finbook: {
        id: "example",
        capabilities: ["price:fund", "fx", "eur-rate:crypto"],
        environment: ["EXAMPLE_SECRET"],
      },
    }),
  );
  writeFileSync(join(source, "index.js"), body);
  const packages = new ProviderPackages(home, {});
  const runtime = new ProviderRuntime(
    () => packages,
    environment,
    () => new Date("2026-10-25T12:34:56Z"),
  );
  const sources = runtime.sources(
    MarketDataConfigSchema.parse({ routes: { "price:fund": ["example"], fx: ["example"] } }),
  );
  const sourceProxy = sources[0];
  if (sourceProxy === undefined) throw new Error("Expected configured source");
  return { home, packages, runtime, source: sourceProxy };
}

const priceNeed = {
  instrument: { id: "local-fund", name: "Local fund", type: "fund" as const, quoteCurrency: "EUR" },
  identifier: "REMOTE",
  from: "2026-10-01",
  through: "2026-10-20",
};
const factory = (price: string) =>
  `export default () => ({ ok:true, data: { fetchPriceHistory: async () => (${price}), fetchFxHistory: async needs => needs.map(need => ({need,ok:true,data:[]})), fetchHistoricalEurRates: async needs => needs.map(need => ({need,ok:true,data:{rate:"0.93",effectiveDate:need.date}})) } });`;

it("adds canonical local identity and host provenance without supplying private instrument fields", async () => {
  const f = fixture(
    `export default environment => ({ok:true,data:{ fetchPriceHistory: async need => { if (need.instrument.id || need.instrument.name || environment.PATH) throw Error("Private input exposed"); return {ok:true,data:[{asOf:"2026-10-19",price:{amount:"108.50",currency:"EUR"}}]}; }, fetchFxHistory:async()=>[], fetchHistoricalEurRates:async()=>[] }});`,
    { PATH: "/private-path" },
  );
  const result = await f.runtime.withSession(async () =>
    succeed(await f.source.fetchPriceHistory(priceNeed)),
  );
  expect(result).toEqual({
    ok: true,
    data: {
      ok: true,
      data: [
        {
          instrument: "local-fund",
          asOf: "2026-10-19",
          price: { amount: "108.5", currency: "EUR" },
          provenance: {
            kind: "fetched",
            source: "example",
            retrievedAt: "2026-10-25T12:34:56.000Z",
          },
        },
      ],
    },
  });
});

it.each([
  ["wrong currency", '{ok:true,data:[{asOf:"2026-10-19",price:{amount:"108",currency:"USD"}}]}'],
  ["numeric amount", '{ok:true,data:[{asOf:"2026-10-19",price:{amount:108,currency:"EUR"}}]}'],
  ["future date", '{ok:true,data:[{asOf:"2026-10-21",price:{amount:"108",currency:"EUR"}}]}'],
  ["non-positive amount", '{ok:true,data:[{asOf:"2026-10-19",price:{amount:"0",currency:"EUR"}}]}'],
  [
    "forged provenance",
    '{ok:true,data:[{asOf:"2026-10-19",price:{amount:"108",currency:"EUR"},provenance:{kind:"manual"}}]}',
  ],
  ["malformed outer result", "null"],
])("rejects %s before producing trusted observations", async (_name, response) => {
  const f = fixture(factory(response));
  const result = await f.runtime.withSession(async () =>
    succeed(await f.source.fetchPriceHistory(priceNeed)),
  );
  expect(result).toMatchObject({
    ok: true,
    data: { ok: false, error: { kind: "invalid-response" } },
  });
});

it("matches reordered FX batches by complete echoed requests and rejects duplicates, omissions and foreign windows", async () => {
  const f = fixture(
    `export default () => ({ok:true,data:{ fetchPriceHistory:async()=>({ok:true,data:[]}), fetchFxHistory:async needs => needs.toReversed().map(need=>({need,ok:true,data:[{asOf:need.through,pair:need.currency+"/EUR",rate:need.currency==="USD"?"0.92":"1.18"}]})), fetchHistoricalEurRates:async()=>[] }});`,
  );
  const needs = [
    { currency: "USD", from: "2026-10-01", through: "2026-10-20", sourceFrom: "2026-09-30" },
    { currency: "GBP", from: "2026-10-05", through: "2026-10-18" },
  ];
  const result = await f.runtime.withSession(async () =>
    succeed(await f.source.fetchFxHistory(needs)),
  );
  expect(result).toMatchObject({
    ok: true,
    data: [
      { need: needs[1], ok: true, data: [{ pair: "GBP/EUR", rate: "1.18" }] },
      { need: needs[0], ok: true, data: [{ pair: "USD/EUR", rate: "0.92" }] },
    ],
  });
  for (const expression of [
    "[needs[0],needs[0]]",
    "[needs[0]]",
    '[needs[0],{...needs[1],sourceFrom:"2026-09-01"}]',
  ]) {
    const broken = fixture(
      `export default () => ({ok:true,data:{ fetchPriceHistory:async()=>({ok:true,data:[]}), fetchFxHistory:async needs => (${expression}).map(need=>({need,ok:true,data:[]})), fetchHistoricalEurRates:async()=>[] }});`,
    );
    const rejected = await broken.runtime.withSession(async () =>
      succeed(await broken.source.fetchFxHistory(needs)),
    );
    expect(rejected).toMatchObject({
      ok: true,
      data: [
        { ok: false, error: { kind: "invalid-response" } },
        { ok: false, error: { kind: "invalid-response" } },
      ],
    });
  }
});

it("validates event-rate association and economic date before adding provenance", async () => {
  const f = fixture(factory("{ok:true,data:[]}"));
  const need = { currency: "BTC", identifier: "bitcoin", date: "2026-10-20" };
  const result = await f.runtime.withSession(async () =>
    succeed(await f.source.fetchHistoricalEurRates([need])),
  );
  expect(result).toMatchObject({
    ok: true,
    data: [
      {
        need,
        ok: true,
        data: { rate: "0.93", effectiveDate: "2026-10-20", provenance: { source: "example" } },
      },
    ],
  });
  const future = fixture(
    `export default () => ({ok:true,data:{ fetchPriceHistory:async()=>({ok:true,data:[]}),fetchFxHistory:async()=>[], fetchHistoricalEurRates:async needs=>needs.map(need=>({need,ok:true,data:{rate:"0.9",effectiveDate:"2026-10-21"}})) }});`,
  );
  expect(
    await future.runtime.withSession(async () =>
      succeed(await future.source.fetchHistoricalEurRates([need])),
    ),
  ).toMatchObject({ data: [{ ok: false, error: { kind: "invalid-response" } }] });
});

it("inspects without importing, catches foreign throws, and redacts declared inputs from expected failures", async () => {
  const secret = "fixture-private-token";
  const f = fixture(
    `import {writeFileSync} from "node:fs"; writeFileSync(new URL("./executed",import.meta.url),"yes"); throw Error("${secret}");`,
    { EXAMPLE_SECRET: secret },
  );
  expect(await f.packages.list()).toMatchObject({
    ok: true,
    data: { providers: [{ metadata: { id: "example" } }], problems: [] },
  });
  const sentinel = join(f.home, "node_modules/example-provider/executed");
  expect(existsSync(sentinel)).toBe(false);
  const result = await f.runtime.withSession(async () =>
    succeed(await f.source.fetchPriceHistory(priceNeed)),
  );
  expect(existsSync(sentinel)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result).toMatchObject({ data: { ok: false, error: { kind: "unavailable" } } });
  const expected = fixture(
    `export default env => ({ok:false,error:{kind:"unauthorized",message:"Rejected "+env.EXAMPLE_SECRET}});`,
    { EXAMPLE_SECRET: secret },
  );
  const failed = await expected.runtime.withSession(async () =>
    succeed(await expected.source.fetchPriceHistory(priceNeed)),
  );
  expect(JSON.stringify(failed)).not.toContain(secret);
  expect(failed).toMatchObject({ data: { error: { message: "Rejected [redacted]" } } });
});

it("excludes code mutation and other code sessions while preserving files, then releases on exceptions", async () => {
  const f = fixture(factory("{ok:true,data:[]}"));
  const before = readFileSync(join(f.home, "package.json"), "utf8");
  await f.runtime.withSession(async () => {
    expect(await f.packages.remove("example-provider")).toMatchObject({
      ok: false,
      error: { type: "storage", hint: expect.stringContaining("Retry") },
    });
    expect(await f.packages.withSession(async () => succeed("should not run"))).toMatchObject({
      ok: false,
      error: { type: "storage" },
    });
    expect(readFileSync(join(f.home, "package.json"), "utf8")).toBe(before);
    return succeed(undefined);
  });
  await expect(
    f.runtime.withSession(async () => {
      throw new Error("Host bug");
    }),
  ).rejects.toThrow("Host bug");
  expect(await f.packages.withSession(async () => succeed("available"))).toEqual({
    ok: true,
    data: "available",
  });
});

it("saves independent valid subjects while malformed facts create no marks or successful checks", async () => {
  const f = fixture(
    `export default () => ({ok:true,data:{ fetchPriceHistory:async need=>({ok:true,data:[{asOf:"2026-10-19",price:{amount:need.identifier==="GOOD"?"105":"-105",currency:"EUR"}}]}),fetchFxHistory:async()=>[],fetchHistoricalEurRates:async()=>[] }});`,
  );
  const book = mkdtempSync(join(tmpdir(), "finbook-invalid-facts-book-"));
  roots.push(book);
  const store = new FileBookStore(book);
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
        date: "2026-10-19",
        account: "broker",
        source: "manual",
        amount: { amount: "2000", currency: "EUR" },
        eurPerUnit: "1",
      }),
    ).ok,
  ).toBe(true);
  for (const id of ["bad", "good"]) {
    expect(
      store.appendInstrument(
        InstrumentSchema.parse({ id, name: id, type: "fund", quoteCurrency: "EUR" }),
      ).ok,
    ).toBe(true);
    expect(
      store.appendEvent(
        EventSchema.parse({
          id: `buy-${id}`,
          type: "buy",
          date: "2026-10-19",
          account: "broker",
          source: "manual",
          instrument: id,
          qty: "4",
          price: { amount: "100", currency: "EUR" },
          grossAmount: "400",
        }),
      ).ok,
    ).toBe(true);
  }
  const config = MarketDataConfigSchema.parse({
    bindings: [
      { kind: "instrument", instrument: "bad", provider: "example", identifier: "BAD" },
      { kind: "instrument", instrument: "good", provider: "example", identifier: "GOOD" },
    ],
  });
  const sources = f.runtime.sources(config);
  const updater = new MarketDataCoordinator({
    store,
    config,
    eurRateSources: sources,
    priceHistorySources: sources,
    fxHistorySources: sources,
    now: () => new Date("2026-10-21T12:00:00Z"),
    withProviderSession: (operation) => f.runtime.withSession(operation),
  });
  expect(await updater.updateHistory()).toMatchObject({
    data: {
      checked: [{ subject: "good" }],
      saved: { prices: 1 },
      failures: [{ subject: "bad", error: { kind: "invalid-response" } }],
    },
  });
  expect(store.load()).toMatchObject({
    data: { prices: [{ instrument: "good", price: { amount: "105" } }] },
  });
  expect(await updater.updateHistory()).toMatchObject({
    data: { checked: [], reused: [{ subject: "good" }], failures: [{ subject: "bad" }] },
  });
});

it("lets host programming failures escape the foreign exception boundary", async () => {
  const f = fixture(
    factory('{ok:true,data:[{asOf:"2026-10-19",price:{amount:"105",currency:"EUR"}}]}'),
  );
  const runtime = new ProviderRuntime(
    () => f.packages,
    {},
    () => {
      throw new Error("Host clock failed");
    },
  );
  await expect(
    runtime.withSession(async () =>
      succeed(await runtime.source("example").fetchPriceHistory(priceNeed)),
    ),
  ).rejects.toThrow("Host clock failed");
});

it("preserves request identity when provider code mutates its input", async () => {
  const f = fixture(
    `export default () => ({ok:true,data:{fetchPriceHistory:async()=>({ok:true,data:[]}),fetchFxHistory:async needs=>{needs[0].currency="GBP";return needs.map(need=>({need,ok:true,data:[{asOf:need.through,pair:"GBP/EUR",rate:"1.17"}]}));},fetchHistoricalEurRates:async()=>[]}});`,
  );
  const need = { currency: "USD", from: "2026-10-01", through: "2026-10-20" };
  const result = await f.runtime.withSession(async () =>
    succeed(await f.source.fetchFxHistory([need])),
  );
  expect(need.currency).toBe("USD");
  expect(result).toMatchObject({
    data: [{ need, ok: false, error: { kind: "invalid-response" } }],
  });
});

it("contains exceptions raised while reading a foreign result", async () => {
  const secret = "unrenderable-fixture-secret";
  const f = fixture(
    `export default ()=>({ok:true,data:{fetchPriceHistory:async()=>({get ok(){throw Error("${secret}");}}),fetchFxHistory:async()=>[],fetchHistoricalEurRates:async()=>[]}});`,
  );
  const result = await f.runtime.withSession(async () =>
    succeed(await f.source.fetchPriceHistory(priceNeed)),
  );
  expect(result).toMatchObject({ data: { ok: false, error: { kind: "unavailable" } } });
  expect(JSON.stringify(result)).not.toContain(secret);
});

it("reports duplicate declared IDs without selecting or importing either package", async () => {
  const f = fixture('throw Error("must not import");');
  const other = join(f.home, "node_modules", "other-provider");
  mkdirSync(other);
  writeFileSync(
    join(other, "package.json"),
    JSON.stringify({
      name: "other-provider",
      version: "0.2.0",
      type: "module",
      exports: "./index.js",
      finbook: { id: "example", capabilities: ["price:fund"] },
    }),
  );
  writeFileSync(join(other, "index.js"), 'throw Error("must not import");');
  writeFileSync(
    join(f.home, "package.json"),
    JSON.stringify({
      name: "finbook-providers",
      private: true,
      dependencies: { "example-provider": "0.1.0", "other-provider": "0.2.0" },
    }),
  );
  expect(await f.packages.list()).toMatchObject({
    ok: true,
    data: {
      providers: [],
      problems: [
        { package: "other-provider", message: expect.stringContaining("Duplicate provider ID") },
        { package: "example-provider", message: expect.stringContaining("Duplicate provider ID") },
      ],
    },
  });
  expect(
    await f.runtime.withSession(async () => succeed(await f.source.fetchPriceHistory(priceNeed))),
  ).toMatchObject({ data: { ok: false, error: { kind: "unavailable" } } });
});

it("redacts a token completely when a shorter declared value is its prefix", async () => {
  const f = fixture(
    'export default env => ({ok:false,error:{kind:"unauthorized",message:"Rejected token "+env.PROVIDER_TOKEN}});',
    { PROVIDER_ACCOUNT: "client-42", PROVIDER_TOKEN: "client-42-actual-token-secret" },
  );
  const path = join(f.home, "node_modules/example-provider/package.json");
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  metadata.finbook.environment = ["PROVIDER_ACCOUNT", "PROVIDER_TOKEN"];
  writeFileSync(path, JSON.stringify(metadata));
  expect(
    await f.runtime.withSession(async () => succeed(await f.source.fetchPriceHistory(priceNeed))),
  ).toMatchObject({ data: { error: { message: "Rejected token [redacted]" } } });
});

it("rejects a retained fiat route after capability removal while allowing an explicit crypto-rate pin", async () => {
  const f = fixture(
    'export default () => ({ok:true,data:{fetchPriceHistory:async()=>({ok:true,data:[]}),fetchFxHistory:async()=>[],fetchHistoricalEurRates:async needs=>needs.map(need=>({need,ok:true,data:{rate:"0.001",effectiveDate:need.date}}))}});',
  );
  const config = MarketDataConfigSchema.parse({ routes: { "eur-rate:fiat": ["example"] } });
  const store = new FileBookStore(join(f.home, "unused-book"));
  const coordinator = new MarketDataCoordinator({
    store,
    config,
    eurRateSources: [],
    eurRateSource: (id) => f.runtime.source(id),
    withProviderSession: (operation) => f.runtime.withSession(operation),
  });
  const need = { currency: "USD", date: "2026-10-20" };
  expect(await coordinator.resolveHistoricalEurRate(need)).toMatchObject({
    ok: false,
    error: { kind: "unsupported" },
  });
  expect(await coordinator.resolveHistoricalEurRate(need, { provider: "example" })).toMatchObject({
    ok: true,
    data: { rate: "0.001", provenance: { source: "example" } },
  });
});
