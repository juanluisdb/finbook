# finbook

finbook is a local, CLI-first book of economic events. It derives cash, positions, contributions, and a EUR glance from an append-only event ledger. It is not a broker, trading tool, or tax-filing product.

`DESIGN.md` is the source of truth for scope, domain rules, CLI contracts, tests, and milestones.

## Development

The project requires Node 24.19.0 or newer within major 24 and pnpm 11.24.0.

```sh
corepack pnpm install
corepack pnpm check
```

Build the CLI and run it from the emitted `dist` path:

```sh
corepack pnpm build
FINBOOK_HOME=/tmp/finbook-data node packages/cli/dist/main.js --help
FINBOOK_HOME=/tmp/finbook-data node packages/cli/dist/main.js doctor --json
```

## Market data

Events that affect EUR accounting require `eurPerUnit`. Enter it directly, or explicitly fetch it while creating the event:

```sh
finbook event add buy ... --eur-per-unit 0.925
finbook event add buy ... --fetch-rate
```

Current and historical visualization marks can be fetched explicitly:

```sh
finbook show glance --fetch
finbook show glance --as-of 2026-08-05 --fetch
```

With all requested providers available, the first command exits `0` and returns the ordinary glance success envelope (or the compact human view). A partial fetch keeps every successful mark, shows the usable partial view, reports each failed need, and exits `1`; JSON mode keeps one `ok: false` envelope with the partial view under `error.details` so scripts can retry safely.

Fetched prices and FX marks are cached one observation at a time. If a command stops part-way through a batch, rerunning it naturally reuses the successful cached marks.

Provider configuration is non-secret:

```sh
finbook config provider list
finbook config source set --instrument VWCE --provider yahoo --identifier VWCE.DE
finbook config source set --currency BTC --provider coingecko --identifier bitcoin
```

Provider credentials use environment variables and are never stored in the book. For example:

```sh
export FINBOOK_COINGECKO_DEMO_API_KEY=...
```

The CLI is non-interactive. Use `--json` for the stable `{ ok, data }` or `{ ok, error }` envelope. Monetary values are decimal strings inside `Money` objects.

Book data belongs in `$FINBOOK_HOME` (default `~/.finbook`), never in this checkout. Use a temporary directory for tests and examples.
