import { expect, it, vi } from "vitest";
import { InstrumentSchema } from "@finbook/core";
import { EodhdSource } from "../src/index.js";

const fund = InstrumentSchema.parse({
  id: "fund-x",
  name: "Fund X",
  type: "fund",
  quoteCurrency: "EUR",
});
const need = {
  instrument: fund,
  identifier: "FUND.X.EUFUND",
  from: "2026-02-27",
  through: "2026-03-03",
  sourceFrom: "2026-02-27",
};

it("retains every raw native close, independently of adjusted closes, in a single request", async () => {
  const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json([
      { date: "2026-02-27", close: 100.5, adjusted_close: 25 },
      { date: "2026-03-02", close: 101.25, adjusted_close: 26 },
      { date: "2026-03-03", close: 103.75, adjusted_close: 27 },
    ]),
  );
  const provider = new EodhdSource({
    apiKey: "fixture-key",
    fetchImplementation,
    now: () => new Date("2026-03-04T12:00:00Z"),
  });
  expect(await provider.fetchPriceHistory(need)).toMatchObject({
    ok: true,
    data: [
      { asOf: "2026-02-27", price: { amount: "100.5", currency: "EUR" } },
      { asOf: "2026-03-02", price: { amount: "101.25", currency: "EUR" } },
      { asOf: "2026-03-03", price: { amount: "103.75", currency: "EUR" } },
    ],
  });
  expect(fetchImplementation).toHaveBeenCalledOnce();
});

it("rejects future rows, malformed payloads and non-JSON successes", async () => {
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([{ date: "2026-03-04", close: 104 }]))
    .mockResolvedValueOnce(Response.json([{ date: "2026-03-03", close: -8 }]))
    .mockResolvedValueOnce(new Response("not-json"));
  const provider = new EodhdSource({ apiKey: "fixture-key", fetchImplementation });
  for (let index = 0; index < 3; index++)
    expect(await provider.fetchPriceHistory(need)).toMatchObject({
      ok: false,
      error: { kind: "invalid-response" },
    });
});

it("rejects absent credentials and unsupported instruments before requesting data", async () => {
  const fetchImplementation = vi.fn<typeof fetch>();
  expect(await new EodhdSource({ fetchImplementation }).fetchPriceHistory(need)).toMatchObject({
    ok: false,
    error: { kind: "unauthorized" },
  });
  expect(
    await new EodhdSource({ apiKey: "fixture-key", fetchImplementation }).fetchPriceHistory({
      ...need,
      instrument: { ...fund, type: "crypto" },
    }),
  ).toMatchObject({ ok: false, error: { kind: "unsupported" } });
  expect(fetchImplementation).not.toHaveBeenCalled();
});

it.each([
  [401, "unauthorized"],
  [403, "unauthorized"],
  [404, "not-found"],
  [429, "rate-limited"],
  [422, "invalid-response"],
  [503, "unavailable"],
] as const)("normalizes HTTP %s without retrying or exposing the key", async (status, kind) => {
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response("private-key", { status, headers: { "retry-after": "9" } }),
    );
  const result = await new EodhdSource({
    apiKey: "private-key",
    fetchImplementation,
  }).fetchPriceHistory(need);
  expect(result).toMatchObject({ ok: false, error: { kind, status } });
  expect(JSON.stringify(result)).not.toContain("private-key");
  expect(fetchImplementation).toHaveBeenCalledOnce();
});

it("retains a rate-limit retry delay and redacts transport failures", async () => {
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("limit", { status: 429, headers: { "retry-after": "9" } }))
    .mockRejectedValueOnce(new Error("URL contains private-key"));
  const provider = new EodhdSource({ apiKey: "private-key", fetchImplementation });
  expect(await provider.fetchPriceHistory(need)).toMatchObject({
    ok: false,
    error: { kind: "rate-limited", retryAfterMs: 9000 },
  });
  const failed = await provider.fetchPriceHistory(need);
  expect(failed).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  expect(JSON.stringify(failed)).not.toContain("private-key");
});
