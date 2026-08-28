import { describe, expect, it } from "vitest";

import {
  AccountSchema,
  EventSchema,
  InstrumentSchema,
  type Account,
  type BookState,
  type Event,
  type Instrument,
  apply,
  createInitialState,
} from "../src/index.js";

const accounts: Account[] = [
  AccountSchema.parse({
    id: "ib",
    name: "Interactive Brokers",
    platform: "interactive-brokers",
    country: "IE",
    custodial: "broker",
  }),
  AccountSchema.parse({
    id: "myinvestor",
    name: "MyInvestor",
    platform: "myinvestor",
    country: "ES",
    custodial: "broker",
  }),
];

const instruments: Instrument[] = [
  InstrumentSchema.parse({
    id: "HROW",
    name: "Harrow",
    type: "stock",
    quoteCurrency: "USD",
  }),
  InstrumentSchema.parse({
    id: "META",
    name: "Meta Platforms",
    type: "stock",
    quoteCurrency: "USD",
  }),
];

function initialState(): BookState {
  return createInitialState(accounts, instruments);
}

function applyOrThrow(state: BookState, event: Event): BookState {
  const result = apply(state, event);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function cashAmount(state: BookState, accountId: string, currency: string): string {
  return state.cash[accountId]?.[currency]?.amount ?? "0";
}

function deposit(state: BookState, amount: string, currency = "EUR"): BookState {
  const event =
    currency === "EUR"
      ? EventSchema.parse({
          id: `deposit-${amount}-${currency}`,
          date: "2026-03-03",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount, currency },
        })
      : EventSchema.parse({
          id: `deposit-${amount}-${currency}`,
          date: "2026-03-03",
          source: "manual",
          type: "deposit",
          account: "ib",
          amount: { amount, currency },
          eurPerUnit: "0.9",
        });

  return applyOrThrow(state, event);
}

function buyHrow(state: BookState): BookState {
  return applyOrThrow(
    state,
    EventSchema.parse({
      id: "buy-hrow",
      date: "2026-03-03",
      source: "manual",
      type: "buy",
      account: "ib",
      instrument: "HROW",
      qty: "20",
      price: { amount: "40.45", currency: "USD" },
      fee: { amount: "0.28", currency: "USD" },
      eurPerUnit: "0.861",
    }),
  );
}

