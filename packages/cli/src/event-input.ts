import { readFileSync } from "node:fs";

import {
  EventSchema,
  type FileBookStore,
  type Event,
  type EurRateProvenance,
  type Money,
} from "@finbook/core";
import {
  ProviderIdSchema,
  type EurRateNeed,
  type EurRateResolution,
  type ResolvePriceOptions,
} from "@finbook/market-data";

import {
  externalFailure,
  notFoundFailure,
  requireResult,
  CliFailure,
  validationFailure,
} from "./errors.js";
import { writeSuccess } from "./output.js";

type AddBase = {
  id?: string | undefined;
  date?: string | undefined;
  source?: string | undefined;
  externalId?: string | undefined;
  note?: string | undefined;
};

type EventBaseFields = {
  id: string;
  date: string;
  source: string;
  note?: string;
  externalId?: string;
};

type RateInput = {
  eurPerUnit?: string | undefined;
  fetchRate?: boolean | undefined;
  provider?: string | undefined;
};

type AccountMoneyInput = AddBase &
  RateInput & {
    account?: string | undefined;
    amount?: string | undefined;
    currency?: string | undefined;
  };

export type DepositAddInput = AccountMoneyInput & { type: "deposit" };
export type WithdrawalAddInput = AccountMoneyInput & { type: "withdrawal" };

export type TransferAddInput = AddBase & {
  type: "transfer";
  from?: string | undefined;
  to?: string | undefined;
  amount?: string | undefined;
  currency?: string | undefined;
};

export type FxAddInput = AddBase & {
  type: "fx";
  account?: string | undefined;
  fromAmount?: string | undefined;
  fromCurrency?: string | undefined;
  toAmount?: string | undefined;
  toCurrency?: string | undefined;
  feeAmount?: string | undefined;
  feeCurrency?: string | undefined;
};

type TradeAddInput = AddBase &
  RateInput & {
    account?: string | undefined;
    instrument?: string | undefined;
    qty?: string | undefined;
    priceAmount?: string | undefined;
    priceCurrency?: string | undefined;
    feeAmount?: string | undefined;
    feeCurrency?: string | undefined;
  };

export type BuyAddInput = TradeAddInput & { type: "buy" };
export type SellAddInput = TradeAddInput & { type: "sell" };

type IncomeAddInput = AddBase &
  RateInput & {
    account?: string | undefined;
    instrument?: string | undefined;
    grossAmount?: string | undefined;
    grossCurrency?: string | undefined;
    withholdingForeignAmount?: string | undefined;
    withholdingDomesticAmount?: string | undefined;
  };

export type DividendAddInput = IncomeAddInput & { type: "dividend" };
export type InterestAddInput = IncomeAddInput & { type: "interest" };
export type FeeAddInput = AccountMoneyInput & { type: "fee" };

export type EventAddInput =
  | DepositAddInput
  | WithdrawalAddInput
  | TransferAddInput
  | FxAddInput
  | BuyAddInput
  | SellAddInput
  | DividendAddInput
  | InterestAddInput
  | FeeAddInput;

type EditBase = {
  type: Event["type"];
  date?: string | undefined;
  note?: string | undefined;
  clearNote?: boolean | undefined;
};

type EditRateInput = RateInput;

type EditAccountMoneyInput = EditBase &
  EditRateInput & {
    account?: string | undefined;
    amount?: string | undefined;
    currency?: string | undefined;
  };

export type DepositEditInput = EditAccountMoneyInput & { type: "deposit" };
export type WithdrawalEditInput = EditAccountMoneyInput & { type: "withdrawal" };

export type TransferEditInput = EditBase & {
  type: "transfer";
  from?: string | undefined;
  to?: string | undefined;
  amount?: string | undefined;
  currency?: string | undefined;
};

