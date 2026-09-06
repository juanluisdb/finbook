import type { FxStamp, Instrument, PriceStamp, Provenance } from "@finbook/core";

import { z } from "zod";

import { CurrencySchema, IsoDateSchema, InstrumentIdSchema } from "@finbook/core";

export const ProviderIdSchema = z.enum(["yahoo", "coingecko", "ecb"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const RouteKeySchema = z.enum([
  "price:stock",
  "price:etf",
  "price:fund",
  "price:etc",
  "price:crypto",
  "fx",
  "eur-rate:fiat",
  "eur-rate:crypto",
]);
export type RouteKey = z.infer<typeof RouteKeySchema>;

export const PROVIDER_CAPABILITIES = {
  yahoo: ["price:stock", "price:etf", "price:fund", "price:etc", "price:crypto"],
  coingecko: ["price:crypto", "fx", "eur-rate:crypto"],
  ecb: ["fx", "eur-rate:fiat"],
} as const satisfies Record<ProviderId, readonly RouteKey[]>;

export function providerSupportsRoute(provider: ProviderId, route: RouteKey): boolean {
  return PROVIDER_CAPABILITIES[provider]?.some((candidate) => candidate === route) ?? false;
}

export function providerSupportsBinding(
  provider: ProviderId,
  kind: "instrument" | "currency",
): boolean {
  if (kind === "instrument") {
    return PROVIDER_CAPABILITIES[provider].some((route) => route.startsWith("price:"));
  }
  return (
    providerSupportsRoute(provider, "fx") ||
    providerSupportsRoute(provider, "eur-rate:fiat") ||
    providerSupportsRoute(provider, "eur-rate:crypto")
  );
}

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
    "eur-rate:crypto": z.array(ProviderIdSchema).optional(),
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
    for (const route of RouteKeySchema.options) {
      for (const provider of config.routes[route] ?? []) {
        if (!providerSupportsRoute(provider, route)) {
          context.addIssue({
            code: "custom",
            path: ["routes", route],
            message: `Provider ${provider} cannot serve ${route}`,
          });
        }
      }
    }
    const seen = new Set<string>();
    for (const binding of config.bindings) {
      if (!providerSupportsBinding(binding.provider, binding.kind)) {
        context.addIssue({
          code: "custom",
          path: ["bindings"],
          message: `Provider ${binding.provider} cannot serve ${binding.kind} bindings`,
        });
      }
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

export type PriceNeed = {
  instrument: Instrument;
  asOf: string;
  mode: "latest" | "historical";
  identifier: string;
};

export type FxNeed = {
  currency: string;
  asOf: string;
  mode: "latest" | "historical";
  identifier?: string;
};

export type EurRateNeed = {
  currency: string;
  date: string;
  identifier?: string;
};

export type PriceOutcome =
  | { need: PriceNeed; ok: true; data: PriceObservation }
  | { need: PriceNeed; ok: false; error: ProviderFailure };

export type FxOutcome =
  | { need: FxNeed; ok: true; data: FxObservation }
  | { need: FxNeed; ok: false; error: ProviderFailure };

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

export type ProviderFailureKind =
  | "unsupported"
  | "not-found"
  | "rate-limited"
  | "unauthorized"
  | "unavailable"
  | "invalid-response";

export type ProviderFailure = {
  kind: ProviderFailureKind;
  message: string;
  status?: number;
  retryAfterMs?: number;
};

export interface PriceSource {
  readonly id: ProviderId;
  fetchPrices(needs: readonly PriceNeed[]): Promise<readonly PriceOutcome[]>;
}

export interface FxSource {
  readonly id: ProviderId;
  fetchFxRates(needs: readonly FxNeed[]): Promise<readonly FxOutcome[]>;
}

export interface HistoricalEurRateSource {
  readonly id: ProviderId;
  fetchHistoricalEurRates(needs: readonly EurRateNeed[]): Promise<readonly EurRateOutcome[]>;
}

export type PriceFetchFailure = {
  need: PriceNeed;
  provider: ProviderId | "none";
  error: ProviderFailure;
};

export type PriceFetchReport = {
  requested: number;
  cached: number;
  fetched: readonly PriceObservation[];
  failures: readonly PriceFetchFailure[];
};

export type FxFetchFailure = {
  need: FxNeed;
  provider: ProviderId | "none";
  error: ProviderFailure;
};

export type FxFetchReport = {
  requested: number;
  cached: number;
  fetched: readonly FxObservation[];
  failures: readonly FxFetchFailure[];
};

export const DateNeedSchema = z.object({
  asOf: IsoDateSchema,
});
