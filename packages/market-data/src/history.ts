import {
  FxStampSchema,
  PriceStampSchema,
  MoneyValue,
  succeed,
  withRefreshLock,
  type BookSnapshot,
  type Result,
} from "@finbook/core";
import type { MarketDataStore, ManualMarkConflict } from "./coordinator.js";
import type {
  FxHistoryNeed,
  FxHistorySource,
  MarketDataConfig,
  PriceHistorySource,
  ProviderFailure,
  ProviderId,
} from "./contracts.js";
import { findBinding } from "./config.js";
import { completedHistoryDate } from "./history-date.js";
import {
  HistoryChecks,
  checkIsIntact,
  type HistoryCheck,
  type HistoryObservation,
} from "./history-checks.js";
import {
  historyRequirements,
  retainHistory,
  uncheckedRanges,
  type HistoryRequirement,
} from "./history-plan.js";
import { selectPriceProviders, selectFxProviders } from "./routing.js";

export type HistoryRange = {
  kind: "price" | "fx";
  subject: string;
  from: string;
  through: string;
  provider: ProviderId | "none";
};
export type HistoryUpdateReport = {
  checked: HistoryRange[];
  reused: HistoryRange[];
  empty: HistoryRange[];
  saved: { prices: number; fx: number };
  failures: (HistoryRange & { error: ProviderFailure })[];
  conflicts: ManualMarkConflict[];
};

type HistoryUpdaterOptions = {
  store: MarketDataStore;
  config: MarketDataConfig;
  priceSources: readonly PriceHistorySource[];
  fxSources: readonly FxHistorySource[];
  now: () => Date;
};

type HistoryWork = {
  requirement: HistoryRequirement;
  key: string;
  providers: readonly ProviderId[];
  sourceFrom: string | undefined;
  retainFrom: string;
};
type HistoryResponse =
  | { ok: true; observations: readonly HistoryObservation[] }
  | { ok: false; error: ProviderFailure };

export class HistoryUpdater {
  private readonly options: HistoryUpdaterOptions;
  private readonly checks: HistoryChecks;
  constructor(options: HistoryUpdaterOptions) {
    this.options = options;
    this.checks = new HistoryChecks(options.store.dataHome);
  }

  update(): Promise<Result<HistoryUpdateReport>> {
    return withRefreshLock(this.options.store.dataHome, async () => {
      const loaded = this.options.store.load();
      if (!loaded.ok) return loaded;
      const checked = this.checks.load();
      if (!checked.ok) return checked;
      const now = this.options.now();
      const through = completedHistoryDate(now);
      const required = historyRequirements(loaded.data, through);
      if (!required.ok) return required;
      const report: HistoryUpdateReport = {
        checked: [],
        reused: [],
        empty: [],
        saved: { prices: 0, fx: 0 },
        failures: [],
        conflicts: [],
      };
      const planned = this.plan(required.data, checked.data, loaded.data, report);
      const work = planned.work;
      const snapshot = { ...loaded.data, prices: [...loaded.data.prices], fx: [...loaded.data.fx] };
      const fxResponses = new Map<ProviderId, Map<HistoryWork, HistoryResponse>>();
      const candidates = planned.observations;
      for (const item of work) {
        let failure: ProviderFailure = {
          kind: "unsupported",
          message: "No historical source is configured.",
        };
        let lastProvider: ProviderId | "none" = "none";
        let completed = false;
        for (const provider of item.providers) {
          lastProvider = provider;
          const response =
            item.requirement.kind === "price"
              ? await this.fetchPrice(item, provider)
              : await this.fetchFx(item, provider, work, fxResponses);
          if (!response.ok) {
            failure = response.error;
            continue;
          }
          const validated = validateHistory(item.requirement, provider, response.observations);
          if (!validated.ok) {
            failure = validated.error;
            continue;
          }
          const retained = retainHistory(
            validated.observations.map((observation) => ({
              asOf: observation.mark.asOf,
              observation,
            })),
            { from: item.retainFrom, through: item.requirement.through },
          ).map((value) => value.observation);
          const saved = this.save(item, provider, retained, snapshot, report);
          if (!saved.ok) return saved;
          candidates.push(...retained);
          completed = true;
          break;
        }
        if (!completed)
          report.failures.push({ ...range(item.requirement, lastProvider), error: failure });
      }
      const current = this.options.store.load();
      if (!current.ok) return current;
      const latestCandidates = new Map(
        candidates.map((observation) => {
          const subject =
            observation.kind === "price" ? observation.mark.instrument : observation.mark.pair;
          return [`${observation.kind}:${subject}:${observation.mark.asOf}`, observation] as const;
        }),
      );
      report.conflicts = [...latestCandidates.values()].flatMap((observation) => {
        const conflict = manualConflict(observation, current.data);
        return conflict === undefined ? [] : [conflict];
      });
      return succeed(report);
    });
  }