export type FxEditInput = EditBase & {
  type: "fx";
  account?: string | undefined;
  fromAmount?: string | undefined;
  fromCurrency?: string | undefined;
  toAmount?: string | undefined;
  toCurrency?: string | undefined;
  feeAmount?: string | undefined;
  feeCurrency?: string | undefined;
  clearFee?: boolean | undefined;
};

type TradeEditInput = EditBase &
  EditRateInput & {
    account?: string | undefined;
    instrument?: string | undefined;
    qty?: string | undefined;
    priceAmount?: string | undefined;
    priceCurrency?: string | undefined;
    feeAmount?: string | undefined;
    feeCurrency?: string | undefined;
    clearFee?: boolean | undefined;
  };

export type BuyEditInput = TradeEditInput & { type: "buy" };
export type SellEditInput = TradeEditInput & { type: "sell" };

type IncomeEditInput = EditBase &
  EditRateInput & {
    account?: string | undefined;
    instrument?: string | undefined;
    grossAmount?: string | undefined;
    grossCurrency?: string | undefined;
    withholdingForeignAmount?: string | undefined;
    withholdingDomesticAmount?: string | undefined;
    clearWithholdingForeign?: boolean | undefined;
    clearWithholdingDomestic?: boolean | undefined;
  };

export type DividendEditInput = IncomeEditInput & { type: "dividend" };
export type InterestEditInput = IncomeEditInput & { type: "interest" };
export type FeeEditInput = EditAccountMoneyInput & { type: "fee" };

export type EventEditInput =
  | DepositEditInput
  | WithdrawalEditInput
  | TransferEditInput
  | FxEditInput
  | BuyEditInput
  | SellEditInput
  | DividendEditInput
  | InterestEditInput
  | FeeEditInput;

export type HistoricalRateResolver = {
  resolveHistoricalEurRate(
    need: EurRateNeed,
    options?: ResolvePriceOptions,
  ): Promise<EurRateResolution>;
};

export async function addEvent(
  store: FileBookStore,
  input: EventAddInput,
  json: boolean,
  generateId: () => string,
  rateResolver?: HistoricalRateResolver,
): Promise<void> {
  const event = await buildEvent(input, generateId, rateResolver);
  const saved = requireResult(store.appendEvent(event));
  writeSuccess(saved, json, `${saved.id} added on ${saved.date}: ${eventSummary(saved)}`);
}

export function addEventFile(store: FileBookStore, path: string, json: boolean): void {
  const event = readEventFile(path);
  const saved = requireResult(store.appendEvent(event));
  writeSuccess(saved, json, `${saved.id} added on ${saved.date}: ${eventSummary(saved)}`);
}

export async function editEvent(
  store: FileBookStore,
  input: EventEditInput,
  id: string,
  json: boolean,
  rateResolver?: HistoricalRateResolver,
): Promise<void> {
  if (!hasEditValues(input)) {
    throw validationFailure(
      "An event edit needs at least one mutable field.",
      "Provide a field to change or a clear flag.",
    );
  }
  const snapshot = requireResult(store.load());
  const current = snapshot.events.find((event) => event.id === id);
  if (current === undefined) throw notFoundFailure("event", id);
  if (current.type !== input.type) {
    throw validationFailure(
      `Event ${id} is a ${current.type}, not a ${input.type}.`,
      "Use the matching event edit command; changing type requires delete and add.",
    );
  }
  const replacement = await buildReplacement(current, input, rateResolver);
  const saved = requireResult(store.replaceEvent(id, replacement));
  writeSuccess(saved, json, `${saved.id} edited on ${saved.date}: ${eventSummary(saved)}`);
}

export function deleteEvent(store: FileBookStore, id: string, json: boolean): void {
  const deleted = requireResult(store.deleteEvent(id));
  writeSuccess(deleted, json, `${deleted.id} deleted on ${deleted.date}: ${eventSummary(deleted)}`);
}

