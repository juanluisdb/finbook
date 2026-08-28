# finbook

finbook is a local, CLI-first book of economic events. It derives cash, positions, contributions, and a EUR glance from an append-only event ledger. It is not a broker, trading tool, or tax-filing product.

`DESIGN.md` is the source of truth for v1 scope, domain rules, CLI contracts, tests, and milestones.

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

The CLI is non-interactive. Use `--json` for the stable `{ ok, data }` or `{ ok, error }` envelope. Monetary values are decimal strings inside `Money` objects.

Book data belongs in `$FINBOOK_HOME` (default `~/.finbook`), never in this checkout. Use a temporary directory for tests and examples.
