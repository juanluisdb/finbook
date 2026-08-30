import { readFileSync } from "node:fs";

import {
  AccountSchema,
  EventSchema,
  FileBookStore,
  InstrumentSchema,
  PriceStampSchema,
  FxStampSchema,
  createInitialState,
  replayEvents,
  type Account,
  type Event,
  type Instrument,
  type PriceStamp,
  type FxStamp,
} from "@finbook/core";

import { CliFailure, requireResult, validationFailure } from "./errors.js";
import { writeSuccess } from "./output.js";

export type AccountWriteOptions = {
  id?: string | undefined;
  name?: string | undefined;
  platform?: string | undefined;
  country?: string | undefined;
  custodial?: string | undefined;
  json?: boolean | undefined;
};

export type InstrumentWriteOptions = {
  id?: string | undefined;
  name?: string | undefined;
  type?: string | undefined;
  quoteCurrency?: string | undefined;
  isin?: string | undefined;
  json?: boolean | undefined;
};

export type EventWriteOptions = {
  file?: string | undefined;
  id?: string | undefined;
  date?: string | undefined;
  source?: string | undefined;
  externalId?: string | undefined;
  note?: string | undefined;
  account?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  amount?: string | undefined;
  currency?: string | undefined;
  fromAmount?: string | undefined;
  fromCurrency?: string | undefined;
  toAmount?: string | undefined;
  toCurrency?: string | undefined;
  feeAmount?: string | undefined;
  feeCurrency?: string | undefined;
  instrument?: string | undefined;
  qty?: string | undefined;
  priceAmount?: string | undefined;
  priceCurrency?: string | undefined;
  grossAmount?: string | undefined;
  grossCurrency?: string | undefined;
  withholdingForeignAmount?: string | undefined;
  withholdingDomesticAmount?: string | undefined;
  eurPerUnit?: string | undefined;
  json?: boolean | undefined;
};

export type PriceWriteOptions = {
  instrument?: string | undefined;
  amount?: string | undefined;
  currency?: string | undefined;
  asOf?: string | undefined;
  json?: boolean | undefined;
};

type RawMoney = {
  amount: string;
  currency: string;
};

export type FxWriteOptions = {
  pair?: string | undefined;
  rate?: string | undefined;
  asOf?: string | undefined;
  json?: boolean | undefined;
};

export function addAccount(
  store: FileBookStore,
  options: AccountWriteOptions,
  json: boolean,
): void {
  const account = parseAccount({
    id: required(options.id, "--id"),
    name: required(options.name, "--name"),
    platform: required(options.platform, "--platform"),
    country: required(options.country, "--country"),
    custodial: required(options.custodial, "--custodial"),
  });
  requireResult(store.appendAccount(account));
  writeSuccess(account, json, `${account.id} added`);
}

export function addInstrument(
  store: FileBookStore,
  options: InstrumentWriteOptions,
  json: boolean,
): void {
  const instrument = parseInstrument({
    id: required(options.id, "--id"),
    name: required(options.name, "--name"),
    type: required(options.type, "--type"),
    quoteCurrency: required(options.quoteCurrency, "--quote-currency"),
    isin: options.isin,
  });
  requireResult(store.appendInstrument(instrument));
  writeSuccess(instrument, json, `${instrument.id} added`);
}

export function addEvent(
  store: FileBookStore,
  type: string | undefined,
  options: EventWriteOptions,
  json: boolean,
  generateId: () => string,
): void {
  const event = buildEvent(type, options, generateId);
  const snapshot = requireResult(store.load());
  const replayed = replayEvents(createInitialState(snapshot.accounts, snapshot.instruments), [
    ...snapshot.events,
    event,
  ]);
  requireResult(replayed);
  requireResult(store.appendEvent(event));
  writeSuccess(event, json, `${event.id} added`);
}

