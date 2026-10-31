import {
  type FileBookStore,
  IsoDateSchema,
  PositiveDecimalStringSchema,
  type Result,
} from "@finbook/core";
import { selectHistoricalEurRateProviders } from "./routing.js";
import { HistoryUpdater, type HistoryUpdateReport } from "./history.js";
import { findBinding } from "./config.js";
import type {
  MarketDataConfig,
  EurRateNeed,
  EurRateOutcome,
  EurRateResolution,
  HistoricalEurRateSource,
  PriceHistorySource,
  FxHistorySource,
  ProviderFailure,
  ProviderId,
} from "./contracts.js";

export type MarketDataStore = Pick<FileBookStore, "dataHome" | "load" | "appendPrice" | "appendFx">;
export type MarketDataCoordinatorOptions = {
  store: MarketDataStore;
  config: MarketDataConfig;
  eurRateSources: readonly HistoricalEurRateSource[];
  priceHistorySources?: readonly PriceHistorySource[];
  fxHistorySources?: readonly FxHistorySource[];
  now?: () => Date;
};
export type ResolveRateOptions = { provider?: ProviderId };
export type ManualMarkConflict = {
  kind: "price" | "fx";
  subject: string;
  asOf: string;
  manual: string;
  fetched: string;
  currency: string;
  action: "kept";
};
export class MarketDataCoordinator {
  private readonly config: MarketDataConfig;
  private readonly eurRateSources: readonly HistoricalEurRateSource[];
  private readonly history: HistoryUpdater;
  constructor(options: MarketDataCoordinatorOptions) {
    this.config = options.config;
    this.eurRateSources = options.eurRateSources;
    this.history = new HistoryUpdater({
      store: options.store,
      config: options.config,
      priceSources: options.priceHistorySources ?? [],
      fxSources: options.fxHistorySources ?? [],
      now: options.now ?? (() => new Date()),
    });
  }
  updateHistory(): Promise<Result<HistoryUpdateReport>> {
    return this.history.update();
  }

  async resolveHistoricalEurRate(
    need: EurRateNeed,
    options: ResolveRateOptions = {},
  ): Promise<EurRateResolution> {
    const bindingCandidate = findBinding(this.config, "currency", need.currency);
    const binding = bindingCandidate?.kind === "currency" ? bindingCandidate : undefined;
    const selection = selectHistoricalEurRateProviders(binding, this.config, options.provider);
    if (!selection.ok) return { ok: false, error: selection.error };
    let lastFailure: ProviderFailure | undefined;

    for (const provider of selection.providers) {
      const source = this.eurRateSources.find((candidate) => candidate.id === provider);
      if (source === undefined) {
        lastFailure = {
          kind: "unavailable",
          message: `Provider ${provider} is not available in this build.`,
        };
        continue;
      }
      const providerNeed =
        binding?.provider === provider ? { ...need, identifier: binding.identifier } : need;
      let outcomes: readonly EurRateOutcome[];
      try {
        outcomes = await source.fetchHistoricalEurRates([providerNeed]);
      } catch (error) {
        lastFailure = {
          kind: "unavailable",
          message: error instanceof Error ? error.message : "Provider request failed.",
        };
        continue;
      }
      const outcome = outcomes[0];
      if (outcome === undefined) {
        lastFailure = {
          kind: "invalid-response",
          message: `Provider ${provider} omitted ${need.currency}.`,
        };
        continue;
      }
      if (!outcome.ok) {
        lastFailure = outcome.error;
        continue;
      }
      const rate = PositiveDecimalStringSchema.safeParse(outcome.data.rate);
      const effectiveDate = IsoDateSchema.safeParse(outcome.data.effectiveDate);
      if (!rate.success || !effectiveDate.success) {
        lastFailure = {
          kind: "invalid-response",
          message: `Provider ${provider} returned an invalid EUR rate.`,
        };
        continue;
      }
      if (effectiveDate.data > need.date) {
        lastFailure = {
          kind: "invalid-response",
          message: `Provider ${provider} returned a future EUR rate.`,
        };
        continue;
      }
      if (outcome.data.provenance.kind !== "fetched") {
        lastFailure = {
          kind: "invalid-response",
          message: `Provider ${provider} returned a non-fetched EUR rate.`,
        };
        continue;
      }
      return {
        ok: true,
        data: {
          rate: rate.data,
          effectiveDate: effectiveDate.data,
          provenance: outcome.data.provenance,
        },
      };
    }

    const error = lastFailure ?? {
      kind: "unavailable" as const,
      message: `No provider is configured for ${need.currency}.`,
    };
    if (binding === undefined && (error.kind === "unsupported" || error.kind === "not-found")) {
      return {
        ok: false,
        error: {
          ...error,
          message: `${error.message} Bind it with: finbook config source set --currency ${need.currency} --provider coingecko --identifier <provider-id>.`,
        },
      };
    }
    return { ok: false, error };
  }
}
