import type { ProviderFailure } from "./contracts.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1_000;

type LatestObservationTimeInput = {
  provider: string;
  identifier: string;
  observedAt: Date | undefined;
  retrievedAt: Date;
  maxAgeHours: number;
};

export function validateLatestObservationTime({
  provider,
  identifier,
  observedAt,
  retrievedAt,
  maxAgeHours,
}: LatestObservationTimeInput): ProviderFailure | undefined {
  if (observedAt === undefined || !Number.isFinite(observedAt.getTime())) {
    return {
      kind: "invalid-response",
      message: `${provider} returned no valid timestamp for ${identifier}.`,
    };
  }

  const age = retrievedAt.getTime() - observedAt.getTime();
  if (age < -MAX_FUTURE_CLOCK_SKEW_MILLISECONDS) {
    return {
      kind: "invalid-response",
      message: `${provider} returned a future timestamp for ${identifier}: ${observedAt.toISOString()}.`,
    };
  }
  if (age > maxAgeHours * MILLISECONDS_PER_HOUR) {
    return {
      kind: "invalid-response",
      message: `${provider} returned a stale timestamp for ${identifier}: ${observedAt.toISOString()}.`,
    };
  }
  return undefined;
}