  private plan(
    requirements: readonly HistoryRequirement[],
    checks: readonly HistoryCheck[],
    snapshot: BookSnapshot,
    report: HistoryUpdateReport,
  ) {
    const work: HistoryWork[] = [];
    const observations: HistoryObservation[] = [];
    for (const requirement of requirements) {
      const selection =
        requirement.kind === "price"
          ? selectPriceProviders(
              {
                instrument: requirement.instrument,
              },
              this.options.config,
              undefined,
            )
          : selectFxProviders({ currency: requirement.subject }, this.options.config, undefined);
      if (!selection.ok) {
        report.failures.push({ ...range(requirement, selection.provider), error: selection.error });
        continue;
      }
      const key = JSON.stringify({
        kind: requirement.kind,
        subject: requirement.subject,
        instrument:
          requirement.kind === "price"
            ? {
                type: requirement.instrument.type,
                quoteCurrency: requirement.instrument.quoteCurrency,
              }
            : null,
        route: selection.providers.map((provider) => ({
          provider,
          identifier: this.identifier(requirement, provider),
        })),
      });
      const matching = checks.filter(
        (check) => check.key === key && checkIsIntact(check, snapshot),
      );
      for (const check of matching) {
        const from = check.from > requirement.from ? check.from : requirement.from;
        const through = check.through < requirement.through ? check.through : requirement.through;
        if (from <= through) {
          report.reused.push({ ...range(requirement, check.provider), from, through });
          observations.push(...check.observations);
        }
      }
      for (const missing of uncheckedRanges(requirement, matching)) {
        const sourceFrom = latestObservationDate(requirement, snapshot, missing.from);
        const retainFrom = sourceFrom ?? missing.from;
        work.push({
          requirement: { ...requirement, ...missing },
          key,
          providers: selection.providers,
          sourceFrom,
          retainFrom: retainFrom < requirement.from ? requirement.from : retainFrom,
        });
      }
    }
    work.sort(
      (a, b) =>
        b.requirement.through.localeCompare(a.requirement.through) ||
        b.requirement.from.localeCompare(a.requirement.from) ||
        a.requirement.subject.localeCompare(b.requirement.subject),
    );
    return { work, observations };
  }

  private identifier(requirement: HistoryRequirement, provider: ProviderId): string {
    const binding =
      requirement.kind === "price"
        ? findBinding(this.options.config, "instrument", requirement.subject)
        : findBinding(this.options.config, "currency", requirement.subject);
    return binding?.provider === provider ? binding.identifier : requirement.subject;
  }

  private async fetchPrice(item: HistoryWork, provider: ProviderId): Promise<HistoryResponse> {
    const requirement = item.requirement;
    if (requirement.kind !== "price") throw new Error("Expected price history work.");
    const source = this.options.priceSources.find((value) => value.id === provider);
    if (source === undefined) return unsupported(provider);
    const need = {
      instrument: requirement.instrument,
      identifier: this.identifier(requirement, provider),
      from: requirement.from,
      through: requirement.through,
    };
    const response = await source.fetchPriceHistory(
      item.sourceFrom === undefined ? need : { ...need, sourceFrom: item.sourceFrom },
    );
    return response.ok
      ? { ok: true, observations: response.data.map((mark) => ({ kind: "price", mark })) }
      : response;
  }

