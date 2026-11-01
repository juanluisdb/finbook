import { z } from "zod";
import { type Result } from "@finbook/core";
import {
  EnvironmentSchema,
  EurRateOutcomeSchema,
  FactoryResultSchema,
  FxHistoryOutcomeSchema,
  PriceHistoryOutcomeSchema,
  type ProviderEnvironment,
  type ProviderMetadata,
} from "@finbook/provider-sdk";
import type { ProviderPackages } from "./packages.js";
import type {
  MarketDataConfig,
  PriceHistoryNeed,
  PriceHistoryOutcome,
  FxHistoryNeed,
  FxHistoryOutcome,
  EurRateNeed,
  EurRateOutcome,
  ProviderFailure,
} from "./contracts.js";

const FxBatchSchema = z.array(FxHistoryOutcomeSchema);
const RateBatchSchema = z.array(EurRateOutcomeSchema);

export type ProviderPackagesFactory = () => ProviderPackages;
export class ProviderRuntime {
  private readonly loaded = new Map<string, ReturnType<ProviderRuntime["load"]>>();
  private readonly packages: ProviderPackagesFactory;
  private readonly environment: ProviderEnvironment;
  private readonly now: () => Date;
  constructor(
    packages: ProviderPackagesFactory,
    environment: ProviderEnvironment,
    now: () => Date = () => new Date(),
  ) {
    this.packages = packages;
    this.environment = environment;
    this.now = now;
  }