export function setPrice(store: FileBookStore, options: PriceWriteOptions, json: boolean): void {
  const stamp = parsePrice({
    instrument: required(options.instrument, "--instrument"),
    price: {
      amount: required(options.amount, "--amount"),
      currency: required(options.currency, "--currency"),
    },
    asOf: required(options.asOf, "--as-of"),
    provenance: { kind: "manual" },
  });
  requireResult(store.appendPrice(stamp));
  writeSuccess(
    stamp,
    json,
    `${stamp.instrument} price set to ${stamp.price.amount} ${stamp.price.currency}`,
  );
}

export function setFx(store: FileBookStore, options: FxWriteOptions, json: boolean): void {
  const stamp = parseFx({
    pair: required(options.pair, "--pair"),
    rate: required(options.rate, "--rate"),
    asOf: required(options.asOf, "--as-of"),
    provenance: { kind: "manual" },
  });
  requireResult(store.appendFx(stamp));
  writeSuccess(stamp, json, `${stamp.pair} FX set to ${stamp.rate}`);
}

function buildEvent(
  type: string | undefined,
  options: EventWriteOptions,
  generateId: () => string,
): Event {
  if (options.file !== undefined && type !== undefined) {
    throw validationFailure(
      "Do not provide an event type with `--file`.",
      "Use either a type and flags or `--file`.",
    );
  }
  if (options.file !== undefined) return readEventFile(options.file);
  if (type === undefined) {
    throw validationFailure(
      "Missing event type.",
      "Provide a type such as `deposit` or use `--file`.",
    );
  }

  const base = {
    id: options.id ?? generateId(),
    date: required(options.date, "--date"),
    source: options.source ?? "manual",
    note: options.note,
    externalId: options.externalId,
  };

  switch (type) {
    case "deposit":
      return parseEvent({
        ...base,
        type,
        account: required(options.account, "--account"),
        amount: requiredMoney(options.amount, options.currency, "--amount", "--currency"),
        eurPerUnit: requiredEurPerUnit(options.currency, options.eurPerUnit),
      });
    case "withdrawal":
      return parseEvent({
        ...base,
        type,
        account: required(options.account, "--account"),
        amount: requiredMoney(options.amount, options.currency, "--amount", "--currency"),
        eurPerUnit: requiredEurPerUnit(options.currency, options.eurPerUnit),
      });
    case "transfer":
      return parseEvent({
        ...base,
        type,
        from: required(options.from, "--from"),
        to: required(options.to, "--to"),
        amount: requiredMoney(options.amount, options.currency, "--amount", "--currency"),
      });
    case "fx":
      return parseEvent({
        ...base,
        type,
        account: required(options.account, "--account"),
        from: requiredMoney(
          options.fromAmount,
          options.fromCurrency,
          "--from-amount",
          "--from-currency",
        ),
        to: requiredMoney(options.toAmount, options.toCurrency, "--to-amount", "--to-currency"),
        fee: optionalMoney(
          options.feeAmount,
          options.feeCurrency,
          "--fee-amount",
          "--fee-currency",
        ),
      });
    case "buy":
    case "sell":
      return parseEvent({
        ...base,
        type,
        account: required(options.account, "--account"),
        instrument: required(options.instrument, "--instrument"),
        qty: required(options.qty, "--qty"),
        price: requiredMoney(
          options.priceAmount,
          options.priceCurrency,
          "--price-amount",
          "--price-currency",
        ),
        fee: optionalMoney(
          options.feeAmount,
          options.feeCurrency ?? options.priceCurrency,
          "--fee-amount",
          "--fee-currency",
        ),
        eurPerUnit: requiredEurPerUnit(options.priceCurrency, options.eurPerUnit),
      });
    case "dividend":
      return parseEvent({
        ...base,
        type,
        account: required(options.account, "--account"),
        instrument: required(options.instrument, "--instrument"),
        gross: requiredMoney(
          options.grossAmount,
          options.grossCurrency,
          "--gross-amount",
          "--gross-currency",
        ),
        withholdingForeign: optionalMoney(
          options.withholdingForeignAmount,
          options.grossCurrency,
          "--withholding-foreign-amount",
          "--gross-currency",
        ),
        withholdingDomestic: optionalMoney(
          options.withholdingDomesticAmount,
          options.grossCurrency,
          "--withholding-domestic-amount",
          "--gross-currency",
        ),
        eurPerUnit: requiredEurPerUnit(options.grossCurrency, options.eurPerUnit),
      });
    case "interest":
      return parseEvent({
        ...base,
        type,
        account: required(options.account, "--account"),
        gross: requiredMoney(
          options.grossAmount,
          options.grossCurrency,
          "--gross-amount",
          "--gross-currency",
        ),
        withholdingForeign: optionalMoney(
          options.withholdingForeignAmount,
          options.grossCurrency,
          "--withholding-foreign-amount",
          "--gross-currency",
        ),
        withholdingDomestic: optionalMoney(
          options.withholdingDomesticAmount,
          options.grossCurrency,
          "--withholding-domestic-amount",
          "--gross-currency",
        ),
        eurPerUnit: requiredEurPerUnit(options.grossCurrency, options.eurPerUnit),
      });
    case "fee":
      return parseEvent({
        ...base,
        type,
        account: required(options.account, "--account"),
        amount: requiredMoney(options.amount, options.currency, "--amount", "--currency"),
        eurPerUnit: requiredEurPerUnit(options.currency, options.eurPerUnit),
      });
    default:
      throw validationFailure(
        `Unknown event type: ${type}.`,
        "Use deposit, withdrawal, transfer, fx, buy, sell, dividend, interest, or fee.",
      );
  }
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
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw validationFailure(
      `Event file ${path} is not valid JSON.`,
      "Provide one JSON event object.",
    );
  }
  return parseEvent(value);
}

