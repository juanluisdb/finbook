# finbook

finbook is a local, single-user book of financial events. It derives cash, positions, contributions, and a EUR portfolio glance from an ordered ledger. It is not a broker, trading tool, tax calculator, or hosted service.

`DESIGN.md` is the source of truth for the domain and CLI contracts. `IMPROVEMENT_PLAN.md` records the decisions and improvement program that produced the current v1.

## Build and check

finbook requires Node 24.19.0 or newer within major 24 and pnpm 11.24.0.

```sh
corepack pnpm install
corepack pnpm check
corepack pnpm build
```

For development from this checkout, define a shell function and use a temporary book:

```sh
export FINBOOK_HOME="$(mktemp -d)"
finbook() { node packages/cli/dist/main.js "$@"; }
finbook --help
```

The CLI is non-interactive. Human-readable tables are the default; `--json` returns a stable `{ ok, data }` or `{ ok, error }` envelope. Empty lists are successful. Data goes to stdout, diagnostics go to stderr, and exit codes distinguish external failure (`1`), validation/conflict (`2`), and not found (`3`).

## First book

Create two owned accounts and one instrument:

```sh
finbook account add --id myinvestor --name MyInvestor --platform myinvestor --country ES --custodial broker
finbook account add --id ib --name "Interactive Brokers" --platform interactive-brokers --country IE --custodial broker
finbook instrument add --id HROW --name Harrow --type stock --quote-currency USD
```

A `deposit` is money entering your financial life. A movement between two accounts you own is a `transfer`, so it does not inflate contributions:

```sh
finbook event add deposit --id deposit-1 --date 2026-03-03 --account myinvestor --amount 800 --currency EUR
finbook event add transfer --id transfer-1 --date 2026-03-03 --from myinvestor --to ib --amount 800 --currency EUR
```

Record an FX conversion and a purchase. `eurPerUnit` is the historical EUR value of one unit of the event currency:

```sh
finbook event add fx --id fx-1 --date 2026-03-03 --account ib --from-amount 798 --from-currency EUR --to-amount 927.04 --to-currency USD --fee-amount 1.71 --fee-currency EUR
finbook event add buy --id buy-hrow --date 2026-03-03 --account ib --instrument HROW --qty 20 --price-amount 40.45 --price-currency USD --fee-amount 0.28 --fee-currency USD --eur-per-unit 0.861
```

Add current valuation marks and inspect the result:

```sh
finbook price set --instrument HROW --amount 41 --currency USD --as-of 2026-03-04
finbook fx set --pair USD/EUR --rate 0.866 --as-of 2026-03-04
finbook show glance --as-of 2026-03-04
finbook show positions --as-of 2026-03-04
finbook doctor
```

Event history keeps ledger order and can be narrowed without changing it. Repeated values in one filter are OR; different filter dimensions are AND:

```sh
finbook event list --type buy --type sell --instrument HROW --source manual --from 2026-01-01
finbook event get buy-hrow
```

## Correcting events safely

Edits keep omitted fields unchanged. Before committing an edit or deletion, finbook replays the complete candidate ledger and rejects any change that would make a later event invalid.

This sale consumes all 20 units, so reducing the earlier purchase to 15 is rejected and writes nothing:

```sh
finbook event add sell --id sell-hrow --date 2026-03-05 --account ib --instrument HROW --qty 20 --price-amount 41 --price-currency USD --eur-per-unit 0.866
finbook event edit buy buy-hrow --qty 15
```

After removing the dependent sale, the edit is valid:

```sh
finbook event delete sell-hrow
finbook event edit buy buy-hrow --qty 15
finbook event get buy-hrow
```

Deletion is immediate and non-interactive. There is no automatic backup, undo log, tombstone, or hidden history. If you want a safety copy before a bulk correction, copy `$FINBOOK_HOME` yourself.

## Missing and fetched market data

Views remain useful when a valuation mark is missing. They show partial totals plus an exact manual remedy and the corresponding fetch command:

```text
missing data
- FX USD/EUR as of 2026-03-04
  add: finbook fx set --pair USD/EUR --rate <decimal> --as-of 2026-03-04
  or:  finbook show glance --as-of 2026-03-04 --fetch
```

Resolve that hole manually with a known rate:

```sh
finbook fx set --pair USD/EUR --rate 0.866 --as-of 2026-03-04
```

Or fetch only the marks required by a view:

```sh
finbook show glance --fetch
finbook show glance --as-of 2026-03-04 --fetch
```

A complete fetch exits `0`. A partial fetch preserves every successful mark, returns the usable partial view, reports each failed need, and exits `1`. JSON mode returns one `ok: false` envelope with the partial view under `error.details`, so a script can inspect the saved work and retry safely.

Rate-bearing events require their historical `eurPerUnit`. Supply it directly or explicitly fetch it before writing:

```sh
finbook event add buy --date 2026-03-06 --account ib --instrument HROW --qty 1 --price-amount 42 --price-currency USD --eur-per-unit 0.87
finbook event add buy --date 2026-03-06 --account ib --instrument HROW --qty 1 --price-amount 42 --price-currency USD --fetch-rate
```

Configure non-secret routes and source bindings separately:

```sh
finbook config provider list
finbook config source set --instrument HROW --provider yahoo --identifier HROW
finbook config source set --currency BTC --provider coingecko --identifier bitcoin
```

An instrument binding must reference an instrument already in the book. Currency bindings only require a valid uppercase currency shape because finbook has no currency registry.

CoinGecko credentials come from the environment and are never stored:

```sh
export FINBOOK_COINGECKO_DEMO_API_KEY="replace-with-your-key"
```

## Dates and local data

Event dates, mark dates, and `asOf` values are daily economic dates written as `YYYY-MM-DD`; they do not represent a time of day or timezone. An omitted current-view date uses the machine-local calendar day. Provider retrieval timestamps are stored as UTC instants.

Book data lives in `$FINBOOK_HOME` (default `~/.finbook`), never in this checkout. It contains private financial information. Do not commit or upload it to a remote repository. Provider credentials also do not belong in the checkout, book files, command output, or logs.

`finbook doctor` is offline and read-only. It validates stored schemas, replay, configuration, permissions, lock ownership, and valuation completeness without initializing, repairing, unlocking, fetching, or exposing event payloads or credentials:

```sh
finbook doctor
finbook doctor --json
```