describe("accounting engine", () => {
  it("applies a deposit to cash and contributed capital", () => {
    const state = deposit(initialState(), "800");

    expect(cashAmount(state, "ib", "EUR")).toBe("800");
    expect(state.contributedEur).toEqual({ amount: "800", currency: "EUR" });
  });

  it("applies a withdrawal to cash and contributed capital", () => {
    const state = applyOrThrow(
      deposit(initialState(), "100"),
      EventSchema.parse({
        id: "withdrawal-1",
        date: "2026-03-04",
        source: "manual",
        type: "withdrawal",
        account: "ib",
        amount: { amount: "25", currency: "EUR" },
      }),
    );

    expect(cashAmount(state, "ib", "EUR")).toBe("75");
    expect(state.contributedEur).toEqual({ amount: "75", currency: "EUR" });
  });

  it("moves a transfer without changing contributed capital", () => {
    const state = applyOrThrow(
      deposit(initialState(), "800"),
      EventSchema.parse({
        id: "transfer-1",
        date: "2026-03-05",
        source: "manual",
        type: "transfer",
        from: "ib",
        to: "myinvestor",
        amount: { amount: "200", currency: "EUR" },
      }),
    );

    expect(cashAmount(state, "ib", "EUR")).toBe("600");
    expect(cashAmount(state, "myinvestor", "EUR")).toBe("200");
    expect(state.contributedEur).toEqual({ amount: "800", currency: "EUR" });
  });

  it("applies FX to both cash sides and charges a source-currency fee", () => {
    const state = applyOrThrow(
      deposit(initialState(), "800"),
      EventSchema.parse({
        id: "fx-1",
        date: "2026-03-03",
        source: "manual",
        type: "fx",
        account: "ib",
        from: { amount: "798", currency: "EUR" },
        to: { amount: "927.04", currency: "USD" },
        fee: { amount: "1.71", currency: "EUR" },
      }),
    );

    expect(cashAmount(state, "ib", "EUR")).toBe("0.29");
    expect(cashAmount(state, "ib", "USD")).toBe("927.04");
    expect(state.contributedEur).toEqual({ amount: "800", currency: "EUR" });
  });

  it("buys a position with a fee included in native lot cost", () => {
    const state = buyHrow(
      applyOrThrow(
        deposit(initialState(), "800"),
        EventSchema.parse({
          id: "fx-2",
          date: "2026-03-03",
          source: "manual",
          type: "fx",
          account: "ib",
          from: { amount: "798", currency: "EUR" },
          to: { amount: "927.04", currency: "USD" },
          fee: { amount: "1.71", currency: "EUR" },
        }),
      ),
    );

    expect(cashAmount(state, "ib", "USD")).toBe("117.76");
    expect(state.lots.ib?.HROW).toEqual([
      { quantity: "20", cost: { amount: "809.28", currency: "USD" }, eventIds: ["buy-hrow"] },
    ]);
    expect(state.contributedEur).toEqual({ amount: "800", currency: "EUR" });
  });

  it("reduces holdings proportionally on a sell and adds net proceeds", () => {
    const bought = buyHrow(
      applyOrThrow(
        deposit(initialState(), "800"),
        EventSchema.parse({
          id: "fx-3",
          date: "2026-03-03",
          source: "manual",
          type: "fx",
          account: "ib",
          from: { amount: "798", currency: "EUR" },
          to: { amount: "927.04", currency: "USD" },
          fee: { amount: "1.71", currency: "EUR" },
        }),
      ),
    );
    const state = applyOrThrow(
      bought,
      EventSchema.parse({
        id: "sell-hrow",
        date: "2026-08-05",
        source: "manual",
        type: "sell",
        account: "ib",
        instrument: "HROW",
        qty: "12",
        price: { amount: "39.83", currency: "USD" },
        fee: { amount: "0.37", currency: "USD" },
        eurPerUnit: "0.866",
      }),
    );

    expect(cashAmount(state, "ib", "USD")).toBe("595.35");
    expect(state.lots.ib?.HROW).toEqual([
      { quantity: "8", cost: { amount: "323.712", currency: "USD" }, eventIds: ["buy-hrow"] },
    ]);
  });

  it("records net dividend, interest, and standalone fee cash movements", () => {
    let state = deposit(initialState(), "100");
    state = applyOrThrow(
      state,
      EventSchema.parse({
        id: "dividend-1",
        date: "2026-06-25",
        source: "manual",
        type: "dividend",
        account: "ib",
        instrument: "META",
        gross: { amount: "1.07", currency: "USD" },
        withholdingForeign: { amount: "0.16", currency: "USD" },
      }),
    );
    state = applyOrThrow(
      state,
      EventSchema.parse({
        id: "interest-1",
        date: "2026-06-26",
        source: "manual",
        type: "interest",
        account: "ib",
        gross: { amount: "5", currency: "EUR" },
        withholdingDomestic: { amount: "1", currency: "EUR" },
      }),
    );
    state = applyOrThrow(
      state,
      EventSchema.parse({
        id: "fee-1",
        date: "2026-06-27",
        source: "manual",
        type: "fee",
        account: "ib",
        amount: { amount: "2", currency: "EUR" },
      }),
    );

    expect(cashAmount(state, "ib", "EUR")).toBe("102");
    expect(cashAmount(state, "ib", "USD")).toBe("0.91");
    expect(state.contributedEur).toEqual({ amount: "100", currency: "EUR" });
  });

  it("rejects unknown IDs, oversells, and negative cash without mutating state", () => {
    const state = initialState();
    const before = structuredClone(state);
    const unknownAccount = EventSchema.parse({
      id: "unknown-account",
      date: "2026-03-03",
      source: "manual",
      type: "deposit",
      account: "unknown",
      amount: { amount: "1", currency: "EUR" },
    });
    const unknownResult = apply(state, unknownAccount);

    expect(unknownResult).toMatchObject({ ok: false, error: { type: "not-found" } });
    expect(state).toEqual(before);

    const noCashResult = apply(
      state,
      EventSchema.parse({
        id: "buy-without-cash",
        date: "2026-03-03",
        source: "manual",
        type: "buy",
        account: "ib",
        instrument: "HROW",
        qty: "1",
        price: { amount: "1", currency: "USD" },
      }),
    );
    expect(noCashResult).toMatchObject({ ok: false, error: { type: "invariant" } });
    expect(state).toEqual(before);
  });

  it("rejects a trade whose price currency differs from the instrument quote currency", () => {
    const result = apply(
      deposit(initialState(), "100"),
      EventSchema.parse({
        id: "wrong-currency-buy",
        date: "2026-03-03",
        source: "manual",
        type: "buy",
        account: "ib",
        instrument: "HROW",
        qty: "1",
        price: { amount: "1", currency: "EUR" },
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { type: "invariant" } });
  });

  it("keeps a position while recording a missing historical-rate hole", () => {
    const state = applyOrThrow(
      deposit(initialState(), "100", "USD"),
      EventSchema.parse({
        id: "buy-hole",
        date: "2026-03-03",
        source: "manual",
        type: "buy",
        account: "ib",
        instrument: "HROW",
        qty: "1",
        price: { amount: "10", currency: "USD" },
      }),
    );

    expect(state.lots.ib?.HROW).toHaveLength(1);
    expect(state.holes).toContainEqual(
      expect.objectContaining({ sourceId: "buy-hole", kind: "historical-rate" }),
    );
  });

  it("keeps the same instrument in separate account pockets", () => {
    let state = deposit(initialState(), "1000", "USD");
    state = buyHrow(state);
    state = applyOrThrow(
      state,
      EventSchema.parse({
        id: "deposit-myinvestor",
        date: "2026-03-04",
        source: "manual",
        type: "deposit",
        account: "myinvestor",
        amount: { amount: "100", currency: "USD" },
        eurPerUnit: "0.9",
      }),
    );
    state = applyOrThrow(
      state,
      EventSchema.parse({
        id: "buy-myinvestor",
        date: "2026-03-04",
        source: "manual",
        type: "buy",
        account: "myinvestor",
        instrument: "HROW",
        qty: "2",
        price: { amount: "20", currency: "USD" },
        eurPerUnit: "0.9",
      }),
    );

    expect(state.lots.ib?.HROW?.[0]?.quantity).toBe("20");
    expect(state.lots.myinvestor?.HROW?.[0]?.quantity).toBe("2");
  });
});