  private async fetchFx(
    item: HistoryWork,
    provider: ProviderId,
    work: readonly HistoryWork[],
    allResponses: Map<ProviderId, Map<HistoryWork, HistoryResponse>>,
  ): Promise<HistoryResponse> {
    const responses = allResponses.get(provider) ?? new Map<HistoryWork, HistoryResponse>();
    allResponses.set(provider, responses);
    const cached = responses.get(item);
    if (cached !== undefined) return cached;
    const source = this.options.fxSources.find((value) => value.id === provider);
    if (source === undefined) return unsupported(provider);
    const group = work.filter(
      (value) =>
        value.requirement.kind === "fx" &&
        value.providers.includes(provider) &&
        !responses.has(value) &&
        value.providers.slice(0, value.providers.indexOf(provider)).every((previous) => {
          const prior = allResponses.get(previous)?.get(value);
          return prior === undefined
            ? !this.options.fxSources.some((source) => source.id === previous)
            : !prior.ok;
        }),
    );
    if (!group.includes(item)) group.push(item);
    const requests = group.map((value) => {
      const need = {
        currency: value.requirement.subject,
        identifier: this.identifier(value.requirement, provider),
        from: value.requirement.from,
        through: value.requirement.through,
      };
      const request: FxHistoryNeed =
        value.sourceFrom === undefined ? need : { ...need, sourceFrom: value.sourceFrom };
      return { work: value, need: request };
    });
    const outcomes = await source.fetchFxHistory(requests.map((request) => request.need));
    for (const { work: value, need } of requests) {
      const outcome = outcomes.find(
        (result) =>
          result.need.currency === need.currency &&
          result.need.from === need.from &&
          result.need.through === need.through &&
          result.need.identifier === need.identifier,
      );
      responses.set(
        value,
        outcome === undefined
          ? {
              ok: false,
              error: {
                kind: "invalid-response",
                message: `${provider} omitted a historical FX outcome.`,
              },
            }
          : outcome.ok
            ? { ok: true, observations: outcome.data.map((mark) => ({ kind: "fx", mark })) }
            : outcome,
      );
    }
    const response = responses.get(item);
    if (response === undefined) throw new Error("Historical FX batch omitted its requested work.");
    return response;
  }

  private save(
    item: HistoryWork,
    provider: ProviderId,
    observations: readonly HistoryObservation[],
    snapshot: { prices: BookSnapshot["prices"][number][]; fx: BookSnapshot["fx"][number][] },
    report: HistoryUpdateReport,
  ): Result<void> {
    const retained: HistoryObservation[] = [];
    for (const observation of observations) {
      if (observation.kind === "price") {
        const mark = observation.mark;
        const existing = snapshot.prices.findLast(
          (value) =>
            value.instrument === mark.instrument &&
            value.asOf === mark.asOf &&
            value.provenance.kind === "fetched",
        );
        if (
          existing !== undefined &&
          existing.price.currency === mark.price.currency &&
          MoneyValue.from(existing.price).amount.equals(mark.price.amount) &&
          existing.provenance.kind === "fetched" &&
          existing.provenance.source === provider
        )
          retained.push({ kind: "price", mark: existing });
        else {
          const saved = this.options.store.appendPrice(mark);
          if (!saved.ok) return saved;
          snapshot.prices.push(mark);
          retained.push(observation);
          report.saved.prices++;
        }
      } else {
        const mark = observation.mark;
        const existing = snapshot.fx.findLast(
          (value) =>
            value.pair === mark.pair &&
            value.asOf === mark.asOf &&
            value.provenance.kind === "fetched",
        );
        if (
          existing !== undefined &&
          existing.rate === mark.rate &&
          existing.provenance.kind === "fetched" &&
          existing.provenance.source === provider
        )
          retained.push({ kind: "fx", mark: existing });
        else {
          const saved = this.options.store.appendFx(mark);
          if (!saved.ok) return saved;
          snapshot.fx.push(mark);
          retained.push(observation);
          report.saved.fx++;
        }
      }
    }
    const saved = this.checks.save({
      key: item.key,
      from: item.requirement.from,
      through: item.requirement.through,
      provider,
      checkedAt: this.options.now().toISOString(),
      observations: retained,
    });
    if (!saved.ok) return saved;
    const completed = range(item.requirement, provider);
    report.checked.push(completed);
    if (retained.length === 0) report.empty.push(completed);
    return succeed(undefined);
  }
}

