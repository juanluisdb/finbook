import { expect, it, vi } from "vitest";
import { EcbSource } from "../src/index.js";

it("gets Friday context for a weekend, inverts native ECB rates and batches currencies", async () => {
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        '<gesmes:Envelope><Cube><Cube time="2024-09-06"><Cube currency="USD" rate="1.25"/><Cube currency="GBP" rate="0.8"/></Cube><Cube time="2024-09-09"><Cube currency="USD" rate="2"/></Cube></Cube></gesmes:Envelope>',
      ),
    );
  const source = new EcbSource({ fetchImplementation });
  expect(
    await source.fetchFxHistory([
      { currency: "USD", from: "2024-09-07", through: "2024-09-08" },
      { currency: "GBP", from: "2024-09-07", through: "2024-09-08" },
    ]),
  ).toMatchObject([
    { ok: true, data: [{ asOf: "2024-09-06", pair: "USD/EUR", rate: "0.8" }] },
    { ok: true, data: [{ asOf: "2024-09-06", pair: "GBP/EUR", rate: "1.25" }] },
  ]);
  expect(fetchImplementation).toHaveBeenCalledOnce();
});
