import { randomUUID } from "node:crypto";

import {
  EventTypeSchema,
  FileBookStore,
  InstrumentIdSchema,
  NonEmptyStringSchema,
  getGlance,
  getPositions,
  type BookSnapshot,
  type Event,
} from "@finbook/core";
import { Command } from "commander";
import {
  MarketDataConfigStore,
  type FxFetchReport,
  type FxNeed,
  type MarketDataCoordinator,
  type PriceFetchReport,
  type PriceNeed,
} from "@finbook/market-data";

import {
  listProviders,
  removeSource,
  setProviderEnabled,
  setRoute,
  setSource,
  setTimeZone,
  showConfig,
} from "./config.js";
import { currentDate, parseDate, requireDate } from "./dates.js";
import {
  CliFailure,
  externalFailure,
  notFoundFailure,
  requireResult,
  type ExternalFailureDetails,
  validationFailure,
} from "./errors.js";
import { doctorError, inspectDoctor } from "./doctor.js";
import { registerEventCommands } from "./event-commands.js";
import {
  renderAccounts,
  renderDoctor,
  renderEvents,
  renderFx,
  renderGlance,
  renderInstruments,
  renderPositions,
  renderPrices,
} from "./human-output.js";
import { writeSuccess } from "./output.js";
import { addAccount, addInstrument, setFx, setPrice } from "./writes.js";

type ProgramOptions = {
  now?: () => Date;
  generateId?: () => string;
  marketDataFactory?: () => MarketDataCoordinator;
};

export function createProgram(dataHome: string, options: ProgramOptions = {}): Command {
  const store = new FileBookStore(dataHome);
  const marketDataConfig = new MarketDataConfigStore(dataHome);
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? randomUUID;
  const marketDataFactory = options.marketDataFactory;
  const resolveDefaultDate = () => {
    const metadata = requireResult(store.loadMetadata());
    return currentDate(now(), metadata.timeZone);
  };
  const program = new Command()
    .name("finbook")
    .description("A local book of economic events")
    .version("0.1.0")
    .option("--json", "return the stable JSON envelope");

  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: () => undefined,
  });

  const doctor = program.command("doctor").description("report book health");
  addJsonOption(doctor);
  doctor.action((_options, command) =>
    showDoctor(store, marketDataConfig, jsonMode(command), now()),
  );

  const config = program
    .command("config")
    .description("configure the book and market-data sources");
  const configShow = config.command("show").description("show non-secret configuration");
  addJsonOption(configShow);
  configShow.action((_options, command) => showConfig(store, marketDataConfig, jsonMode(command)));
  const timezone = config.command("timezone").description("manage the book timezone");
  const timezoneSet = timezone
    .command("set <iana-name>")
    .description("set the timezone used to resolve today");
  addJsonOption(timezoneSet);
  timezoneSet.action((value, _options, command) => setTimeZone(store, value, jsonMode(command)));
  const configProviders = config.command("provider").description("manage providers");
  const providerList = configProviders.command("list").description("list providers");
  addJsonOption(providerList);
  providerList.action((_options, command) => listProviders(marketDataConfig, jsonMode(command)));
  for (const [verb, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    const providerCommand = configProviders
      .command(`${verb} <id>`)
      .description(`${verb} a provider`);
    addJsonOption(providerCommand);
    providerCommand.action((id, _options, command) =>
      setProviderEnabled(marketDataConfig, id, enabled, jsonMode(command)),
    );
  }
  const route = config.command("route").description("manage provider routes");
  const routeSet = route.command("set <kind> <providers...>").description("set a provider route");
  addJsonOption(routeSet);
  routeSet.action((kind, providers, _options, command) =>
    setRoute(marketDataConfig, kind, providers, jsonMode(command)),
  );
  const source = config.command("source").description("manage source bindings");
  const sourceSet = source.command("set").description("bind an instrument or currency");
  sourceSet
    .option("--instrument <id>", "local instrument ID")
    .option("--currency <code>", "local currency code")
    .requiredOption("--provider <id>", "provider ID")
    .requiredOption("--identifier <id>", "provider identifier");
  addJsonOption(sourceSet);
  sourceSet.action((_options, command) =>
    setSource(store, marketDataConfig, command.opts(), jsonMode(command)),
  );
  const sourceRemove = source
    .command("remove")
    .description("remove an instrument or currency binding");
  sourceRemove
    .option("--instrument <id>", "local instrument ID")
    .option("--currency <code>", "local currency code");
  addJsonOption(sourceRemove);
  sourceRemove.action((_options, command) =>
    removeSource(marketDataConfig, command.opts(), jsonMode(command)),
  );

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
    .requiredOption("--type <type>", "instrument type: stock, etf, fund, etc, or crypto")
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

  const event = program.command("event").description("manage events");
  registerEventCommands(event, store, generateId, marketDataFactory);
  const eventList = event.command("list").description("list events");
  eventList
    .option("--account <id>", "filter by account")
    .option("--type <type>", "filter by event type; repeatable", collectOption, [])
    .option("--instrument <id>", "filter by instrument; repeatable", collectOption, [])
    .option("--source <source>", "filter by exact source; repeatable", collectOption, [])
    .option("--from <date>", "inclusive start date")
    .option("--to <date>", "inclusive end date");
  addJsonOption(eventList);
  eventList.addHelpText(
    "after",
    "\nExample:\n  finbook event list --type buy --instrument HROW --from 2026-01-01",
  );
  eventList.action((_options, command) => listEvents(store, command.opts(), jsonMode(command)));
  const eventGet = event.command("get <id>").description("get one event");
  addJsonOption(eventGet);
  eventGet.addHelpText("after", "\nExample:\n  finbook event get buy-1");
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
  glance
    .option("--as-of <date>", "valuation date")
    .option("--fetch", "fetch missing valuation marks before showing the view");
  addJsonOption(glance);
  glance.action((_options, command) =>
    showGlance(store, command.opts(), jsonMode(command), resolveDefaultDate(), marketDataFactory),
  );
  const positions = show.command("positions").description("show current positions");
  positions
    .option("--as-of <date>", "valuation date")
    .option("--fetch", "fetch missing valuation marks before showing the view");
  addJsonOption(positions);
  positions.action((_options, command) =>
    showPositions(
      store,
      command.opts(),
      jsonMode(command),
      resolveDefaultDate(),
      marketDataFactory,
    ),
  );

  program.addHelpText(
    "after",
    [
      "",
      "Get started:",
      "  finbook account add --help",
      "  finbook instrument add --help",
      "  finbook event add --help",
      "  finbook price set --help",
      "  finbook show glance --fetch",
      "  finbook show glance",
      "  finbook event get <id>",
      "  finbook event edit <type> <id> --help",
    ].join("\n"),
  );

  return program;
}

