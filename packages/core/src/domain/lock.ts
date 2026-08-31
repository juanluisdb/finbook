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

export function withBookLock<T>(dataHome: string, operation: () => Result<T>): Result<T> {
  const acquired = acquireBookLock(dataHome);
  if (!acquired.ok) return fail(acquired.error);

  let result: Result<T>;
  try {
    result = operation();
  } catch (error) {
    result = fail(
      storageError(
        `The local mutation failed${error instanceof Error ? `: ${error.message}` : ": unknown error"}; its commit status is uncertain`,
        "Inspect the book before retrying.",
      ),
    );
  }

  const released = releaseBookLock(dataHome, acquired.data);
  if (!released.ok) return fail(released.error);
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

    const owner = readLockOwner(lockPath);
    if (!owner.ok) {
      return fail(
        storageError(
          `The book lock is active or uncertain; ${owner.error}; the mutation did not run`,
          `Inspect ${lockPath} and remove it only after confirming no finbook process is using the book.`,
        ),
      );
    }
    if (owner.data.hostname !== hostname()) {
      return fail(
        storageError(
          `The book is locked by PID ${owner.data.pid} on ${owner.data.hostname}; the mutation did not run`,
          "Retry after that process finishes; inspect the lock manually if the other host is unavailable.",
        ),
      );
    }
    const alive = processIsAlive(owner.data.pid);
    if (alive === true) {
      return fail(
        storageError(
          `The book is locked by PID ${owner.data.pid} on ${owner.data.hostname}; the mutation did not run`,
          "Retry after that process finishes.",
        ),
      );
    }
    if (alive === undefined) {
      return fail(
        storageError(
          `The book lock owner PID ${owner.data.pid} could not be verified; the mutation did not run`,
          `Inspect ${lockPath} and remove it only after confirming no finbook process is using the book.`,
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
