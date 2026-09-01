import { Command } from "commander";
import type { FileBookStore } from "@finbook/core";
import type { MarketDataCoordinator } from "@finbook/market-data";

import {
  addEvent,
  addEventFile,
  deleteEvent,
  editEvent,
  type EventAddOptions,
  type EventEditOptions,
  type HistoricalRateResolver,
} from "./event-input.js";
import { validationFailure } from "./errors.js";

export function registerEventCommands(
  event: Command,
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const add = event.command("add").description("add an event");
  add.option("--file <path>", "read one canonical event object");
  addJsonOption(add);
  add.action((_options, command) => {
    const options = command.opts();
    if (options.file === undefined) {
      throw validationFailure(
        "Missing event type.",
        "Provide a type such as `deposit` or use --file.",
      );
    }
    return addEventFile(store, options.file, jsonMode(command));
  });

  registerDepositAdd(add, store, generateId, marketDataFactory);
  registerWithdrawalAdd(add, store, generateId, marketDataFactory);
  registerTransferAdd(add, store, generateId);
  registerFxAdd(add, store, generateId);
  registerBuyAdd(add, store, generateId, marketDataFactory);
  registerSellAdd(add, store, generateId, marketDataFactory);
  registerDividendAdd(add, store, generateId, marketDataFactory);
  registerInterestAdd(add, store, generateId, marketDataFactory);
  registerFeeAdd(add, store, generateId, marketDataFactory);

  const edit = event.command("edit").description("edit one event");
  registerDepositEdit(edit, store, marketDataFactory);
  registerWithdrawalEdit(edit, store, marketDataFactory);
  registerTransferEdit(edit, store);
  registerFxEdit(edit, store);
  registerBuyEdit(edit, store, marketDataFactory);
  registerSellEdit(edit, store, marketDataFactory);
  registerDividendEdit(edit, store, marketDataFactory);
  registerInterestEdit(edit, store, marketDataFactory);
  registerFeeEdit(edit, store, marketDataFactory);

  const remove = event.command("delete <id>").description("delete one event");
  addJsonOption(remove);
  remove.action((id, _options, command) => deleteEvent(store, id, jsonMode(command)));
}

