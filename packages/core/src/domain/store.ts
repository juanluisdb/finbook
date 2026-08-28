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
import { fail, succeed, type DomainError, type Result } from "./result.js";
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

  appendAccount(account: Account): Result<void> {
    const parsed = AccountSchema.safeParse(account);
    if (!parsed.success) return fail(validationError(FILES.accounts, parsed.error));
    const snapshot = this.load();
    if (!snapshot.ok) return fail(snapshot.error);
    if (snapshot.data.accounts.some((existing) => existing.id === parsed.data.id)) {
      return fail(
        invariantError(`Account ID already exists: ${parsed.data.id}.`, "Choose a new account ID."),
      );
    }
    try {
      this.writeJson(FILES.accounts, [...snapshot.data.accounts, parsed.data]);
      return succeed(undefined);
    } catch (error) {
      return fail(
        storageException(
          FILES.accounts,
          error instanceof Error ? error.message : "unknown filesystem error",
        ),
      );
    }
  }

  appendInstrument(instrument: Instrument): Result<void> {
    const parsed = InstrumentSchema.safeParse(instrument);
    if (!parsed.success) return fail(validationError(FILES.instruments, parsed.error));
    const snapshot = this.load();
    if (!snapshot.ok) return fail(snapshot.error);
    if (snapshot.data.instruments.some((existing) => existing.id === parsed.data.id)) {
      return fail(
        invariantError(
          `Instrument ID already exists: ${parsed.data.id}.`,
          "Choose a new instrument ID.",
        ),
      );
    }
    try {
      this.writeJson(FILES.instruments, [...snapshot.data.instruments, parsed.data]);
      return succeed(undefined);
    } catch (error) {
      return fail(
        storageException(
          FILES.instruments,
          error instanceof Error ? error.message : "unknown filesystem error",
        ),
      );
    }
  }

  appendEvent(event: Event): Result<void> {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) return fail(validationError(FILES.events, parsed.error));
    const snapshot = this.load();
    if (!snapshot.ok) return fail(snapshot.error);
    if (snapshot.data.events.some((existing) => existing.id === parsed.data.id)) {
      return fail(
        invariantError(`Event ID already exists: ${parsed.data.id}.`, "Choose a new event ID."),
      );
    }
    if (
      parsed.data.externalId !== undefined &&
      snapshot.data.events.some(
        (existing) =>
          existing.source === parsed.data.source && existing.externalId === parsed.data.externalId,
      )
    ) {
      return fail(
        invariantError(
          `Event source and external ID already exist: ${parsed.data.source}/${parsed.data.externalId}.`,
          "Use a new external ID or omit it for a manual event.",
        ),
      );
    }
    try {
      this.appendJsonLine(FILES.events, parsed.data);
      return succeed(undefined);
    } catch (error) {
      return fail(
        storageException(
          FILES.events,
          error instanceof Error ? error.message : "unknown filesystem error",
        ),
      );
    }
  }

  appendPrice(stamp: PriceStamp): Result<void> {
    const parsed = PriceStampSchema.safeParse(stamp);
    if (!parsed.success) return fail(validationError(FILES.prices, parsed.error));
    const snapshot = this.load();
    if (!snapshot.ok) return fail(snapshot.error);
    const instrument = snapshot.data.instruments.find(
      (candidate) => candidate.id === parsed.data.instrument,
    );
    if (instrument === undefined) {
      return fail(notFoundError("instrument", parsed.data.instrument));
    }
    if (instrument.quoteCurrency !== parsed.data.price.currency) {
      return fail(
        invariantError(
          `Price currency ${parsed.data.price.currency} does not match ${instrument.id} quote currency ${instrument.quoteCurrency}.`,
          "Use the instrument quote currency.",
        ),
      );
    }
    try {
      this.appendJsonLine(FILES.prices, parsed.data);
      return succeed(undefined);
    } catch (error) {
      return fail(
        storageException(
          FILES.prices,
          error instanceof Error ? error.message : "unknown filesystem error",
        ),
      );
    }
  }

  appendFx(stamp: FxStamp): Result<void> {
    const parsed = FxStampSchema.safeParse(stamp);
    if (!parsed.success) return fail(validationError(FILES.fx, parsed.error));
    const initialized = this.ensureInitialized();
    if (!initialized.ok) return fail(initialized.error);
    try {
      this.appendJsonLine(FILES.fx, parsed.data);
      return succeed(undefined);
    } catch (error) {
      return fail(
        storageException(
          FILES.fx,
          error instanceof Error ? error.message : "unknown filesystem error",
        ),
      );
    }
  }

  private ensureInitialized(): Result<void> {
    try {
      mkdirSync(this.dataHome, { recursive: true, mode: 0o700 });
      this.ensureJsonFile(FILES.meta, { schemaVersion: CURRENT_SCHEMA_VERSION });
      this.ensureJsonFile(FILES.accounts, []);
      this.ensureJsonFile(FILES.instruments, []);
      this.ensureLineFile(FILES.events);
      this.ensureLineFile(FILES.prices);
      this.ensureLineFile(FILES.fx);
      return succeed(undefined);
    } catch (error) {
      return fail(
        storageException(
          this.dataHome,
          error instanceof Error ? error.message : "unknown filesystem error",
        ),
      );
    }
  }

  private ensureJsonFile<T>(name: string, value: T): void {
    const path = join(this.dataHome, name);
    if (existsSync(path)) {
      this.setOwnerOnly(path);
      return;
    }
    this.writeJson(name, value);
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

  private writeJson<T>(name: string, value: T): void {
    const target = join(this.dataHome, name);
    const temporary = join(this.dataHome, `.${basename(name)}.${process.pid}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.setOwnerOnly(temporary);
      renameSync(temporary, target);
      this.setOwnerOnly(target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private appendJsonLine<T>(name: string, value: T): void {
    const path = join(this.dataHome, name);
    writeFileSync(path, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    });
    this.setOwnerOnly(path);
  }

  private setOwnerOnly(path: string): void {
    chmodSync(path, 0o600);
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

function storageError(message: string): DomainError {
  return { type: "storage", message, hint: "Check FINBOOK_HOME and the book files." };
}

function invariantError(message: string, hint: string): DomainError {
  return { type: "invariant", message, hint };
}

function notFoundError(kind: string, id: string): DomainError {
  return {
    type: "not-found",
    message: `Unknown ${kind} ID: ${id}.`,
    hint: `Add or select an existing ${kind}.`,
  };
}
