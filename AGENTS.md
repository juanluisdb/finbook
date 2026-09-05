# finbook agent instructions

## Orient the change

finbook is a local, single-user financial event book.

`packages/core` owns schemas, decimal arithmetic, deterministic accounting, replay, queries, and the local file adapter. `packages/market-data` owns provider contracts, adapters, non-secret configuration, routing, and cache orchestration. `packages/cli` owns process boot, argv parsing, input preparation, rendering, and exit codes. `packages/app` is reserved.

Respect the dependency direction: CLI composes core and market data; market data depends on core; core does not depend on either outer package.

## Read the owning design

Read `docs/PRODUCT.md` before changing user-visible behaviour, financial meaning, event semantics, valuation semantics, or product scope.

Read `docs/DESIGN.md` before changing package responsibilities, parsing boundaries, persistence, locking, replay, mutation, errors, CLI contracts, or verification strategy.

Read `docs/MARKET_DATA.md` before changing providers, capabilities, source configuration, routing, fetching, retries, caching, or historical-rate resolution.

Update the owning document in the same change when its mental model, constraints, or guarantees change. Follow `docs/AGENTS.md` whenever editing files under `docs/`.

The README is the product entry point. Update it when installation, first-use workflow, common commands, or user-facing capabilities change.

## Run the repository gate

Use the pinned package manager through Corepack:

```sh
corepack pnpm check
```

`pnpm check` runs typechecking, type-aware linting, formatting checks, and tests. Do not declare work complete until it passes.

## Protect domain boundaries

Parse environment values, CLI input, stored file content, and provider responses with Zod at their boundary. Pass parsed values downstream instead of re-parsing raw input in core.

Keep decimal values as strings on disk and across package boundaries. Use `decimal.js` through the core decimal and money abstractions for arithmetic.

Core accounting, replay, and queries receive all inputs explicitly and do not perform I/O or read ambient environment state.

Expected validation, not-found, conflict, invariant, storage, and external failures use the stable `Result` error model. Broken internal assumptions fail loudly.

## Protect local data

The book lives at `$FINBOOK_HOME`, never in the checkout. Tests use a temporary data directory.

Route ordinary local book reads and all writes through the file adapter and book lock. Keep inspection paths read-only and non-initializing. Event mutations validate the complete candidate ledger before commit.

`packages/market-data` is the only network boundary. Provider credentials come from environment variables and must never be logged, rendered, or persisted.

Fetched price and FX observations are appended one at a time so interrupted work retains successful marks. Keep live network calls out of the normal repository gate.

Before adding a dependency, check the standard library, Node, and packages already installed.

## Test at the owning boundary

Use in-process tests for pure core behaviour, a real temporary filesystem for storage and configuration behaviour, controlled provider fixtures or local HTTP behaviour for adapters, and the built CLI binary for CLI behaviour.

Test domain invariants and public failure paths rather than private helpers or incidental structure. A behaviour change adds coverage at the narrowest boundary that owns the guarantee.