  async withSession<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    return this.packages().withSession(async () => {
      this.loaded.clear();
      return operation();
    });
  }

  sources(config: MarketDataConfig) {
    const ids = new Set([
      ...Object.values(config.routes).flatMap((providers) => providers ?? []),
      ...config.bindings.map((binding) => binding.provider),
    ]);
    return [...ids].map((id) => this.source(id));
  }

  source(id: string) {
    return {
      id,
      fetchPriceHistory: (need: PriceHistoryNeed) => this.price(id, need),
      fetchFxHistory: (needs: readonly FxHistoryNeed[]) => this.fx(id, needs),
      fetchHistoricalEurRates: (
        needs: readonly EurRateNeed[],
        requiredCapability?: "eur-rate:fiat",
      ) => this.rates(id, needs, requiredCapability),
    };
  }

  private provider(id: string) {
    let loaded = this.loaded.get(id);
    if (loaded === undefined) {
      loaded = this.load(id);
      this.loaded.set(id, loaded);
    }
    return loaded;
  }

  private async load(id: string) {
    const packages = this.packages();
    const found = await packages.find(id);
    if (!found.ok)
      return {
        ok: false as const,
        error: { kind: "unavailable" as const, message: found.error.message },
      };
    const metadata = found.data.metadata;
    const environment = EnvironmentSchema.parse(
      Object.fromEntries(
        metadata.environment.flatMap((name) =>
          this.environment[name] === undefined ? [] : [[name, this.environment[name]]],
        ),
      ),
    );
    let parsed: ReturnType<typeof FactoryResultSchema.safeParse>;
    try {
      const module = await packages.load(found.data.package);
      parsed = FactoryResultSchema.safeParse(module.default(environment));
    } catch {
      return foreignFailure(id);
    }
    if (!parsed.success) return invalid();
    if (!parsed.data.ok)
      return { ok: false as const, error: this.sanitize(parsed.data.error, metadata) };
    const provider = parsed.data.data;
    if (
      metadata.capabilities.some((capability) => capability.startsWith("price:")) !==
        (provider.fetchPriceHistory !== undefined) ||
      metadata.capabilities.includes("fx") !== (provider.fetchFxHistory !== undefined) ||
      metadata.capabilities.some((capability) => capability.startsWith("eur-rate:")) !==
        (provider.fetchHistoricalEurRates !== undefined)
    )
      return invalid();
    return { ok: true as const, data: provider, metadata };
  }

  private async price(id: string, need: PriceHistoryNeed): Promise<PriceHistoryOutcome> {
    const loaded = await this.provider(id);
    if (!loaded.ok) return loaded;
    if (
      !supports(loaded.metadata, `price:${need.instrument.type}`) ||
      loaded.data.fetchPriceHistory === undefined
    )
      return unsupported(id);
    const request = {
      ...need,
      instrument: { type: need.instrument.type, quoteCurrency: need.instrument.quoteCurrency },
    };
    let parsed: ReturnType<typeof PriceHistoryOutcomeSchema.safeParse>;
    try {
      parsed = PriceHistoryOutcomeSchema.safeParse(await loaded.data.fetchPriceHistory(request));
    } catch {
      return foreignFailure(id);
    }
    if (!parsed.success) return invalid();
    if (!parsed.data.ok)
      return { ok: false, error: this.sanitize(parsed.data.error, loaded.metadata) };
    if (
      parsed.data.data.some(
        (fact) => fact.asOf > need.through || fact.price.currency !== need.instrument.quoteCurrency,
      )
    )
      return invalid();
    const provenance = this.provenance(id);
    return {
      ok: true,
      data: parsed.data.data.map((fact) => ({
        ...fact,
        instrument: need.instrument.id,
        provenance,
      })),
    };
  }

  private async fx(
    id: string,
    needs: readonly FxHistoryNeed[],
  ): Promise<readonly FxHistoryOutcome[]> {
    const loaded = await this.provider(id);
    if (!loaded.ok) return needs.map((need) => ({ ...loaded, need }));
    if (!supports(loaded.metadata, "fx") || loaded.data.fetchFxHistory === undefined)
      return needs.map((need) => ({ ...unsupported(id), need }));
    const requests = needs.map((need) => ({ ...need }));
    let parsed: ReturnType<typeof FxBatchSchema.safeParse>;
    try {
      parsed = FxBatchSchema.safeParse(await loaded.data.fetchFxHistory(requests));
    } catch {
      return needs.map((need) => ({ ...foreignFailure(id), need }));
    }
    if (
      !parsed.success ||
      !correlates(
        needs,
        parsed.data.map((outcome) => outcome.need),
      )
    )
      return needs.map((need) => ({ ...invalid(), need }));
    if (
      parsed.data.some(
        (outcome) =>
          outcome.ok &&
          outcome.data.some(
            (fact) =>
              fact.asOf > outcome.need.through || fact.pair !== `${outcome.need.currency}/EUR`,
          ),
      )
    )
      return needs.map((need) => ({ ...invalid(), need }));
    const provenance = this.provenance(id);
    return parsed.data.map((outcome) =>
      outcome.ok
        ? { ...outcome, data: outcome.data.map((fact) => ({ ...fact, provenance })) }
        : { ...outcome, error: this.sanitize(outcome.error, loaded.metadata) },
    );
  }

  private async rates(
    id: string,
    needs: readonly EurRateNeed[],
    requiredCapability?: "eur-rate:fiat",
  ): Promise<readonly EurRateOutcome[]> {
    const loaded = await this.provider(id);
    if (!loaded.ok) return needs.map((need) => ({ ...loaded, need }));
    if (
      loaded.data.fetchHistoricalEurRates === undefined ||
      (requiredCapability !== undefined && !supports(loaded.metadata, requiredCapability))
    )
      return needs.map((need) => ({ ...unsupported(id), need }));
    const requests = needs.map((need) => ({ ...need }));
    let parsed: ReturnType<typeof RateBatchSchema.safeParse>;
    try {
      parsed = RateBatchSchema.safeParse(await loaded.data.fetchHistoricalEurRates(requests));
    } catch {
      return needs.map((need) => ({ ...foreignFailure(id), need }));
    }
    if (
      !parsed.success ||
      !correlates(
        needs,
        parsed.data.map((outcome) => outcome.need),
      )
    )
      return needs.map((need) => ({ ...invalid(), need }));
    if (parsed.data.some((outcome) => outcome.ok && outcome.data.effectiveDate > outcome.need.date))
      return needs.map((need) => ({ ...invalid(), need }));
    const provenance = this.provenance(id);
    return parsed.data.map((outcome) =>
      outcome.ok
        ? { ...outcome, data: { ...outcome.data, provenance } }
        : { ...outcome, error: this.sanitize(outcome.error, loaded.metadata) },
    );
  }

  private provenance(id: string) {
    return { kind: "fetched" as const, source: id, retrievedAt: this.now().toISOString() };
  }
  private sanitize(error: ProviderFailure, metadata: ProviderMetadata): ProviderFailure {
    let message = error.message;
    const values = metadata.environment
      .flatMap((name) => {
        const value = this.environment[name];
        return value === undefined || value.length === 0 ? [] : [value];
      })
      .sort((left, right) => right.length - left.length);
    for (const value of values) message = message.replaceAll(value, "[redacted]");
    return { ...error, message };
  }
}

function supports(metadata: ProviderMetadata, capability: string): boolean {
  return metadata.capabilities.some((value) => value === capability);
}
function invalid() {
  return {
    ok: false as const,
    error: {
      kind: "invalid-response" as const,
      message:
        "Provider result does not match the requested operation, subject, currency, date, or batch.",
    },
  };
}
function unsupported(id: string) {
  return {
    ok: false as const,
    error: {
      kind: "unsupported" as const,
      message: `Provider ${id} does not declare this operation.`,
    },
  };
}
function foreignFailure(id: string) {
  return {
    ok: false as const,
    error: {
      kind: "unavailable" as const,
      message: `Provider ${id} failed to load or execute. Check its package and declared environment inputs.`,
    },
  };
}
function correlates<T extends FxHistoryNeed | EurRateNeed>(
  needs: readonly T[],
  echoes: readonly T[],
): boolean {
  const key = (need: T) =>
    JSON.stringify(
      Object.entries(need)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  const expected = new Set(needs.map(key));
  return (
    expected.size === needs.length &&
    echoes.length === needs.length &&
    new Set(echoes.map(key)).size === echoes.length &&
    echoes.every((need) => expected.has(key(need)))
  );
}
