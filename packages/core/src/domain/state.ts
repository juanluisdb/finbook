import type { Account, Instrument, Money } from "./schemas.js";

export type CashBalances = Record<string, Record<string, Money>>;
export type Lot = {
  quantity: string;
  cost: Money;
  eventIds: readonly string[];
};
export type LotBalances = Record<string, Record<string, Lot[]>>;

export type Hole = {
  sourceId: string;
  kind: "valuation";
  currency: string;
  message: string;
};

export type BookState = {
  accounts: readonly Account[];
  instruments: readonly Instrument[];
  cash: CashBalances;
  lots: LotBalances;
  contributedEur: Money;
  holes: readonly Hole[];
};

export function createInitialState(
  accounts: readonly Account[],
  instruments: readonly Instrument[],
): BookState {
  const cash: CashBalances = {};
  const lots: LotBalances = {};

  for (const account of accounts) {
    cash[account.id] = {};
    lots[account.id] = {};
  }

  return {
    accounts: [...accounts],
    instruments: [...instruments],
    cash,
    lots,
    contributedEur: { amount: "0", currency: "EUR" },
    holes: [],
  };
}

export function cloneState(state: BookState): BookState {
  const cash: CashBalances = {};
  for (const [accountId, balances] of Object.entries(state.cash)) {
    const clonedBalances: Record<string, Money> = {};
    for (const [currency, money] of Object.entries(balances)) {
      clonedBalances[currency] = { ...money };
    }
    cash[accountId] = clonedBalances;
  }

  const lots: LotBalances = {};
  for (const [accountId, accountLots] of Object.entries(state.lots)) {
    const clonedAccountLots: Record<string, Lot[]> = {};
    for (const [instrumentId, instrumentLots] of Object.entries(accountLots)) {
      clonedAccountLots[instrumentId] = instrumentLots.map((lot) => ({
        quantity: lot.quantity,
        cost: { ...lot.cost },
        eventIds: [...lot.eventIds],
      }));
    }
    lots[accountId] = clonedAccountLots;
  }

  return {
    accounts: [...state.accounts],
    instruments: [...state.instruments],
    cash,
    lots,
    contributedEur: { ...state.contributedEur },
    holes: state.holes.map((hole) => ({ ...hole })),
  };
}
