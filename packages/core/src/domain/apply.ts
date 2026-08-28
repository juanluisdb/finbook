import { DecimalMath } from "./decimal.js";
import { MoneyValue } from "./money.js";
import { fail, succeed, type DomainError, type Result } from "./result.js";
import { type Account, type Event, type Instrument, type Money } from "./schemas.js";
import { cloneState, type BookState, type Hole, type Lot } from "./state.js";

export function apply(state: BookState, event: Event): Result<BookState> {
  const nextState = cloneState(state);

  switch (event.type) {
    case "deposit":
      return applyDeposit(nextState, event);
    case "withdrawal":
      return applyWithdrawal(nextState, event);
    case "transfer":
      return applyTransfer(nextState, event);
    case "fx":
      return applyFx(nextState, event);
    case "buy":
      return applyBuy(nextState, event);
    case "sell":
      return applySell(nextState, event);
    case "dividend":
      return applyDividend(nextState, event);
    case "interest":
      return applyInterest(nextState, event);
    case "fee":
      return applyFee(nextState, event);
  }
}

function applyDeposit(
  state: BookState,
  event: Extract<Event, { type: "deposit" }>,
): Result<BookState> {
  const accountError = requireAccount(state, event.account);
  if (accountError !== undefined) return fail(accountError);

  const cashError = adjustCash(state, event.account, event.amount, "add");
  if (cashError !== undefined) return fail(cashError);

  applyContribution(state, event.amount, event.eurPerUnit, event.id, "add");
  return succeed(state);
}

function applyWithdrawal(
  state: BookState,
  event: Extract<Event, { type: "withdrawal" }>,
): Result<BookState> {
  const accountError = requireAccount(state, event.account);
  if (accountError !== undefined) return fail(accountError);

  const cashError = adjustCash(state, event.account, event.amount, "subtract");
  if (cashError !== undefined) return fail(cashError);

  applyContribution(state, event.amount, event.eurPerUnit, event.id, "subtract");
  return succeed(state);
}

function applyTransfer(
  state: BookState,
  event: Extract<Event, { type: "transfer" }>,
): Result<BookState> {
  const fromError = requireAccount(state, event.from);
  if (fromError !== undefined) return fail(fromError);
  const toError = requireAccount(state, event.to);
  if (toError !== undefined) return fail(toError);

  if (event.from === event.to) {
    return fail(
      invariantError("Transfer endpoints must differ.", "Use `fx` for a currency exchange."),
    );
  }
  const sourceCash = adjustCash(state, event.from, event.amount, "subtract");
  if (sourceCash !== undefined) return fail(sourceCash);
  const destinationCash = adjustCash(state, event.to, event.amount, "add");
  if (destinationCash !== undefined) return fail(destinationCash);
  return succeed(state);
}

function applyFx(state: BookState, event: Extract<Event, { type: "fx" }>): Result<BookState> {
  const accountError = requireAccount(state, event.account);
  if (accountError !== undefined) return fail(accountError);

  if (event.from.currency === event.to.currency) {
    return fail(
      invariantError("FX currencies must differ.", "Use a transfer for same-currency movement."),
    );
  }

  const feeInSource = event.fee?.currency === event.from.currency;
  const feeInDestination = event.fee?.currency === event.to.currency;
  if (event.fee !== undefined && !feeInSource && !feeInDestination) {
    return fail(
      invariantError(
        "An FX fee must use the source or destination currency.",
        "Record a fee in one of the exchanged currencies.",
      ),
    );
  }

  const sourceOut =
    event.fee !== undefined && feeInSource
      ? addMoney(event.from, event.fee)
      : MoneyValue.from(event.from);
  const destinationIn =
    event.fee !== undefined && feeInDestination
      ? subtractMoney(event.to, event.fee)
      : MoneyValue.from(event.to);

  if (destinationIn.isNegative()) {
    return fail(
      invariantError("An FX fee cannot exceed the destination amount.", "Check the fee amount."),
    );
  }

  const sourceCash = adjustCash(state, event.account, sourceOut.toMoney(), "subtract");
  if (sourceCash !== undefined) return fail(sourceCash);
  const destinationCash = adjustCash(state, event.account, destinationIn.toMoney(), "add");
  if (destinationCash !== undefined) return fail(destinationCash);
  return succeed(state);
}

