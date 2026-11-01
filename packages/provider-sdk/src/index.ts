import { z } from "zod";
import {
  CurrencySchema,
  IsoDateSchema,
  PositiveDecimalStringSchema,
  type Result,
} from "@finbook/core";

export { createRetryingFetch } from "./http.js";
export const ProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
export const CapabilitySchema = z.enum([
  "price:stock",
  "price:etf",
  "price:fund",
  "price:etc",
  "price:crypto",
  "fx",
  "eur-rate:fiat",
  "eur-rate:crypto",
]);
export type Capability = z.infer<typeof CapabilitySchema>;
export const ProviderMetadataSchema = z
  .object({
    id: ProviderIdSchema,
    capabilities: z
      .array(CapabilitySchema)
      .min(1)
      .refine((values) => new Set(values).size === values.length),
    environment: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u)).default([]),
  })
  .strict();
export type ProviderMetadata = z.infer<typeof ProviderMetadataSchema>;
export const EnvironmentSchema = z.record(z.string(), z.string());
export type ProviderEnvironment = z.infer<typeof EnvironmentSchema>;
export const ProviderFailureSchema = z
  .object({
    kind: z.enum([
      "unsupported",
      "not-found",
      "rate-limited",
      "unauthorized",
      "unavailable",
      "invalid-response",
    ]),
    message: z.string(),
    status: z.number().int().optional(),
    retryAfterMs: z.number().nonnegative().optional(),
  })
  .strict();
export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;
export const WindowSchema = z.object({
  from: IsoDateSchema,
  through: IsoDateSchema,
  sourceFrom: IsoDateSchema.optional(),
});
export const PriceHistoryNeedSchema = WindowSchema.extend({
  identifier: z.string().min(1),
  instrument: z
    .object({
      type: z.enum(["stock", "etf", "fund", "etc", "crypto"]),
      quoteCurrency: CurrencySchema,
    })
    .strict(),
}).strict();
export type PriceHistoryNeed = z.infer<typeof PriceHistoryNeedSchema>;
export const FxHistoryNeedSchema = WindowSchema.extend({
  currency: CurrencySchema,
  identifier: z.string().min(1).optional(),
}).strict();
export type FxHistoryNeed = z.infer<typeof FxHistoryNeedSchema>;
export const EurRateNeedSchema = z
  .object({
    currency: CurrencySchema,
    date: IsoDateSchema,
    identifier: z.string().min(1).optional(),
  })
  .strict();
export type EurRateNeed = z.infer<typeof EurRateNeedSchema>;
export const PriceFactSchema = z
  .object({
    asOf: IsoDateSchema,
    price: z.object({ amount: PositiveDecimalStringSchema, currency: CurrencySchema }).strict(),
  })
  .strict();
export type PriceFact = z.infer<typeof PriceFactSchema>;
export const FxFactSchema = z
  .object({ asOf: IsoDateSchema, pair: z.string(), rate: PositiveDecimalStringSchema })
  .strict();
export type FxFact = z.infer<typeof FxFactSchema>;
export const EurRateFactSchema = z
  .object({ rate: PositiveDecimalStringSchema, effectiveDate: IsoDateSchema })
  .strict();
export type EurRateFact = z.infer<typeof EurRateFactSchema>;
export const PriceHistoryOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.array(PriceFactSchema) }).strict(),
  z.object({ ok: z.literal(false), error: ProviderFailureSchema }).strict(),
]);
export type PriceHistoryOutcome = z.infer<typeof PriceHistoryOutcomeSchema>;
export const FxHistoryOutcomeSchema = z.discriminatedUnion("ok", [
  z
    .object({ need: FxHistoryNeedSchema, ok: z.literal(true), data: z.array(FxFactSchema) })
    .strict(),
  z
    .object({ need: FxHistoryNeedSchema, ok: z.literal(false), error: ProviderFailureSchema })
    .strict(),
]);
export type FxHistoryOutcome = z.infer<typeof FxHistoryOutcomeSchema>;
export const EurRateOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ need: EurRateNeedSchema, ok: z.literal(true), data: EurRateFactSchema }).strict(),
  z
    .object({ need: EurRateNeedSchema, ok: z.literal(false), error: ProviderFailureSchema })
    .strict(),
]);
export type EurRateOutcome = z.infer<typeof EurRateOutcomeSchema>;

export type Provider = {
  fetchPriceHistory?: (need: PriceHistoryNeed) => Promise<PriceHistoryOutcome>;
  fetchFxHistory?: (needs: readonly FxHistoryNeed[]) => Promise<readonly FxHistoryOutcome[]>;
  fetchHistoricalEurRates?: (needs: readonly EurRateNeed[]) => Promise<readonly EurRateOutcome[]>;
};
export type ProviderFactory = (
  environment: ProviderEnvironment,
) => Result<Provider, ProviderFailure>;

// The host parses each asynchronous result separately, with the request's economic context.
export const ProviderSchema = z
  .object({
    fetchPriceHistory: z.function({ input: [z.unknown()], output: z.unknown() }).optional(),
    fetchFxHistory: z.function({ input: [z.unknown()], output: z.unknown() }).optional(),
    fetchHistoricalEurRates: z.function({ input: [z.unknown()], output: z.unknown() }).optional(),
  })
  .strict();
export const FactoryResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: ProviderSchema }).strict(),
  z.object({ ok: z.literal(false), error: ProviderFailureSchema }).strict(),
]);
export const ProviderModuleSchema = z.object({
  default: z.function({ input: [EnvironmentSchema], output: z.unknown() }),
});

export type HistoryWindow = z.infer<typeof WindowSchema>;

export type ProviderModule = z.infer<typeof ProviderModuleSchema>;
