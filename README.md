# finbook

finbook is a small local CLI for keeping investment records and following daily portfolio value in EUR.

Record deposits, transfers, currency exchanges, trades, income, and fees. Explicitly update available historical prices and FX, then read positions, contributions, and daily values offline. Transactions and dated valuation observations stay in inspectable files on your machine.

The same non-interactive commands and structured output work for people and coding agents. Broker statements remain your external records.

## What it helps with

- Keep one history across multiple brokers and accounts.
- Distinguish new contributions from transfers between accounts you own.
- Preserve trade fees, withholding, and historical EUR rates with the event they belong to.
- Inspect positions and daily portfolio value history in EUR.
- Update available fund, stock, crypto, and FX history, then inspect saved values offline.
- Correct history without allowing an edit or deletion to invalidate later events.
- Inspect and automate the book through ordinary files, composable commands, and stable JSON output.

finbook is a local, single-user CLI under active development. It is not a broker, trading tool, tax calculator, hosted service, or official audit trail.

## Build from source

The repository pins its Node and pnpm requirements in `.node-version` and `package.json`.

```sh
corepack pnpm install
corepack pnpm build
```

Run the built CLI directly or define a convenience function:

```sh
finbook() { node packages/cli/dist/main.js "$@"; }
finbook --help
```

Book data defaults to `~/.finbook`. To try finbook without touching that book, point it at another directory outside the checkout:

```sh
export FINBOOK_HOME="$(mktemp -d)"
```

## Start a book

Add an account and an instrument:

```sh
finbook account add --id broker --name "My broker" --platform my-broker --country ES --custodial broker
finbook instrument add --id ACME --name "Example Co" --type stock --quote-currency USD
```

Record money entering the portfolio, exchange it, and buy the instrument:

```sh
finbook event add deposit --date 2026-03-03 --account broker --amount 800 --currency EUR
finbook event add fx --date 2026-03-03 --account broker --from-amount 798 --from-currency EUR --to-amount 927.04 --to-currency USD --fee-amount 1.71 --fee-currency EUR
finbook event add buy --date 2026-03-03 --account broker --instrument ACME --qty 20 --price-amount 40.45 --price-currency USD --gross-amount 809 --fee-in quote --fee-amount 0.28
```

`--gross-amount` records the exact pre-fee cash value reported for a trade; finbook does not reconstruct it from a rounded unit price. A trade fee can come from quote-currency cash (`--fee-in quote`) or from the traded instrument (`--fee-in instrument`). Omit both fee flags when there is no fee.

`eurPerUnit` records the historical EUR value of one unit of the event currency. Non-EUR deposits and withdrawals require it for contribution accounting; provide it directly or use `--fetch-rate`. EUR contributions store `1`. On trades, dividends, interest, and standalone fees the reporting rate is optional: omitting it makes no network request and stores no invented rate. Your EUR-to-USD conversion and subsequent USD purchase can therefore be recorded separately without supplying an extra rate on the purchase. Daily valuation still needs its own market price and FX marks.

Add valuation marks and inspect the portfolio:

```sh
finbook price set --instrument ACME --amount 41 --currency USD --as-of 2026-03-04
finbook fx set --pair USD/EUR --rate 0.866 --as-of 2026-03-04
finbook show glance --as-of 2026-03-04
finbook show positions --as-of 2026-03-04
```

`price set` records the market value of an instrument on a date; it does not record a trade. `fx set` does the same for a currency-to-EUR valuation rate. A trade price is never used as a valuation fallback.

Update available historical data and read daily values offline:

```sh
finbook config source set --instrument ACME --provider eodhd --identifier ACME.US
export FINBOOK_EODHD_API_KEY="..."
finbook update
finbook show history --from 2026-03-03 --to 2026-03-10
finbook show history --from 2026-03-03 --to 2026-03-10 --json
```

Use the actual provider identifier for your instrument. Yahoo supplies fund NAVs, EODHD raw fund and stock closes, ECB fiat exchange rates, and CoinGecko crypto closing history. Yahoo is the default fund provider; EODHD is the default stock provider and needs its API credential and correct exchange identifier. A source binding pins the chosen provider. Automatic ETF/ETC history and corporate actions are unsupported; manual marks remain usable.

For the public fund and Bitcoin examples:

```sh
finbook config source set --instrument <local-fund-id> --provider yahoo --identifier 0P00000WLG.F
finbook config source set --instrument <local-bitcoin-id> --provider coingecko --identifier bitcoin
```

