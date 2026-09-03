import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  inspectBookLock,
  getGlance,
  type BookLockInspection,
  type DomainError,
  type FileBookStore,
} from "@finbook/core";
import type { MarketDataConfigStore } from "@finbook/market-data";

export type DoctorCheckId =
  | "book"
  | "schema"
  | "replay"
  | "market-config"
  | "permissions"
  | "lock"
  | "valuation";

export type DoctorStatus = "ok" | "warning" | "error";

export type DoctorCheck = {
  id: DoctorCheckId;
  status: DoctorStatus;
  message: string;
  hint?: string;
};

export type DoctorReport = {
  status: DoctorStatus;
  schemaVersion: number | null;
  eventCount: number;
  holeCount: number;
  dataPath: string;
  checks: readonly DoctorCheck[];
};

const BOOK_FILES = [
  "meta.json",
  "accounts.json",
  "instruments.json",
  "events.jsonl",
  "prices.jsonl",
  "fx.jsonl",
] as const;

export function inspectDoctor(
  store: FileBookStore,
  marketConfig: MarketDataConfigStore,
  asOf: string,
): DoctorReport {
  const checks: DoctorCheck[] = [];
  let schemaVersion: number | null = null;
  let eventCount = 0;
  let holeCount = 0;

  const book = store.inspect();
  if (!book.ok) {
    checks.push(failedCheck("schema", book.error));
  } else if (!book.data.initialized) {
    checks.push(okCheck("book", "Book is not initialized; there is no local data to validate."));
  } else {
    schemaVersion = book.data.schemaVersion;
    eventCount = book.data.snapshot.events.length;
    checks.push(
      okCheck("book", "Book files are present."),
      okCheck("schema", "Book files match the supported schemas."),
    );
    if (!book.data.replay.ok) {
      checks.push(failedCheck("replay", book.data.replay.error));
    } else {
      checks.push(okCheck("replay", "The complete event ledger replays successfully."));
      const glance = getGlance(book.data.snapshot, asOf);
      if (!glance.ok) {
        checks.push(failedCheck("valuation", glance.error));
      } else {
        holeCount = glance.data.holes.length;
        checks.push(
          holeCount === 0
            ? okCheck("valuation", `Valuation as of ${asOf} is complete.`)
            : {
                id: "valuation",
                status: "warning",
                message: `${String(holeCount)} valuation ${holeCount === 1 ? "hole" : "holes"} as of ${asOf}.`,
                hint: "Run a glance or positions view to see each missing observation and remedy.",
              },
        );
      }
    }
  }

  const config = marketConfig.inspect();
  checks.push(
    config.ok
      ? okCheck(
          "market-config",
          config.data.exists
            ? "Market-data configuration is valid."
            : "No market-data configuration is stored; defaults apply.",
        )
      : failedCheck("market-config", config.error),
  );
  checks.push(permissionCheck(store.dataHome));
  checks.push(lockCheck(inspectBookLock(store.dataHome)));

  return {
    status: overallStatus(checks),
    schemaVersion,
    eventCount,
    holeCount,
    dataPath: store.dataHome,
    checks,
  };
}

export function doctorError(report: DoctorReport): DomainError {
  return {
    type: "storage",
    message: "Book health check failed.",
    hint: "Review the failed doctor checks and correct the local files before retrying.",
    details: { report },
  };
}

function permissionCheck(dataHome: string): DoctorCheck {
  if (process.platform === "win32") {
    return okCheck("permissions", "POSIX owner-only modes do not apply on this platform.");
  }
  if (!existsSync(dataHome)) {
    return okCheck("permissions", "No data directory exists yet.");
  }

  try {
    const unsafe: string[] = [];
    recordUnsafeMode(unsafe, dataHome, 0o700);
    for (const name of [...BOOK_FILES, "market-data.json"] as const) {
      const path = join(dataHome, name);
      if (existsSync(path)) recordUnsafeMode(unsafe, path, 0o600);
    }
    const lockPath = join(dataHome, ".finbook.lock");
    if (existsSync(lockPath)) {
      recordUnsafeMode(unsafe, lockPath, 0o700);
      const ownerPath = join(lockPath, "owner.json");
      if (existsSync(ownerPath)) recordUnsafeMode(unsafe, ownerPath, 0o600);
    }
    return unsafe.length === 0
      ? okCheck("permissions", "Existing finbook paths are owner-only.")
      : {
          id: "permissions",
          status: "error",
          message: `Unsafe permissions: ${unsafe.join(", ")}.`,
          hint: "Restrict the data directory to 0700 and finbook files to 0600.",
        };
  } catch (error) {
    return {
      id: "permissions",
      status: "error",
      message: `Could not inspect permissions: ${error instanceof Error ? error.message : "unknown filesystem error"}.`,
      hint: "Check FINBOOK_HOME and its permissions.",
    };
  }
}

function recordUnsafeMode(unsafe: string[], path: string, expected: number): void {
  const actual = statSync(path).mode & 0o777;
  if (actual !== expected) {
    unsafe.push(`${basename(path)} is ${actual.toString(8).padStart(3, "0")}`);
  }
}

function lockCheck(lock: BookLockInspection): DoctorCheck {
  if (lock.kind === "absent") return okCheck("lock", "No book lock is present.");
  if (lock.kind === "active") {
    return {
      id: "lock",
      status: "warning",
      message: `Book is in use by PID ${String(lock.owner.pid)} on ${lock.owner.hostname}.`,
      hint: "Retry after that process finishes.",
    };
  }
  if (lock.kind === "stale") {
    return {
      id: "lock",
      status: "warning",
      message: `Book has a stale lock from PID ${String(lock.owner.pid)} on ${lock.owner.hostname}.`,
      hint: "Retry a normal finbook command to reclaim the stale lock safely.",
    };
  }
  return {
    id: "lock",
    status: "error",
    message: `Book lock ownership is uncertain: ${lock.reason}.`,
    hint: "Remove the lock only after confirming no finbook process is using the book.",
  };
}

function okCheck(id: DoctorCheckId, message: string): DoctorCheck {
  return { id, status: "ok", message };
}

function failedCheck(id: DoctorCheckId, error: DomainError): DoctorCheck {
  return { id, status: "error", message: error.message, hint: error.hint };
}

function overallStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}
