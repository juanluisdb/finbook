# Product contract

finbook is a deliberately small financial event book for one person managing investments across accounts, providers, and currencies from a Spanish wealth-management perspective.

It answers three practical questions from a single history: what do I own, what is it worth in EUR, and how much of that value came from contributions rather than investment results.

The CLI is the product surface. The local data folder is the persisted book. Broker statements and tax documents remain the owner’s external records.

## Prefer boring and explicit

Broad wealth-management products can provide richer dashboards, integrations, and automation. finbook chooses a smaller surface so its basic answers and awkward accounting cases remain understandable.

Opinionated event meanings replace flexible categorization. Explicit dates and exchange rates replace hidden assumptions. Visible missing data replaces estimated totals. Local files replace an opaque hosted account.

The product should stay simple enough that its owner can inspect the book, understand a calculation from its inputs, and correct history without specialist tooling.

The same interface should work well for a person and a coding agent. Commands are non-interactive, help is discoverable, machine output is structured, failures are actionable, and persisted data uses ordinary documented formats.

Agent usability does not justify a parallel API or agent-only behaviour. Agents use the same commands, validation, and book as the owner.

Spanish focus means reporting in EUR and retaining the event-level facts needed by later Spanish tax work. It does not mean that the current product calculates or files taxes.

## Use the book as the source

The book records economic events; balances, holdings, contributions, valuations, and breakdowns are derived views.

Accounts describe where assets are held. Instruments identify the same asset across accounts, carry one quote currency, and classify it as a stock, ETF, fund, ETC, or cryptoasset. Cash is a balance per account and currency, not an instrument.

Price and FX stamps describe valuation evidence on a date. They are not transactions and never change event history.

This distinction prevents a current portfolio snapshot from replacing the history needed to explain how the portfolio reached that state.

The canonical input shapes live in `packages/core/src/domain/schemas.ts::AccountSchema`, `packages/core/src/domain/schemas.ts::InstrumentSchema`, `packages/core/src/domain/schemas.ts::EventSchema`, `packages/core/src/domain/schemas.ts::PriceStampSchema`, and `packages/core/src/domain/schemas.ts::FxStampSchema`.

## Record the economic meaning

| Event        | Meaning                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `deposit`    | Money entering the owned financial system; increases contributed capital.                    |
| `withdrawal` | Money leaving the owned financial system; decreases contributed capital.                     |
| `transfer`   | Same-currency movement between two owned accounts; does not change contributed capital.      |
| `fx`         | Currency exchange within one account; does not change contributed capital.                   |
| `buy`        | Exact gross cash exchanged for a gross instrument quantity, with any fee applied separately. |
| `sell`       | A gross instrument quantity exchanged for exact gross cash, with any fee applied separately. |
| `dividend`   | Gross instrument income with optional foreign and domestic withholding.                      |
| `interest`   | Gross account income with optional foreign and domestic withholding.                         |
| `fee`        | A standalone account fee that is not attached to a trade.                                    |

A movement from one owned account to another is a transfer even when a broker statement labels the incoming side as a deposit. Treating it as a deposit would overstate contributed capital.

A trade records its reported unit price and exact pre-fee cash amount independently. The cash amount is authoritative for settlement and lot cost because a displayed unit price may be rounded.

A trade fee belongs on its buy or sell and states what pays it. A quote fee changes cash; an instrument fee changes the received or disposed quantity. No fee is represented by omitting the fee. A standalone fee event is only for a charge with no associated trade.

An FX event exchanges two currencies in one account. A transfer moves one currency between accounts; it does not implicitly convert it.

These effects are defined by `packages/core/src/domain/apply.ts::apply`.

## Preserve money and dates

Reporting currency is EUR and is not configurable.

Amounts, quantities, prices, rates, and weights cross boundaries as decimal strings. finbook uses decimal arithmetic and does not round user input into binary floating-point values.

Every deposit, withdrawal, trade, dividend, interest, and standalone fee carries `eurPerUnit`: the historical EUR value of one unit of that event’s native currency. EUR events use `1`. A fetched historical rate also retains its provider, retrieval instant, and effective economic date.

Historical event rates explain the event in EUR. Current FX stamps value live cash and positions. One must not substitute for the other.

