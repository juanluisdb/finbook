import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { EcbSource } from "../src/index.js";

const fixture = readFileSync(resolve(import.meta.dirname, "fixtures/ecb-history.xml"), "utf8");

function source(responseBody = fixture, status = 200): EcbSource {
  const fetchImplementation: typeof fetch = async () =>
    new Response(responseBody, { status, headers: { "content-type": "application/xml" } });
  return new EcbSource({
    fetchImplementation,
    baseUrl: "https://ecb.test/eurofxref",
    now: () => new Date("2026-03-03T12:00:00.000Z"),
  });
}

describe("ECB source", () => {
  it("returns EUR-per-currency FX marks using the latest available date", async () => {
    const result = await source().fetchFxRates([
      { currency: "USD", asOf: "2026-03-03", mode: "latest" },
      { currency: "GBP", asOf: "2026-03-01", mode: "historical" },
    ]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: {
          pair: "USD/EUR",
          rate: "0.9090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909091",
          asOf: "2026-03-02",
          provenance: {
            kind: "fetched",
            source: "ecb",
            retrievedAt: "2026-03-03T12:00:00.000Z",
          },
        },
      },
      {
        ok: true,
        data: {
          pair: "GBP/EUR",
          rate: "1.234567901234567901234567901234567901234567901234567901234567901234567901234567901234567901234567901",
          asOf: "2026-03-01",
        },
      },
    ]);
  });

  it("returns a historical EUR rate with the provider effective date", async () => {
    const result = await source().fetchHistoricalEurRates([
      { currency: "USD", date: "2026-03-03" },
    ]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: {
          rate: "0.9090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909091",
          effectiveDate: "2026-03-02",
          provenance: { kind: "fetched", source: "ecb" },
        },
      },
    ]);
  });

  it("reports unsupported currencies and provider HTTP failures per need", async () => {
    const unsupported = await source().fetchFxRates([
      { currency: "BTC", asOf: "2026-03-03", mode: "latest" },
    ]);
    const unavailable = await source("unauthorized", 401).fetchFxRates([
      { currency: "USD", asOf: "2026-03-03", mode: "latest" },
    ]);

    expect(unsupported).toMatchObject([{ ok: false, error: { kind: "not-found" } }]);
    expect(unavailable).toMatchObject([
      { ok: false, error: { kind: "unauthorized", status: 401 } },
    ]);
  });

  it("reports malformed provider data instead of producing a rate", async () => {
    const result = await source("<not-ecb />").fetchHistoricalEurRates([
      { currency: "USD", date: "2026-03-03" },
    ]);

    expect(result).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
  });
});
