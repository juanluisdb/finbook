import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import { CURRENT_SCHEMA_VERSION } from "../version.js";
import { apply } from "./apply.js";
import { withBookLock } from "./lock.js";
import { orderEvents } from "./replay.js";
import { fail, succeed, type DomainError, type Result } from "./result.js";
import { createInitialState } from "./state.js";
import {
  AccountSchema,
  EventSchema,
  FxStampSchema,
  InstrumentSchema,
  MetaSchema,
  PriceStampSchema,
  type Account,
  type Event,
  type FxStamp,
  type Instrument,
  type PriceStamp,
} from "./schemas.js";
import type { BookSnapshot } from "./snapshot.js";

const AccountsFileSchema = z.array(AccountSchema);
const InstrumentsFileSchema = z.array(InstrumentSchema);

const FILES = {
  meta: "meta.json",
  accounts: "accounts.json",
  instruments: "instruments.json",
  events: "events.jsonl",
  prices: "prices.jsonl",
  fx: "fx.jsonl",
} as const;

export class FileBookStore {
  readonly dataHome: string;

  constructor(dataHome: string) {
    this.dataHome = dataHome;
  }

  load(): Result<BookSnapshot> {
    return withBookLock(this.dataHome, () => this.loadUnlocked());
  }

  appendAccount(account: Account): Result<void> {
    const parsed = AccountSchema.safeParse(account);
    if (!parsed.success) return fail(validationError(FILES.accounts, parsed.error));
    return withBookLock(this.dataHome, () => {
      const snapshot = this.loadUnlocked();
      if (!snapshot.ok) return fail(snapshot.error);
      if (snapshot.data.accounts.some((existing) => existing.id === parsed.data.id)) {
        return fail(
          invariantError(
            `Account ID already exists: ${parsed.data.id}.`,
            "Choose a new account ID.",
          ),
        );
      }
      const written = this.writeJson(FILES.accounts, [...snapshot.data.accounts, parsed.data]);
      if (!written.ok) return fail(written.error);
      return succeed(undefined);
    });
  }

  appendInstrument(instrument: Instrument): Result<void> {
    const parsed = InstrumentSchema.safeParse(instrument);
    if (!parsed.success) return fail(validationError(FILES.instruments, parsed.error));
    return withBookLock(this.dataHome, () => {
      const snapshot = this.loadUnlocked();
      if (!snapshot.ok) return fail(snapshot.error);
      if (snapshot.data.instruments.some((existing) => existing.id === parsed.data.id)) {
        return fail(
          invariantError(
            `Instrument ID already exists: ${parsed.data.id}.`,
            "Choose a new instrument ID.",
          ),
        );
      }
      const written = this.writeJson(FILES.instruments, [
        ...snapshot.data.instruments,
        parsed.data,
      ]);
      if (!written.ok) return fail(written.error);
      return succeed(undefined);
    });
  }

