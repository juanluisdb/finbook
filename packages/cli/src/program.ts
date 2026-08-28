import { randomUUID } from "node:crypto";

import {
  FileBookStore,
  getGlance,
  getPositions,
  type Account,
  type BookSnapshot,
  type Breakdown,
  type CashPosition,
  type Event,
  type FxStamp,
  type Glance,
  type Instrument,
  type Position,
  type PriceStamp,
} from "@finbook/core";
import { Command } from "commander";

import { requireDate } from "./dates.js";
import { notFoundFailure, requireResult, validationFailure } from "./errors.js";
import { createDoctor, type DoctorSummary } from "./doctor.js";
import { formatMoney, formatRows, writeSuccess } from "./output.js";
import { addAccount, addEvent, addInstrument, setFx, setPrice } from "./writes.js";

export function createProgram(
  dataHome: string,
  defaultDate: string,
  generateId: () => string = randomUUID,
): Command {
  const store = new FileBookStore(dataHome);
  const program = new Command()
    .name("finbook")
    .description("A local book of economic events")
    .option("--json", "return the stable JSON envelope");

  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: () => undefined,
  });

  const doctor = program.command("doctor").description("report book health");
  addJsonOption(doctor);
  doctor.action((_options, command) => showDoctor(store, jsonMode(command), defaultDate));

  const account = program.command("account").description("manage accounts");
  const accountAdd = account.command("add").description("add an account");
  accountAdd
    .requiredOption("--id <id>", "account ID")
    .requiredOption("--name <name>", "account name")
    .requiredOption("--platform <platform>", "custodian platform")
    .requiredOption("--country <code>", "custody country")
    .requiredOption("--custodial <kind>", "custodial kind: broker, crypto-exchange, or cash");
  addJsonOption(accountAdd);
  accountAdd.action((_options, command) => addAccount(store, command.opts(), jsonMode(command)));
  const accountList = account.command("list").description("list accounts");
  addJsonOption(accountList);
  accountList.action((_options, command) => listAccounts(store, jsonMode(command)));
  const accountGet = account.command("get <id>").description("get one account");
  addJsonOption(accountGet);
  accountGet.action((id, _options, command) => getAccount(store, id, jsonMode(command)));

  const instrument = program.command("instrument").description("manage instruments");
  const instrumentAdd = instrument.command("add").description("add an instrument");
  instrumentAdd
    .requiredOption("--id <id>", "instrument ID")
    .requiredOption("--name <name>", "instrument name")
    .requiredOption("--type <type>", "instrument type: stock, etf, fund, or crypto")
    .requiredOption("--quote-currency <code>", "instrument quote currency")
    .option("--isin <isin>", "ISIN");
  addJsonOption(instrumentAdd);
  instrumentAdd.action((_options, command) =>
    addInstrument(store, command.opts(), jsonMode(command)),
  );
  const instrumentList = instrument.command("list").description("list instruments");
  addJsonOption(instrumentList);
  instrumentList.action((_options, command) => listInstruments(store, jsonMode(command)));
  const instrumentGet = instrument.command("get <id>").description("get one instrument");
  addJsonOption(instrumentGet);
  instrumentGet.action((id, _options, command) => getInstrument(store, id, jsonMode(command)));

  const event = program.command("event").description("inspect events");
  const eventAdd = event.command("add [type]").description("add an event from flags or --file");
  addEventOptions(eventAdd);
  addJsonOption(eventAdd);
  eventAdd.action((type, _options, command) =>
    addEvent(store, type, command.opts(), jsonMode(command), generateId),
  );
  const eventList = event.command("list").description("list events");
  eventList
    .option("--account <id>", "filter by account")
    .option("--from <date>", "inclusive start date")
    .option("--to <date>", "inclusive end date");
  addJsonOption(eventList);
  eventList.action((_options, command) =>
    listEvents(store, command.opts(), jsonMode(command), defaultDate),
  );
  const eventGet = event.command("get <id>").description("get one event");
  addJsonOption(eventGet);
  eventGet.action((id, _options, command) => getEvent(store, id, jsonMode(command)));

  const price = program.command("price").description("manage price stamps");
  const priceSet = price.command("set").description("append a price stamp");
  priceSet
    .requiredOption("--instrument <id>", "instrument ID")
    .requiredOption("--amount <decimal>", "price amount")
    .requiredOption("--currency <code>", "price currency")
    .requiredOption("--as-of <date>", "price date");
  addJsonOption(priceSet);
  priceSet.action((_options, command) => setPrice(store, command.opts(), jsonMode(command)));
  const priceList = price.command("list").description("list price stamps");
  addJsonOption(priceList);
  priceList.action((_options, command) => listPrices(store, jsonMode(command)));

  const fx = program.command("fx").description("manage FX stamps");
  const fxSet = fx.command("set").description("append an FX stamp");
  fxSet
    .requiredOption("--pair <pair>", "currency/EUR pair")
    .requiredOption("--rate <decimal>", "EUR per unit")
    .requiredOption("--as-of <date>", "rate date");
  addJsonOption(fxSet);
  fxSet.action((_options, command) => setFx(store, command.opts(), jsonMode(command)));
  const fxList = fx.command("list").description("list FX stamps");
  addJsonOption(fxList);
  fxList.action((_options, command) => listFx(store, jsonMode(command)));

  const show = program.command("show").description("show derived views");
  const glance = show.command("glance").description("show the portfolio glance");
  glance.option("--as-of <date>", "valuation date");
  addJsonOption(glance);
  glance.action((_options, command) =>
    showGlance(store, command.opts(), jsonMode(command), defaultDate),
  );
  const positions = show.command("positions").description("show current positions");
  positions.option("--as-of <date>", "valuation date");
  addJsonOption(positions);
  positions.action((_options, command) =>
    showPositions(store, command.opts(), jsonMode(command), defaultDate),
  );

  return program;
}