Create the corresponding local instruments first and verify the identifiers and currencies. CoinGecko can use public access or `FINBOOK_COINGECKO_DEMO_API_KEY`; its Demo history is limited to the past 365 days. Earlier unavailable values remain unknown. No paid subscription is selected automatically.

`update` derives needs from the complete recorded history, including sold assets and foreign cash left after a sale. It checks newest ranges first and saves each observation. Provider failures retain completed work and leave failed ranges retryable. Completed checks, including empty periods, are reused across restarts.

When new dates need acquisition, the same range request also catches up from the last saved eligible observation. This lets delayed NAVs advance without a separate refresh command. Repeating the same completed update makes no request. There is no automatic old-history correction scan; late interior prices or final prices arriving after an exposure ends may remain absent.

Acquisition stops at the preceding completed UTC date, advancing its cutoff at 06:00 UTC. For crypto, a value dated 10 September uses the midnight UTC snapshot starting 11 September as the close of 10 September. Fund NAVs, stock closes, and fiat FX keep their own economic dates. The result is an indicative mixed-market value, with the dates of the selected evidence visible.

```sh
finbook update --json
finbook show glance
finbook show positions --as-of 2026-03-04
finbook doctor
```

All views read saved facts offline. A missing required price or FX observation makes the affected total unknown; trade prices never fill valuation gaps. The last eligible mark carries across non-trading days with its date preserved. Having all required inputs does not mean every price is recent.

Manual marks take priority on the same date. Update retains and reports differing provider values. To correct your choice, use `price set` or `fx set` for that subject and date. There is no bulk replacement option on update. JSON keeps exact decimal strings, acquisition results, conflicts, and selected valuation evidence; displayed EUR valuations round to cents.

Use `finbook <command> --help` for the complete command-specific flags and examples.

## Behaviour worth knowing

- Dates are `YYYY-MM-DD` economic dates, not instants. An omitted view date uses the book timezone, which defaults to `Europe/Madrid`; configure it with `finbook config timezone set <iana-name>`.
- Reporting is always in EUR. Missing marks remain visible and make affected totals unknown rather than silently approximated.
- Transfers move the same currency between owned accounts and do not change contributed capital. Currency conversion within an account is an `fx` event.
- Event edits retain omitted fields. A supplied reporting EUR rate stays recorded; changing its foreign-currency date or currency requires a new rate or `--clear-eur-rate`, which clears rate and provenance together. Required contribution rates cannot be cleared. Edits and deletions replay the complete proposed ledger and write nothing when a later event would become invalid.
- There is no automatic backup, undo log, or hidden event history.
- Human-readable output is the default. `--json` returns a stable success or error envelope for scripts.
- `finbook doctor` is offline and read-only: it reports book, schema, replay, configuration, permission, lock, and valuation health without repairing or initializing anything.

## Local data and credentials

`$FINBOOK_HOME` contains private financial information. Keep it outside the checkout and do not commit or upload it. finbook uses owner-only permissions where the operating system supports them.

Non-secret provider routes and bindings are stored with the book. CoinGecko and EODHD credentials are read from `FINBOOK_COINGECKO_DEMO_API_KEY` and `FINBOOK_EODHD_API_KEY`; they are not persisted.

## Back up and recover deliberately

Stop every finbook process using the book before copying it. Copy the complete `$FINBOOK_HOME` folder to a private location outside the checkout and preserve its owner-only permissions. Keep all book files together; a copy of an actively changing book can be inconsistent.

A partially missing core book fails instead of recreating the missing files. An abandoned or uncertain lock also stops the operation. The error identifies `.finbook.lock` or `.finbook.refresh.lock` and the available ownership information. Inspect the named lock and confirm no process is using the book before manually removing that lock directory. A live owner should be allowed to finish. finbook provides no automatic lock recovery or unlock command.

For restoration, keep the damaged original and copy a known consistent, version-compatible whole backup into a separate location. Point `FINBOOK_HOME` there and run `finbook doctor` before continuing. Do not combine selected files from different snapshots. Doctor inspects without repairing, unlocking, or initializing the book.

The project is unreleased. Disposable test books can be regenerated when data conventions change; no migration or compatibility workflow is provided.

## Development

Run the complete local gate before considering a change finished:

```sh
corepack pnpm check
```

The design documents separate the [product contract](docs/PRODUCT.md), [engineering design](docs/DESIGN.md), and [market-data subsystem](docs/MARKET_DATA.md).
