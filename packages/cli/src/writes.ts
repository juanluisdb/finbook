import {
  AccountSchema,
  FxStampSchema,
  InstrumentSchema,
  PriceStampSchema,
  type Account,
  type FileBookStore,
  type FxStamp,
  type Instrument,
  type PriceStamp,
} from "@finbook/core";

import { requireResult, validationFailure } from "./errors.js";
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

export type PriceWriteOptions = {
  instrument?: string | undefined;
  amount?: string | undefined;
  currency?: string | undefined;
  asOf?: string | undefined;
  json?: boolean | undefined;
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

function zodFailure(
  location: string,
  error: { issues: readonly { message: string }[] },
): ReturnType<typeof validationFailure> {
  const issue = error.issues[0];
  const detail = issue === undefined ? "invalid value" : issue.message;
  return validationFailure(`Invalid ${location}: ${detail}.`, `Fix the ${location} input.`);
}
