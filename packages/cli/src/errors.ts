import type { DomainError, Result } from "@finbook/core";

export class CliFailure extends Error {
  readonly domainError: DomainError;
  readonly exitCode: number;

  constructor(domainError: DomainError) {
    super(domainError.message);
    this.name = "CliFailure";
    this.domainError = domainError;
    this.exitCode = exitCodeFor(domainError);
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

export function externalFailure(message: string, hint: string): CliFailure {
  return new CliFailure({ type: "external", message, hint });
}

export function notFoundFailure(kind: string, id: string): CliFailure {
  return new CliFailure({
    type: "not-found",
    message: `Unknown ${kind} ID: ${id}.`,
    hint: `Add or select an existing ${kind}.`,
  });
}
