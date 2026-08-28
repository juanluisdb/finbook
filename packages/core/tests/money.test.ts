import { describe, expect, it } from "vitest";

import { MoneyValue } from "../src/domain/money.js";

describe("MoneyValue", () => {
  it("adds decimal amounts exactly", () => {
    const total = MoneyValue.from({ amount: "0.1", currency: "EUR" }).add(
      MoneyValue.from({ amount: "0.2", currency: "EUR" }),
    );

    expect(total.toMoney()).toEqual({ amount: "0.3", currency: "EUR" });
  });

  it("refuses to add different currencies", () => {
    expect(() =>
      MoneyValue.from({ amount: "1", currency: "EUR" }).add(
        MoneyValue.from({ amount: "1", currency: "USD" }),
      ),
    ).toThrow("different currencies");
  });
});
