import { Decimal } from "decimal.js";
import { z } from "zod";

import {
  AccountIdSchema,
  CountryCodeSchema,
  CurrencySchema,
  DecimalStringSchema,
  InstrumentIdSchema,
  IsoDateSchema,
  NonEmptyStringSchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
} from "./scalars.js";

export const MoneySchema = z
  .object({
    amount: DecimalStringSchema,
    currency: CurrencySchema,
  })
  .strict();

export const PositiveMoneySchema = MoneySchema.refine(
  (money) => new Decimal(money.amount).greaterThan(0),
  { path: ["amount"], message: "Expected a positive amount" },
);

export const NonNegativeMoneySchema = MoneySchema.refine(
  (money) => new Decimal(money.amount).greaterThanOrEqualTo(0),
  { path: ["amount"], message: "Expected a non-negative amount" },
);

export const AccountSchema = z
  .object({
    id: AccountIdSchema,
    name: NonEmptyStringSchema,
    platform: NonEmptyStringSchema,
    country: CountryCodeSchema,
    custodial: z.enum(["broker", "crypto-exchange", "cash"]),
  })
  .strict();

export const InstrumentSchema = z
  .object({
    id: InstrumentIdSchema,
    name: NonEmptyStringSchema,
    type: z.enum(["stock", "etf", "fund", "crypto"]),
    quoteCurrency: CurrencySchema,
    isin: NonEmptyStringSchema.optional(),
  })
  .strict();

export const MetaSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
  })
  .strict();

const BaseEventSchema = z
  .object({
    id: NonEmptyStringSchema,
    date: IsoDateSchema,
    note: z.string().optional(),
    source: NonEmptyStringSchema,
    externalId: NonEmptyStringSchema.optional(),
  })
  .strict();

const AccountEventSchema = BaseEventSchema.extend({
  account: AccountIdSchema,
});

const EurRateSchema = PositiveDecimalStringSchema;

const DepositSchema = AccountEventSchema.extend({
  type: z.literal("deposit"),
  amount: PositiveMoneySchema,
  eurPerUnit: EurRateSchema.optional(),
});

const WithdrawalSchema = AccountEventSchema.extend({
  type: z.literal("withdrawal"),
  amount: PositiveMoneySchema,
  eurPerUnit: EurRateSchema.optional(),
});

const TransferSchema = BaseEventSchema.extend({
  type: z.literal("transfer"),
  from: AccountIdSchema,
  to: AccountIdSchema,
  amount: PositiveMoneySchema,
}).superRefine((transfer, context) => {
  if (transfer.from === transfer.to) {
    context.addIssue({ code: "custom", path: ["to"], message: "Transfer endpoints must differ" });
  }
});

const FxSchema = AccountEventSchema.extend({
  type: z.literal("fx"),
  from: PositiveMoneySchema,
  to: PositiveMoneySchema,
  fee: NonNegativeMoneySchema.optional(),
}).superRefine((fx, context) => {
  if (fx.from.currency === fx.to.currency) {
    context.addIssue({
      code: "custom",
      path: ["to", "currency"],
      message: "FX currencies must differ",
    });
  }
  if (
    fx.fee !== undefined &&
    fx.fee.currency !== fx.from.currency &&
    fx.fee.currency !== fx.to.currency
  ) {
    context.addIssue({
      code: "custom",
      path: ["fee", "currency"],
      message: "An FX fee must use the source or destination currency",
    });
  }
});

const TradeFields = {
  instrument: InstrumentIdSchema,
  qty: PositiveDecimalStringSchema,
  price: PositiveMoneySchema,
  fee: NonNegativeMoneySchema.optional(),
  eurPerUnit: EurRateSchema.optional(),
};

const BuySchema = AccountEventSchema.extend({
  type: z.literal("buy"),
  ...TradeFields,
}).superRefine(validateTradeCurrencies);

const SellSchema = AccountEventSchema.extend({
  type: z.literal("sell"),
  ...TradeFields,
}).superRefine(validateTradeCurrencies);

const DividendSchema = AccountEventSchema.extend({
  type: z.literal("dividend"),
  instrument: InstrumentIdSchema,
  gross: PositiveMoneySchema,
  withholdingForeign: NonNegativeMoneySchema.optional(),
  withholdingDomestic: NonNegativeMoneySchema.optional(),
  eurPerUnit: EurRateSchema.optional(),
}).superRefine(validateWithholdingCurrencies);

const InterestSchema = AccountEventSchema.extend({
  type: z.literal("interest"),
  gross: PositiveMoneySchema,
  withholdingForeign: NonNegativeMoneySchema.optional(),
  withholdingDomestic: NonNegativeMoneySchema.optional(),
  eurPerUnit: EurRateSchema.optional(),
}).superRefine(validateWithholdingCurrencies);

const FeeEventSchema = AccountEventSchema.extend({
  type: z.literal("fee"),
  amount: PositiveMoneySchema,
  eurPerUnit: EurRateSchema.optional(),
});

export const EventSchema = z.discriminatedUnion("type", [
  DepositSchema,
  WithdrawalSchema,
  TransferSchema,
  FxSchema,
  BuySchema,
  SellSchema,
  DividendSchema,
  InterestSchema,
  FeeEventSchema,
]);

export const PriceStampSchema = z
  .object({
    instrument: InstrumentIdSchema,
    price: PositiveMoneySchema,
    asOf: IsoDateSchema,
  })
  .strict();

export const FxStampSchema = z
  .object({
    pair: z.string().regex(/^[A-Z][A-Z0-9-]{2,9}\/EUR$/u, "Expected a currency/EUR pair"),
    rate: PositiveDecimalStringSchema,
    asOf: IsoDateSchema,
  })
  .strict();

function validateTradeCurrencies(
  trade: { price: { currency: string }; fee?: { currency: string } | undefined },
  context: z.RefinementCtx,
): void {
  if (trade.fee !== undefined && trade.fee.currency !== trade.price.currency) {
    context.addIssue({
      code: "custom",
      path: ["fee", "currency"],
      message: "A v1 trade fee must use the price currency",
    });
  }
}

function validateWithholdingCurrencies(
  income: {
    gross: { currency: string };
    withholdingForeign?: { currency: string } | undefined;
    withholdingDomestic?: { currency: string } | undefined;
  },
  context: z.RefinementCtx,
): void {
  for (const [field, withholding] of [
    ["withholdingForeign", income.withholdingForeign],
    ["withholdingDomestic", income.withholdingDomestic],
  ] as const) {
    if (withholding !== undefined && withholding.currency !== income.gross.currency) {
      context.addIssue({
        code: "custom",
        path: [field, "currency"],
        message: "Withholding must use the gross currency",
      });
    }
  }
}

export type Money = z.infer<typeof MoneySchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Instrument = z.infer<typeof InstrumentSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type Event = z.infer<typeof EventSchema>;
export type PriceStamp = z.infer<typeof PriceStampSchema>;
export type FxStamp = z.infer<typeof FxStampSchema>;
export type DecimalString = z.infer<typeof DecimalStringSchema>;
export type PositiveDecimalString = z.infer<typeof PositiveDecimalStringSchema>;
export type NonNegativeDecimalString = z.infer<typeof NonNegativeDecimalStringSchema>;