function parseEvent(value: Parameters<typeof EventSchema.parse>[0]): Event {
  const parsed = EventSchema.safeParse(value);
  if (!parsed.success) throw zodFailure("event", parsed.error);
  return parsed.data;
}

function parseAccount(value: Parameters<typeof AccountSchema.parse>[0]): Account {
  const parsed = AccountSchema.safeParse(value);
  if (!parsed.success) throw zodFailure("account", parsed.error);
  return parsed.data;
}

function parseInstrument(value: Parameters<typeof InstrumentSchema.parse>[0]): Instrument {
  const parsed = InstrumentSchema.safeParse(value);
  if (!parsed.success) throw zodFailure("instrument", parsed.error);
  return parsed.data;
}

function parsePrice(value: Parameters<typeof PriceStampSchema.parse>[0]): PriceStamp {
  const parsed = PriceStampSchema.safeParse(value);
  if (!parsed.success) throw zodFailure("price stamp", parsed.error);
  return parsed.data;
}

function parseFx(value: Parameters<typeof FxStampSchema.parse>[0]): FxStamp {
  const parsed = FxStampSchema.safeParse(value);
  if (!parsed.success) throw zodFailure("FX stamp", parsed.error);
  return parsed.data;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") {
    throw validationFailure(`Missing required ${flag}.`, `Provide ${flag}.`);
  }
  return value;
}

function requiredEurPerUnit(currency: string | undefined, value: string | undefined): string {
  if (currency === "EUR") return value ?? "1";
  return required(value, "--eur-per-unit");
}

function requiredMoney(
  amount: string | undefined,
  currency: string | undefined,
  amountFlag: string,
  currencyFlag: string,
): RawMoney {
  return {
    amount: required(amount, amountFlag),
    currency: required(currency, currencyFlag),
  };
}

function optionalMoney(
  amount: string | undefined,
  currency: string | undefined,
  amountFlag: string,
  currencyFlag: string,
): { amount: string; currency: string } | undefined {
  if (amount === undefined) return undefined;
  if (currency === undefined || currency.trim() === "") {
    throw validationFailure(`Missing ${currencyFlag}.`, `Provide ${currencyFlag}.`);
  }
  return { amount, currency };
}

function zodFailure(
  location: string,
  error: { issues: readonly { message: string }[] },
): CliFailure {
  const issue = error.issues[0];
  const detail = issue === undefined ? "invalid value" : issue.message;
  return validationFailure(`Invalid ${location}: ${detail}.`, `Fix the ${location} input.`);
}