async function buildEvent(
  input: EventAddInput,
  generateId: () => string,
  rateResolver: HistoricalRateResolver | undefined,
): Promise<Event> {
  const base = addBase(input, generateId);
  switch (input.type) {
    case "deposit":
    case "withdrawal":
    case "fee": {
      const amount = requiredMoney(input.amount, input.currency, "--amount", "--currency");
      const rate = await resolveEurRate(amount.currency, base.date, input, rateResolver);
      return parseEvent({
        ...base,
        type: input.type,
        account: required(input.account, "--account"),
        amount,
        ...rate,
      });
    }
    case "transfer":
      return parseEvent({
        ...base,
        type: input.type,
        from: required(input.from, "--from"),
        to: required(input.to, "--to"),
        amount: requiredMoney(input.amount, input.currency, "--amount", "--currency"),
      });
    case "fx":
      return parseEvent({
        ...base,
        type: input.type,
        account: required(input.account, "--account"),
        from: requiredMoney(
          input.fromAmount,
          input.fromCurrency,
          "--from-amount",
          "--from-currency",
        ),
        to: requiredMoney(input.toAmount, input.toCurrency, "--to-amount", "--to-currency"),
        fee: optionalMoney(input.feeAmount, input.feeCurrency, "--fee-amount", "--fee-currency"),
      });
    case "buy":
    case "sell": {
      const price = requiredMoney(
        input.priceAmount,
        input.priceCurrency,
        "--price-amount",
        "--price-currency",
      );
      const rate = await resolveEurRate(price.currency, base.date, input, rateResolver);
      return parseEvent({
        ...base,
        type: input.type,
        account: required(input.account, "--account"),
        instrument: required(input.instrument, "--instrument"),
        qty: required(input.qty, "--qty"),
        price,
        fee: optionalMoney(
          input.feeAmount,
          input.feeAmount === undefined ? undefined : (input.feeCurrency ?? input.priceCurrency),
          "--fee-amount",
          "--fee-currency",
        ),
        ...rate,
      });
    }
    case "dividend": {
      const gross = requiredMoney(
        input.grossAmount,
        input.grossCurrency,
        "--gross-amount",
        "--gross-currency",
      );
      const rate = await resolveEurRate(gross.currency, base.date, input, rateResolver);
      return parseEvent({
        ...base,
        type: input.type,
        account: required(input.account, "--account"),
        instrument: required(input.instrument, "--instrument"),
        gross,
        withholdingForeign: optionalMoney(
          input.withholdingForeignAmount,
          input.withholdingForeignAmount === undefined ? undefined : input.grossCurrency,
          "--withholding-foreign-amount",
          "--gross-currency",
        ),
        withholdingDomestic: optionalMoney(
          input.withholdingDomesticAmount,
          input.withholdingDomesticAmount === undefined ? undefined : input.grossCurrency,
          "--withholding-domestic-amount",
          "--gross-currency",
        ),
        ...rate,
      });
    }
    case "interest": {
      const gross = requiredMoney(
        input.grossAmount,
        input.grossCurrency,
        "--gross-amount",
        "--gross-currency",
      );
      const rate = await resolveEurRate(gross.currency, base.date, input, rateResolver);
      return parseEvent({
        ...base,
        type: input.type,
        account: required(input.account, "--account"),
        gross,
        withholdingForeign: optionalMoney(
          input.withholdingForeignAmount,
          input.withholdingForeignAmount === undefined ? undefined : input.grossCurrency,
          "--withholding-foreign-amount",
          "--gross-currency",
        ),
        withholdingDomestic: optionalMoney(
          input.withholdingDomesticAmount,
          input.withholdingDomesticAmount === undefined ? undefined : input.grossCurrency,
          "--withholding-domestic-amount",
          "--gross-currency",
        ),
        ...rate,
      });
    }
  }
}

