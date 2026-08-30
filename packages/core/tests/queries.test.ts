import { describe, expect, it } from "vitest";

import {
  AccountSchema,
  EventSchema,
  InstrumentSchema,
  type Account,
  type BookSnapshot,
  getGlance,
  getPositions,
} from "../src/index.js";

const accounts: Account[] = [
  AccountSchema.parse({
    id: "ib",
    name: "Interactive Brokers",
    platform: "interactive-brokers",
    country: "IE",
    custodial: "broker",
  }),
];

const instruments = [
  InstrumentSchema.parse({
    id: "HROW",
    name: "Harrow",
    type: "stock",
    quoteCurrency: "USD",
  }),
];

function snapshot(overrides: Partial<BookSnapshot> = {}): BookSnapshot {
  return {
    accounts,
    instruments,
    events: [
      EventSchema.parse({
        id: "deposit-1",
        date: "2026-03-01",
        source: "manual",
        type: "deposit",
        account: "ib",
        amount: { amount: "100", currency: "USD" },
        eurPerUnit: "0.9",
      }),
      EventSchema.parse({
        id: "buy-1",
        date: "2026-03-02",
        source: "manual",
        type: "buy",
        account: "ib",
        instrument: "HROW",
        qty: "1",
        price: { amount: "40", currency: "USD" },
        eurPerUnit: "0.9",
      }),
    ],
    prices: [
      { instrument: "HROW", price: { amount: "40", currency: "USD" }, asOf: "2026-04-01" },
      { instrument: "HROW", price: { amount: "50", currency: "USD" }, asOf: "2026-06-01" },
    ],
    fx: [
      { pair: "USD/EUR", rate: "0.9", asOf: "2026-04-01" },
      { pair: "USD/EUR", rate: "0.8", asOf: "2026-06-01" },
    ],
    ...overrides,
  };
}

describe("replay and queries", () => {
  it("uses only event and stamp data at or before as-of", () => {
    const result = getGlance(snapshot(), "2026-05-01");

    expect(result).toMatchObject({
      ok: true,
      data: {
        asOf: "2026-05-01",
        totalEur: { amount: "90", currency: "EUR" },
        contributedEur: { amount: "90", currency: "EUR" },
        pnlEur: { amount: "0", currency: "EUR" },
      },
    });

    const later = getGlance(snapshot(), "2026-07-01");
    expect(later).toMatchObject({
      ok: true,
      data: {
        totalEur: { amount: "88", currency: "EUR" },
        contributedEur: { amount: "90", currency: "EUR" },
        pnlEur: { amount: "-2", currency: "EUR" },
      },
    });
  });

  it("uses the last trade price as a fallback when no price stamp exists", () => {
    const result = getPositions(
      snapshot({
        prices: [],
      }),
      "2026-05-01",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        positions: [
          {
            instrument: "HROW",
            quantity: "1",
            valueEur: { amount: "36", currency: "EUR" },
          },
        ],
      },
    });
  });

  it("reports a valuation hole when a non-EUR FX stamp is missing", () => {
    const result = getGlance(
      snapshot({
        fx: [],
      }),
      "2026-05-01",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalEur: null,
        holes: expect.arrayContaining([
          expect.objectContaining({ kind: "valuation", sourceId: "fx:USD/EUR" }),
        ]),
      },
    });
  });

  it("keeps contribution known without historical-rate holes", () => {
    const result = getGlance(
      snapshot({
        events: [
          EventSchema.parse({
            id: "deposit-rated",
            date: "2026-03-01",
            source: "manual",
            type: "deposit",
            account: "ib",
            amount: { amount: "100", currency: "USD" },
            eurPerUnit: "0.9",
          }),
          EventSchema.parse({
            id: "buy-rated",
            date: "2026-03-02",
            source: "manual",
            type: "buy",
            account: "ib",
            instrument: "HROW",
            qty: "1",
            price: { amount: "40", currency: "USD" },
            eurPerUnit: "0.9",
          }),
        ],
      }),
      "2026-05-01",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalEur: { amount: "90", currency: "EUR" },
        contributedEur: { amount: "90", currency: "EUR" },
        pnlEur: { amount: "0", currency: "EUR" },
        holes: [],
      },
    });
  });

  it("replays a late historical event by date instead of append order", () => {
    const result = getPositions(
      snapshot({
        events: [
          EventSchema.parse({
            id: "buy-before-deposit",
            date: "2026-03-02",
            source: "manual",
            type: "buy",
            account: "ib",
            instrument: "HROW",
            qty: "1",
            price: { amount: "40", currency: "USD" },
            eurPerUnit: "0.9",
          }),
          EventSchema.parse({
            id: "deposit-after-buy-entry",
            date: "2026-03-01",
            source: "manual",
            type: "deposit",
            account: "ib",
            amount: { amount: "50", currency: "USD" },
            eurPerUnit: "0.9",
          }),
        ],
      }),
      "2026-03-05",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        positions: [{ instrument: "HROW", quantity: "1" }],
      },
    });
  });

  it("groups current EUR value into platform and currency weights", () => {
    const result = getGlance(
      snapshot({
        accounts: [
          accounts[0],
          AccountSchema.parse({
            id: "myinvestor",
            name: "MyInvestor",
            platform: "myinvestor",
            country: "ES",
            custodial: "broker",
          }),
        ],
        events: [
          EventSchema.parse({
            id: "deposit-ib",
            date: "2026-03-01",
            source: "manual",
            type: "deposit",
            account: "ib",
            amount: { amount: "100", currency: "EUR" },
            eurPerUnit: "1",
          }),
          EventSchema.parse({
            id: "deposit-myinvestor",
            date: "2026-03-01",
            source: "manual",
            type: "deposit",
            account: "myinvestor",
            amount: { amount: "300", currency: "EUR" },
            eurPerUnit: "1",
          }),
        ],
      }),
      "2026-03-05",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalEur: { amount: "400", currency: "EUR" },
        byPlatform: [
          { key: "interactive-brokers", valueEur: { amount: "100" }, weight: "0.25" },
          { key: "myinvestor", valueEur: { amount: "300" }, weight: "0.75" },
        ],
        byCurrency: [{ key: "EUR", valueEur: { amount: "400" }, weight: "1" }],
        weights: {
          byPlatform: { "interactive-brokers": "0.25", myinvestor: "0.75" },
        },
      },
    });
  });

  it("keeps contribution known when valuation data is missing", () => {
    const result = getGlance(
      snapshot({
        events: [
          EventSchema.parse({
            id: "deposit-rated",
            date: "2026-03-01",
            source: "manual",
            type: "deposit",
            account: "ib",
            amount: { amount: "100", currency: "USD" },
            eurPerUnit: "0.9",
          }),
        ],
        fx: [],
      }),
      "2026-05-01",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalEur: null,
        contributedEur: { amount: "90", currency: "EUR" },
        pnlEur: null,
        holes: [expect.objectContaining({ sourceId: "fx:USD/EUR", kind: "valuation" })],
      },
    });
  });
});
