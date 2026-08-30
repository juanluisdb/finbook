import { XMLParser } from "fast-xml-parser";
import {
  CurrencySchema,
  IsoDateSchema,
  MoneyValue,
  PositiveDecimalStringSchema,
  type Provenance,
} from "@finbook/core";
import { z } from "zod";

import { createRetryingFetch } from "./http.js";
import {
  type EurRateNeed,
  type EurRateOutcome,
  type FxNeed,
  type FxObservation,
  type FxOutcome,
} from "./contracts.js";

const DEFAULT_BASE_URL = "https://www.ecb.europa.eu/stats/eurofxref";
const EcbRateSchema = z
  .object({
    "@_currency": z.array(CurrencySchema).length(1),
    "@_rate": z.array(PositiveDecimalStringSchema).length(1),
  })
  .strict();
const EcbDaySchema = z
  .object({
    "@_time": z.array(IsoDateSchema).length(1),
    Cube: z.array(EcbRateSchema),
  })
  .strict();
const EcbDocumentSchema = z
  .object({
    "gesmes:Envelope": z.array(
      z
        .object({
          Cube: z.array(
            z
              .object({
                Cube: z.array(EcbDaySchema),
              })
              .strict(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type EcbDay = {
  date: string;
  rates: readonly EcbRate[];
};

type EcbRate = {
  currency: string;
  rate: string;
};

type ParseResult = { ok: true; data: readonly EcbDay[] } | { ok: false; error: EcbFailure };

type EcbFailure = {
  kind: "not-found" | "rate-limited" | "unauthorized" | "unavailable" | "invalid-response";
  message: string;
  status?: number;
};

export type EcbSourceOptions = {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

export class EcbSource {
  readonly id = "ecb" as const;
  private readonly baseUrl: URL;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(options: EcbSourceOptions = {}) {
    this.baseUrl = new URL(`${options.baseUrl ?? DEFAULT_BASE_URL}/`);
    this.fetch = createRetryingFetch(options.fetchImplementation);
    this.now = options.now ?? (() => new Date());
  }

  async fetchFxRates(needs: readonly FxNeed[]): Promise<readonly FxOutcome[]> {
    const outcomes: Array<FxOutcome | undefined> = Array.from(
      { length: needs.length },
      () => undefined,
    );
    await this.resolveFxGroup(
      needs.map((need, index) => ({ need, index })),
      "eurofxref-daily.xml",
      outcomes,
    );
    await this.resolveFxGroup(
      needs
        .map((need, index) => ({ need, index }))
        .filter(({ need }) => need.mode === "historical"),
      "eurofxref-hist.xml",
      outcomes,
    );
    return needs.map(
      (need, index) =>
        outcomes[index] ?? {
          need,
          ok: false,
          error: { kind: "invalid-response", message: "ECB source omitted a requested rate." },
        },
    );
  }

  async fetchHistoricalEurRates(needs: readonly EurRateNeed[]): Promise<readonly EurRateOutcome[]> {
    if (needs.length === 0) return [];
    const loaded = await this.loadDays("eurofxref-hist.xml");
    if (!loaded.ok) return needs.map((need) => ({ need, ok: false, error: loaded.error }));
    return needs.map((need) => {
      const rate = rateAt(loaded.data, need.currency, need.date);
      if (rate === undefined) {
        return {
          need,
          ok: false,
          error: {
            kind: "not-found",
            message: `ECB has no ${need.currency} rate on or before ${need.date}.`,
          },
        };
      }
      return {
        need,
        ok: true,
        data: {
          rate: invert(rate.rate),
          effectiveDate: rate.date,
          provenance: this.provenance(),
        },
      };
    });
  }

  private async resolveFxGroup(
    entries: readonly { need: FxNeed; index: number }[],
    file: "eurofxref-daily.xml" | "eurofxref-hist.xml",
    outcomes: Array<FxOutcome | undefined>,
  ): Promise<void> {
    const historical = file === "eurofxref-hist.xml";
    const selected = entries.filter(
      ({ need }) => need.mode === (historical ? "historical" : "latest"),
    );
    if (selected.length === 0) return;
    const loaded = await this.loadDays(file);
    if (!loaded.ok) {
      for (const { need, index } of selected)
        outcomes[index] = { need, ok: false, error: loaded.error };
      return;
    }
    for (const { need, index } of selected) {
      if (need.currency === "EUR") {
        outcomes[index] = {
          need,
          ok: false,
          error: { kind: "invalid-response", message: "ECB does not publish an EUR/EUR rate." },
        };
        continue;
      }
      const rate = rateAt(loaded.data, need.currency, need.asOf);
      if (rate === undefined) {
        outcomes[index] = {
          need,
          ok: false,
          error: {
            kind: "not-found",
            message: `ECB has no ${need.currency} rate on or before ${need.asOf}.`,
          },
        };
        continue;
      }
      const observation: FxObservation = {
        pair: `${need.currency}/EUR`,
        rate: invert(rate.rate),
        asOf: rate.date,
        provenance: this.provenance(),
      };
      outcomes[index] = { need, ok: true, data: observation };
    }
  }

  private async loadDays(file: "eurofxref-daily.xml" | "eurofxref-hist.xml"): Promise<ParseResult> {
    let response: Response;
    try {
      response = await this.fetch(new URL(file, this.baseUrl));
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: error instanceof Error ? error.message : "ECB request failed.",
        },
      };
    }
    if (!response.ok) return { ok: false, error: httpFailure(response.status) };
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: error instanceof Error ? error.message : "ECB request failed.",
        },
      };
    }
    return parseDays(body);
  }

  private provenance(): Extract<Provenance, { kind: "fetched" }> {
    return {
      kind: "fetched",
      source: "ecb",
      retrievedAt: this.now().toISOString(),
    };
  }
}

function parseDays(body: string): ParseResult {
  let value: ReturnType<XMLParser["parse"]>;
  try {
    value = new XMLParser({
      ignoreAttributes: false,
      isArray: () => true,
    }).parse(body);
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "invalid-response",
        message: error instanceof Error ? error.message : "ECB response could not be parsed.",
      },
    };
  }
  const parsed = EcbDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: { kind: "invalid-response", message: "ECB response did not match its data shape." },
    };
  }
  const envelope = parsed.data["gesmes:Envelope"][0];
  const cube = envelope?.Cube[0];
  if (cube === undefined) {
    return {
      ok: false,
      error: { kind: "invalid-response", message: "ECB response contained no observations." },
    };
  }
  const days: EcbDay[] = [];
  for (const day of cube.Cube) {
    const date = day["@_time"][0];
    if (date === undefined) {
      return {
        ok: false,
        error: { kind: "invalid-response", message: "ECB observation had no date." },
      };
    }
    const rates: EcbRate[] = [];
    for (const rate of day.Cube) {
      const currency = rate["@_currency"][0];
      const value = rate["@_rate"][0];
      if (currency === undefined || value === undefined) {
        return {
          ok: false,
          error: { kind: "invalid-response", message: "ECB observation was incomplete." },
        };
      }
      rates.push({ currency, rate: value });
    }
    days.push({ date, rates });
  }
  return { ok: true, data: days };
}

function rateAt(
  days: readonly EcbDay[],
  currency: string,
  asOf: string,
): { date: string; rate: string } | undefined {
  let selected: { date: string; rate: string } | undefined;
  for (const day of days) {
    if (day.date > asOf) continue;
    const rate = day.rates.find((candidate) => candidate.currency === currency);
    if (rate === undefined) continue;
    if (selected === undefined || day.date > selected.date)
      selected = { date: day.date, rate: rate.rate };
  }
  return selected;
}

function invert(rate: string): string {
  return MoneyValue.from({ amount: "1", currency: "EUR" }).divide(rate).toMoney().amount;
}

function httpFailure(status: number): EcbFailure {
  if (status === 401 || status === 403) {
    return {
      kind: "unauthorized",
      status,
      message: `ECB rejected the request with HTTP ${status}.`,
    };
  }
  if (status === 404) return { kind: "not-found", status, message: "ECB endpoint was not found." };
  if (status === 429)
    return { kind: "rate-limited", status, message: "ECB rate-limited the request." };
  return {
    kind: status >= 500 ? "unavailable" : "invalid-response",
    status,
    message: `ECB returned HTTP ${status}.`,
  };
}
