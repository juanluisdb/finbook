import { readFileSync } from "node:fs";

import {
  AccountIdSchema,
  CurrencySchema,
  EventSchema,
  IsoDateSchema,
  InstrumentIdSchema,
  NonNegativeDecimalStringSchema,
  NonEmptyStringSchema,
  PositiveDecimalStringSchema,
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
import { z } from "zod";

import {
  externalFailure,
  notFoundFailure,
  requireResult,
  CliFailure,
  validationFailure,
} from "./errors.js";
import { writeSuccess } from "./output.js";

const AddBaseFields = {
  id: NonEmptyStringSchema.optional(),
  date: IsoDateSchema,
  source: NonEmptyStringSchema.optional(),
  externalId: NonEmptyStringSchema.optional(),
  note: z.string().optional(),
  json: z.boolean().optional(),
};

const RateFields = {
  eurPerUnit: PositiveDecimalStringSchema.optional(),
  fetchRate: z.boolean().optional(),
  provider: ProviderIdSchema.optional(),
};

const RateOptionsSchema = z.object(RateFields).strict();
type RateInput = z.infer<typeof RateOptionsSchema>;

const EditBaseFields = {
  date: IsoDateSchema.optional(),
  note: z.string().optional(),
  clearNote: z.boolean().optional(),
  json: z.boolean().optional(),
};

const AccountMoneyAddFields = {
  ...AddBaseFields,
  ...RateFields,
  account: AccountIdSchema,
  amount: PositiveDecimalStringSchema,
  currency: CurrencySchema,
};

const TransferAddSchema = z
  .object({
    ...AddBaseFields,
    type: z.literal("transfer"),
    from: AccountIdSchema,
    to: AccountIdSchema,
    amount: PositiveDecimalStringSchema,
    currency: CurrencySchema,
  })
  .strict();

const FxAddSchema = z
  .object({
    ...AddBaseFields,
    type: z.literal("fx"),
    account: AccountIdSchema,
    fromAmount: PositiveDecimalStringSchema,
    fromCurrency: CurrencySchema,
    toAmount: PositiveDecimalStringSchema,
    toCurrency: CurrencySchema,
    feeAmount: NonNegativeDecimalStringSchema.optional(),
    feeCurrency: CurrencySchema.optional(),
  })
  .strict()
  .superRefine((input, context) =>
    validateOptionalMoneyPair(input.feeAmount, input.feeCurrency, context),
  );

const TradeAddFields = {
  ...AddBaseFields,
  ...RateFields,
  account: AccountIdSchema,
  instrument: InstrumentIdSchema,
  qty: PositiveDecimalStringSchema,
  priceAmount: PositiveDecimalStringSchema,
  priceCurrency: CurrencySchema,
  feeAmount: NonNegativeDecimalStringSchema.optional(),
  feeCurrency: CurrencySchema.optional(),
};

const DividendAddSchema = z
  .object({
    ...AddBaseFields,
    ...RateFields,
    type: z.literal("dividend"),
    account: AccountIdSchema,
    instrument: InstrumentIdSchema,
    grossAmount: PositiveDecimalStringSchema,
    grossCurrency: CurrencySchema,
    withholdingForeignAmount: NonNegativeDecimalStringSchema.optional(),
    withholdingDomesticAmount: NonNegativeDecimalStringSchema.optional(),
  })
  .strict();

const InterestAddSchema = z
  .object({
    ...AddBaseFields,
    ...RateFields,
    type: z.literal("interest"),
    account: AccountIdSchema,
    grossAmount: PositiveDecimalStringSchema,
    grossCurrency: CurrencySchema,
    withholdingForeignAmount: NonNegativeDecimalStringSchema.optional(),
    withholdingDomesticAmount: NonNegativeDecimalStringSchema.optional(),
  })
  .strict();

const AddInputSchema = z.discriminatedUnion("type", [
  z
    .object({ ...AccountMoneyAddFields, type: z.literal("deposit") })
    .strict()
    .superRefine(validateRateOptions),
  z
    .object({ ...AccountMoneyAddFields, type: z.literal("withdrawal") })
    .strict()
    .superRefine(validateRateOptions),
  TransferAddSchema,
  FxAddSchema,
  z
    .object({ ...TradeAddFields, type: z.literal("buy") })
    .strict()
    .superRefine(validateRateOptions),
  z
    .object({ ...TradeAddFields, type: z.literal("sell") })
    .strict()
    .superRefine(validateRateOptions),
  DividendAddSchema.superRefine(validateRateOptions),
  InterestAddSchema.superRefine(validateRateOptions),
  z
    .object({ ...AccountMoneyAddFields, type: z.literal("fee") })
    .strict()
    .superRefine(validateRateOptions),
]);

const AccountMoneyEditFields = {
  ...EditBaseFields,
  ...RateFields,
  account: AccountIdSchema.optional(),
  amount: PositiveDecimalStringSchema.optional(),
  currency: CurrencySchema.optional(),
};

const TransferEditSchema = z
  .object({
    ...EditBaseFields,
    type: z.literal("transfer"),
    from: AccountIdSchema.optional(),
    to: AccountIdSchema.optional(),
    amount: PositiveDecimalStringSchema.optional(),
    currency: CurrencySchema.optional(),
  })
  .strict();

const FxEditSchema = z
  .object({
    ...EditBaseFields,
    type: z.literal("fx"),
    account: AccountIdSchema.optional(),
    fromAmount: PositiveDecimalStringSchema.optional(),
    fromCurrency: CurrencySchema.optional(),
    toAmount: PositiveDecimalStringSchema.optional(),
    toCurrency: CurrencySchema.optional(),
    feeAmount: NonNegativeDecimalStringSchema.optional(),
    feeCurrency: CurrencySchema.optional(),
    clearFee: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    validateOptionalMoneyPair(input.feeAmount, input.feeCurrency, context);
    validateClearValue(input.feeAmount, input.clearFee, context, "fee");
  });

const TradeEditFields = {
  ...EditBaseFields,
  ...RateFields,
  account: AccountIdSchema.optional(),
  instrument: InstrumentIdSchema.optional(),
  qty: PositiveDecimalStringSchema.optional(),
  priceAmount: PositiveDecimalStringSchema.optional(),
  priceCurrency: CurrencySchema.optional(),
  feeAmount: NonNegativeDecimalStringSchema.optional(),
  feeCurrency: CurrencySchema.optional(),
  clearFee: z.boolean().optional(),
};

const IncomeEditFields = {
  ...EditBaseFields,
  ...RateFields,
  account: AccountIdSchema.optional(),
  grossAmount: PositiveDecimalStringSchema.optional(),
  grossCurrency: CurrencySchema.optional(),
  withholdingForeignAmount: NonNegativeDecimalStringSchema.optional(),
  withholdingDomesticAmount: NonNegativeDecimalStringSchema.optional(),
  clearWithholdingForeign: z.boolean().optional(),
  clearWithholdingDomestic: z.boolean().optional(),
};

const EditInputSchema = z.discriminatedUnion("type", [
  z
    .object({ ...AccountMoneyEditFields, type: z.literal("deposit") })
    .strict()
    .superRefine(validateRateOptions),
  z
    .object({ ...AccountMoneyEditFields, type: z.literal("withdrawal") })
    .strict()
    .superRefine(validateRateOptions),
  TransferEditSchema,
  FxEditSchema,
  z
    .object({ ...TradeEditFields, type: z.literal("buy") })
    .strict()
    .superRefine(validateRateOptions),
  z
    .object({ ...TradeEditFields, type: z.literal("sell") })
    .strict()
    .superRefine(validateRateOptions),
  z
    .object({
      ...IncomeEditFields,
      type: z.literal("dividend"),
      instrument: InstrumentIdSchema.optional(),
    })
    .strict()
    .superRefine(validateRateOptions),
  z
    .object({ ...IncomeEditFields, type: z.literal("interest") })
    .strict()
    .superRefine(validateRateOptions),
  z
    .object({ ...AccountMoneyEditFields, type: z.literal("fee") })
    .strict()
    .superRefine(validateRateOptions),
]);

export type EventAddInput = z.infer<typeof AddInputSchema>;
export type EventEditInput = z.infer<typeof EditInputSchema>;
export type EventAddOptions = z.input<typeof AddInputSchema>;
export type EventEditOptions = z.input<typeof EditInputSchema>;

type EventBaseFields = {
  id: string;
  date: string;
  source: string;
  note?: string;
  externalId?: string;
};

type AddBase = Pick<EventAddInput, "id" | "date" | "source" | "externalId" | "note">;
type EditBase = Pick<EventEditInput, "type" | "date" | "note" | "clearNote">;
type AccountMoneyEditInput = Extract<EventEditInput, { type: "deposit" | "withdrawal" | "fee" }>;
type FxEditInput = Extract<EventEditInput, { type: "fx" }>;
type TradeEditInput = Extract<EventEditInput, { type: "buy" | "sell" }>;
type IncomeEditInput = Extract<EventEditInput, { type: "dividend" | "interest" }>;

type Reference = { kind: "account" | "instrument"; id: string };

export type HistoricalRateResolver = {
  resolveHistoricalEurRate(
    need: EurRateNeed,
    options?: ResolvePriceOptions,
  ): Promise<EurRateResolution>;
};

export function parseAddInput(value: EventAddOptions): EventAddInput {
  const parsed = AddInputSchema.safeParse(value);
  if (!parsed.success) throw zodFailure("event input", parsed.error);
  return parsed.data;
}

export function parseEditInput(value: EventEditOptions): EventEditInput {
  const parsed = EditInputSchema.safeParse(value);
  if (!parsed.success) throw zodFailure("event input", parsed.error);
  return parsed.data;
}

export async function addEvent(
  store: FileBookStore,
  input: EventAddOptions,
  json: boolean,
  generateId: () => string,
  rateResolver?: HistoricalRateResolver,
): Promise<void> {
  const parsedInput = parseAddInput(input);
  const snapshot = requireResult(store.load());
  validateReferences(snapshot, addReferences(parsedInput));
  const event = await buildEvent(parsedInput, generateId, rateResolver);
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
  input: EventEditOptions,
  id: string,
  json: boolean,
  rateResolver?: HistoricalRateResolver,
): Promise<void> {
  const parsedInput = parseEditInput(input);
  const eventId = parseEventId(id);
  if (!hasEditValues(parsedInput)) {
    throw validationFailure(
      "An event edit needs at least one mutable field.",
      "Provide a field to change or a clear flag.",
    );
  }
  const snapshot = requireResult(store.load());
  const current = snapshot.events.find((event) => event.id === eventId);
  if (current === undefined) throw notFoundFailure("event", eventId);
  if (current.type !== parsedInput.type) {
    throw validationFailure(
      `Event ${eventId} is a ${current.type}, not a ${parsedInput.type}.`,
      "Use the matching event edit command; changing type requires delete and add.",
    );
  }
  validateReferences(snapshot, editReferences(current, parsedInput));
  const replacement = await buildReplacement(current, parsedInput, rateResolver);
  const saved = requireResult(store.replaceEvent(eventId, replacement, current));
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
      const account = required(input.account, "--account");
      const rate = await resolveEurRate(amount.currency, base.date, input, rateResolver);
      return parseEvent({
        ...base,
        type: input.type,
        account,
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
      const account = required(input.account, "--account");
      const instrument = required(input.instrument, "--instrument");
      const qty = required(input.qty, "--qty");
      const price = requiredMoney(
        input.priceAmount,
        input.priceCurrency,
        "--price-amount",
        "--price-currency",
      );
      const fee = optionalMoney(
        input.feeAmount,
        input.feeAmount === undefined ? undefined : (input.feeCurrency ?? input.priceCurrency),
        "--fee-amount",
        "--fee-currency",
      );
      const rate = await resolveEurRate(price.currency, base.date, input, rateResolver);
      const event = {
        ...base,
        type: input.type,
        account,
        instrument,
        qty,
        price,
      };
      if (fee !== undefined) Object.assign(event, { fee });
      Object.assign(event, rate);
      return parseEvent(event);
    }
    case "dividend": {
      const account = required(input.account, "--account");
      const instrument = required(input.instrument, "--instrument");
      const gross = requiredMoney(
        input.grossAmount,
        input.grossCurrency,
        "--gross-amount",
        "--gross-currency",
      );
      const withholdingForeign = optionalMoney(
        input.withholdingForeignAmount,
        input.withholdingForeignAmount === undefined ? undefined : input.grossCurrency,
        "--withholding-foreign-amount",
        "--gross-currency",
      );
      const withholdingDomestic = optionalMoney(
        input.withholdingDomesticAmount,
        input.withholdingDomesticAmount === undefined ? undefined : input.grossCurrency,
        "--withholding-domestic-amount",
        "--gross-currency",
      );
      const rate = await resolveEurRate(gross.currency, base.date, input, rateResolver);
      const event = {
        ...base,
        type: input.type,
        account,
        instrument,
        gross,
      };
      if (withholdingForeign !== undefined) Object.assign(event, { withholdingForeign });
      if (withholdingDomestic !== undefined) Object.assign(event, { withholdingDomestic });
      Object.assign(event, rate);
      return parseEvent(event);
    }
    case "interest": {
      const account = required(input.account, "--account");
      const gross = requiredMoney(
        input.grossAmount,
        input.grossCurrency,
        "--gross-amount",
        "--gross-currency",
      );
      const withholdingForeign = optionalMoney(
        input.withholdingForeignAmount,
        input.withholdingForeignAmount === undefined ? undefined : input.grossCurrency,
        "--withholding-foreign-amount",
        "--gross-currency",
      );
      const withholdingDomestic = optionalMoney(
        input.withholdingDomesticAmount,
        input.withholdingDomesticAmount === undefined ? undefined : input.grossCurrency,
        "--withholding-domestic-amount",
        "--gross-currency",
      );
      const rate = await resolveEurRate(gross.currency, base.date, input, rateResolver);
      const event = {
        ...base,
        type: input.type,
        account,
        gross,
      };
      if (withholdingForeign !== undefined) Object.assign(event, { withholdingForeign });
      if (withholdingDomestic !== undefined) Object.assign(event, { withholdingDomestic });
      Object.assign(event, rate);
      return parseEvent(event);
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

function addReferences(input: EventAddInput): readonly Reference[] {
  switch (input.type) {
    case "deposit":
    case "withdrawal":
    case "fee":
    case "fx":
    case "interest":
      return [{ kind: "account", id: input.account }];
    case "transfer":
      return [
        { kind: "account", id: input.from },
        { kind: "account", id: input.to },
      ];
    case "buy":
    case "sell":
    case "dividend":
      return [
        { kind: "account", id: input.account },
        { kind: "instrument", id: input.instrument },
      ];
  }
}

function editReferences(current: Event, input: EventEditInput): readonly Reference[] {
  switch (current.type) {
    case "deposit":
    case "withdrawal":
    case "fee":
      if (input.type !== current.type) return [];
      return [{ kind: "account", id: input.account ?? current.account }];
    case "transfer":
      if (input.type !== current.type) return [];
      return [
        { kind: "account", id: input.from ?? current.from },
        { kind: "account", id: input.to ?? current.to },
      ];
    case "fx":
      if (input.type !== current.type) return [];
      return [{ kind: "account", id: input.account ?? current.account }];
    case "buy":
    case "sell":
      if (input.type !== current.type) return [];
      return [
        { kind: "account", id: input.account ?? current.account },
        { kind: "instrument", id: input.instrument ?? current.instrument },
      ];
    case "dividend":
      if (input.type !== current.type) return [];
      return [
        { kind: "account", id: input.account ?? current.account },
        { kind: "instrument", id: input.instrument ?? current.instrument },
      ];
    case "interest":
      if (input.type !== current.type) return [];
      return [{ kind: "account", id: input.account ?? current.account }];
  }
}

function validateReferences(
  snapshot: { accounts: readonly { id: string }[]; instruments: readonly { id: string }[] },
  references: readonly Reference[],
): void {
  for (const reference of references) {
    const values = reference.kind === "account" ? snapshot.accounts : snapshot.instruments;
    if (!values.some((value) => value.id === reference.id)) {
      throw notFoundFailure(reference.kind, reference.id);
    }
  }
}

function validateOptionalMoneyPair(
  amount: string | undefined,
  currency: string | undefined,
  context: z.RefinementCtx,
): void {
  const amountProvided = amount !== undefined;
  const currencyProvided = currency !== undefined;
  if (amountProvided === currencyProvided) return;
  const missing = amountProvided ? "feeCurrency" : "feeAmount";
  context.addIssue({
    code: "custom",
    path: [missing],
    message: `The ${missing} value is required with its money pair`,
  });
}

function validateRateOptions(input: RateInput, context: z.RefinementCtx): void {
  if (input.provider !== undefined && input.fetchRate !== true) {
    context.addIssue({
      code: "custom",
      path: ["provider"],
      message: "--provider requires --fetch-rate",
    });
  }
  if (input.eurPerUnit !== undefined && input.fetchRate === true) {
    context.addIssue({
      code: "custom",
      path: ["fetchRate"],
      message: "Use either --eur-per-unit or --fetch-rate",
    });
  }
}

function validateClearValue(
  value: string | undefined,
  clear: boolean | undefined,
  context: z.RefinementCtx,
  label: string,
): void {
  if (clear === true && value !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["clear"],
      message: `A ${label} value cannot be used with its clear flag`,
    });
  }
}

async function buildAccountMoneyReplacement(
  current: Extract<Event, { type: "deposit" | "withdrawal" | "fee" }>,
  input: AccountMoneyEditInput,
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
  input: TradeEditInput,
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
  input: IncomeEditInput,
  base: EventBaseFields,
  rateResolver: HistoricalRateResolver | undefined,
): Promise<Event> {
  const gross = mergeMoney(current.gross, input.grossAmount, input.grossCurrency);
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
  const rate = await resolveEditedRate(
    gross.currency,
    current.gross.currency,
    current,
    base.date,
    input,
    rateResolver,
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
    date: input.date,
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
  if (amount !== undefined) return { amount, currency };
  if (current === undefined) return undefined;
  if (current.currency !== currency) {
    throw validationFailure(
      "Changing gross currency requires new withholding amounts or clear flags.",
      `Provide ${amountFlag} or use its clear flag.`,
    );
  }
  return current;
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
  const result = await resolver.resolveHistoricalEurRate(
    { currency, date },
    input.provider === undefined ? undefined : { provider: input.provider },
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
  if (!parsed.success) throw zodFailure("event", parsed.error, false);
  return parsed.data;
}

function parseEventId(value: string): string {
  const parsed = NonEmptyStringSchema.safeParse(value);
  if (!parsed.success) throw validationFailure("Missing event ID.", "Provide an event ID.");
  return parsed.data;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "")
    throw validationFailure(`Missing required ${flag}.`, `Provide ${flag}.`);
  return value;
}

function zodFailure(location: string, error: z.ZodError, aggregateMissing = true): CliFailure {
  const missing = aggregateMissing
    ? [...new Set(error.issues.filter(isMissingIssue).map((issue) => issueFlag(issue.path)))]
    : [];
  if (missing.length > 0) {
    return validationFailure(
      `Missing required fields: ${missing.join(", ")}.`,
      "Provide all required fields before retrying.",
    );
  }
  const issue = error.issues[0];
  const detail = issue === undefined ? "invalid value" : issue.message;
  return validationFailure(`Invalid ${location}: ${detail}.`, `Fix the ${location} input.`);
}

function isMissingIssue(issue: z.core.$ZodIssue): boolean {
  return issue.code === "invalid_type" && issue.input === undefined;
}

function issueFlag(path: readonly PropertyKey[]): string {
  const field = String(path.at(-1) ?? "field");
  return `--${field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
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