Event dates, stamp dates, and view dates are economic calendar dates in `YYYY-MM-DD` form, without a time of day or timezone.

The book timezone determines the implicit current date when a view omits `--as-of`. It defaults to `Europe/Madrid`, is configurable with an IANA timezone name, and never changes stored economic dates. Provider retrieval timestamps are UTC instants.

The boundary rules live in `packages/core/src/domain/scalars.ts` and `packages/core/src/domain/schemas.ts`; implicit date selection lives in `packages/cli/src/dates.ts::currentDate`.

## Keep the ledger valid

Events have stable identity and ordered position in the ledger. IDs are unique; a source and external ID pair is also unique when supplied.

Replay uses economic date first and append order as the same-day tie-breaker. A view for date `D` excludes events after `D`.

The book rejects unknown accounts or instruments, negative cash, sales above the held quantity including an instrument fee, mismatched trade currencies, invalid fees, instrument fees that consume an entire purchase, and withholding above gross income.

An edit preserves the event ID, type, source, external ID, and ledger position. Fields omitted from a typed edit remain unchanged; optional values are removed only through their explicit clear flags.

Before adding, editing, or deleting an event, finbook replays the complete proposed ledger. A correction that would invalidate a later transaction is rejected without changing the event file.

For example, after buying and then selling 20 units, changing the purchase quantity to 15 would make the later sale invalid, so the edit is rejected.

The replay ordering and mutation guarantees live in `packages/core/src/domain/replay.ts::orderEvents` and `packages/core/src/domain/store.ts::FileBookStore`.

## Read a portfolio as of a date

`show positions` returns live positions, cash balances, their EUR values where known, and valuation holes.

`show glance` adds total value, contributed capital, the difference between them, and breakdowns by platform, asset type, and native currency.

For date `D`, finbook replays events through `D`, selects the latest eligible price and FX stamp on or before `D`, and values the resulting state. When no price stamp exists, the latest eligible trade price is the instrument-price fallback.

EUR cash needs no FX stamp. Every other live currency needs a currency-to-EUR stamp.

Missing valuation evidence stays visible as a hole. Affected values, totals, and weights are unknown rather than guessed; the remaining positions and cash are still returned.

The difference between total value and contributed capital is a portfolio glance, not realized gain, tax profit, or performance attribution.

The query contract lives in `packages/core/src/domain/queries.ts::getPositions` and `packages/core/src/domain/queries.ts::getGlance`.

## Correct and inspect deliberately

The CLI is non-interactive. Deletion is immediate once the candidate ledger validates.

finbook creates no automatic backup, tombstone, undo log, or hidden event history. The local data files are the current book.

`doctor` is an offline, read-only inspection. It can report an uninitialized book, schema or replay problems, unsafe permissions, lock state, market configuration, and valuation completeness. It does not initialize, repair, unlock, fetch, or expose event payloads or credentials.

Human output is for direct use. JSON output uses a stable success or error envelope for scripts, keeps data on stdout, diagnostics on stderr, and distinguishes validation, not-found, and external failures with exit codes.

The CLI behaviour lives in `packages/cli/src/program.ts::createProgram`, `packages/cli/src/doctor.ts::inspectDoctor`, and `packages/cli/src/output.ts`.

## Retain inputs for Spanish tax work

finbook keeps native prices, exact gross trade amounts, gross trade quantities, instrument-denominated fee quantities, dates, quote fees, gross income, foreign and domestic withholding, historical EUR rates, account custody country and type, and optional instrument ISINs.

Those facts are useful inputs for later Spanish tax readers, but finbook does not determine filing obligations, calculate official FIFO gains, calculate currency-lot gains, select tax boxes, prepare forms, or give tax advice.

Original broker statements and tax documents remain the legal record. A future tax reader must consume the same event book without changing the meaning of existing events.

## Stay inside the product boundary

finbook is not a broker connection, order-entry system, background price service, multi-user database, hosted application, or sync engine.

It does not import broker files, schedule fetches, reconcile a broker balance to the cent, model corporate actions, exchange one cryptoasset directly for another, or produce tax reports.

These are current product boundaries, not placeholders for automatic expansion. A new capability should earn its data model and user workflow before it enters the book.