async function buildReplacement(
  current: Event,
  input: EventEditInput,
  rateResolver: HistoricalRateResolver | undefined,
): Promise<Event> {
  const base = editBase(current, input);
  switch (current.type) {
    case "deposit":
      if (input.type !== "deposit") throw typeMismatch(input.type, current.type);
      return buildAccountMoneyReplacement(current, input, base, rateResolver);
    case "withdrawal":
      if (input.type !== "withdrawal") throw typeMismatch(input.type, current.type);
      return buildAccountMoneyReplacement(current, input, base, rateResolver);
    case "fee":
      if (input.type !== "fee") throw typeMismatch(input.type, current.type);
      return buildAccountMoneyReplacement(current, input, base, rateResolver);
    case "transfer":
      if (input.type !== "transfer") throw typeMismatch(input.type, current.type);
      return parseEvent({
        ...base,
        type: current.type,
        from: input.from ?? current.from,
        to: input.to ?? current.to,
        amount: mergeMoney(current.amount, input.amount, input.currency),
      });
    case "fx":
      if (input.type !== "fx") throw typeMismatch(input.type, current.type);
      return buildFxReplacement(current, input, base);
    case "buy":
      if (input.type !== "buy") throw typeMismatch(input.type, current.type);
      return buildTradeReplacement(current, input, base, rateResolver);
    case "sell":
      if (input.type !== "sell") throw typeMismatch(input.type, current.type);
      return buildTradeReplacement(current, input, base, rateResolver);
    case "dividend":
      if (input.type !== "dividend") throw typeMismatch(input.type, current.type);
      return buildIncomeReplacement(current, input, base, rateResolver);
    case "interest":
      if (input.type !== "interest") throw typeMismatch(input.type, current.type);
      return buildIncomeReplacement(current, input, base, rateResolver);
  }
}

function typeMismatch(actual: EventEditInput["type"], expected: Event["type"]): CliFailure {
  return validationFailure(
    `Event edit type ${actual} does not match stored type ${expected}.`,
    "Use the matching event edit command; changing type requires delete and add.",
  );
}

async function buildAccountMoneyReplacement(
  current: Extract<Event, { type: "deposit" | "withdrawal" | "fee" }>,
  input: DepositEditInput | WithdrawalEditInput | FeeEditInput,
  base: EventBaseFields,
  rateResolver: HistoricalRateResolver | undefined,
): Promise<Event> {
  const amount = mergeMoney(current.amount, input.amount, input.currency);
  const rate = await resolveEditedRate(
    amount.currency,
    current.amount.currency,
    current,
    base.date,
    input,
    rateResolver,
  );
  return parseEvent({
    ...base,
    type: current.type,
    account: input.account ?? current.account,
    amount,
    ...rate,
  });
}

function buildFxReplacement(
  current: Extract<Event, { type: "fx" }>,
  input: FxEditInput,
  base: EventBaseFields,
): Event {
  const fee = mergeOptionalMoney(
    current.fee,
    input.feeAmount,
    input.feeCurrency,
    input.clearFee,
    undefined,
    "--fee-currency",
  );
  const replacement = {
    ...base,
    type: current.type,
    account: input.account ?? current.account,
    from: mergeMoney(current.from, input.fromAmount, input.fromCurrency),
    to: mergeMoney(current.to, input.toAmount, input.toCurrency),
  };
  if (fee !== undefined) Object.assign(replacement, { fee });
  return parseEvent(replacement);
}

async function buildTradeReplacement(
  current: Extract<Event, { type: "buy" | "sell" }>,
  input: BuyEditInput | SellEditInput,
  base: EventBaseFields,
  rateResolver: HistoricalRateResolver | undefined,
): Promise<Event> {
  const price = mergeMoney(current.price, input.priceAmount, input.priceCurrency);
  const fee = mergeOptionalMoney(
    current.fee,
    input.feeAmount,
    input.feeCurrency,
    input.clearFee,
    price.currency,
    "--fee-currency",
  );
  const rate = await resolveEditedRate(
    price.currency,
    current.price.currency,
    current,
    base.date,
    input,
    rateResolver,
  );
  const replacement = {
    ...base,
    type: current.type,
    account: input.account ?? current.account,
    instrument: input.instrument ?? current.instrument,
    qty: input.qty ?? current.qty,
    price,
    ...rate,
  };
  if (fee !== undefined) Object.assign(replacement, { fee });
  return parseEvent(replacement);
}