  appendEvent(event: Event): Result<Event> {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) return fail(validationError(FILES.events, parsed.error));
    return withBookLock(this.dataHome, () => {
      const snapshot = this.loadUnlocked();
      if (!snapshot.ok) return fail(snapshot.error);
      if (snapshot.data.events.some((existing) => existing.id === parsed.data.id)) {
        return fail(
          invariantError(`Event ID already exists: ${parsed.data.id}.`, "Choose a new event ID."),
        );
      }
      const duplicateEvent = duplicateExternalIdForEvent(snapshot.data.events, parsed.data);
      if (duplicateEvent !== undefined) return fail(duplicateEvent);
      const events = [...snapshot.data.events, parsed.data];
      const replayed = this.validateCandidate(snapshot.data, events, "append", parsed.data.id);
      if (!replayed.ok) return fail(replayed.error);
      const written = this.writeEvents(events);
      if (!written.ok) return fail(written.error);
      return succeed(parsed.data);
    });
  }

  replaceEvent(id: string, replacement: Event, expected: Event): Result<Event> {
    const parsed = EventSchema.safeParse(replacement);
    if (!parsed.success) return fail(validationError(FILES.events, parsed.error));
    const parsedExpected = EventSchema.safeParse(expected);
    if (!parsedExpected.success) return fail(validationError(FILES.events, parsedExpected.error));
    return withBookLock(this.dataHome, () => {
      const snapshot = this.loadUnlocked();
      if (!snapshot.ok) return fail(snapshot.error);
      const index = snapshot.data.events.findIndex((event) => event.id === id);
      if (index === -1) return fail(conflictError(id));
      const existing = snapshot.data.events[index];
      if (existing === undefined) return fail(notFoundError("event", id));
      if (!isDeepStrictEqual(existing, parsedExpected.data)) return fail(conflictError(id));
      if (parsed.data.id !== id || parsed.data.type !== existing.type) {
        return fail(
          invariantError(
            `Event replacement must keep ID ${id} and type ${existing.type}.`,
            "Use the matching event edit command or delete and add to change type.",
          ),
        );
      }
      if (
        parsed.data.source !== existing.source ||
        parsed.data.externalId !== existing.externalId
      ) {
        return fail(
          invariantError(
            `Event replacement must keep source and external ID for ${id}.`,
            "Keep immutable event identity fields unchanged.",
          ),
        );
      }
      const events = [...snapshot.data.events];
      events[index] = parsed.data;
      const replayed = this.validateCandidate(snapshot.data, events, "replace", id);
      if (!replayed.ok) return fail(replayed.error);
      const written = this.writeEvents(events);
      if (!written.ok) return fail(written.error);
      return succeed(parsed.data);
    });
  }

  deleteEvent(id: string): Result<Event> {
    return withBookLock(this.dataHome, () => {
      const snapshot = this.loadUnlocked();
      if (!snapshot.ok) return fail(snapshot.error);
      const index = snapshot.data.events.findIndex((event) => event.id === id);
      if (index === -1) return fail(notFoundError("event", id));
      const removed = snapshot.data.events[index];
      if (removed === undefined) return fail(notFoundError("event", id));
      const events = snapshot.data.events.filter((_event, eventIndex) => eventIndex !== index);
      const replayed = this.validateCandidate(snapshot.data, events, "delete", id);
      if (!replayed.ok) return fail(replayed.error);
      const written = this.writeEvents(events);
      if (!written.ok) return fail(written.error);
      return succeed(removed);
    });
  }

  appendPrice(stamp: PriceStamp): Result<void> {
    const parsed = PriceStampSchema.safeParse(stamp);
    if (!parsed.success) return fail(validationError(FILES.prices, parsed.error));
    return withBookLock(this.dataHome, () => {
      const snapshot = this.loadUnlocked();
      if (!snapshot.ok) return fail(snapshot.error);
      const instrument = snapshot.data.instruments.find(
        (candidate) => candidate.id === parsed.data.instrument,
      );
      if (instrument === undefined)
        return fail(notFoundError("instrument", parsed.data.instrument));
      if (instrument.quoteCurrency !== parsed.data.price.currency) {
        return fail(
          invariantError(
            `Price currency ${parsed.data.price.currency} does not match ${instrument.id} quote currency ${instrument.quoteCurrency}.`,
            "Use the instrument quote currency.",
          ),
        );
      }
      const written = this.appendJsonLine(FILES.prices, parsed.data);
      if (!written.ok) return fail(written.error);
      return succeed(undefined);
    });
  }

  appendFx(stamp: FxStamp): Result<void> {
    const parsed = FxStampSchema.safeParse(stamp);
    if (!parsed.success) return fail(validationError(FILES.fx, parsed.error));
    return withBookLock(this.dataHome, () => {
      const initialized = this.ensureInitialized();
      if (!initialized.ok) return fail(initialized.error);
      const written = this.appendJsonLine(FILES.fx, parsed.data);
      if (!written.ok) return fail(written.error);
      return succeed(undefined);
    });
  }

  private loadUnlocked(): Result<BookSnapshot> {
    const initialized = this.ensureInitialized();
    if (!initialized.ok) return fail(initialized.error);

    const meta = this.readJson(FILES.meta, MetaSchema);
    if (!meta.ok) return fail(meta.error);
    if (meta.data.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      return fail({
        type: "storage",
        message: `Unsupported book schema version: ${meta.data.schemaVersion}.`,
        hint: `This v1 build reads schema version ${CURRENT_SCHEMA_VERSION}.`,
      });
    }

    const accounts = this.readJson(FILES.accounts, AccountsFileSchema);
    if (!accounts.ok) return fail(accounts.error);
    const accountError = duplicateIdError("account", accounts.data);
    if (accountError !== undefined) return fail(accountError);

    const instruments = this.readJson(FILES.instruments, InstrumentsFileSchema);
    if (!instruments.ok) return fail(instruments.error);
    const instrumentError = duplicateIdError("instrument", instruments.data);
    if (instrumentError !== undefined) return fail(instrumentError);

    const events = this.readJsonLines(FILES.events, EventSchema);
    if (!events.ok) return fail(events.error);
    const duplicateEventId = duplicateIdError("event", events.data);
    if (duplicateEventId !== undefined) return fail(duplicateEventId);
    const duplicateEvent = duplicateExternalIdError(events.data);
    if (duplicateEvent !== undefined) return fail(duplicateEvent);

    const prices = this.readJsonLines(FILES.prices, PriceStampSchema);
    if (!prices.ok) return fail(prices.error);

    const fx = this.readJsonLines(FILES.fx, FxStampSchema);
    if (!fx.ok) return fail(fx.error);

    return succeed({
      accounts: accounts.data,
      instruments: instruments.data,
      events: events.data,
      prices: prices.data,
      fx: fx.data,
    });
  }

  private validateCandidate(
    snapshot: BookSnapshot,
    events: readonly Event[],
    mutation: "append" | "replace" | "delete",
    targetId: string,
  ): Result<void> {
    let state = createInitialState(snapshot.accounts, snapshot.instruments);
    for (const event of orderEvents(events)) {
      const result = apply(state, event);
      if (!result.ok) return fail(mutationError(mutation, targetId, event, result.error));
      state = result.data;
    }
    return succeed(undefined);
  }

  private ensureInitialized(): Result<void> {
    try {
      mkdirSync(this.dataHome, { recursive: true, mode: 0o700 });
      this.setOwnerOnly(this.dataHome, 0o700);
      const meta = this.ensureJsonFile(FILES.meta, { schemaVersion: CURRENT_SCHEMA_VERSION });
      if (!meta.ok) return fail(meta.error);
      const accounts = this.ensureJsonFile(FILES.accounts, []);
      if (!accounts.ok) return fail(accounts.error);
      const instruments = this.ensureJsonFile(FILES.instruments, []);
      if (!instruments.ok) return fail(instruments.error);
      this.ensureLineFile(FILES.events);
      this.ensureLineFile(FILES.prices);
      this.ensureLineFile(FILES.fx);
      return succeed(undefined);
    } catch (error) {
      if (!(error instanceof Error) || !isFileSystemError(error)) throw error;
      return fail(
        storageException(
          this.dataHome,
          error instanceof Error ? error.message : "unknown filesystem error",
        ),
      );
    }
  }

  private ensureJsonFile<T>(name: string, value: T): Result<void> {
    const path = join(this.dataHome, name);
    if (existsSync(path)) {
      this.setOwnerOnly(path);
      return succeed(undefined);
    }
    return this.writeJson(name, value);
  }

  private ensureLineFile(name: string): void {
    const path = join(this.dataHome, name);
    if (!existsSync(path)) writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
    this.setOwnerOnly(path);
  }

  private readJson<T>(name: string, schema: z.ZodType<T>): Result<T> {
    const path = join(this.dataHome, name);
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      const parsed = schema.safeParse(value);
      return parsed.success ? succeed(parsed.data) : fail(validationError(name, parsed.error));
    } catch (error) {
      return fail(
        storageException(name, error instanceof Error ? error.message : "unknown filesystem error"),
      );
    }
  }

  private readJsonLines<T>(name: string, schema: z.ZodType<T>): Result<T[]> {
    const path = join(this.dataHome, name);
    try {
      const lines = readFileSync(path, "utf8").split(/\r?\n/u);
      const values: T[] = [];
      for (const [index, line] of lines.entries()) {
        if (index === lines.length - 1 && line === "") continue;
        if (line.trim() === "") {
          return fail(storageLineError(name, index + 1, "empty JSONL line"));
        }
        let value: T;
        try {
          const parsed = schema.safeParse(JSON.parse(line));
          if (!parsed.success) return fail(validationError(`${name}:${index + 1}`, parsed.error));
          value = parsed.data;
        } catch {
          return fail(storageLineError(name, index + 1, "invalid JSON"));
        }
        values.push(value);
      }
      return succeed(values);
    } catch (error) {
      return fail(
        storageException(name, error instanceof Error ? error.message : "unknown filesystem error"),
      );
    }
  }

  private writeJson<T>(name: string, value: T): Result<void> {
    const target = join(this.dataHome, name);
    const temporary = join(this.dataHome, `.${basename(name)}.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    let failure: DomainError | undefined;
    let thrown = false;
    let thrownError: unknown;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.setOwnerOnly(temporary);
      renameSync(temporary, target);
      renamed = true;
      this.setOwnerOnly(target);
    } catch (error) {
      if (!(error instanceof Error) || !isFileSystemError(error)) {
        thrown = true;
        thrownError = error;
      } else {
        failure = storageWriteError(name, error.message, renamed);
      }
    }
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch (error) {
      if (!(error instanceof Error) || !isFileSystemError(error)) {
        if (!thrown) {
          thrown = true;
          thrownError = error;
        }
      } else if (failure === undefined) {
        failure = storageWriteError(name, error.message, renamed);
      }
    }
    if (thrown) throw thrownError;
    return failure === undefined ? succeed(undefined) : fail(failure);
  }

  private writeEvents(events: readonly Event[]): Result<void> {
    const target = join(this.dataHome, FILES.events);
    const temporary = join(
      this.dataHome,
      `.${basename(FILES.events)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let renamed = false;
    let failure: DomainError | undefined;
    let thrown = false;
    let thrownError: unknown;
    try {
      const content =
        events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
      this.setOwnerOnly(temporary, 0o600);
      renameSync(temporary, target);
      renamed = true;
      this.setOwnerOnly(target, 0o600);
    } catch (error) {
      if (!(error instanceof Error) || !isFileSystemError(error)) {
        thrown = true;
        thrownError = error;
      } else {
        failure = storageWriteError(FILES.events, error.message, renamed);
      }
    }
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch (error) {
      if (!(error instanceof Error) || !isFileSystemError(error)) {
        if (!thrown) {
          thrown = true;
          thrownError = error;
        }
      } else if (failure === undefined) {
        failure = storageWriteError(FILES.events, error.message, renamed);
      }
    }
    if (thrown) throw thrownError;
    return failure === undefined ? succeed(undefined) : fail(failure);
  }

  private appendJsonLine<T>(name: string, value: T): Result<void> {
    const path = join(this.dataHome, name);
    try {
      writeFileSync(path, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
      this.setOwnerOnly(path);
      return succeed(undefined);
    } catch (error) {
      if (!(error instanceof Error) || !isFileSystemError(error)) throw error;
      return fail(storageWriteError(name, error.message, true));
    }
  }

  private setOwnerOnly(path: string, mode = 0o600): void {
    if (process.platform !== "win32") chmodSync(path, mode);
  }
}

function duplicateIdError<T extends { id: string }>(
  kind: string,
  values: readonly T[],
): DomainError | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      return storageError(`Duplicate ${kind} ID in book: ${value.id}.`);
    }
    seen.add(value.id);
  }
  return undefined;
}

