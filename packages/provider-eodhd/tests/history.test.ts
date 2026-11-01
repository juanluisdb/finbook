import { expect, it, vi } from "vitest";
import { InstrumentSchema } from "@finbook/core";
import { EodhdSource } from "../src/index.js";

it("distinguishes a valid empty EODHD window from unavailable or malformed history", async () => {
  const request = {
    instrument: InstrumentSchema.parse({
      id: "apple",
      name: "Apple",
      type: "stock",
      quoteCurrency: "USD",
    }),
    identifier: "AAPL.US",
    from: "2024-09-07",
    sourceFrom: "2024-09-07",
    through: "2024-09-08",
  };
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
    .mockResolvedValueOnce(Response.json([{ date: "2024-09-07", close: -10 }]));
  const source = new EodhdSource({ apiKey: "fixture", fetchImplementation });
  expect(await source.fetchPriceHistory(request)).toEqual({ ok: true, data: [] });
  expect(await source.fetchPriceHistory(request)).toMatchObject({
    ok: false,
    error: { kind: "not-found", status: 404 },
  });
  expect(await source.fetchPriceHistory(request)).toMatchObject({
    ok: false,
    error: { kind: "invalid-response" },
  });
  expect(fetchImplementation).toHaveBeenCalledTimes(3);
  const url = fetchImplementation.mock.calls[0]?.[0];
  if (!(url instanceof URL)) throw new Error("Expected a URL");
  expect(url.searchParams.get("from")).toBe("2024-09-07");
  expect(url.searchParams.get("to")).toBe("2024-09-08");
});
