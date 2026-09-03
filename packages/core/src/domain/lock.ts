import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { IsoInstantSchema, NonEmptyStringSchema } from "./scalars.js";
import { fail, succeed, type DomainError, type Result } from "./result.js";

const LOCK_DIRECTORY = ".finbook.lock";
const LockOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    hostname: NonEmptyStringSchema,
    createdAt: IsoInstantSchema,
    token: NonEmptyStringSchema,
  })
  .strict();

export type LockOwner = z.infer<typeof LockOwnerSchema>;

export type BookLockInspection =
  | { kind: "absent" }
  | { kind: "active"; owner: Omit<LockOwner, "token"> }
  | { kind: "stale"; owner: Omit<LockOwner, "token"> }
  | { kind: "uncertain"; reason: string; owner?: Omit<LockOwner, "token"> };

export function inspectBookLock(dataHome: string): BookLockInspection {
  const lockPath = join(dataHome, LOCK_DIRECTORY);
  if (!existsSync(lockPath)) return { kind: "absent" };

  const ownerResult = readLockOwner(lockPath);
  if (!ownerResult.ok) {
    return existsSync(lockPath)
      ? { kind: "uncertain", reason: ownerResult.error }
      : { kind: "absent" };
  }

  const { pid, hostname: ownerHostname, createdAt } = ownerResult.data;
  const owner = { pid, hostname: ownerHostname, createdAt };
  if (ownerHostname !== hostname()) {
    return { kind: "uncertain", reason: "the lock belongs to another host", owner };
  }

  const alive = processIsAlive(pid);
  if (alive === true) return { kind: "active", owner };
  if (alive === false) return { kind: "stale", owner };
  return { kind: "uncertain", reason: "the owner process could not be verified", owner };
}

export function withBookLock<T>(dataHome: string, operation: () => Result<T>): Result<T> {
  const acquired = acquireBookLock(dataHome);
  if (!acquired.ok) return fail(acquired.error);

  let result: Result<T> | undefined;
  let threw = false;
  let thrownError: unknown;
  let released: Result<void>;
  try {
    result = operation();
  } catch (error) {
    threw = true;
    thrownError = error;
  } finally {
    released = releaseBookLock(dataHome, acquired.data);
  }

  if (threw) throw thrownError;
  if (!released.ok) return fail(released.error);
  if (result === undefined) throw new Error("Book lock operation returned no result.");
  return result;
}

function acquireBookLock(dataHome: string): Result<string> {
  const lockPath = join(dataHome, LOCK_DIRECTORY);
  try {
    ensureDataDirectory(dataHome);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown filesystem error";
    return fail(
      storageError(
        `Could not prepare ${dataHome}: ${detail}`,
        "Check FINBOOK_HOME and its permissions.",
      ),
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const owner: LockOwner = {
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
        token: randomUUID(),
      };
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (process.platform !== "win32") chmodSync(join(lockPath, "owner.json"), 0o600);
      return succeed(owner.token);
    } catch (error) {
      if (!(error instanceof Error)) {
        return fail(
          storageError(
            "Could not create the book lock: unknown filesystem error; the mutation did not run",
            "Check FINBOOK_HOME and retry.",
          ),
        );
      }
      if (!isAlreadyExists(error)) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          return fail(
            storageError(
              `Could not create the book lock: ${error.message}; the mutation did not run`,
              "Check FINBOOK_HOME and retry.",
            ),
          );
        }
        return fail(
          storageError(
            `Could not create the book lock: ${error.message}; the mutation did not run`,
            "Check FINBOOK_HOME and retry.",
          ),
        );
      }
    }

    const inspection = inspectBookLock(dataHome);
    if (inspection.kind === "absent") continue;
    if (inspection.kind === "uncertain") {
      return fail(
        storageError(
          `The book lock is active or uncertain; ${inspection.reason}; the mutation did not run`,
          `Inspect ${lockPath} and remove it only after confirming no finbook process is using the book.`,
        ),
      );
    }
    if (inspection.kind === "active") {
      return fail(
        storageError(
          `The book is locked by PID ${inspection.owner.pid} on ${inspection.owner.hostname}; the mutation did not run`,
          "Retry after that process finishes.",
        ),
      );
    }
    try {
      const quarantine = join(dataHome, `.${LOCK_DIRECTORY}.stale-${randomUUID()}`);
      renameSync(lockPath, quarantine);
      rmSync(quarantine, { recursive: true, force: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown filesystem error";
      return fail(
        storageError(
          `Could not reclaim the stale book lock: ${detail}; the mutation did not run`,
          `Inspect ${lockPath} and retry after confirming the owner is dead.`,
        ),
      );
    }
  }

  return fail(
    storageError(
      "The book lock changed while a stale owner was being reclaimed; the mutation did not run",
      `Inspect ${lockPath} and retry after confirming no finbook process is using the book.`,
    ),
  );
}

function releaseBookLock(dataHome: string, token: string): Result<void> {
  const lockPath = join(dataHome, LOCK_DIRECTORY);
  const owner = readLockOwner(lockPath);
  if (!owner.ok) {
    return fail(
      storageError(
        `Could not verify the book lock during release: ${owner.error}; the mutation may have committed`,
        `Inspect ${lockPath} before retrying.`,
      ),
    );
  }
  if (owner.data.token !== token) {
    return fail(
      storageError(
        "The book lock changed during release; the mutation may have committed",
        `Inspect ${lockPath} before retrying.`,
      ),
    );
  }
  try {
    rmSync(lockPath, { recursive: true, force: false });
    return succeed(undefined);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown filesystem error";
    return fail(
      storageError(
        `Could not release the book lock: ${detail}; the mutation may have committed`,
        `Inspect ${lockPath} before retrying.`,
      ),
    );
  }
}

function ensureDataDirectory(dataHome: string): void {
  mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dataHome, 0o700);
}

type LockOwnerResult = { ok: true; data: LockOwner } | { ok: false; error: string };

function readLockOwner(lockPath: string): LockOwnerResult {
  try {
    const parsed = LockOwnerSchema.safeParse(
      JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")),
    );
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, error: "the owner record is malformed" };
  } catch {
    return {
      ok: false,
      error: existsSync(lockPath)
        ? "the owner record is missing or unreadable"
        : "the lock disappeared",
    };
  }
}

function processIsAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) return undefined;
    if (!isErrnoException(error)) return undefined;
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return undefined;
  }
}

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}

function isAlreadyExists(error: Error): boolean {
  return isErrnoException(error) && error.code === "EEXIST";
}

function storageError(message: string, hint: string): DomainError {
  return { type: "storage", message, hint };
}