async function buildIncomeReplacement(
  current: Extract<Event, { type: "dividend" | "interest" }>,
  input: DividendEditInput | InterestEditInput,
  base: EventBaseFields,
  rateResolver: HistoricalRateResolver | undefined,
): Promise<Event> {
  const gross = mergeMoney(current.gross, input.grossAmount, input.grossCurrency);
  const rate = await resolveEditedRate(
    gross.currency,
    current.gross.currency,
    current,
    base.date,
    input,
    rateResolver,
  );
  const foreign = mergeWithholding(
    current.withholdingForeign,
    input.withholdingForeignAmount,
    gross.currency,
    input.clearWithholdingForeign,
    "--withholding-foreign-amount",
  );
  const domestic = mergeWithholding(
    current.withholdingDomestic,
    input.withholdingDomesticAmount,
    gross.currency,
    input.clearWithholdingDomestic,
    "--withholding-domestic-amount",
  );
  const common = {
    ...base,
    type: current.type,
    account: input.account ?? current.account,
    gross,
    ...rate,
  };
  if (foreign !== undefined) Object.assign(common, { withholdingForeign: foreign });
  if (domestic !== undefined) Object.assign(common, { withholdingDomestic: domestic });
  if (current.type === "dividend") {
    if (input.type !== "dividend") throw typeMismatch(input.type, current.type);
    return parseEvent({ ...common, instrument: input.instrument ?? current.instrument });
  }
  return parseEvent(common);
}

function addBase(input: AddBase, generateId: () => string): EventBaseFields {
  const base: EventBaseFields = {
    id: input.id ?? generateId(),
    date: required(input.date, "--date"),
    source: input.source ?? "manual",
  };
  if (input.note !== undefined) base.note = input.note;
  if (input.externalId !== undefined) base.externalId = input.externalId;
  return base;
}

function editBase(current: Event, input: EditBase): EventBaseFields {
  if (input.note !== undefined && input.clearNote === true) {
    throw validationFailure("Use either `--note` or `--clear-note`.", "Choose one note action.");
  }
  const base: EventBaseFields = {
    id: current.id,
    date: input.date ?? current.date,
    source: current.source,
  };
  if (current.externalId !== undefined) base.externalId = current.externalId;
  if (current.note !== undefined) base.note = current.note;
  if (input.clearNote === true) delete base.note;
  else if (input.note !== undefined) base.note = input.note;
  return base;
}

function hasEditValues(input: EventEditInput): boolean {
  return Object.entries(input).some(
    ([key, value]) => key !== "type" && value !== undefined && value !== false,
  );
}

function mergeMoney(
  current: { amount: string; currency: string },
  amount: string | undefined,
  currency: string | undefined,
): Money {
  return { amount: amount ?? current.amount, currency: currency ?? current.currency };
}

function mergeOptionalMoney(
  current: { amount: string; currency: string } | undefined,
  amount: string | undefined,
  currency: string | undefined,
  clear: boolean | undefined,
  defaultCurrency: string | undefined,
  currencyFlag: string,
): { amount: string; currency: string } | undefined {
  if (clear === true && (amount !== undefined || currency !== undefined)) {
    throw validationFailure(
      "A value and its clear flag cannot be used together.",
      "Choose either the value or the clear flag.",
    );
  }
  if (clear === true) return undefined;
  if (amount === undefined && currency === undefined) return current;
  if (current === undefined) {
    if (amount === undefined)
      throw validationFailure("Missing fee amount.", "Provide --fee-amount.");
    return { amount, currency: currency ?? required(defaultCurrency, currencyFlag) };
  }
  return { amount: amount ?? current.amount, currency: currency ?? current.currency };
}

