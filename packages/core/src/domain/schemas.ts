import { z } from "zod";

import { DecimalMath } from "./decimal.js";

import {
  AccountIdSchema,
  CountryCodeSchema,
  CurrencySchema,
  DecimalStringSchema,
  InstrumentIdSchema,
  IsoDateSchema,
  IsoInstantSchema,
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
  (money) => new DecimalMath(money.amount).greaterThan(0),
  { path: ["amount"], message: "Expected a positive amount" },
);

export const NonNegativeMoneySchema = MoneySchema.refine(
  (money) => new DecimalMath(money.amount).greaterThanOrEqualTo(0),
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

export const EurRateProvenanceSchema = z
  .object({
    source: NonEmptyStringSchema,
    effectiveDate: IsoDateSchema,
    retrievedAt: IsoInstantSchema,
  })
  .strict();

const DepositSchema = AccountEventSchema.extend({
  type: z.literal("deposit"),
  amount: PositiveMoneySchema,
  eurPerUnit: EurRateSchema,
  eurRateProvenance: EurRateProvenanceSchema.optional(),
})
  .superRefine((deposit, context) =>
    validateEurPerUnit(deposit.amount.currency, deposit.eurPerUnit, context),
  )
  .superRefine(validateEurRateProvenance);

const WithdrawalSchema = AccountEventSchema.extend({
  type: z.literal("withdrawal"),
  amount: PositiveMoneySchema,
  eurPerUnit: EurRateSchema,
  eurRateProvenance: EurRateProvenanceSchema.optional(),
})
  .superRefine((withdrawal, context) =>
    validateEurPerUnit(withdrawal.amount.currency, withdrawal.eurPerUnit, context),
  )
  .superRefine(validateEurRateProvenance);

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
  eurPerUnit: EurRateSchema,
  eurRateProvenance: EurRateProvenanceSchema.optional(),
};

const BuySchema = AccountEventSchema.extend({
  type: z.literal("buy"),
  ...TradeFields,
})
  .superRefine(validateTradeCurrencies)
  .superRefine((buy, context) => validateEurPerUnit(buy.price.currency, buy.eurPerUnit, context))
  .superRefine(validateEurRateProvenance);

const SellSchema = AccountEventSchema.extend({
  type: z.literal("sell"),
  ...TradeFields,
})
  .superRefine(validateTradeCurrencies)
  .superRefine((sell, context) => validateEurPerUnit(sell.price.currency, sell.eurPerUnit, context))
  .superRefine(validateEurRateProvenance);

const DividendSchema = AccountEventSchema.extend({
  type: z.literal("dividend"),
  instrument: InstrumentIdSchema,
  gross: PositiveMoneySchema,
  withholdingForeign: NonNegativeMoneySchema.optional(),
  withholdingDomestic: NonNegativeMoneySchema.optional(),
  eurPerUnit: EurRateSchema,
  eurRateProvenance: EurRateProvenanceSchema.optional(),
})
  .superRefine(validateWithholdingCurrencies)
  .superRefine((dividend, context) =>
    validateEurPerUnit(dividend.gross.currency, dividend.eurPerUnit, context),
  )
  .superRefine(validateEurRateProvenance);

const InterestSchema = AccountEventSchema.extend({
  type: z.literal("interest"),
  gross: PositiveMoneySchema,
  withholdingForeign: NonNegativeMoneySchema.optional(),
  withholdingDomestic: NonNegativeMoneySchema.optional(),
  eurPerUnit: EurRateSchema,
  eurRateProvenance: EurRateProvenanceSchema.optional(),
})
  .superRefine(validateWithholdingCurrencies)
  .superRefine((interest, context) =>
    validateEurPerUnit(interest.gross.currency, interest.eurPerUnit, context),
  )
  .superRefine(validateEurRateProvenance);

const FeeEventSchema = AccountEventSchema.extend({
  type: z.literal("fee"),
  amount: PositiveMoneySchema,
  eurPerUnit: EurRateSchema,
  eurRateProvenance: EurRateProvenanceSchema.optional(),
})
  .superRefine((fee, context) => validateEurPerUnit(fee.amount.currency, fee.eurPerUnit, context))
  .superRefine(validateEurRateProvenance);

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

export const ProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z
    .object({
      kind: z.literal("fetched"),
      source: NonEmptyStringSchema,
      retrievedAt: IsoInstantSchema,
    })
    .strict(),
]);

export const PriceStampSchema = z
  .object({
    instrument: InstrumentIdSchema,
    price: PositiveMoneySchema,
    asOf: IsoDateSchema,
    provenance: ProvenanceSchema,
  })
  .strict();

export const FxStampSchema = z
  .object({
    pair: z.string().regex(/^[A-Z][A-Z0-9-]{2,9}\/EUR$/u, "Expected a currency/EUR pair"),
    rate: PositiveDecimalStringSchema,
    asOf: IsoDateSchema,
    provenance: ProvenanceSchema,
  })
  .strict();

function validateEurPerUnit(currency: string, eurPerUnit: string, context: z.RefinementCtx): void {
  if (currency === "EUR" && !new DecimalMath(eurPerUnit).equals(1)) {
    context.addIssue({
      code: "custom",
      path: ["eurPerUnit"],
      message: "EUR events must use an EUR-per-unit rate of 1",
    });
  }
}

function validateEurRateProvenance(
  event: { date: string; eurRateProvenance?: { effectiveDate: string } | undefined },
  context: z.RefinementCtx,
): void {
  if (event.eurRateProvenance !== undefined && event.eurRateProvenance.effectiveDate > event.date) {
    context.addIssue({
      code: "custom",
      path: ["eurRateProvenance", "effectiveDate"],
      message: "The effective EUR rate date cannot be after the event date",
    });
  }
}

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
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type EurRateProvenance = z.infer<typeof EurRateProvenanceSchema>;
export type DecimalString = z.infer<typeof DecimalStringSchema>;
export type PositiveDecimalString = z.infer<typeof PositiveDecimalStringSchema>;
export type NonNegativeDecimalString = z.infer<typeof NonNegativeDecimalStringSchema>;
