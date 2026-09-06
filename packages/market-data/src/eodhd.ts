import { IsoDateSchema, MoneyValue } from "@finbook/core";

import { z } from "zod";

import {
  type PriceNeed,
  type PriceOutcome,
  type PriceSource,
  type ProviderFailure,
} from "./contracts.js";

const EODHD_BASE_URL = "https://eodhd.com/api/eod/";
const LOOKBACK_DAYS = 9;
const MAX_LATEST_AGE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 10_000;

const EodhdRowSchema = z
  .object({
    date: IsoDateSchema,
    close: z.number().finite().positive(),
  })
  .passthrough();
const EodhdResponseSchema = z.array(EodhdRowSchema);

export type EodhdSourceOptions = {
  apiKey?: string | undefined;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

export class EodhdSource implements PriceSource {
  readonly id = "eodhd" as const;
  private readonly apiKey: string | undefined;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;

  constructor(options: EodhdSourceOptions = {}) {
    this.apiKey = nonEmpty(options.apiKey);
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  fetchPrices(needs: readonly PriceNeed[]): Promise<readonly PriceOutcome[]> {
    return Promise.all(needs.map(async (need) => this.fetchPrice(need)));
  }

  private async fetchPrice(need: PriceNeed): Promise<PriceOutcome> {
    if (need.instrument.type !== "fund") {
      return failure(need, "unsupported", "EODHD is configured only for fund prices.");
    }
    if (this.apiKey === undefined) {
      return failure(need, "unauthorized", "EODHD requires FINBOOK_EODHD_API_KEY.");
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(requestUrl(need, this.apiKey), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return failure(need, "unavailable", "EODHD request failed.");
    }
    if (!response.ok) return { need, ok: false, error: httpFailure(response) };

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return failure(need, "invalid-response", "EODHD returned invalid JSON.");
    }
    const parsed = EodhdResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return failure(need, "invalid-response", "EODHD returned invalid daily prices.");
    }
    const [first, ...remaining] = parsed.data;
    if (first === undefined) {
      return failure(need, "not-found", `EODHD returned no history for ${need.identifier}.`);
    }
    if (parsed.data.some((row) => row.date > need.asOf)) {
      return failure(
        need,
        "invalid-response",
        `EODHD returned a future date for ${need.identifier}.`,
      );
    }

    const selected = remaining.reduce(
      (latest, row) => (row.date > latest.date ? row : latest),
      first,
    );
    if (need.mode === "latest" && daysBetween(selected.date, need.asOf) > MAX_LATEST_AGE_DAYS) {
      return failure(
        need,
        "invalid-response",
        `EODHD returned a stale date for ${need.identifier}: ${selected.date}.`,
      );
    }

    return {
      need,
      ok: true,
      data: {
        instrument: need.instrument.id,
        price: {
          amount: MoneyValue.from({
            amount: String(selected.close),
            currency: need.instrument.quoteCurrency,
          }).toMoney().amount,
          currency: need.instrument.quoteCurrency,
        },
        asOf: need.mode === "latest" ? need.asOf : selected.date,
        provenance: {
          kind: "fetched",
          source: "eodhd",
          retrievedAt: this.now().toISOString(),
        },
      },
    };
  }
}

function requestUrl(need: PriceNeed, apiKey: string): URL {
  const url = new URL(`${EODHD_BASE_URL}${encodeURIComponent(need.identifier)}`);
  const from = new Date(`${need.asOf}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
  url.searchParams.set("api_token", apiKey);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("period", "d");
  url.searchParams.set("order", "d");
  url.searchParams.set("from", from.toISOString().slice(0, 10));
  url.searchParams.set("to", need.asOf);
  return url;
}

function httpFailure(response: Response): ProviderFailure {
  const status = response.status;
  if (status === 401 || status === 403) {
    return { kind: "unauthorized", message: "EODHD rejected the API credential.", status };
  }
  if (status === 404) {
    return { kind: "not-found", message: "EODHD returned no data for the identifier.", status };
  }
  if (status === 429) {
    const retryAfter = retryAfterMs(response.headers.get("retry-after"));
    const failure: ProviderFailure = {
      kind: "rate-limited",
      message: "EODHD rate limit reached.",
      status,
    };
    if (retryAfter !== undefined) failure.retryAfterMs = retryAfter;
    return failure;
  }
  if (status === 400 || status === 422) {
    return { kind: "invalid-response", message: "EODHD rejected the request.", status };
  }
  return { kind: "unavailable", message: "EODHD request failed.", status };
}

function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(timestamp - Date.now(), 0) : undefined;
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function failure(need: PriceNeed, kind: ProviderFailure["kind"], message: string): PriceOutcome {
  return { need, ok: false, error: { kind, message } };
}
