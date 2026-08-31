import type { DomainError, Glance, PositionsResult, Result } from "@finbook/core";
import type { ProviderFailureKind, ProviderId } from "@finbook/market-data";

export type PartialFetchFailure = {
  kind: "price" | "fx";
  subject: string;
  provider: ProviderId | "none";
  reason: ProviderFailureKind;
  message: string;
};

export type ExternalFailureDetails = {
  requested: { prices: number; fx: number };
  saved: { prices: number; fx: number };
  failures: readonly PartialFetchFailure[];
  partial: Glance | PositionsResult;
};

export class CliFailure extends Error {
  readonly domainError: DomainError;
  readonly exitCode: number;
  readonly externalDetails: ExternalFailureDetails | undefined;

  constructor(domainError: DomainError, externalDetails?: ExternalFailureDetails) {
    super(domainError.message);
    this.name = "CliFailure";
    this.domainError = domainError;
    this.exitCode = exitCodeFor(domainError);
    this.externalDetails = externalDetails;
  }
}

export function requireResult<T>(result: Result<T>): T {
  if (!result.ok) throw new CliFailure(result.error);
  return result.data;
}

export function exitCodeFor(error: DomainError): number {
  if (error.type === "not-found") return 3;
  if (error.type === "validation" || error.type === "invariant") return 2;
  return 1;
}

export function validationFailure(message: string, hint: string): CliFailure {
  return new CliFailure({ type: "validation", message, hint });
}

export function externalFailure(
  message: string,
  hint: string,
  details?: ExternalFailureDetails,
): CliFailure {
  return new CliFailure({ type: "external", message, hint, details }, details);
}

export function notFoundFailure(kind: string, id: string): CliFailure {
  return new CliFailure({
    type: "not-found",
    message: `Unknown ${kind} ID: ${id}.`,
    hint: `Add or select an existing ${kind}.`,
  });
}