function mergeWithholding(
  current: { amount: string; currency: string } | undefined,
  amount: string | undefined,
  currency: string,
  clear: boolean | undefined,
  amountFlag: string,
): { amount: string; currency: string } | undefined {
  if (clear === true && amount !== undefined) {
    throw validationFailure(
      "A withholding value and its clear flag cannot be used together.",
      `Choose either ${amountFlag} or its clear flag.`,
    );
  }
  if (clear === true) return undefined;
  if (amount === undefined && current === undefined) return undefined;
  return { amount: amount ?? current?.amount ?? required(undefined, amountFlag), currency };
}

type RateBearingEvent = {
  date: string;
  eurPerUnit: string;
  eurRateProvenance?: EurRateProvenance | undefined;
};

async function resolveEditedRate(
  currency: string,
  currentCurrency: string,
  current: RateBearingEvent,
  date: string,
  input: RateInput,
  resolver: HistoricalRateResolver | undefined,
): Promise<RateFields> {
  const currencyChanged = currency !== currentCurrency;
  const dateChanged = date !== current.date;
  const wantsNewRate = input.eurPerUnit !== undefined || input.fetchRate === true;
  if (input.provider !== undefined && input.fetchRate !== true) {
    throw validationFailure(
      "`--provider` requires `--fetch-rate`.",
      "Use --provider only when fetching the event rate.",
    );
  }
  if (input.eurPerUnit !== undefined && input.fetchRate === true) {
    throw validationFailure(
      "Use either `--eur-per-unit` or `--fetch-rate`.",
      "Choose one source for the event rate.",
    );
  }
  if (!wantsNewRate && !currencyChanged && !dateChanged) return existingRate(current);
  if (currency === "EUR") {
    if (input.fetchRate === true) {
      throw validationFailure(
        "EUR events do not need `--fetch-rate`.",
        "Omit --fetch-rate; finbook stores the EUR rate as 1.",
      );
    }
    return { eurPerUnit: input.eurPerUnit ?? "1" };
  }
  if (!wantsNewRate) {
    throw validationFailure(
      "Changing a rate-bearing date or currency requires a new EUR rate.",
      "Provide --eur-per-unit or use --fetch-rate.",
    );
  }
  return resolveEurRate(currency, date, input, resolver);
}

function existingRate(event: RateBearingEvent): RateFields {
  return event.eurRateProvenance === undefined
    ? { eurPerUnit: event.eurPerUnit }
    : { eurPerUnit: event.eurPerUnit, eurRateProvenance: event.eurRateProvenance };
}

type RateFields = { eurPerUnit: string; eurRateProvenance?: EurRateProvenance };

async function resolveEurRate(
  currency: string,
  date: string,
  input: RateInput,
  resolver: HistoricalRateResolver | undefined,
): Promise<RateFields> {
  const wantsFetch = input.fetchRate === true;
  if (input.provider !== undefined && !wantsFetch) {
    throw validationFailure(
      "`--provider` requires `--fetch-rate`.",
      "Use --provider only when fetching the event rate.",
    );
  }
  if (input.eurPerUnit !== undefined && wantsFetch) {
    throw validationFailure(
      "Use either `--eur-per-unit` or `--fetch-rate`.",
      "Choose one source for the event rate.",
    );
  }
  if (currency === "EUR") {
    if (wantsFetch) {
      throw validationFailure(
        "EUR events do not need `--fetch-rate`.",
        "Omit --fetch-rate; finbook stores the EUR rate as 1.",
      );
    }
    return { eurPerUnit: input.eurPerUnit ?? "1" };
  }
  if (input.eurPerUnit !== undefined) return { eurPerUnit: input.eurPerUnit };
  if (!wantsFetch) return { eurPerUnit: required(undefined, "--eur-per-unit") };
  if (resolver === undefined) {
    throw validationFailure(
      "Historical-rate fetching is not configured.",
      "Provide --eur-per-unit or configure a rate provider.",
    );
  }
  const provider = parseProvider(input.provider);
  const result = await resolver.resolveHistoricalEurRate(
    { currency, date },
    provider === undefined ? undefined : { provider },
  );
  if (!result.ok) {
    throw externalFailure(
      `Could not fetch the historical EUR rate: ${result.error.message}.`,
      "Retry the provider or provide --eur-per-unit.",
    );
  }
  return {
    eurPerUnit: result.data.rate,
    eurRateProvenance: {
      source: result.data.provenance.source,
      effectiveDate: result.data.effectiveDate,
      retrievedAt: result.data.provenance.retrievedAt,
    },
  };
}

