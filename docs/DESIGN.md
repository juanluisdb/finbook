# Engineering design

finbook is a local, single-process CLI around a deterministic financial event model and an inspectable file store.

The [product contract](PRODUCT.md) owns what the book means to a user. This document explains the engineering boundaries that preserve those semantics. [Market data](MARKET_DATA.md) owns provider routing, fetching, and cache orchestration.

## Follow the dependency direction

```text
argv and environment
        |
        v
packages/cli  --------->  packages/market-data
        |                         |
        +------------+------------+
                     v
                packages/core
                     |
                     v
               $FINBOOK_HOME
```

`packages/core` owns schemas, decimal arithmetic, event application, replay, queries, the local file adapter, and the shared result model.

`packages/market-data` owns historical acquisition, normalized provider contracts, non-secret source configuration, provider adapters, routing, retries, and incremental cache writes. It derives valuation needs from core queries and depends on core types and storage; core has no knowledge of provider protocols or acquisition timing.

`packages/cli` owns process boot, environment parsing, Commander registration, input preparation, human and JSON rendering, and exit codes. It composes core and market data without moving their rules into command handlers.

`packages/app` is reserved and has no responsibility in the current system.

The public package surfaces are `packages/core/src/index.ts` and `packages/market-data/src/index.ts`. New cross-package dependencies should enter through those exports instead of reaching into another package’s private module.

## Keep computation pure

Event application is a pure state transition in `packages/core/src/domain/apply.ts::apply`.

Replay in `packages/core/src/domain/replay.ts::replayEvents` orders the selected events and folds them through `apply`. Queries in `packages/core/src/domain/queries.ts::getPositions` and `packages/core/src/domain/queries.ts::getGlance` replay a snapshot and then value the derived state.

`packages/core/src/domain/queries.ts::getHistory` composes the same dated glance over an inclusive daily interval. It stores no derived daily totals and carries no independent accounting rules.

These functions do not read files, environment variables, clocks, or providers. Their inputs contain every fact needed to produce the result.

`packages/core/src/domain/apply.ts::applySell` subtracts disposed units from aggregate holdings before allocating the remaining quantity across lots. The final allocation takes the explicit unit residual; non-final allocations cannot exceed the quantity still unallocated. Proportional cost allocation remains separate from that exact total.

The file adapter and CLI perform effects around this deterministic center. Clocks, ID generators, provider gateways, and fetch implementations are passed in at effect boundaries where tests need control.

## Parse each boundary once

Zod schemas validate CLI option objects, canonical event files, environment-derived configuration, stored JSON, stored JSONL, and provider responses.

The boundary passes parsed values downstream. Core logic does not re-interpret raw argv, JSON, file lines, or provider payloads.

Decimal values remain strings on disk and across package boundaries. `packages/core/src/domain/decimal.ts::DecimalMath` and `packages/core/src/domain/money.ts::MoneyValue` own arithmetic and currency-safe operations.

Trade settlement uses the reported gross cash amount rather than multiplying quantity by the displayed unit price. The price remains an independent transaction fact for display; it is not a valuation fallback. `packages/core/src/domain/schemas.ts::TradeFeeSchema` distinguishes quote-currency fees from instrument-quantity fees, and `packages/core/src/domain/apply.ts::apply` applies each to cash or holdings at replay time.

Broken user input and persisted data return typed domain failures. Impossible internal states throw rather than being translated into ordinary validation errors.

## Treat the snapshot as input

`packages/core/src/domain/snapshot.ts::BookSnapshot` groups the account catalog, instrument catalog, ordered events, price stamps, and FX stamps loaded from disk.

The snapshot contains facts, not cached balances or positions. Derived state is recreated by replay so a single accounting path serves writes, reads, and inspection.

Event ordering is centralized in `packages/core/src/domain/replay.ts::orderEvents`: economic date is primary and original ledger position is the stable tie-breaker.