type JsonOptions = {
  json?: boolean | undefined;
};

type EventListOptions = JsonOptions & {
  account?: string | undefined;
  type?: readonly string[] | undefined;
  instrument?: readonly string[] | undefined;
  source?: readonly string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

type AsOfOptions = JsonOptions & {
  asOf?: string | undefined;
  fetch?: boolean | undefined;
};

function addJsonOption(command: Command): void {
  command.option("--json", "return the stable JSON envelope");
}

function collectOption(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

function jsonMode(command: Command): boolean {
  return command.optsWithGlobals().json === true;
}

function loadSnapshot(store: FileBookStore): BookSnapshot {
  return requireResult(store.load());
}

function showDoctor(
  store: FileBookStore,
  marketDataConfig: MarketDataConfigStore,
  json: boolean,
  now: Date,
): void {
  const report = inspectDoctor(store, marketDataConfig, now);
  if (report.status === "error") {
    if (!json) writeSuccess(report, false, renderDoctor(report));
    throw new CliFailure(doctorError(report));
  }
  writeSuccess(report, json, renderDoctor(report));
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

function listEvents(store: FileBookStore, options: EventListOptions, json: boolean): void {
  const snapshot = loadSnapshot(store);
  if (
    options.account !== undefined &&
    !snapshot.accounts.some((account) => account.id === options.account)
  ) {
    throw notFoundFailure("account", options.account);
  }
  const types = options.type?.map(parseEventType) ?? [];
  const instruments = options.instrument?.map(parseInstrumentFilter) ?? [];
  const sources = options.source?.map(parseSourceFilter) ?? [];
  for (const instrument of instruments) {
    if (!snapshot.instruments.some((candidate) => candidate.id === instrument)) {
      throw notFoundFailure("instrument", instrument);
    }
  }
  const typeSet = new Set(types);
  const instrumentSet = new Set(instruments);
  const sourceSet = new Set(sources);
  const from = options.from === undefined ? undefined : parseDate(options.from, "--from");
  const to = options.to === undefined ? undefined : parseDate(options.to, "--to");
  if (from !== undefined && to !== undefined && from > to) {
    throw validationFailure(
      "The `--from` date must not be after `--to`.",
      "Swap the date range values.",
    );
  }
  const events = snapshot.events.filter((event) => {
    if (options.account !== undefined && !eventBelongsToAccount(event, options.account))
      return false;
    if (typeSet.size > 0 && !typeSet.has(event.type)) return false;
    if (instrumentSet.size > 0 && !eventBelongsToInstrument(event, instrumentSet)) return false;
    if (sourceSet.size > 0 && !sourceSet.has(event.source)) return false;
    if (from !== undefined && event.date < from) return false;
    if (to !== undefined && event.date > to) return false;
    return true;
  });
  writeSuccess(events, json, renderEvents(events));
}

function parseEventType(value: string): Event["type"] {
  const parsed = EventTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw validationFailure(
      `Unknown event type: ${value}.`,
      `Use one of: ${EventTypeSchema.options.join(", ")}.`,
    );
  }
  return parsed.data;
}

function parseInstrumentFilter(value: string): string {
  const parsed = InstrumentIdSchema.safeParse(value);
  if (!parsed.success) {
    throw validationFailure("Invalid instrument ID.", "Use a valid local instrument ID.");
  }
  return parsed.data;
}

function parseSourceFilter(value: string): string {
  const parsed = NonEmptyStringSchema.safeParse(value);
  if (!parsed.success) {
    throw validationFailure("Invalid event source.", "Use a non-empty exact source ID.");
  }
  return parsed.data;
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

async function showGlance(
  store: FileBookStore,
  options: AsOfOptions,
  json: boolean,
  defaultDate: string,
  marketDataFactory?: () => MarketDataCoordinator,
): Promise<void> {
  const asOf = requireDate(options.asOf, "--as-of", defaultDate);
  const fetched = await awaitSnapshot(store, options, asOf, defaultDate, marketDataFactory);
  const glance = requireResult(getGlance(fetched.snapshot, asOf));
  if (hasFetchFailures(fetched.reports)) {
    if (!json) writeSuccess(glance, false, renderGlance(glance));
    throw partialFetchFailure(fetched.reports, glance);
  }
  writeSuccess(glance, json, renderGlance(glance));
}

async function showPositions(
  store: FileBookStore,
  options: AsOfOptions,
  json: boolean,
  defaultDate: string,
  marketDataFactory?: () => MarketDataCoordinator,
): Promise<void> {
  const asOf = requireDate(options.asOf, "--as-of", defaultDate);
  const fetched = await awaitSnapshot(store, options, asOf, defaultDate, marketDataFactory);
  const positions = requireResult(getPositions(fetched.snapshot, asOf));
  if (hasFetchFailures(fetched.reports)) {
    if (!json) writeSuccess(positions, false, renderPositions(positions));
    throw partialFetchFailure(fetched.reports, positions);
  }
  writeSuccess(positions, json, renderPositions(positions));
}

type FetchReports = {
  prices: PriceFetchReport;
  fx: FxFetchReport;
};

type FetchedSnapshot = {
  snapshot: BookSnapshot;
  reports: FetchReports;
};

async function awaitSnapshot(
  store: FileBookStore,
  options: AsOfOptions,
  asOf: string,
  defaultDate: string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): Promise<FetchedSnapshot> {
  const snapshot = loadSnapshot(store);
  if (options.fetch !== true) return { snapshot, reports: emptyFetchReports() };
  if (marketDataFactory === undefined) {
    throw validationFailure(
      "Valuation fetching is not configured.",
      "Configure a market-data provider before using --fetch.",
    );
  }
  const marketData = marketDataFactory();
  const positions = requireResult(getPositions(snapshot, asOf));
  const mode = asOf === defaultDate ? "latest" : "historical";
  const priceNeeds: PriceNeed[] = [];
  const currencies = new Set<string>();
  for (const position of positions.positions) {
    const instrument = snapshot.instruments.find(
      (candidate) => candidate.id === position.instrument,
    );
    if (instrument === undefined) continue;
    priceNeeds.push({ instrument, asOf, mode, identifier: instrument.id });
    if (instrument.quoteCurrency !== "EUR") currencies.add(instrument.quoteCurrency);
  }
  for (const entry of positions.cash) {
    if (entry.currency !== "EUR") currencies.add(entry.currency);
  }
  const priceReport = requireResult(await marketData.resolvePrices(priceNeeds));
  const fxNeeds: FxNeed[] = [...currencies].map((currency) => ({ currency, asOf, mode }));
  const fxReport = requireResult(await marketData.resolveFxRates(fxNeeds));
  return {
    snapshot: loadSnapshot(store),
    reports: { prices: priceReport, fx: fxReport },
  };
}

function emptyFetchReports(): FetchReports {
  return {
    prices: { requested: 0, cached: 0, fetched: [], failures: [] },
    fx: { requested: 0, cached: 0, fetched: [], failures: [] },
  };
}

function hasFetchFailures(reports: FetchReports): boolean {
  return reports.prices.failures.length > 0 || reports.fx.failures.length > 0;
}

function partialFetchFailure(reports: FetchReports, partial: ExternalFailureDetails["partial"]) {
  const failures = [
    ...reports.prices.failures.map(({ need, provider, error }) => ({
      kind: "price" as const,
      subject: need.instrument.id,
      provider,
      reason: error.kind,
      message: error.message,
    })),
    ...reports.fx.failures.map(({ need, provider, error }) => ({
      kind: "fx" as const,
      subject: need.currency,
      provider,
      reason: error.kind,
      message: error.message,
    })),
  ];
  return externalFailure(
    "Could not fetch every requested market-data observation.",
    "Retry the command or add the missing marks manually.",
    {
      requested: { prices: reports.prices.requested, fx: reports.fx.requested },
      saved: { prices: reports.prices.fetched.length, fx: reports.fx.fetched.length },
      failures,
      partial,
    },
  );
}

function eventBelongsToAccount(event: Event, accountId: string): boolean {
  return event.type === "transfer"
    ? event.from === accountId || event.to === accountId
    : event.account === accountId;
}

function eventBelongsToInstrument(event: Event, instruments: ReadonlySet<string>): boolean {
  return "instrument" in event && instruments.has(event.instrument);
}
