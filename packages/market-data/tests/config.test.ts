import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MarketDataConfigSchema,
  MarketDataConfigStore,
  defaultRoute,
  effectiveRoute,
  findBinding,
  type MarketDataConfig,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "finbook-market-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("market-data configuration", () => {
  it("provides deterministic routes without a config file", () => {
    expect(defaultRoute("price:stock")).toEqual(["yahoo"]);
    expect(defaultRoute("price:etf")).toEqual(["yahoo"]);
    expect(defaultRoute("price:fund")).toEqual(["yahoo"]);
    expect(defaultRoute("price:crypto")).toEqual(["coingecko"]);
    expect(defaultRoute("fx")).toEqual(["ecb"]);
    expect(defaultRoute("eur-rate:fiat")).toEqual(["ecb"]);
    expect(defaultRoute("eur-rate:crypto")).toEqual(["coingecko"]);
  });

  it("round-trips only non-secret overrides and bindings", () => {
    const store = new MarketDataConfigStore(temporaryHome());
    const config = MarketDataConfigSchema.parse({
      disabledProviders: ["yahoo"],
      routes: { "price:fund": ["yahoo"] },
      bindings: [
        {
          kind: "instrument",
          instrument: "fund-x",
          provider: "yahoo",
          identifier: "FUND.X",
        },
        {
          kind: "currency",
          currency: "BTC",
          provider: "coingecko",
          identifier: "bitcoin",
        },
      ],
    });

    expect(store.save(config)).toEqual({ ok: true, data: undefined });
    expect(store.load()).toEqual({ ok: true, data: config });
    const file = readFileSync(join(store.dataHome, "market-data.json"), "utf8");
    expect(file).not.toContain("apiKey");
    expect(file).not.toContain("secret");
  });

  it("applies route overrides after disabled providers", () => {
    const config = MarketDataConfigSchema.parse({
      disabledProviders: ["coingecko"],
      routes: { "price:crypto": ["coingecko"] },
    });

    expect(effectiveRoute("price:crypto", config)).toEqual([]);
    expect(effectiveRoute("price:stock", config)).toEqual(["yahoo"]);
  });

  it("finds explicit bindings by local instrument or currency", () => {
    const config: MarketDataConfig = MarketDataConfigSchema.parse({
      bindings: [
        { kind: "instrument", instrument: "fund-x", provider: "yahoo", identifier: "FUND.X" },
        { kind: "currency", currency: "BTC", provider: "coingecko", identifier: "bitcoin" },
      ],
    });

    expect(findBinding(config, "instrument", "fund-x")).toMatchObject({
      provider: "yahoo",
      identifier: "FUND.X",
    });
    expect(findBinding(config, "currency", "BTC")).toMatchObject({
      provider: "coingecko",
      identifier: "bitcoin",
    });
    expect(findBinding(config, "instrument", "missing")).toBeUndefined();
  });

  it("rejects duplicate bindings and unknown providers", () => {
    expect(() =>
      MarketDataConfigSchema.parse({
        bindings: [
          { kind: "instrument", instrument: "fund-x", provider: "yahoo", identifier: "A" },
          { kind: "instrument", instrument: "fund-x", provider: "yahoo", identifier: "B" },
        ],
      }),
    ).toThrow();
    expect(() => MarketDataConfigSchema.parse({ disabledProviders: ["unknown"] })).toThrow();
  });

  it("rejects a route whose provider cannot serve that operation", () => {
    expect(() => MarketDataConfigSchema.parse({ routes: { "price:stock": ["ecb"] } })).toThrow(
      /price:stock/u,
    );
  });

  it("keeps the config file owner-only where supported", () => {
    if (process.platform === "win32") return;
    const store = new MarketDataConfigStore(temporaryHome());
    expect(store.save(MarketDataConfigSchema.parse({})).ok).toBe(true);
    expect(statSync(join(store.dataHome, "market-data.json")).mode & 0o777).toBe(0o600);
  });
});
