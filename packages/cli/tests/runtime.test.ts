import { describe, expect, it } from "vitest";

import { assertSupportedNodeVersion } from "../src/runtime.js";

describe("Node runtime guard", () => {
  it("accepts the supported runtime floor", () => {
    expect(() => assertSupportedNodeVersion("24.19.0")).not.toThrow();
  });

  it("rejects runtimes outside the supported range", () => {
    expect(() => assertSupportedNodeVersion("24.18.9")).toThrow(">=24.19.0");
    expect(() => assertSupportedNodeVersion("26.0.0")).toThrow(">=24.19.0");
  });
});
