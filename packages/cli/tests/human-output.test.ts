import { describe, expect, it } from "vitest";

import { renderHoles } from "../src/human-output.js";

describe("human output", () => {
  it("renders an exact manual and fetch remedy for a missing price", () => {
    const output = renderHoles(
      [
        {
          sourceId: "price:HROW",
          kind: "valuation",
          currency: "USD",
          message: "Missing HROW price.",
        },
      ],
      "2026-09-03",
      "positions",
    );

    expect(output).toContain("price HROW in USD as of 2026-09-03");
    expect(output).toContain(
      "finbook price set --instrument HROW --amount <decimal> --currency USD --as-of 2026-09-03",
    );
    expect(output).toContain("finbook show positions --as-of 2026-09-03 --fetch");
  });
});