function parseProvider(value: string | undefined): ResolvePriceOptions["provider"] {
  if (value === undefined) return undefined;
  const parsed = ProviderIdSchema.safeParse(value);
  if (!parsed.success)
    throw validationFailure(
      `Unknown provider: ${value}.`,
      "Use a provider supported by the current build.",
    );
  return parsed.data;
}

function requiredMoney(
  amount: string | undefined,
  currency: string | undefined,
  amountFlag: string,
  currencyFlag: string,
): Money {
  return { amount: required(amount, amountFlag), currency: required(currency, currencyFlag) };
}

function optionalMoney(
  amount: string | undefined,
  currency: string | undefined,
  amountFlag: string,
  currencyFlag: string,
): { amount: string; currency: string } | undefined {
  if (amount === undefined && currency !== undefined) {
    throw validationFailure(`Missing required ${amountFlag}.`, `Provide ${amountFlag}.`);
  }
  if (amount === undefined) return undefined;
  if (currency === undefined) {
    throw validationFailure(`Missing required ${currencyFlag}.`, `Provide ${currencyFlag}.`);
  }
  return { amount, currency };
}

function readEventFile(path: string): Event {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw validationFailure(
      `Could not read event file ${path}: ${error instanceof Error ? error.message : "unknown file error"}.`,
      "Check the file path and permissions.",
    );
  }
  try {
    return parseEvent(JSON.parse(raw));
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw validationFailure(
      `Event file ${path} is not valid JSON.`,
      "Provide one JSON event object.",
    );
  }
}

function parseEvent(value: Parameters<typeof EventSchema.parse>[0]): Event {
  const parsed = EventSchema.safeParse(value);
  if (!parsed.success) throw zodFailure("event", parsed.error);
  return parsed.data;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "")
    throw validationFailure(`Missing required ${flag}.`, `Provide ${flag}.`);
  return value;
}

function zodFailure(
  location: string,
  error: { issues: readonly { message: string }[] },
): CliFailure {
  const issue = error.issues[0];
  const detail = issue === undefined ? "invalid value" : issue.message;
  return validationFailure(`Invalid ${location}: ${detail}.`, `Fix the ${location} input.`);
}

function eventSummary(event: Event): string {
  switch (event.type) {
    case "deposit":
    case "withdrawal":
    case "fee":
      return `${event.type} ${event.amount.amount} ${event.amount.currency}`;
    case "transfer":
      return `transfer ${event.amount.amount} ${event.amount.currency} ${event.from} → ${event.to}`;
    case "fx":
      return `FX ${event.from.amount} ${event.from.currency} → ${event.to.amount} ${event.to.currency}`;
    case "buy":
    case "sell":
      return `${event.type} ${event.qty} ${event.instrument}`;
    case "dividend":
      return `dividend ${event.gross.amount} ${event.gross.currency} ${event.instrument}`;
    case "interest":
      return `interest ${event.gross.amount} ${event.gross.currency}`;
  }
}
