import { describe, expect, it, vi } from "vitest";

import { InstrumentSchema } from "@finbook/core";

import { EodhdSource, type PriceNeed } from "../src/index.js";

const fund = InstrumentSchema.parse({
  id: "fund-x",
  name: "Fund X",
  type: "fund",
  quoteCurrency: "EUR",
});

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function need(mode: PriceNeed["mode"], asOf = "2026-03-03"): PriceNeed {
  return { instrument: fund, asOf, mode, identifier: "FUND.X.EUFUND" };
}

function jsonResponse(value: JsonValue, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers({ "content-type": "application/json" });
  new Headers(headers).forEach((headerValue, name) => responseHeaders.set(name, headerValue));
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

function source(fetchImplementation: typeof fetch, apiKey = "test-secret"): EodhdSource {
  return new EodhdSource({
    apiKey,
    fetchImplementation,
    now: () => new Date("2026-03-03T22:00:00.000Z"),
  });
}

describe("EODHD source", () => {
  it("fetches a dated latest close once and stamps the requested book date", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        {
          date: "2026-03-02",
          open: 101,
          high: 102,
          low: 100,
          close: 101.25,
          adjusted_close: 99.5,
          volume: 0,
        },
      ]),
    );

    const result = await source(fetchImplementation).fetchPrices([need("latest")]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: {
          instrument: "fund-x",
          price: { amount: "101.25", currency: "EUR" },
          asOf: "2026-03-03",
          provenance: {
            kind: "fetched",
            source: "eodhd",
            retrievedAt: "2026-03-03T22:00:00.000Z",
          },
        },
      },
    ]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const requested = fetchImplementation.mock.calls[0]?.[0];
    expect(requested).toBeInstanceOf(URL);
    if (!(requested instanceof URL)) throw new Error("Expected an EODHD URL");
    expect(requested.pathname).toBe("/api/eod/FUND.X.EUFUND");
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      api_token: "test-secret",
      fmt: "json",
      period: "d",
      order: "d",
      from: "2026-02-22",
      to: "2026-03-03",
    });
  });

  it("selects the newest eligible historical close and retains its date", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        { date: "2026-02-28", close: 100.5 },
        { date: "2026-02-27", close: 99 },
      ]),
    );

    const result = await source(fetchImplementation).fetchPrices([
      need("historical", "2026-03-01"),
    ]);

    expect(result).toMatchObject([
      {
        ok: true,
        data: { price: { amount: "100.5", currency: "EUR" }, asOf: "2026-02-28" },
      },
    ]);
  });

  it.each([
    ["future", "2026-03-04"],
    ["stale", "2026-02-23"],
  ])("rejects a %s latest observation date", async (reason, date) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse([{ date, close: 100 }]));

    const result = await source(fetchImplementation).fetchPrices([need("latest")]);

    expect(result).toMatchObject([
      {
        ok: false,
        error: { kind: "invalid-response", message: expect.stringContaining(reason) },
      },
    ]);
  });

  it("rejects absent credentials and unsupported instruments without requesting data", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const stockNeed: PriceNeed = {
      ...need("latest"),
      instrument: InstrumentSchema.parse({
        id: "stock-x",
        name: "Stock X",
        type: "stock",
        quoteCurrency: "EUR",
      }),
    };

    const missingKey = await source(fetchImplementation, "").fetchPrices([need("latest")]);
    const unsupported = await source(fetchImplementation).fetchPrices([stockNeed]);

    expect(missingKey).toMatchObject([{ ok: false, error: { kind: "unauthorized" } }]);
    expect(unsupported).toMatchObject([{ ok: false, error: { kind: "unsupported" } }]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    [400, "invalid-response"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not-found"],
    [422, "invalid-response"],
    [429, "rate-limited"],
    [500, "unavailable"],
  ] as const)("normalizes HTTP %s without retrying", async (status, kind) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: "provider detail" }, status));

    const result = await source(fetchImplementation).fetchPrices([need("latest")]);

    expect(result).toMatchObject([{ ok: false, error: { kind, status } }]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("reports a usable retry delay without issuing another request", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({}, 429, { "retry-after": "30" }));

    const result = await source(fetchImplementation).fetchPrices([need("latest")]);

    expect(result).toMatchObject([
      { ok: false, error: { kind: "rate-limited", retryAfterMs: 30_000 } },
    ]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("spends one request for each unresolved fund need", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse([{ date: "2026-03-02", close: 100 }])),
      );
    const otherNeed: PriceNeed = {
      ...need("latest"),
      instrument: InstrumentSchema.parse({
        id: "fund-y",
        name: "Fund Y",
        type: "fund",
        quoteCurrency: "EUR",
      }),
      identifier: "FUND.Y.EUFUND",
    };

    const result = await source(fetchImplementation).fetchPrices([need("latest"), otherNeed]);

    expect(result).toMatchObject([{ ok: true }, { ok: true }]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("rejects empty, malformed, and non-JSON success payloads", async () => {
    const emptyFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const malformedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse([{ date: "not-a-date", close: -1 }]));
    const nonJsonFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON"));

    const empty = await source(emptyFetch).fetchPrices([need("historical")]);
    const malformed = await source(malformedFetch).fetchPrices([need("historical")]);
    const nonJson = await source(nonJsonFetch).fetchPrices([need("historical")]);

    expect(empty).toMatchObject([{ ok: false, error: { kind: "not-found" } }]);
    expect(malformed).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
    expect(nonJson).toMatchObject([{ ok: false, error: { kind: "invalid-response" } }]);
  });

  it("does not expose the API key when transport fails", async () => {
    const secret = "secret-that-must-not-appear";
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`failed URL contains ${secret}`));

    const result = await source(fetchImplementation, secret).fetchPrices([need("latest")]);
    const rendered = JSON.stringify(result);

    expect(result).toMatchObject([{ ok: false, error: { kind: "unavailable" } }]);
    expect(rendered).not.toContain(secret);
  });
});
