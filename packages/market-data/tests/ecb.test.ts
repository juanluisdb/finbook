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
  it("returns a historical EUR rate with the provider effective date", async () => {
    const result = await source().fetchHistoricalEurRates([
      { currency: "USD", date: "2026-03-03" },
    ]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: {
          rate: "0.909090909090909091",
          effectiveDate: "2026-03-02",
          provenance: { kind: "fetched", source: "ecb" },
        },
      },
    ]);
  });

  it("reports unsupported currencies and provider HTTP failures per need", async () => {
    const unsupported = await source().fetchFxHistory([
      { currency: "BTC", from: "2026-03-01", through: "2026-03-03" },
    ]);
    const unavailable = await source("unauthorized", 401).fetchFxHistory([
      { currency: "USD", from: "2026-03-01", through: "2026-03-03" },
    ]);

    expect(unsupported).toMatchObject([{ ok: false, error: { kind: "unsupported" } }]);
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