function applyBuy(state: BookState, event: Extract<Event, { type: "buy" }>): Result<BookState> {
  const accountError = requireAccount(state, event.account);
  if (accountError !== undefined) return fail(accountError);
  const instrument = findInstrument(state, event.instrument);
  if (instrument === undefined) return fail(notFoundError("instrument", event.instrument));
  const currencyError = requireTradeCurrency(instrument, event.price.currency);
  if (currencyError !== undefined) return fail(currencyError);

  const cost = tradeValue(event.price, event.qty, event.fee);
  const cashError = adjustCash(state, event.account, cost.toMoney(), "subtract");
  if (cashError !== undefined) return fail(cashError);

  const accountLots = state.lots[event.account] ?? {};
  const instrumentLots = accountLots[event.instrument] ?? [];
  const lot: Lot = {
    quantity: event.qty,
    cost: cost.toMoney(),
    eventIds: [event.id],
  };
  accountLots[event.instrument] = [...instrumentLots, lot];
  state.lots[event.account] = accountLots;
  recordHistoricalRateHole(state, event.id, event.price, event.eurPerUnit, false);
  return succeed(state);
}

function applySell(state: BookState, event: Extract<Event, { type: "sell" }>): Result<BookState> {
  const accountError = requireAccount(state, event.account);
  if (accountError !== undefined) return fail(accountError);
  const instrument = findInstrument(state, event.instrument);
  if (instrument === undefined) return fail(notFoundError("instrument", event.instrument));
  const currencyError = requireTradeCurrency(instrument, event.price.currency);
  if (currencyError !== undefined) return fail(currencyError);

  const accountLots = state.lots[event.account] ?? {};
  const instrumentLots = accountLots[event.instrument] ?? [];
  const totalQuantity = instrumentLots.reduce(
    (total, lot) => total.plus(new DecimalMath(lot.quantity)),
    new DecimalMath(0),
  );
  const requestedQuantity = new DecimalMath(event.qty);
  if (requestedQuantity.greaterThan(totalQuantity)) {
    return fail(
      invariantError(
        "Cannot sell more than the current holding.",
        "Check the instrument quantity.",
      ),
    );
  }

  const grossProceeds = MoneyValue.from(event.price).multiply(event.qty);
  const proceeds =
    event.fee === undefined ? grossProceeds : grossProceeds.subtract(MoneyValue.from(event.fee));
  if (proceeds.isNegative()) {
    return fail(
      invariantError("A sell fee cannot exceed gross proceeds.", "Check the fee amount."),
    );
  }

  const cashError = adjustCash(state, event.account, proceeds.toMoney(), "add");
  if (cashError !== undefined) return fail(cashError);

  const remainingFactor = new DecimalMath(1)
    .minus(requestedQuantity.dividedBy(totalQuantity))
    .toFixed();
  const remainingLots = instrumentLots
    .map((lot) => ({
      ...lot,
      quantity: new DecimalMath(lot.quantity).times(remainingFactor).toFixed(),
      cost: MoneyValue.from(lot.cost).multiply(remainingFactor).toMoney(),
    }))
    .filter((lot) => !new DecimalMath(lot.quantity).isZero());
  if (remainingLots.length === 0) {
    delete accountLots[event.instrument];
  } else {
    accountLots[event.instrument] = remainingLots;
  }
  state.lots[event.account] = accountLots;
  recordHistoricalRateHole(state, event.id, event.price, event.eurPerUnit, false);
  return succeed(state);
}

function applyDividend(
  state: BookState,
  event: Extract<Event, { type: "dividend" }>,
): Result<BookState> {
  const accountError = requireAccount(state, event.account);
  if (accountError !== undefined) return fail(accountError);
  const instrument = findInstrument(state, event.instrument);
  if (instrument === undefined) return fail(notFoundError("instrument", event.instrument));
  const currencyError = requireTradeCurrency(instrument, event.gross.currency);
  if (currencyError !== undefined) return fail(currencyError);
  const net = incomeNet(event.gross, event.withholdingForeign, event.withholdingDomestic);
  if (net.isNegative()) {
    return fail(
      invariantError("Withholdings cannot exceed gross income.", "Check the withholding amounts."),
    );
  }
  const cashError = adjustCash(state, event.account, net.toMoney(), "add");
  if (cashError !== undefined) return fail(cashError);
  recordHistoricalRateHole(state, event.id, event.gross, event.eurPerUnit, false);
  return succeed(state);
}

function applyInterest(
  state: BookState,
  event: Extract<Event, { type: "interest" }>,
): Result<BookState> {
  const accountError = requireAccount(state, event.account);
  if (accountError !== undefined) return fail(accountError);
  const net = incomeNet(event.gross, event.withholdingForeign, event.withholdingDomestic);
  if (net.isNegative()) {
    return fail(
      invariantError("Withholdings cannot exceed gross income.", "Check the withholding amounts."),
    );
  }
  const cashError = adjustCash(state, event.account, net.toMoney(), "add");
  if (cashError !== undefined) return fail(cashError);
  recordHistoricalRateHole(state, event.id, event.gross, event.eurPerUnit, false);
  return succeed(state);
}

