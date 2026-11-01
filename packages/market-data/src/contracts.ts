import type { FxStamp, Instrument, PriceStamp, Provenance } from "@finbook/core";

import { z } from "zod";

import { CurrencySchema, InstrumentIdSchema } from "@finbook/core";

export { ProviderIdSchema } from "@finbook/provider-sdk";
import { ProviderIdSchema } from "@finbook/provider-sdk";
export type ProviderId = string;
export const RouteKeySchema = z.enum([
  "price:stock",
  "price:etf",
  "price:fund",
  "price:etc",
  "price:crypto",
  "fx",
  "eur-rate:fiat",
]);
export type RouteKey = z.infer<typeof RouteKeySchema>;

const ProviderIdentifierSchema = z.string().min(1);

const InstrumentBindingSchema = z
  .object({
    kind: z.literal("instrument"),
    instrument: InstrumentIdSchema,
    provider: ProviderIdSchema,
    identifier: ProviderIdentifierSchema,
  })
  .strict();

const CurrencyBindingSchema = z
  .object({
    kind: z.literal("currency"),
    currency: CurrencySchema,
    provider: ProviderIdSchema,
    identifier: ProviderIdentifierSchema,
  })
  .strict();

export const SourceBindingSchema = z.discriminatedUnion("kind", [
  InstrumentBindingSchema,
  CurrencyBindingSchema,
]);
export type SourceBinding = z.infer<typeof SourceBindingSchema>;

const RouteOverridesSchema = z
  .object({
    "price:stock": z.array(ProviderIdSchema).optional(),
    "price:etf": z.array(ProviderIdSchema).optional(),
    "price:fund": z.array(ProviderIdSchema).optional(),
    "price:etc": z.array(ProviderIdSchema).optional(),
    "price:crypto": z.array(ProviderIdSchema).optional(),
    fx: z.array(ProviderIdSchema).optional(),
    "eur-rate:fiat": z.array(ProviderIdSchema).optional(),
  })
  .strict()
  .default({});

export const MarketDataConfigSchema = z
  .object({
    disabledProviders: z.array(ProviderIdSchema).default([]),
    routes: RouteOverridesSchema,
    bindings: z.array(SourceBindingSchema).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    for (const binding of config.bindings) {
      const key = `${binding.kind}:${binding.kind === "instrument" ? binding.instrument : binding.currency}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["bindings"],
          message: `Duplicate source binding for ${key}`,
        });
      }
      seen.add(key);
    }
  });

export type MarketDataConfig = z.infer<typeof MarketDataConfigSchema>;

export type { EurRateNeed } from "@finbook/provider-sdk";
import type { EurRateNeed, ProviderFailure } from "@finbook/provider-sdk";
export type EurRateOutcome =
  | { need: EurRateNeed; ok: true; data: EurRateObservation }
  | { need: EurRateNeed; ok: false; error: ProviderFailure };

export type EurRateResolution =
  | { ok: true; data: EurRateObservation }
  | { ok: false; error: ProviderFailure };

export type PriceObservation = Omit<PriceStamp, "provenance"> & {
  provenance: Extract<Provenance, { kind: "fetched" }>;
};

export type FxObservation = Omit<FxStamp, "provenance"> & {
  provenance: Extract<Provenance, { kind: "fetched" }>;
};

export type EurRateObservation = {
  rate: string;
  effectiveDate: string;
  provenance: Extract<Provenance, { kind: "fetched" }>;
};

export type { ProviderFailure } from "@finbook/provider-sdk";
export type ProviderFailureKind = ProviderFailure["kind"];

export interface HistoricalEurRateSource {
  readonly id: ProviderId;
  fetchHistoricalEurRates(
    needs: readonly EurRateNeed[],
    requiredCapability?: "eur-rate:fiat",
  ): Promise<readonly EurRateOutcome[]>;
}

export type HistoryWindow = { from: string; through: string; sourceFrom?: string | undefined };
export type PriceHistoryNeed = HistoryWindow & { instrument: Instrument; identifier: string };
export type FxHistoryNeed = HistoryWindow & { currency: string; identifier?: string | undefined };
export type PriceHistoryOutcome =
  | { ok: true; data: readonly PriceObservation[] }
  | { ok: false; error: ProviderFailure };
export type FxHistoryOutcome =
  | { need: FxHistoryNeed; ok: true; data: readonly FxObservation[] }
  | { need: FxHistoryNeed; ok: false; error: ProviderFailure };

export interface PriceHistorySource {
  readonly id: ProviderId;
  fetchPriceHistory(need: PriceHistoryNeed): Promise<PriceHistoryOutcome>;
}

export interface FxHistorySource {
  readonly id: ProviderId;
  fetchFxHistory(needs: readonly FxHistoryNeed[]): Promise<readonly FxHistoryOutcome[]>;
}