Query valuation selects the latest eligible stamp by economic date. On the same date, manual provenance takes priority over fetched provenance; append order breaks ties within that priority. `packages/core/src/domain/queries.ts::priceStampAt` and `packages/core/src/domain/queries.ts::fxStampAt` own selection, and query results carry the selected evidence so renderers do not reimplement it.

## Make the file store the mutation boundary

`packages/core/src/domain/store.ts::FileBookStore` is the only adapter that owns the persisted book.

```text
$FINBOOK_HOME/
  meta.json
  accounts.json
  instruments.json
  events.jsonl
  prices.jsonl
  fx.jsonl
  market-data.json
  market-history.jsonl
```

`meta.json` carries the schema version and book timezone. Accounts and instruments are JSON arrays. Events, prices, and FX rates are JSONL so ledger order and append order remain explicit. Market-data configuration is described in [Market data](MARKET_DATA.md).

Loading validates every complete file before returning a snapshot. An invalid or empty JSONL record identifies its file and line rather than being skipped.

The adapter initializes the complete core file set only when none of those files exist. If some core files exist and others are missing, ordinary reads and mutations fail without recreating them. Configuration-only first use remains valid; optional market-data files do not determine core initialization. `packages/core/src/domain/store.ts::FileBookStore.inspect` reads an existing book without creating it. This detects partial core-file loss; removing the entire core book is indistinguishable from a new home.

Account and instrument writes replace their JSON file atomically. Event add, replacement, and deletion construct the complete candidate sequence, replay it, and atomically replace `events.jsonl` only after validation succeeds.

Price and FX stamps append one normalized record at a time. Their ordering is useful cache state, and retaining each successful fetch makes interrupted work resumable. Market data writes a resolution receipt only after all of its observations are persisted; the receipt never substitutes for the observation itself.

Manual marks retain same-date precedence. Corrections append an explicit price or FX observation through the same file adapter; acquisition does not remove manual facts or bulk-replace them with provider candidates.

Temporary files are written in the same directory as their target before rename. A failure after the rename is reported as a mutation that may have committed so callers do not retry blindly.

The store keeps the data directory owner-only and regular book files owner-readable and owner-writable on platforms that expose POSIX permissions.

`packages/core/src/version.ts::CURRENT_SCHEMA_VERSION` identifies the persisted schema. Core validates metadata before reading or writing book facts.

## Keep the book outside the running checkout

`packages/cli/src/environment.ts::loadRuntimeConfig` resolves relative user paths against the caller's directory and derives the protected checkout from the running module's source/built monorepo location. Canonical path comparison includes existing symlinked parents of a not-yet-created data directory. The caller's directory is not the checkout boundary. This prevents accidental placement of private book data; it is not a sandbox against concurrent filesystem changes by the owner.

## Serialize access to one book

Every store operation that may initialize, read for mutation, or write uses `packages/core/src/domain/lock.ts::withBookLock`.

The lock is an owner-only directory containing a validated owner record with process, host, creation instant, and acquisition token. Directory creation provides mutual exclusion for independent CLI processes.

An existing live, abandoned, or uncertain lock prevents the protected operation from running. finbook never reclaims a stale lock automatically: inspecting ownership and subsequently deleting a pathname cannot guarantee that the pathname still belongs to that owner. Failures name the lock and advise waiting for a live owner or confirming that no process uses the book before manual recovery. Failed acquisition cleans up a directory only when that acquisition created it.

Release verifies the acquisition token before removing the lock. A release failure reports that the operation may have committed.

`packages/core/src/domain/lock.ts::inspectBookLock` classifies a lock without acquiring or reclaiming it so doctor remains read-only.

This lock protects one local book from concurrent CLI processes. It is not a distributed lock or a synchronization protocol for replicated folders.

`packages/core/src/domain/lock.ts::withRefreshLock` uses a separate per-book refresh lock over the asynchronous provider operation. A competing refresh fails fast and can retry after completion. Ordinary book locks cover only local reads and commits, not network waits. Both locks use the same ownership and manual recovery rules.

## Prevent stale event edits

The CLI reads the target event before preparing a replacement, including any historical-rate fetch.