function applyFee(state: BookState, event: Extract<Event, { type: "fee" }>): Result<BookState> {
  const accountError = requireAccount(state, event.account);
  if (accountError !== undefined) return fail(accountError);
  const cashError = adjustCash(state, event.account, event.amount, "subtract");
  if (cashError !== undefined) return fail(cashError);
  recordHistoricalRateHole(state, event.id, event.amount, event.eurPerUnit, false);
  return succeed(state);
}

function requireAccount(state: BookState, accountId: string): DomainError | undefined {
  return findAccount(state, accountId) === undefined
    ? notFoundError("account", accountId)
    : undefined;
}

function findAccount(state: BookState, accountId: string): Account | undefined {
  return state.accounts.find((account) => account.id === accountId);
}

function findInstrument(state: BookState, instrumentId: string): Instrument | undefined {
  return state.instruments.find((instrument) => instrument.id === instrumentId);
}

function requireTradeCurrency(instrument: Instrument, currency: string): DomainError | undefined {
  return instrument.quoteCurrency === currency
    ? undefined
    : invariantError(
        `Trade currency ${currency} does not match ${instrument.id} quote currency ${instrument.quoteCurrency}.`,
        "Use the instrument quote currency.",
      );
}

function adjustCash(
  state: BookState,
  accountId: string,
  amount: Money,
  direction: "add" | "subtract",
): DomainError | undefined {
  const current = MoneyValue.from(
    state.cash[accountId]?.[amount.currency] ?? {
      amount: "0",
      currency: amount.currency,
    },
  );
  const next =
    direction === "add"
      ? current.add(MoneyValue.from(amount))
      : current.subtract(MoneyValue.from(amount));
  if (next.isNegative()) {
    return invariantError(
      `Insufficient ${amount.currency} cash in account ${accountId}.`,
      "Add the cash event before recording this operation.",
    );
  }
  const accountCash = state.cash[accountId] ?? {};
  accountCash[amount.currency] = next.toMoney();
  state.cash[accountId] = accountCash;
  return undefined;
}

function applyContribution(
  state: BookState,
  amount: Money,
  eurPerUnit: string | undefined,
  eventId: string,
  direction: "add" | "subtract",
): void {
  const eurAmount = toEur(amount, eurPerUnit);
  if (eurAmount === undefined) {
    recordHistoricalRateHole(state, eventId, amount, eurPerUnit, true);
    return;
  }
  const current = MoneyValue.from(state.contributedEur);
  const next = direction === "add" ? current.add(eurAmount) : current.subtract(eurAmount);
  state.contributedEur = next.toMoney();
}

function toEur(amount: Money, eurPerUnit: string | undefined): MoneyValue | undefined {
  if (amount.currency === "EUR") return MoneyValue.from(amount);
  if (eurPerUnit === undefined) return undefined;
  const converted = new DecimalMath(amount.amount).times(new DecimalMath(eurPerUnit));
  return MoneyValue.from({ amount: converted.toFixed(), currency: "EUR" });
}

function recordHistoricalRateHole(
  state: BookState,
  sourceId: string,
  amount: Money,
  eurPerUnit: string | undefined,
  affectsContribution: boolean,
): void {
  if (amount.currency === "EUR" || eurPerUnit !== undefined) return;
  const hole: Hole = {
    sourceId,
    kind: "historical-rate",
    affectsContribution,
    currency: amount.currency,
    message: `Missing historical EUR rate for ${amount.currency} amount.`,
  };
  state.holes = [...state.holes, hole];
}

function tradeValue(price: Money, quantity: string, fee: Money | undefined): MoneyValue {
  const gross = MoneyValue.from(price).multiply(quantity);
  return fee === undefined ? gross : gross.add(MoneyValue.from(fee));
}

function incomeNet(
  gross: Money,
  withholdingForeign: Money | undefined,
  withholdingDomestic: Money | undefined,
): MoneyValue {
  let net = MoneyValue.from(gross);
  if (withholdingForeign !== undefined) net = net.subtract(MoneyValue.from(withholdingForeign));
  if (withholdingDomestic !== undefined) net = net.subtract(MoneyValue.from(withholdingDomestic));
  return net;
}

function addMoney(left: Money, right: Money): MoneyValue {
  return MoneyValue.from(left).add(MoneyValue.from(right));
}

function subtractMoney(left: Money, right: Money): MoneyValue {
  return MoneyValue.from(left).subtract(MoneyValue.from(right));
}

function notFoundError(kind: string, id: string): DomainError {
  return {
    type: "not-found",
    message: `Unknown ${kind} ID: ${id}.`,
    hint: `Add or select an existing ${kind}.`,
  };
}

function invariantError(message: string, hint: string): DomainError {
  return { type: "invariant", message, hint };
}
