# finbook

Wealth-management apps can track almost everything. That breadth is useful, but it can make basic questions and awkward cases hard to control.

finbook takes the opposite approach. It is boring on purpose: a small, opinionated, local ledger focused on the needs of a Spanish investor.

Record what happened once—deposits, transfers, currency exchanges, trades, income, and fees—and finbook derives what you own, where it sits, how much you contributed, and what it is worth in EUR. Its rules cover details that generic summaries often blur, such as own-account transfers, trade fees, withholding, and historical exchange rates.

The book lives on your machine in inspectable files. The CLI is non-interactive and provides structured output, so people and coding agents can use the same predictable interface. finbook neither connects to a broker nor files taxes; it preserves the dated native-currency facts needed to understand the portfolio and support later Spanish tax work.

## What it helps with

- Keep one history across multiple brokers and accounts.
- Distinguish new contributions from transfers between accounts you own.
- Preserve trade fees, withholding, and historical EUR rates with the event they belong to.
- Inspect positions and portfolio value on any economic date.
- Add valuation marks yourself or explicitly refresh the price and FX data a view needs.
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
finbook instrument add --id HROW --name Harrow --type stock --quote-currency USD
```

Record money entering the portfolio, exchange it, and buy the instrument:

```sh
finbook event add deposit --date 2026-03-03 --account broker --amount 800 --currency EUR
finbook event add fx --date 2026-03-03 --account broker --from-amount 798 --from-currency EUR --to-amount 927.04 --to-currency USD --fee-amount 1.71 --fee-currency EUR
finbook event add buy --date 2026-03-03 --account broker --instrument HROW --qty 20 --price-amount 40.45 --price-currency USD --fee-amount 0.28 --fee-currency USD --eur-per-unit 0.861
```

`eurPerUnit` records the historical EUR value of one unit of the event currency. For a non-EUR event, provide it directly or use `--fetch-rate`. EUR events store a rate of `1` automatically.

Add valuation marks and inspect the portfolio:

```sh
finbook price set --instrument HROW --amount 41 --currency USD --as-of 2026-03-04
finbook fx set --pair USD/EUR --rate 0.866 --as-of 2026-03-04
finbook show glance --as-of 2026-03-04
finbook show positions --as-of 2026-03-04
```

`price set` records the market value of an instrument on a date; it does not record a trade. `fx set` does the same for a currency-to-EUR valuation rate. `--fetch` asks the configured providers for the valuation data required by the view and saves each successful result locally.

```sh
finbook show glance --fetch
finbook doctor
```

Use `finbook <command> --help` for the complete command-specific flags and examples.

## Behaviour worth knowing

- Dates are `YYYY-MM-DD` economic dates, not instants. An omitted view date uses the book timezone, which defaults to `Europe/Madrid`; configure it with `finbook config timezone set <iana-name>`.
- Reporting is always in EUR. Missing marks remain visible and make affected totals unknown rather than silently approximated.
- Transfers move the same currency between owned accounts and do not change contributed capital. Currency conversion within an account is an `fx` event.
- Event edits retain omitted fields. Edits and deletions replay the complete proposed ledger and write nothing when a later event would become invalid.
- There is no automatic backup, undo log, or hidden event history.
- Human-readable output is the default. `--json` returns a stable success or error envelope for scripts.
- `finbook doctor` is offline and read-only: it reports book, schema, replay, configuration, permission, lock, and valuation health without repairing or initializing anything.

## Local data and credentials

`$FINBOOK_HOME` contains private financial information. Keep it outside the checkout and do not commit or upload it. finbook uses owner-only permissions where the operating system supports them.

Non-secret provider routes and bindings are stored with the book. CoinGecko credentials are read from `FINBOOK_COINGECKO_DEMO_API_KEY` and are not persisted.

## Development

Run the complete local gate before considering a change finished:

```sh
corepack pnpm check
```

The design documents separate the [product contract](docs/PRODUCT.md), [engineering design](docs/DESIGN.md), and [market-data subsystem](docs/MARKET_DATA.md).