function duplicateExternalIdError(events: readonly Event[]): DomainError | undefined {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.externalId === undefined) continue;
    const key = `${event.source}\u0000${event.externalId}`;
    if (seen.has(key)) {
      return storageError(
        `Duplicate event source and external ID in book: ${event.source}/${event.externalId}.`,
      );
    }
    seen.add(key);
  }
  return undefined;
}

function duplicateExternalIdForEvent(
  events: readonly Event[],
  candidate: Event,
): DomainError | undefined {
  if (
    candidate.externalId !== undefined &&
    events.some(
      (event) => event.source === candidate.source && event.externalId === candidate.externalId,
    )
  ) {
    return invariantError(
      `Event source and external ID already exist: ${candidate.source}/${candidate.externalId}.`,
      "Use a new external ID or omit it for a manual event.",
    );
  }
  return undefined;
}

function validationError(location: string, error: z.ZodError): DomainError {
  const issue = error.issues[0];
  const detail = issue === undefined ? "invalid value" : issue.message;
  return {
    type: "validation",
    message: `Invalid data in ${location}: ${detail}.`,
    hint: "Fix the stored value or provide a valid object.",
  };
}

function storageLineError(name: string, line: number, reason: string): DomainError {
  return storageError(`${name}:${line}: ${reason}.`);
}