function range(requirement: HistoryRequirement, provider: ProviderId | "none"): HistoryRange {
  return {
    kind: requirement.kind,
    subject: requirement.subject,
    from: requirement.from,
    through: requirement.through,
    provider,
  };
}

function unsupported(provider: ProviderId): HistoryResponse {
  return {
    ok: false,
    error: {
      kind: "unsupported",
      message: `${provider} does not provide this historical operation.`,
    },
  };
}

function latestObservationDate(
  requirement: HistoryRequirement,
  snapshot: BookSnapshot,
  through: string,
): string | undefined {
  const marks =
    requirement.kind === "price"
      ? snapshot.prices.filter((mark) => mark.instrument === requirement.subject)
      : snapshot.fx.filter((mark) => mark.pair === `${requirement.subject}/EUR`);
  return marks
    .filter((mark) => mark.asOf <= through)
    .map((mark) => mark.asOf)
    .sort()
    .at(-1);
}

function validateHistory(
  requirement: HistoryRequirement,
  provider: ProviderId,
  observations: readonly HistoryObservation[],
): HistoryResponse {
  const parsed: HistoryObservation[] = [];
  for (const observation of observations) {
    const result =
      observation.kind === "price"
        ? PriceStampSchema.safeParse(observation.mark)
        : FxStampSchema.safeParse(observation.mark);
    if (
      !result.success ||
      result.data.provenance.kind !== "fetched" ||
      result.data.provenance.source !== provider ||
      result.data.asOf > requirement.through
    )
      return invalidHistory();
    if (
      observation.kind === "price" &&
      requirement.kind === "price" &&
      "instrument" in result.data &&
      result.data.instrument === requirement.subject &&
      result.data.price.currency === requirement.instrument.quoteCurrency
    )
      parsed.push({ kind: "price", mark: result.data });
    else if (
      observation.kind === "fx" &&
      requirement.kind === "fx" &&
      "pair" in result.data &&
      result.data.pair === `${requirement.subject}/EUR`
    )
      parsed.push({ kind: "fx", mark: result.data });
    else return invalidHistory();
  }
  return { ok: true, observations: parsed };
}

function invalidHistory(): HistoryResponse {
  return {
    ok: false,
    error: {
      kind: "invalid-response",
      message:
        "Historical observations do not match the requested subject, currency, date, or provider.",
    },
  };
}

function manualConflict(
  observation: HistoryObservation,
  snapshot: { prices: BookSnapshot["prices"]; fx: BookSnapshot["fx"] },
): ManualMarkConflict | undefined {
  if (observation.kind === "price") {
    const mark = observation.mark;
    const manual = snapshot.prices.findLast(
      (value) =>
        value.instrument === mark.instrument &&
        value.asOf === mark.asOf &&
        value.provenance.kind === "manual",
    );
    if (manual === undefined || MoneyValue.from(manual.price).amount.equals(mark.price.amount))
      return undefined;
    return {
      kind: "price",
      subject: mark.instrument,
      asOf: mark.asOf,
      currency: mark.price.currency,
      manual: manual.price.amount,
      fetched: mark.price.amount,
      action: "kept",
    };
  }
  const mark = observation.mark;
  const manual = snapshot.fx.findLast(
    (value) =>
      value.pair === mark.pair && value.asOf === mark.asOf && value.provenance.kind === "manual",
  );
  if (manual === undefined || manual.rate === mark.rate) return undefined;
  return {
    kind: "fx",
    subject: mark.pair,
    asOf: mark.asOf,
    currency: "EUR",
    manual: manual.rate,
    fetched: mark.rate,
    action: "kept",
  };
}
