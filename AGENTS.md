# finbook agent instructions

## What this is

finbook is a local, single-user financial event book. `packages/core` owns deterministic domain logic and the local file adapter; `packages/market-data` owns external price/FX adapters and cache orchestration; `packages/cli` owns process boot, argv parsing, output, and exit codes. `packages/app` is reserved.

## Commands and the bar

Use the pinned package manager through Corepack:

```sh
corepack pnpm check
```

`pnpm check` runs typechecking, type-aware linting, formatting checks, and tests. Do not declare work complete until it passes. A behavior change adds the boundary test named in `DESIGN.md`.

## Boundaries and parsing

Parse environment values, CLI input, file lines, and JSON with Zod at their boundary. Pass the parsed value downstream; do not re-parse raw input in core. Keep decimal values as strings on disk and on the wire, and use `decimal.js` for arithmetic.

The book lives at `$FINBOOK_HOME`, never in the checkout. Tests use a temporary data directory. Core accounting, replay, and queries do not perform I/O or read ambient environment state. Market-data fetching is explicit; successful marks are appended one at a time so interrupted runs resume from the cache.

## Error model

Expected validation, not-found, and domain failures return the stable `ok: false` result and are mapped by the CLI to the documented exit code. Broken internal invariants are bugs and fail loudly. JSON mode keeps its envelope on failure; data stays on stdout and diagnostics stay on stderr.

## Test conventions

Do not use module mocks. Use in-process tests for pure core behavior, a real temporary filesystem for storage behavior, and the built CLI binary for CLI behavior. Tests assert domain invariants and failure paths, not private helpers or incidental structure.

## External data and dependencies

`packages/market-data` is the only network boundary. Validate provider responses with Zod and pass normalized decimal strings into core. Use environment variables for provider credentials; never log or persist them. Keep live network calls out of the normal gate by testing adapters with fixtures and local HTTP servers.

Before adding a dependency, check the standard library, Node, and the packages already installed. Keep broker parsers, schedulers, Effect, and tax reports out of the current scope.
