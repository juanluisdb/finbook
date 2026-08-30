export type DomainErrorType = "validation" | "not-found" | "invariant" | "storage" | "external";

export type DomainError = {
  type: DomainErrorType;
  message: string;
  hint: string;
};

export type Result<T, E = DomainError> = { ok: true; data: T } | { ok: false; error: E };

export function succeed<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(error: DomainError): Result<never> {
  return { ok: false, error };
}
