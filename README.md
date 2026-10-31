# finbook

Wealth-management apps can track almost everything. That breadth is useful, but it can make basic questions and awkward cases hard to control.

finbook takes the opposite approach. It is boring on purpose: a small, opinionated, local ledger focused on the needs of a Spanish investor.

Record what happened once—deposits, transfers, currency exchanges, trades, income, and fees—and finbook derives what you own, where it sits, how much you contributed, and what it is worth in EUR. Its rules cover details that generic summaries often blur, such as own-account transfers, trade fees, withholding, and historical exchange rates.

The book lives on your machine in inspectable files. The CLI is non-interactive and provides structured output, so people and coding agents can use the same predictable interface. finbook neither connects to a broker nor files taxes; it preserves the dated native-currency facts needed to understand the portfolio and support later Spanish tax work.

## What it helps with

- Keep one history across multiple brokers and accounts.
- Distinguish new contributions from transfers between accounts you own.
- Preserve trade fees, withholding, and historical EUR rates with the event they belong to.
- Inspect positions and daily portfolio value history in EUR.
- Update available fund, stock, and fiat FX history, then inspect saved values offline.
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

Use the actual provider identifier for your instrument. Historical updates support Yahoo fund NAVs, EODHD raw fund and stock closes, and ECB fiat exchange rates. Yahoo remains the default fund provider; bind its local instrument ID to the Yahoo symbol when needed. Historical stocks require an explicit EODHD binding or route because Yahoo historical stock closes can use split-adjusted units. Provider credentials and account access determine available history. Corporate actions are not modeled.

`update` derives requirements from the complete recorded history, including sold assets and foreign cash left after a sale. It checks newest ranges first, saves each observation, and reports failed ranges without discarding completed work. Completed checks, including empty periods, are reused across restarts. They have no expiry or automatic recheck; late NAVs or provider corrections inside a checked period may remain absent. The table shows actual observation dates, carries the last eligible mark over non-trading days, and leaves totals unknown when an indispensable input is missing. A trade price never fills a valuation gap.

Crypto historical acquisition is not supported by `update` yet. Such needs are reported as failures while supported work is saved. Ordinary views remain offline. Single-date fetching remains available with `show glance --fetch` or `show positions --fetch`, including crypto; its separate daily cache can recheck lagging observations on a later cycle.

Both operations start their daily cycle at 06:00 UTC. History, security prices, and fiat FX stop at the preceding completed UTC date; single-date crypto uses the cycle date's midnight UTC snapshot. Earlier single-date views cap their targets at the requested date. The CLI performs no background scheduling.

```sh
finbook update --json
finbook show glance
finbook doctor
```

Manual marks take priority over fetched observations for the same date. Fetching reports differing values and retains the provider candidate. To accept it persistently without another provider request:

```sh
finbook show glance --fetch --replace-manual
```

This replaces conflicting same-date manual price and FX marks in the requested view; it does not affect transactions or manual marks on other dates. `--json` includes refresh counts, conflicts, and selected valuation evidence.

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

This build uses book schema 4 and rejects earlier book formats without rewriting their financial files. There is no automatic migration. Create a disposable test book in a new directory when needed. Rolling back a build after writing rate-free events also requires a compatible reader or a complete pre-change backup.

## Development

Run the complete local gate before considering a change finished:

```sh
corepack pnpm check
```

The design documents separate the [product contract](docs/PRODUCT.md), [engineering design](docs/DESIGN.md), and [market-data subsystem](docs/MARKET_DATA.md).