type JsonOptions = {
  json?: boolean | undefined;
};

type EventListOptions = JsonOptions & {
  account?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

type AsOfOptions = JsonOptions & {
  asOf?: string | undefined;
};

function addEventOptions(command: Command): void {
  command
    .option("--file <path>", "read one canonical event object")
    .option("--id <id>", "event ID; generated when omitted")
    .option("--date <date>", "event date")
    .option("--source <source>", "event source; defaults to manual")
    .option("--external-id <id>", "source-specific idempotency ID")
    .option("--note <text>", "event note")
    .option("--account <id>", "account ID")
    .option("--from <id>", "source account or amount, depending on event type")
    .option("--to <id>", "destination account or amount, depending on event type")
    .option("--amount <decimal>", "amount")
    .option("--currency <code>", "currency")
    .option("--from-amount <decimal>", "FX source amount")
    .option("--from-currency <code>", "FX source currency")
    .option("--to-amount <decimal>", "FX destination amount")
    .option("--to-currency <code>", "FX destination currency")
    .option("--fee-amount <decimal>", "trade or FX fee amount")
    .option("--fee-currency <code>", "trade or FX fee currency")
    .option("--instrument <id>", "instrument ID")
    .option("--qty <decimal>", "quantity")
    .option("--price-amount <decimal>", "trade price amount")
    .option("--price-currency <code>", "trade price currency")
    .option("--gross-amount <decimal>", "gross income amount")
    .option("--gross-currency <code>", "gross income currency")
    .option("--withholding-foreign-amount <decimal>", "foreign withholding")
    .option("--withholding-domestic-amount <decimal>", "domestic withholding")
    .option("--eur-per-unit <decimal>", "historical EUR per unit rate");
}

function addJsonOption(command: Command): void {
  command.option("--json", "return the stable JSON envelope");
}

function jsonMode(command: Command): boolean {
  return command.optsWithGlobals().json === true;
}

function loadSnapshot(store: FileBookStore): BookSnapshot {
  return requireResult(store.load());
}

function showDoctor(store: FileBookStore, json: boolean, defaultDate: string): void {
  const snapshot = loadSnapshot(store);
  const glance = requireResult(getGlance(snapshot, defaultDate));
  const data = createDoctor(store.dataHome, snapshot.events.length, glance.holes.length);
  writeSuccess(data, json, renderDoctor(data));
}

function listAccounts(store: FileBookStore, json: boolean): void {
  const accounts = loadSnapshot(store).accounts;
  writeSuccess(accounts, json, renderAccounts(accounts));
}

function getAccount(store: FileBookStore, id: string, json: boolean): void {
  const account = loadSnapshot(store).accounts.find((candidate) => candidate.id === id);
  if (account === undefined) throw notFoundFailure("account", id);
  writeSuccess(account, json, renderAccounts([account]));
}

function listInstruments(store: FileBookStore, json: boolean): void {
  const instruments = loadSnapshot(store).instruments;
  writeSuccess(instruments, json, renderInstruments(instruments));
}

function getInstrument(store: FileBookStore, id: string, json: boolean): void {
  const instrument = loadSnapshot(store).instruments.find((candidate) => candidate.id === id);
  if (instrument === undefined) throw notFoundFailure("instrument", id);
  writeSuccess(instrument, json, renderInstruments([instrument]));
}

function listEvents(
  store: FileBookStore,
  options: EventListOptions,
  json: boolean,
  defaultDate: string,
): void {
  const snapshot = loadSnapshot(store);
  if (
    options.account !== undefined &&
    !snapshot.accounts.some((account) => account.id === options.account)
  ) {
    throw notFoundFailure("account", options.account);
  }
  const from =
    options.from === undefined ? undefined : requireDate(options.from, "--from", defaultDate);
  const to = options.to === undefined ? undefined : requireDate(options.to, "--to", defaultDate);
  if (from !== undefined && to !== undefined && from > to) {
    throw validationFailure(
      "The `--from` date must not be after `--to`.",
      "Swap the date range values.",
    );
  }
  const events = snapshot.events.filter((event) => {
    if (options.account !== undefined && !eventBelongsToAccount(event, options.account))
      return false;
    if (from !== undefined && event.date < from) return false;
    if (to !== undefined && event.date > to) return false;
    return true;
  });
  writeSuccess(events, json, renderEvents(events));
}

function getEvent(store: FileBookStore, id: string, json: boolean): void {
  const event = loadSnapshot(store).events.find((candidate) => candidate.id === id);
  if (event === undefined) throw notFoundFailure("event", id);
  writeSuccess(event, json, renderEvents([event]));
}

function listPrices(store: FileBookStore, json: boolean): void {
  const prices = loadSnapshot(store).prices;
  writeSuccess(prices, json, renderPrices(prices));
}

function listFx(store: FileBookStore, json: boolean): void {
  const fx = loadSnapshot(store).fx;
  writeSuccess(fx, json, renderFx(fx));
}

function showGlance(
  store: FileBookStore,
  options: AsOfOptions,
  json: boolean,
  defaultDate: string,
): void {
  const asOf = requireDate(options.asOf, "--as-of", defaultDate);
  const glance = requireResult(getGlance(loadSnapshot(store), asOf));
  writeSuccess(glance, json, renderGlance(glance));
}

function showPositions(
  store: FileBookStore,
  options: AsOfOptions,
  json: boolean,
  defaultDate: string,
): void {
  const asOf = requireDate(options.asOf, "--as-of", defaultDate);
  const positions = requireResult(getPositions(loadSnapshot(store), asOf));
  writeSuccess(positions, json, renderPositions(positions.positions, positions.cash));
}

function eventBelongsToAccount(event: Event, accountId: string): boolean {
  return event.type === "transfer"
    ? event.from === accountId || event.to === accountId
    : event.account === accountId;
}

function renderDoctor(data: DoctorSummary): string {
  return formatRows(
    ["FIELD", "VALUE"],
    [
      ["schema version", String(data.schemaVersion)],
      ["events", String(data.eventCount)],
      ["holes", String(data.holeCount)],
      ["data path", data.dataPath],
    ],
  );
}

function renderAccounts(accounts: readonly Account[]): string {
  return formatRows(
    ["ID", "NAME", "PLATFORM", "COUNTRY", "CUSTODIAL"],
    accounts.map((account) => [
      account.id,
      account.name,
      account.platform,
      account.country,
      account.custodial,
    ]),
  );
}

function renderInstruments(instruments: readonly Instrument[]): string {
  return formatRows(
    ["ID", "NAME", "TYPE", "QUOTE", "ISIN"],
    instruments.map((instrument) => [
      instrument.id,
      instrument.name,
      instrument.type,
      instrument.quoteCurrency,
      instrument.isin ?? "",
    ]),
  );
}

function renderEvents(events: readonly Event[]): string {
  return formatRows(
    ["DATE", "TYPE", "ID", "ACCOUNT"],
    events.map((event) => [event.date, event.type, event.id, eventAccount(event)]),
  );
}

function renderPrices(prices: readonly PriceStamp[]): string {
  return formatRows(
    ["AS OF", "INSTRUMENT", "PRICE"],
    prices.map((stamp) => [stamp.asOf, stamp.instrument, formatMoney(stamp.price)]),
  );
}

function renderFx(stamps: readonly FxStamp[]): string {
  return formatRows(
    ["AS OF", "PAIR", "RATE"],
    stamps.map((stamp) => [stamp.asOf, stamp.pair, stamp.rate]),
  );
}

function renderGlance(glance: Glance): string {
  return [
    `as of: ${glance.asOf}`,
    `total: ${formatMoney(glance.totalEur)}`,
    `contributed: ${formatMoney(glance.contributedEur)}`,
    `pnl: ${formatMoney(glance.pnlEur)}`,
    `holes: ${String(glance.holes.length)}`,
    "",
    "by platform",
    formatBreakdowns(glance.byPlatform),
    "",
    "by asset type",
    formatBreakdowns(glance.byAssetType),
    "",
    "by currency",
    formatBreakdowns(glance.byCurrency),
  ].join("\n");
}

function renderPositions(positions: readonly Position[], cash: readonly CashPosition[]): string {
  return [
    "positions",
    formatRows(
      ["ACCOUNT", "INSTRUMENT", "QUANTITY", "COST", "VALUE EUR"],
      positions.map((position) => [
        position.account,
        position.instrument,
        position.quantity,
        formatMoney(position.cost),
        formatMoney(position.valueEur),
      ]),
    ),
    "",
    "cash",
    formatRows(
      ["ACCOUNT", "CURRENCY", "BALANCE", "VALUE EUR"],
      cash.map((entry) => [
        entry.account,
        entry.currency,
        formatMoney(entry.balance),
        formatMoney(entry.valueEur),
      ]),
    ),
  ].join("\n");
}

function formatBreakdowns(rows: readonly Breakdown[]): string {
  return formatRows(
    ["KEY", "VALUE EUR", "WEIGHT"],
    rows.map((row) => [row.key, formatMoney(row.valueEur), row.weight ?? "unknown"]),
  );
}

function eventAccount(event: Event): string {
  return event.type === "transfer" ? `${event.from} → ${event.to}` : event.account;
}
