import { expect, it } from "vitest";
import {
  AccountSchema,
  EventSchema,
  InstrumentSchema,
  getHistory,
  type BookSnapshot,
} from "../src/index.js";

const account = AccountSchema.parse({
  id: "broker",
  name: "Broker",
  platform: "example",
  country: "ES",
  custodial: "broker",
});
const fund = InstrumentSchema.parse({
  id: "fund",
  name: "Fund",
  type: "fund",
  quoteCurrency: "EUR",
});

it("replays each inclusive day, carries the actual quote date, and values cash after a full sale", () => {
  const snapshot: BookSnapshot = {
    accounts: [account],
    instruments: [fund],
    fx: [],
    events: [
      EventSchema.parse({
        id: "deposit",
        source: "manual",
        type: "deposit",
        date: "2024-09-01",
        account: "broker",
        amount: { amount: "1000", currency: "EUR" },
        eurPerUnit: "1",
      }),
      EventSchema.parse({
        id: "buy",
        source: "manual",
        type: "buy",
        date: "2024-09-02",
        account: "broker",
        instrument: "fund",
        qty: "20",
        price: { amount: "40", currency: "EUR" },
        grossAmount: "800",
        eurPerUnit: "1",
      }),
      EventSchema.parse({
        id: "sell",
        source: "manual",
        type: "sell",
        date: "2024-09-09",
        account: "broker",
        instrument: "fund",
        qty: "20",
        price: { amount: "43", currency: "EUR" },
        grossAmount: "860",
        eurPerUnit: "1",
      }),
    ],
    prices: [
      {
        instrument: "fund",
        asOf: "2024-09-02",
        price: { amount: "40", currency: "EUR" },
        provenance: { kind: "manual" },
      },
      {
        instrument: "fund",
        asOf: "2024-09-03",
        price: { amount: "41", currency: "EUR" },
        provenance: { kind: "manual" },
      },
      {
        instrument: "fund",
        asOf: "2024-09-06",
        price: { amount: "42", currency: "EUR" },
        provenance: { kind: "manual" },
      },
    ],
  };
  const history = getHistory(snapshot, "2024-08-30", "2024-09-11");
  if (!history.ok) throw new Error(history.error.message);
  expect(history.data.map((row) => row.asOf)).toEqual([
    "2024-09-01",
    "2024-09-02",
    "2024-09-03",
    "2024-09-04",
    "2024-09-05",
    "2024-09-06",
    "2024-09-07",
    "2024-09-08",
    "2024-09-09",
    "2024-09-10",
    "2024-09-11",
  ]);
  expect(history.data.map((row) => row.totalEur?.amount)).toEqual([
    "1000",
    "1000",
    "1020",
    "1020",
    "1020",
    "1040",
    "1040",
    "1040",
    "1060",
    "1060",
    "1060",
  ]);
  expect(history.data[7]?.positions[0]?.priceMark).toEqual({
    asOf: "2024-09-06",
    source: "manual",
  });
  expect(history.data[8]?.positions).toEqual([]);
});

it("leaves earlier daily values unknown when only the execution price and a future NAV exist", () => {
  const snapshot: BookSnapshot = {
    accounts: [account],
    instruments: [fund],
    fx: [],
    events: [
      EventSchema.parse({
        id: "deposit",
        source: "manual",
        type: "deposit",
        date: "2024-09-02",
        account: "broker",
        amount: { amount: "1000", currency: "EUR" },
        eurPerUnit: "1",
      }),
      EventSchema.parse({
        id: "buy",
        source: "manual",
        type: "buy",
        date: "2024-09-02",
        account: "broker",
        instrument: "fund",
        qty: "20",
        price: { amount: "40", currency: "EUR" },
        grossAmount: "800",
        eurPerUnit: "1",
      }),
    ],
    prices: [
      {
        instrument: "fund",
        asOf: "2024-09-04",
        price: { amount: "43", currency: "EUR" },
        provenance: { kind: "manual" },
      },
    ],
  };
  expect(getHistory(snapshot, "2024-09-02", "2024-09-04")).toMatchObject({
    data: [
      { totalEur: null, holes: [{ sourceId: "price:fund" }], positions: [{ priceMark: null }] },
      { totalEur: null, positions: [{ priceMark: null }] },
      { totalEur: { amount: "1060" }, positions: [{ priceMark: { asOf: "2024-09-04" } }] },
    ],
  });
  expect(getHistory(snapshot, "2024-08-01", "2024-09-01")).toEqual({ ok: true, data: [] });
});

it("returns empty history for an empty ledger and rejects impossible or inverted dates", () => {
  const snapshot: BookSnapshot = { accounts: [], instruments: [], events: [], prices: [], fx: [] };
  expect(getHistory(snapshot, "2024-09-02", "2024-09-04")).toEqual({ ok: true, data: [] });
  expect(getHistory(snapshot, "2024-09-04", "2024-09-02")).toMatchObject({
    ok: false,
    error: { type: "validation" },
  });
  expect(getHistory(snapshot, "2024-02-30", "2024-09-02")).toMatchObject({
    ok: false,
    error: { type: "validation" },
  });
});
