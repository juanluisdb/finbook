import ky, { HTTPError } from "ky";

const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

export function createRetryingFetch(
  fetchImplementation: typeof fetch = globalThis.fetch,
): typeof fetch {
  const request = ky.create({
    fetch: fetchImplementation,
    throwHttpErrors: false,
    timeout: 10_000,
    totalTimeout: 30_000,
    retry: {
      limit: 2,
      statusCodes: RETRYABLE_STATUS_CODES,
      afterStatusCodes: [429, 503],
      maxRetryAfter: 30_000,
      backoffLimit: 5_000,
      retryOnTimeout: true,
      jitter: true,
    },
    hooks: {
      afterResponse: [({ response, retryCount }) => retryResponse(response, retryCount)],
    },
  });

  return async (input, init) => {
    try {
      return await request(input, init);
    } catch (error) {
      if (error instanceof HTTPError) return error.response;
      throw error;
    }
  };
}

function retryResponse(
  response: Response,
  retryCount: number,
): Response | ReturnType<typeof ky.retry> {
  if (!RETRYABLE_STATUS_CODES.includes(response.status) || retryCount >= 2) return response;
  const delay = retryAfterMs(response.headers.get("retry-after"));
  if (delay === null) return response;
  return delay === undefined ? ky.retry() : ky.retry({ delay });
}

function retryAfterMs(value: string | null): number | null | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return boundedDelay(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return boundedDelay(timestamp - Date.now());
}

function boundedDelay(delay: number): number | null {
  if (delay > 30_000) return null;
  return Math.max(delay, 0);
}
