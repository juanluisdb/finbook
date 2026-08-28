import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../src/environment.js";

describe("runtime configuration", () => {
  it("resolves the configured data home outside the checkout", () => {
    expect(loadRuntimeConfig({ FINBOOK_HOME: "../finbook-data" }, "/work/finbook")).toEqual({
      dataHome: "/work/finbook-data",
    });
  });

  it("rejects a data home inside the checkout", () => {
    expect(() => loadRuntimeConfig({ FINBOOK_HOME: "./data" }, "/work/finbook")).toThrow(
      "outside the checkout",
    );
  });
});