`packages/core/src/domain/store.ts::FileBookStore.replaceEvent` receives that expected event and compares it with the current record while holding the book lock. A changed or deleted target produces a conflict instead of overwriting concurrent work.

Replacement keeps identity fields and line position stable. Deletion and replacement both replay the complete candidate ledger, so removing or weakening an earlier event cannot leave a later event invalid.

No backup or event-history layer sits behind this operation. Atomicity protects the current file from partial writes; it does not provide undo.

## Keep errors useful at each layer

`packages/core/src/domain/result.ts::Result` carries expected validation, not-found, conflict, invariant, storage, external, and internal failures with a message and corrective hint.

Core and adapters return failures that callers can handle. Internal programming errors still fail loudly.

`packages/cli/src/errors.ts::exitCodeFor` maps not-found failures to exit code `3`, validation/conflict/invariant failures to `2`, and storage/external/internal failures to `1`. Success, including an empty result, is `0`.

`packages/cli/src/output.ts::writeSuccess` and `packages/cli/src/output.ts::writeError` keep the JSON envelope stable. JSON results go to stdout; human failures and diagnostics go to stderr.

An incomplete update is an external failure even when it saves useful observations. The CLI returns the saved-work report and failed ranges; offline views remain available from those persisted facts.

## Keep the CLI as an adapter

`packages/cli/src/program.ts::createProgram` defines the discoverable command hierarchy and help. Commander parses argv shape; Zod in the command-specific input modules validates the resulting values.

Typed event commands expose only the legal flags for their event variant. File input accepts one canonical event object and reaches the same core mutation boundary.

`packages/cli/src/event-input.ts::parseAddInput` and `packages/cli/src/event-input.ts::parseEditInput` own event option validation. Input preparation resolves defaults and optional historical rates before asking the store to commit.

Event preparation distinguishes required contribution rates from optional reporting evidence. A rate-free optional event triggers no provider call. Explicit `--fetch-rate` must resolve successfully before saving. Typed optional-rate edits expose `--clear-eur-rate`; stale supplied foreign rates require replacement or clearing, while unrelated edits retain them. Core schemas reject orphaned rate provenance and invalid effective dates.

Trade input requires the exact gross amount. Fee source and amount are supplied together; an omitted pair means no fee. Edits preserve an existing fee only while its unit remains unchanged, and require an explicit replacement amount or clear when a quote currency or instrument change would reinterpret that value.

Human renderers in `packages/cli/src/human-output.ts` consume the same filtered or derived values as JSON mode. Filtering and query semantics happen before presentation so output mode cannot change results.

`packages/cli/src/main.ts::main` is the process boundary. It validates the runtime, resolves `FINBOOK_HOME`, constructs concrete providers lazily, maps expected failures, and returns the process exit code.

## Inspect without changing state

`packages/cli/src/doctor.ts::inspectDoctor` combines read-only book, lock, filesystem, market-config, replay, and valuation inspections.

An absent home is a valid uninitialized state. Valuation holes and known active or stale same-host locks are warnings; malformed data, failed replay, unsafe permissions, or uncertain lock ownership are errors.

Doctor must not call an initializing load path, acquire or reclaim a lock, fetch data, repair files, change permissions, or include event payloads and credentials in its report.

## Verify behaviour at its owning boundary

Pure accounting, replay, and query behaviour uses in-process tests under `packages/core/tests`.

Persistence and locking use real temporary directories rather than mocked filesystem modules.

Provider adapters use fixtures or local HTTP behaviour without live network calls. Coordinator tests use small in-process sources and the real storage contract needed by the scenario.

CLI behaviour runs the built binary against temporary book directories so argv parsing, stdout, stderr, and exit codes are covered together.

Tests should assert domain invariants and public failure behaviour, not private helpers or incidental object construction. A behaviour change adds coverage at the narrowest boundary that owns the guarantee.

The repository gate in `package.json::scripts.check` runs typechecking, type-aware linting, formatting checks, and tests.
