import { describe, expect, it } from "vitest";

import { currentDate } from "../src/dates.js";

describe("CLI date handling", () => {
  it("resolves the configured calendar date at a UTC boundary", () => {
    expect(currentDate(new Date("2026-03-01T23:30:00.000Z"), "Europe/Madrid")).toBe("2026-03-02");
    expect(currentDate(new Date("2026-03-01T23:30:00.000Z"), "Atlantic/Canary")).toBe("2026-03-01");
  });
});