function registerDepositAdd(
  parent: Command,
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command("deposit").description("record a deposit");
  addBaseOptions(command);
  addAccountMoneyOptions(command, true);
  addRateOptions(command);
  addJsonOption(command);
  command.action((_options, current) =>
    addEvent(
      store,
      typedAddEventInput(current, "deposit"),
      jsonMode(current),
      generateId,
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerWithdrawalAdd(
  parent: Command,
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command("withdrawal").description("record a withdrawal");
  addBaseOptions(command);
  addAccountMoneyOptions(command, true);
  addRateOptions(command);
  addJsonOption(command);
  command.action((_options, current) =>
    addEvent(
      store,
      typedAddEventInput(current, "withdrawal"),
      jsonMode(current),
      generateId,
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerTransferAdd(
  parent: Command,
  store: FileBookStore,
  generateId: () => string,
): void {
  const command = parent.command("transfer").description("record a transfer");
  addBaseOptions(command);
  command
    .option("--from <id>", "required source account")
    .option("--to <id>", "required destination account");
  addMoneyOptions(command, true);
  addJsonOption(command);
  command.action((_options, current) =>
    addEvent(store, typedAddEventInput(current, "transfer"), jsonMode(current), generateId),
  );
}

function registerFxAdd(parent: Command, store: FileBookStore, generateId: () => string): void {
  const command = parent.command("fx").description("record a currency exchange");
  addBaseOptions(command);
  command.option("--account <id>", "required account ID");
  addFxMoneyOptions(command, true);
  command
    .option("--fee-amount <decimal>", "FX fee amount")
    .option("--fee-currency <code>", "FX fee currency");
  addJsonOption(command);
  command.action((_options, current) =>
    addEvent(store, typedAddEventInput(current, "fx"), jsonMode(current), generateId),
  );
}

function registerTradeAdd(
  parent: Command,
  type: "buy" | "sell",
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command(type).description(`record a ${type}`);
  addBaseOptions(command);
  addTradeOptions(command, true);
  addRateOptions(command);
  addJsonOption(command);
  command.action((_options, current) =>
    addEvent(
      store,
      typedAddEventInput(current, type),
      jsonMode(current),
      generateId,
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerBuyAdd(
  parent: Command,
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  registerTradeAdd(parent, "buy", store, generateId, marketDataFactory);
}

function registerSellAdd(
  parent: Command,
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  registerTradeAdd(parent, "sell", store, generateId, marketDataFactory);
}

function registerIncomeAdd(
  parent: Command,
  type: "dividend" | "interest",
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command(type).description(`record ${type}`);
  addBaseOptions(command);
  if (type === "dividend")
    command
      .option("--account <id>", "required account ID")
      .option("--instrument <id>", "required instrument ID");
  else command.option("--account <id>", "required account ID");
  addGrossOptions(command, true);
  command
    .option("--withholding-foreign-amount <decimal>", "foreign withholding")
    .option("--withholding-domestic-amount <decimal>", "domestic withholding");
  addRateOptions(command);
  addJsonOption(command);
  command.action((_options, current) =>
    addEvent(
      store,
      typedAddEventInput(current, type),
      jsonMode(current),
      generateId,
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerDividendAdd(
  parent: Command,
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  registerIncomeAdd(parent, "dividend", store, generateId, marketDataFactory);
}

function registerInterestAdd(
  parent: Command,
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  registerIncomeAdd(parent, "interest", store, generateId, marketDataFactory);
}

function registerFeeAdd(
  parent: Command,
  store: FileBookStore,
  generateId: () => string,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command("fee").description("record a fee");
  addBaseOptions(command);
  addAccountMoneyOptions(command, true);
  addRateOptions(command);
  addJsonOption(command);
  command.action((_options, current) =>
    addEvent(
      store,
      typedAddEventInput(current, "fee"),
      jsonMode(current),
      generateId,
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerDepositEdit(
  parent: Command,
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command("deposit <id>").description("edit a deposit");
  addBaseEditOptions(command);
  addAccountMoneyEditOptions(command);
  addRateOptions(command);
  addJsonOption(command);
  command.action((id, _options, current) =>
    editEvent(
      store,
      typedEditEventInput(current, "deposit"),
      id,
      jsonMode(current),
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerWithdrawalEdit(
  parent: Command,
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command("withdrawal <id>").description("edit a withdrawal");
  addBaseEditOptions(command);
  addAccountMoneyEditOptions(command);
  addRateOptions(command);
  addJsonOption(command);
  command.action((id, _options, current) =>
    editEvent(
      store,
      typedEditEventInput(current, "withdrawal"),
      id,
      jsonMode(current),
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerTransferEdit(parent: Command, store: FileBookStore): void {
  const command = parent.command("transfer <id>").description("edit a transfer");
  addBaseEditOptions(command);
  command.option("--from <id>", "source account").option("--to <id>", "destination account");
  addMoneyEditOptions(command);
  addJsonOption(command);
  command.action((id, _options, current) =>
    editEvent(store, typedEditEventInput(current, "transfer"), id, jsonMode(current)),
  );
}

function registerFxEdit(parent: Command, store: FileBookStore): void {
  const command = parent.command("fx <id>").description("edit a currency exchange");
  addBaseEditOptions(command);
  command.option("--account <id>", "account ID");
  addFxMoneyEditOptions(command);
  command
    .option("--fee-amount <decimal>", "FX fee amount")
    .option("--fee-currency <code>", "FX fee currency")
    .option("--clear-fee", "remove the fee");
  addJsonOption(command);
  command.action((id, _options, current) =>
    editEvent(store, typedEditEventInput(current, "fx"), id, jsonMode(current)),
  );
}

function registerTradeEdit(
  parent: Command,
  type: "buy" | "sell",
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command(`${type} <id>`).description(`edit a ${type}`);
  addBaseEditOptions(command);
  addTradeEditOptions(command);
  addRateOptions(command);
  addJsonOption(command);
  command.action((id, _options, current) =>
    editEvent(
      store,
      typedEditEventInput(current, type),
      id,
      jsonMode(current),
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerBuyEdit(
  parent: Command,
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  registerTradeEdit(parent, "buy", store, marketDataFactory);
}

function registerSellEdit(
  parent: Command,
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  registerTradeEdit(parent, "sell", store, marketDataFactory);
}

function registerIncomeEdit(
  parent: Command,
  type: "dividend" | "interest",
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command(`${type} <id>`).description(`edit ${type}`);
  addBaseEditOptions(command);
  command.option("--account <id>", "account ID");
  if (type === "dividend") command.option("--instrument <id>", "instrument ID");
  addGrossEditOptions(command);
  command
    .option("--withholding-foreign-amount <decimal>", "foreign withholding")
    .option("--clear-withholding-foreign", "remove foreign withholding")
    .option("--withholding-domestic-amount <decimal>", "domestic withholding")
    .option("--clear-withholding-domestic", "remove domestic withholding");
  addRateOptions(command);
  addJsonOption(command);
  command.action((id, _options, current) =>
    editEvent(
      store,
      typedEditEventInput(current, type),
      id,
      jsonMode(current),
      rateResolver(current, marketDataFactory),
    ),
  );
}

function registerDividendEdit(
  parent: Command,
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  registerIncomeEdit(parent, "dividend", store, marketDataFactory);
}

function registerInterestEdit(
  parent: Command,
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  registerIncomeEdit(parent, "interest", store, marketDataFactory);
}

function registerFeeEdit(
  parent: Command,
  store: FileBookStore,
  marketDataFactory: (() => MarketDataCoordinator) | undefined,
): void {
  const command = parent.command("fee <id>").description("edit a fee");
  addBaseEditOptions(command);
  addAccountMoneyEditOptions(command);
  addRateOptions(command);
  addJsonOption(command);
  command.action((id, _options, current) =>
    editEvent(
      store,
      typedEditEventInput(current, "fee"),
      id,
      jsonMode(current),
      rateResolver(current, marketDataFactory),
    ),
  );
}

function addBaseOptions(command: Command): void {
  command
    .option("--id <id>", "event ID; generated when omitted")
    .option("--date <date>", "required event date")
    .option("--source <source>", "event source; defaults to manual")
    .option("--external-id <id>", "source-specific idempotency ID")
    .option("--note <text>", "event note");
}

function addBaseEditOptions(command: Command): void {
  command
    .option("--date <date>", "event date")
    .option("--note <text>", "event note")
    .option("--clear-note", "remove the note");
}

function addAccountMoneyOptions(command: Command, required = false): void {
  command
    .option("--account <id>", required ? "required account ID" : "account ID")
    .option("--amount <decimal>", required ? "required amount" : "amount")
    .option("--currency <code>", required ? "required currency" : "currency");
}

function addAccountMoneyEditOptions(command: Command): void {
  addAccountMoneyOptions(command);
}

function addMoneyOptions(command: Command, required = false): void {
  command
    .option("--amount <decimal>", required ? "required amount" : "amount")
    .option("--currency <code>", required ? "required currency" : "currency");
}

function addMoneyEditOptions(command: Command): void {
  addMoneyOptions(command);
}

function addFxMoneyOptions(command: Command, required = false): void {
  command
    .option("--from-amount <decimal>", required ? "required FX source amount" : "FX source amount")
    .option(
      "--from-currency <code>",
      required ? "required FX source currency" : "FX source currency",
    )
    .option(
      "--to-amount <decimal>",
      required ? "required FX destination amount" : "FX destination amount",
    )
    .option(
      "--to-currency <code>",
      required ? "required FX destination currency" : "FX destination currency",
    );
}

function addFxMoneyEditOptions(command: Command): void {
  addFxMoneyOptions(command);
}

function addTradeOptions(command: Command, required = false): Command {
  return command
    .option("--account <id>", required ? "required account ID" : "account ID")
    .option("--instrument <id>", required ? "required instrument ID" : "instrument ID")
    .option("--qty <decimal>", required ? "required quantity" : "quantity")
    .option(
      "--price-amount <decimal>",
      required ? "required trade price amount" : "trade price amount",
    )
    .option(
      "--price-currency <code>",
      required ? "required trade price currency" : "trade price currency",
    )
    .option("--fee-amount <decimal>", "trade fee amount")
    .option("--fee-currency <code>", "trade fee currency");
}

function addTradeEditOptions(command: Command): void {
  addTradeOptions(command).option("--clear-fee", "remove the fee");
}

function addGrossOptions(command: Command, required = false): void {
  command
    .option(
      "--gross-amount <decimal>",
      required ? "required gross income amount" : "gross income amount",
    )
    .option(
      "--gross-currency <code>",
      required ? "required gross income currency" : "gross income currency",
    );
}

function addGrossEditOptions(command: Command): void {
  addGrossOptions(command);
}

function addRateOptions(command: Command): void {
  command
    .option("--eur-per-unit <decimal>", "historical EUR per unit rate")
    .option("--fetch-rate", "fetch the historical EUR rate before writing")
    .option("--provider <id>", "pin the historical-rate provider");
}

function rateResolver(
  command: Command,
  factory: (() => MarketDataCoordinator) | undefined,
): HistoricalRateResolver | undefined {
  return command.opts().fetchRate === true && factory !== undefined ? factory() : undefined;
}

function addJsonOption(command: Command): void {
  command.option("--json", "return the stable JSON envelope");
}

function typedAddEventInput(command: Command, type: EventAddOptions["type"]): EventAddOptions {
  if (command.optsWithGlobals().file !== undefined) {
    throw validationFailure(
      "Cannot combine --file with a typed event.",
      "Use --file without an event type or remove --file.",
    );
  }
  const options = { ...command.opts() };
  // SAFETY: Commander supplies only registered options, and addEvent validates them with Zod.
  return { type, ...options } as EventAddOptions;
}

function typedEditEventInput(command: Command, type: EventEditOptions["type"]): EventEditOptions {
  if (command.optsWithGlobals().file !== undefined) {
    throw validationFailure(
      "Cannot combine --file with a typed event.",
      "Use --file without an event type or remove --file.",
    );
  }
  const options = { ...command.opts() };
  // SAFETY: Commander supplies only registered options, and editEvent validates them with Zod.
  return { type, ...options } as EventEditOptions;
}

function jsonMode(command: Command): boolean {
  return command.optsWithGlobals().json === true;
}