function storageException(location: string, detail: string): DomainError {
  return storageError(`Could not access ${location}: ${detail}.`);
}

function storageWriteError(
  location: string,
  detail: string,
  mayHaveCommitted: boolean,
): DomainError {
  return storageError(
    `Could not write ${location}: ${detail}; ${mayHaveCommitted ? "the mutation may have committed" : "no changes were written"}.`,
  );
}

function mutationError(
  mutation: "append" | "replace" | "delete",
  targetId: string,
  blockingEvent: Event,
  cause: DomainError,
): DomainError {
  const verb = mutation === "append" ? "append" : mutation === "replace" ? "replace" : "delete";
  return {
    type: cause.type,
    message: `Cannot ${verb} event ${targetId}: ${cause.message} Blocking event ${blockingEvent.id} (${blockingEvent.type}) on ${blockingEvent.date}; no changes were written.`,
    hint: "Correct the event mutation and retry.",
    details: {
      mutation: { kind: mutation, target: targetId },
      blockingEvent: {
        id: blockingEvent.id,
        type: blockingEvent.type,
        date: blockingEvent.date,
      },
    },
  };
}

function storageError(message: string): DomainError {
  return { type: "storage", message, hint: "Check FINBOOK_HOME and the book files." };
}

function invariantError(message: string, hint: string): DomainError {
  return { type: "invariant", message, hint };
}

function conflictError(id: string): DomainError {
  return {
    type: "conflict",
    message: `Event ${id} changed while preparing this edit.`,
    hint: "Reload the event and retry the edit.",
    details: { eventId: id },
  };
}

function notFoundError(kind: string, id: string): DomainError {
  return {
    type: "not-found",
    message: `Unknown ${kind} ID: ${id}.`,
    hint: `Add or select an existing ${kind}.`,
  };
}

function isFileSystemError(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}
