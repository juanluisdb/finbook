# finbook improvement plan

finbook does not need a platform rewrite. It needs to make every accepted command trustworthy: a write must leave a replayable book, a market-data request must not quietly use the wrong observation, and incomplete results must look incomplete to both a person and a script.

This plan was originally based on the repository at `21e9bef`, the then-current `DESIGN.md`, the full source and test suite, and the attached testing rules. It is now updated against `main` at merge commit `2003ef1`. [PR #1 — Make reads and market-data fetching correct and honest](https://github.com/juanluisdb/finbook/pull/1) and [PR #2 — Make book mutations safe and add corrections](https://github.com/juanluisdb/finbook/pull/2) are complete. The normal project gate passes 169 tests across 25 test files.

## Outcome

After the **Now** work:

- Every book mutation is validated and persisted as one local critical section.
- A direct core consumer cannot append an event that makes the ledger invalid.
- Event mistakes can be edited or deleted through strict type-specific commands.
- A rejected edit or deletion leaves the original bytes unchanged.
- Commands reject irrelevant flags instead of silently discarding them.
- `--fetch` never reports complete success when any requested provider operation failed.
- Current market fetches cannot be satisfied by a stale historical request made today.
- Historical provider routing, non-trading days, and mixed crypto quote currencies behave predictably.
- Human output exposes the date and every valuation hole; JSON and exit codes remain stable and scriptable.
- Help is side-effect free, current views use the machine's local calendar date, and genuine timestamps remain UTC.

The quality bar is a dense, non-interactive CLI with actionable errors. There will be no prompts, dashboards, telemetry service, database, distributed lock, or speculative abstraction.

## Current assessment

### What is already strong

- The event ledger is the source of truth; cash, positions, contribution, P&L, and weights are derived.
- Core replay and queries are deterministic and free of I/O and ambient environment state.
- Decimal values stay as strings at boundaries and use `decimal.js` for arithmetic.
- Zod validates CLI, file, configuration, and provider inputs.
- Expected failures use a stable result model; JSON keeps a consistent success/error envelope.
- Market providers are isolated behind owned interfaces, and normalized observations are persisted one at a time.
- Tests use pure in-process core calls, real temporary filesystems, local HTTP, and the built CLI. There are no module mocks.
- The entire suite is fast enough to remain a single local gate.

These foundations should be deepened, not replaced.

### Baseline defects and remaining trust gaps

This table preserves the original review baseline while making roadmap progress explicit. “Done” rows shipped in PR 1 or PR 2; the baseline behavior is retained as the reason for the change rather than presented as the current code.

| Area                    | Status | Baseline behavior                                                                                                                                       | Required behavior                                                                                                                                               |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest cache            | Done   | A historical price or FX mark retrieved today could satisfy a later `latest` request (`packages/market-data/src/coordinator.ts`).                       | `latest --fetch` performs a current provider request. Historical marks remain valid for historical valuation only.                                              |
| Historical crypto rates | Done   | The default `eur-rate:crypto` route was unreachable without an explicit provider/binding path; unbound BTC fell into the fiat route.                    | A crypto currency binding selects the crypto-rate route and supplies its provider identifier. An unbound unsupported currency gets an actionable binding error. |
| Disabled providers      | Done   | Explicit pins and source bindings could bypass `disabledProviders`.                                                                                     | Disabled is a global hard-off switch. A pin or binding to a disabled provider fails before network I/O.                                                         |
| Route validity          | Done   | Configuration could express provider/route combinations the provider cannot serve.                                                                      | One provider-capability registry validates defaults, overrides, bindings, and explicit pins.                                                                    |
| Yahoo history           | Done   | A historical query requested only the requested UTC day, so weekends and holidays could miss the prior close (`packages/market-data/src/yahoo.ts`).     | Search a bounded prior window and select the last close on or before the requested date.                                                                        |
| CoinGecko batches       | Done   | The coordinator grouped by provider, while CoinGecko accepts one quote currency per batch (`packages/market-data/src/coingecko.ts`).                    | CoinGecko partitions its own requests by quote currency. Provider-specific batching stays inside the adapter.                                                   |
| Partial fetches         | Done   | Coordinator reports contained failures, but the CLI discarded them and exited zero (`packages/cli/src/program.ts`).                                     | Persist successes, render the usable partial view, report every failure, and exit nonzero.                                                                      |
| Event flags             | Done   | `event add <type>` registers every event option; known but irrelevant flags are silently ignored.                                                       | Each type exposes and accepts only its own fields.                                                                                                              |
| Root JSON               | Done   | `finbook --json` reached Commander's help path and returned a malformed validation message.                                                             | Return one valid JSON error envelope with exit 2.                                                                                                               |
| Help side effects       | Done   | Startup loaded market configuration before parsing help and could create `market-data.json`.                                                            | Help and version paths do not touch `FINBOOK_HOME`.                                                                                                             |
| Current date            | Done   | `toISOString().slice(0, 10)` used the UTC day for a local view.                                                                                         | Omitted current-view dates use the machine's local calendar day and always print the resolved `asOf`.                                                           |
| Domain writes           | Done   | The CLI replays a candidate, then `FileBookStore.appendEvent` separately loads and appends. Direct consumers bypass replay, and two processes can race. | The core file adapter owns lock → load → candidate replay → persistence.                                                                                        |
| Event correction        | Done   | The only correction path is manual JSONL editing.                                                                                                       | Validated `event edit <type> <id>` and `event delete <id>` commands.                                                                                            |
| Event durability        | Done   | A process can leave a partial appended JSONL line.                                                                                                      | Event mutations write a complete temporary JSONL file and atomically rename it.                                                                                 |
| Directory permissions   | Done   | `mkdir(..., mode: 0700)` does not repair an already-existing permissive directory.                                                                      | Enforce `0700` on the data directory and `0600` on files where the platform supports it.                                                                        |
| Human views             | PR 3   | Glance prints only a hole count; positions omit `asOf` and holes; event rows do not summarize the transaction.                                          | Compact summaries include the resolved date and actionable missing-data details.                                                                                |

### Test-suite assessment

The suite has the right architecture. It does not need a target ratio or a new testing framework. Core logic is naturally dominated by small tests, while the filesystem and built CLI correctly use medium tests.

PR 1 added the current-date, cache-mode, provider routing/capability, partial-fetch, and root CLI guarantees. PR 2 added direct-store mutation invariants, process-level lock/concurrency cases, byte-preserving rejection cases, strict typed command coverage, and the complete edit/delete workflow. The remaining weaknesses are guarantee coverage and test focus:

- `packages/core/tests/tooling.test.ts` is tautological and proves nothing.
- A few eager tests combine several behaviors, notably income events, accounting failures, as-of queries, provider configuration, and file-store initialization.
- The accounting test named for unknown IDs, oversells, and negative cash does not exercise an actual oversell.
- Same-date replay order, future-event as-of filtering, same-date FX last-wins, and derived-state reload equivalence are not pinned.
- CLI tests still do not cover incomplete human views, detailed doctor outcomes, or all read-boundary error mappings.
- Provider fixtures for Yahoo and CoinGecko are still authored from the code's expected shape rather than maintained as captured raw provider samples.
- `fetch-rate.test.ts` writes to process output during a lower-level orchestration test.
- `pnpm test` depends on an already-built CLI; only `pnpm check` reliably builds before testing.

The plan below adds tests with each behavior change and performs only the cleanup that improves diagnostic value. The normal-week CLI workflow remains as the single broad acceptance test.

## Settled design

### Product and scope

- This remains a local, single-user CLI and one live copy of `FINBOOK_HOME`.
- The roadmap is tiered: **Now** is committed trust work, **Next** is worthwhile polish, and **Later** has explicit triggers.
- Valid existing `event add <type>` commands remain valid.
- Human output is compact; error messages name what failed, the affected entity, whether anything was written, and the next action.
- JSON remains `{ ok: true, data } | { ok: false, error }`. An optional structured `error.details` field is additive.
- External/provider failures continue to use the existing nonzero exit 1. Validation and invariant failures use 2; not-found uses 3. A new exit-code taxonomy is not justified yet.

### Date and time model

| Fact                      | Stored representation       |
| ------------------------- | --------------------------- |
| Event trade/value date    | Calendar date, `YYYY-MM-DD` |
| Price/FX effective date   | Calendar date, `YYYY-MM-DD` |
| Provider retrieval time   | UTC ISO instant             |
| Same-day event order      | Stable JSONL line order     |
| Omitted current-view date | Machine-local calendar date |

Economic dates are not converted through a timezone. Intraday accounting, execution timestamps, and settlement timestamps stay out of scope. A persisted IANA book timezone is deferred until the book is routinely used across machines or while travelling.

### Event mutation model

`FileBookStore` becomes the deep local-book boundary; do not add a pass-through repository or service above it.

```text
CLI parses a type-specific command
  → constructs a parsed event or edit
  → FileBookStore mutation
      → acquire FINBOOK_HOME lock
      → load and parse the latest files
      → construct the candidate event sequence
      → validate uniqueness and immutable fields
      → replay the entire candidate sequence
      → write complete temporary events.jsonl
      → atomic rename over events.jsonl
      → release lock in finally
  → render the committed result
```

Rules:

- `addEvent`, `editEvent`, and `deleteEvent` all use this path. The CLI does not perform a separate authoritative preflight.
- The edited event keeps its line position, so same-date append order does not change accidentally.
- Type-specific edits preserve `id`, `type`, `source`, and `externalId`.
- Unspecified fields retain their previous values. Clearing an optional field uses an explicit flag such as `--clear-note` or `--clear-fee`; omission never means deletion.
- Changing event type is delete plus add, not an edit.
- A failed mutation leaves `events.jsonl` byte-for-byte unchanged.
- Successful edits and deletions are intentionally irreversible in this phase. finbook creates no backup or hidden history.
- Additions remain append-like in meaning, but `events.jsonl` is no longer described as physically append-only. It is an ordered, inspectable JSONL ledger that explicit correction commands may atomically rewrite.

The local lock is a small lock directory created atomically under `FINBOOK_HOME`. Its owner record contains PID, hostname, creation time, and a unique acquisition token. It fails fast with a stable “book is busy” error when active and can reclaim a same-host lock whose PID definitely no longer exists by first moving the stale directory aside. A foreign-host, malformed, missing, or just-created owner record is treated as active; PR 2 provides safe manual guidance, and PR 3's `doctor` makes the diagnosis friendlier. No lock is held across a provider network call. Each normalized market observation acquires the lock only for its local append.

Whole-file event rewrites are acceptable because replay already reads every event and the expected book is small. Do not add SQLite, a WAL, `fsync` policy, or a background lock manager without measured evidence.

### CLI command shape

```text
event
├── add
│   ├── deposit
│   ├── withdrawal
│   ├── transfer
│   ├── fx
│   ├── buy
│   ├── sell
│   ├── dividend
│   ├── interest
│   └── fee
├── edit
│   └── <the same type set> <id>
├── delete <id>
├── list
└── get <id>
```

`event add --file <path>` remains supported for compatibility and automation. It still passes through the canonical core mutation. Each typed command owns its legal options and examples; a shared helper is limited to genuinely shared base fields.

### Market-data behavior

- Historical needs reuse any valid observation whose effective date is on or before the requested date, preserving interrupted historical-batch resume.
- A `latest --fetch` request always reaches a provider. This is the simplest correct fix for historical-cache contamination and matches the explicit meaning of `--fetch`.
- Re-running an interrupted latest fetch may refetch successful needs. That extra local-tool network cost is accepted instead of adding request-intent metadata, a cache sidecar, or a persisted-schema migration.
- If repeated latest fetching becomes a real rate-limit problem, persisted fetch intent can be designed later with an explicit schema migration.
- Provider capabilities have one definition. Configuration, source bindings, default routes, and explicit pins all validate against it.
- A currency binding to a crypto-rate provider selects the crypto rate route and carries the provider identifier. An unbound unsupported currency fails with the exact `config source set --currency ...` next step.
- Disabled providers are never called, including through a binding or explicit pin.
- Yahoo searches a bounded ten-calendar-day window for the last close on or before a historical date. Ten days covers normal weekends and market holidays without turning one request into an unbounded history download.
- CoinGecko partitions current price needs by quote currency inside its adapter.

### Partial fetch contract

```text
fetch all requested price needs
  → append each success immediately
  → retain each per-need failure
fetch all requested FX needs
  → append each success immediately
  → retain each per-need failure
reload and derive the usable view
  → no failures: normal success, exit 0
  → any failure: partial view + structured failures, exit 1
```

Human mode writes the usable view to stdout and one actionable failure report to stderr. JSON mode writes one `{ ok: false, error }` envelope to stdout; `error.details` contains counts, per-need failures, and the partial view. Successful marks are not rolled back.

### Security and operations boundary

The relevant threat is another local OS user reading financial data or a credential leaking through output. There is no remote user, tenant, authentication system, or public server.

- Keep the directory `0700` and files `0600` where supported.
- Credentials remain environment-only and are absent from data, errors, and fixtures.
- Provider hosts remain fixed by adapters; do not add user-supplied fetch URLs.
- `doctor` and structured errors are the observability system. Do not add metrics, tracing, analytics, or a log service.
- A future literal Git integration must address accidental remotes and financial-data disclosure before it is considered safe.

## Now: pull request roadmap

The program is five substantial PRs: two are merged and the final three are specified below. The N1–N10 sections are case-level workstreams inside those PRs, not a request to open ten small reviews.

| PR                                                                       | Status                                                                    | Outcome                                                                                                            | Workstreams                                  | Dependency |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ---------- |
| **PR 1 — Make reads and market-data fetching correct and honest**        | **Done:** merged as [PR #1](https://github.com/juanluisdb/finbook/pull/1) | Current and historical views use the right date and provider behavior; a partial fetch cannot look successful.     | N1, N2, N6, contract docs, tests             | None       |
| **PR 2 — Make book mutations safe and add corrections**                  | **Done:** merged as [PR #2](https://github.com/juanluisdb/finbook/pull/2) | Every write uses one locked domain-aware boundary; users can edit/delete events through strict typed commands.     | N3, N4, N5, relevant N8 cases, contract docs | PR 1       |
| **PR 3 — Make history, holes, and book health actionable**               | **Implemented:** awaiting review                                          | Human reads explain what happened and what is missing; `doctor` diagnoses the local book without changing it.      | N7, focused docs and tests                   | PR 2       |
| **PR 4 — Make the remaining correctness guarantees explicit in tests**   | Planned                                                                   | The suite pins the remaining domain, replay, filesystem, CLI, and provider guarantees without brittle test layers. | N8, provider-fixture maintenance notes       | PR 3       |
| **PR 5 — Finish inspection guardrails, onboarding, and the v1 contract** | Planned                                                                   | Growing books remain easy to inspect, binding typos fail early, and docs/help match the final product end to end.  | N9, N10, final acceptance pass               | PR 4       |

Each PR must be internally complete: tests ship with behavior, `DESIGN.md` changes ship with the contract they describe, and `corepack pnpm check` is green. A later PR may strengthen an already-shipped guarantee, but it must not be used to defer the minimum regression test required by the PR that changes behavior.

### PR 1 — Make reads and market-data fetching correct and honest — completed

**Status:** completed and merged in [PR #1](https://github.com/juanluisdb/finbook/pull/1) on 2026-08-31. The merge commit on `main` is `a93c75c`; `corepack pnpm check` passed with 115 tests across 22 files. This section remains as the decision and acceptance record for the shipped work.

#### User-visible result

After this PR:

- `finbook show glance` and `show positions` resolve an omitted `--as-of` from the machine's local calendar date and print that date.
- `--fetch` means a real latest-provider request; a historical observation retrieved today cannot suppress it.
- Historical fetches still reuse persisted observations and resume successful items after interruption.
- Yahoo historical requests work on weekends and ordinary market holidays.
- CoinGecko can price crypto instruments with different quote currencies in one finbook operation.
- Disabled and incapable providers fail before network I/O, regardless of route, binding, or explicit pin.
- A partially successful fetch persists every success, renders the usable result, reports every failure, and exits 1.
- Help and no-command paths do not initialize market-data configuration.
- `finbook --json` without a command returns one valid validation envelope with exit 2.

This PR is intentionally broad enough to finish one product promise: a read with `--fetch` is correct and honest from process boot through provider normalization and final output. Splitting lazy boot, provider routing, cache semantics, and partial failures into separate PRs would create intermediate states that are individually green but still misleading to the user.

#### Scope

**In**

- N1 process boot and current-date behavior.
- N2 cache, routing, provider-capability, Yahoo, and CoinGecko corrections.
- N6 partial-fetch error/output contract.
- The PR 1 cases listed in N8.
- `DESIGN.md` and README changes required to describe these behaviors.

**Out**

- The local writer lock and atomic event rewrite.
- Event edit/delete.
- Per-type add/edit command trees.
- Rich event summaries, expanded hole rendering, and the full doctor redesign.
- Automatic backups, Git history, persisted timezone, CI, and persisted latest-fetch intent.

#### Contract to implement

Latest and historical modes remain explicit coordinator inputs:

```text
historical need
  cache hit when a valid matching mark has asOf <= requested asOf
  otherwise call the configured provider chain

latest need created by an omitted/current asOf
  never use the persisted mark cache to skip the request
  call the configured provider chain
  append each successful normalized mark
```

Provider choice follows one order:

```text
1. Parse and validate an explicit provider pin, if present.
2. Reject it if disabled or incapable of the requested operation.
3. Otherwise inspect the subject binding.
4. Reject the binding if its provider is disabled or incapable.
5. Otherwise use the effective configured route, already filtered by capability and disabled state.
6. Try fallback providers in route order; an explicit pin never falls back.
```

The provider-capability registry is the only definition of which provider supports which route. Default routes and config validation derive from it or are checked against it. Do not add parallel per-provider allowlists in the CLI and coordinator.

For historical EUR rates:

- A currency binding to CoinGecko classifies that subject as crypto, selects `eur-rate:crypto`, and passes the binding's identifier.
- A currency binding to ECB selects the fiat route.
- An unbound currency uses the fiat route. If every provider reports unsupported/not-found, the final error tells the user how to add a currency binding.
- `--provider` still requires `--fetch-rate` and cannot bypass disabled state or capability validation.

Partial fetch JSON has one envelope. Do not add a sibling `data` field to the failure variant:

```json
{
  "ok": false,
  "error": {
    "type": "external",
    "message": "Could not fetch every requested market-data observation.",
    "hint": "Retry the command or add the missing marks manually.",
    "details": {
      "requested": { "prices": 2, "fx": 1 },
      "saved": { "prices": 1, "fx": 1 },
      "failures": [
        {
          "kind": "price",
          "subject": "HROW",
          "provider": "yahoo",
          "reason": "unavailable",
          "message": "Provider request failed."
        }
      ],
      "partial": { "asOf": "2026-08-31" }
    }
  }
}
```

The actual `partial` value is the same public glance or positions shape the successful command would return. `error.details` is optional and additive; existing error fields and exit codes do not change.

Human mode writes the partial glance/positions to stdout, then one grouped diagnostic to stderr. Do not log each provider failure at multiple layers.

#### Target code shape

```text
packages/cli/src/
├── main.ts          lazy runtime/provider construction; root error handling
├── dates.ts         pure local-calendar date resolution
├── program.ts       fetch orchestration; partial result/error rendering
├── errors.ts        typed CLI/external failure carrying optional details
└── output.ts        one JSON envelope; stdout/stderr discipline

packages/market-data/src/
├── contracts.ts     provider capabilities and report contracts
├── config.ts        effective routes and global disabled semantics
├── coordinator.ts   latest/historical cache policy and fallback orchestration
├── yahoo.ts         bounded historical lookback
└── coingecko.ts     quote-currency partitioning inside the adapter
```

Keep provider-specific batch rules in the provider adapter. Keep CLI formatting out of market-data. Keep `currentDate` at the process boundary; core replay continues to accept an explicit `YYYY-MM-DD`.

#### Implementation order inside the PR

1. **Pin current defects with failing tests.** Add the latest-cache contamination, local-date boundary, root JSON, help side-effect, partial-fetch, Yahoo weekend, CoinGecko mixed-currency, and disabled-provider cases before changing production code. Run each narrow test and observe the expected failure.
2. **Make boot lazy and date resolution explicit.** Construct market configuration/providers only when a command needs them. Replace UTC slicing with an injected local-calendar helper. This gives the rest of the PR a stable definition of “current.”
3. **Introduce one provider-capability registry.** Route validation, explicit pins, bindings, and disabled state use it. Update config parsing/writes without changing the stored config shape.
4. **Correct provider adapters.** Give Yahoo a ten-day historical window and make CoinGecko partition current needs by quote currency. Validate against captured provider-shaped fixtures.
5. **Correct coordinator semantics.** Latest needs bypass persisted cache; historical needs retain cache reuse. Apply the agreed historical-rate route order and keep per-need failures distinguishable.
6. **Carry reports through the CLI.** Attempt independent price and FX work, persist successes, reload the snapshot, derive the partial view, and emit the agreed human/JSON failure contract.
7. **Update contracts and documentation.** Change the relevant `DESIGN.md` acceptance cases and README market-data examples in the same PR.
8. **Run the full gate and a fresh-home smoke pass.** `corepack pnpm check` must pass after the built-CLI cases, not only package-level tests.

These are implementation steps, not required commits. The coding agent may organize commits for review clarity without turning them into separate PRs.

#### Required tests by layer

**Small/in-process**

- `dates.test.ts`: an instant on the UTC/local boundary resolves to the machine-local calendar date when the test supplies the timezone/clock seam.
- `config.test.ts`: every configured/default route contains only capable providers; disabled providers are removed from routes and rejected through pins/bindings.
- `yahoo.test.ts`: a Saturday request selects Friday's captured close; no point in the ten-day window returns `not-found`; a future point is ignored.
- `coingecko.test.ts`: mixed EUR/USD crypto needs become two gateway requests and return one outcome per need.
- `coordinator.test.ts`: historical marks retrieved today do not satisfy latest price or FX needs; historical reruns still reuse successes; crypto bindings select the crypto route; explicit pins do not fall back.

**Medium/local collaborators**

- `commands.test.ts`: help/no-args do not create book/config files; root `--json` returns exit 2 and valid JSON; omitted view date is visible.
- A focused built-CLI market-fetch test: one provider success plus one failure persists the success, emits the agreed JSON details, and exits 1.
- The same built-CLI scenario in human mode: partial view on stdout, one grouped diagnostic on stderr, exit 1.
- Retain the local HTTP transport tests. Do not add live Yahoo, CoinGecko, or ECB calls.

Interaction assertions are allowed only where the behavior is the interaction: provider skipped, fallback attempted, request partitioned, or cache reused. Do not pin incidental batch sizes or internal helper calls.

#### Documentation changes in PR 1

`DESIGN.md` must state:

- omitted current-view dates use the machine-local day;
- economic dates remain timezone-free and retrieval instants remain UTC;
- latest `--fetch` always calls providers, while historical mode reuses cache;
- disabled/provider-capability semantics and crypto binding behavior;
- partial fetch output and exit behavior;
- Yahoo's bounded prior-date selection and CoinGecko's internal currency partitioning.

README examples must show one complete `--fetch` success and explain that a partial fetch saves successes but exits nonzero. Do not pull the full onboarding rewrite from PR 5 into this PR.

#### Compatibility, rollback, and risks

- No persisted book or market-config shape changes; no schema bump or migration.
- Existing valid CLI commands remain valid.
- Invalid provider routes and disabled-provider pins that were previously accepted now fail intentionally.
- Latest `--fetch` may make more provider calls than before. That is an accepted correctness trade-off; persisted latest-fetch intent remains Later work.
- `error.details` is additive. Consumers that only read `type`, `message`, and `hint` continue to work.
- Reverting the PR requires no data rollback. Marks written by the new code use existing schemas and remain readable by the old code.
- The main implementation risk is accidentally making historical mode refetch everything. The interrupted-historical-batch test is the guard.
- The second risk is reporting a partial failure before deriving the partial view. The built-CLI test must assert both persisted successes and the returned partial state.

#### PR 1 acceptance checklist

- [x] Every confirmed PR 1 bug has a regression test that failed before the fix.
- [x] `finbook --help` and no-argument help leave a fresh `FINBOOK_HOME` untouched.
- [x] `finbook --json` returns one parseable validation envelope and exit 2.
- [x] Current views use and display the local calendar date.
- [x] Latest price and FX requests cannot be skipped by historical marks retrieved today.
- [x] Historical reruns reuse prior successful observations.
- [x] Yahoo handles a weekend request and CoinGecko handles mixed quote currencies.
- [x] Disabled/incapable providers are rejected before network I/O through routes, bindings, and pins.
- [x] Partial fetches persist successes, return the partial view, expose per-need failures, and exit 1 in both output modes.
- [x] No credentials or raw provider payloads are printed or persisted.
- [x] `DESIGN.md` and the focused README market-data section match the implementation.
- [x] `corepack pnpm check` passes.

#### PR 1 review focus

Reviewers should spend their attention on four load-bearing expressions:

1. What classifies a need as latest versus historical at the CLI call site.
2. What can cause the coordinator to skip a provider call.
3. Whether every provider-selection path applies capability and disabled checks.
4. Whether partial fetch failures survive through the final CLI envelope and exit status.

Avoid spending review time on table spacing or internal helper names until those guarantees are settled.

### PR 2 — Make book mutations safe and add corrections — completed

**Status:** completed and merged in [PR #2](https://github.com/juanluisdb/finbook/pull/2) on 2026-09-01. The merge commit on `main` is `2003ef1`; `corepack pnpm check` passes with 169 tests across 25 files. This section remains as the decision and acceptance record for the shipped work.

#### User-visible result

After this PR:

- Every local write is serialized through one `FINBOOK_HOME` lock. Two commands cannot both validate against the same stale book and commit an invalid result.
- Direct `FileBookStore` consumers receive the same event validation as the CLI; the CLI no longer performs the authoritative replay itself.
- `event add` accepts only fields legal for the selected event type. Previously ignored flags become validation errors.
- `event edit <type> <id>` changes only explicitly supplied mutable fields and preserves the event's identity and ledger position.
- `event delete <id>` removes an event only when the entire remaining ledger still replays.
- A rejected add, edit, or delete leaves `events.jsonl` byte-for-byte unchanged and says that no changes were written.
- Successful add/edit/delete rewrites a complete valid `events.jsonl` atomically. It creates no backup, tombstone, or hidden history.
- A busy or uncertain lock fails quickly with an actionable error instead of waiting indefinitely.
- Existing data directories and book/config files are repaired to owner-only modes where the platform supports POSIX permissions.

This keeps the engineering proportional to a local, single-user CLI: one filesystem lock and atomic rename, not SQLite, a WAL, a daemon, a distributed lock, automatic backups, or a revision system.

#### Scope

**In**

- N3's shared local lock, locked read-modify-write paths, event candidate replay, atomic event-file replacement, and permission enforcement.
- N4's core replace/delete operations and downstream-dependency error context.
- N5's strict per-type add/edit command tree and `event delete`.
- The PR 2 cases from N8: direct-store invariants, concurrency, byte preservation, reload equivalence, malformed `--file`, and strict CLI behavior.
- The `DESIGN.md` contract changes and focused README correction examples required to make irreversibility explicit.

**Out**

- Automatic backups, undo, tombstones, audit history, or Git integration.
- A prompt or `--yes` flag for deletion; entering the complete delete command is the confirmation.
- A persisted book timezone, intraday event timestamps, settlement modeling, or schema-version change.
- Network/distributed locks or any lock intended for multiple machines or multiple live copies of the same book.
- `fsync`, a write-ahead log, crash recovery beyond same-filesystem atomic rename, or performance optimization without measurements.
- The doctor/output work owned by PR 3, the broad test cleanup owned by PR 4, and the complete onboarding rewrite owned by PR 5.

#### Book-lock contract

Core owns one small lock primitive used by `FileBookStore` and `MarketDataConfigStore`:

```text
withBookLock(FINBOOK_HOME, local mutation)
  → ensure FINBOOK_HOME exists and is mode 0700 where supported
  → atomically create .finbook.lock/ with mode 0700
  → write .finbook.lock/owner.json with mode 0600
      { pid, hostname, createdAt, token }
  → run the complete local read → validate → write operation
  → release only the lock carrying this acquisition token, in finally
```

Acquisition behavior is deliberately small and deterministic:

- A valid owner whose process is alive is active; return a stable `storage` error immediately.
- A valid same-host owner whose PID no longer exists is stale. Move that lock directory to a uniquely named quarantine path, retry acquisition once, and clean up the quarantined directory. Moving before deleting prevents one contender from deleting a newly acquired lock.
- A different-host owner, malformed owner record, missing owner record, or owner record still being created is uncertain and therefore active. Do not guess based on age.
- PID liveness uses the operating system's non-destructive process check. Permission-denied means “alive”; only a definite missing process is reclaimable.
- Lock setup/release failures are storage failures. Error text names the owner when known, whether the mutation may have committed, and the exact retry/manual-inspection action.
- Do not wait, poll, sleep, or add a timeout setting. A local command can be retried by the caller.
- Never hold the lock while fetching a market price or historical EUR rate. Fetch and normalize first; acquire only for each local append or final event replacement.
- The lock directory is ephemeral coordination state, not book data and not part of a backup.

Initialization is also a mutation. Public `FileBookStore.load()` and market-config loads acquire the local lock because they may initialize missing files or repair permissions; code already inside a mutation uses a private unlocked load to avoid re-entrant acquisition. Event/account/instrument/config replacements are atomic renames, and price/FX writes remain one locked line append at a time. PR 3 adds a separate strictly read-only inspection path for doctor rather than weakening the normal load contract.

All read-modify-write operations must share the same critical section:

- account and instrument additions;
- event add, replace, and delete;
- manual and fetched price/FX appends;
- market-data config creation and updates.

`MarketDataConfigStore.save(load() + change)` is not sufficient because two callers can lose one another's update between the calls. Add one store-owned update operation that loads, transforms, validates, and writes under a single lock; the CLI passes parsed values and does not own config concurrency.

#### Event-mutation contract

`FileBookStore` is the authoritative event boundary. Keep the public calls explicit—`appendEvent`, `replaceEvent`, and `deleteEvent`—and share their mechanics privately rather than adding a pass-through repository or service.

```text
appendEvent(event)
replaceEvent(id, complete replacement)
deleteEvent(id)
  → acquire book lock
  → load and parse the latest accounts, instruments, and ordered events
  → construct the complete candidate event sequence
      add: append at the end
      replace: substitute at the target line
      delete: remove only the target line
  → validate event IDs and source/external-ID uniqueness
  → replay the entire candidate in economic-date order with stable line-order ties
  → on success, serialize all candidate events to a same-directory temporary file
  → chmod temporary file 0600, rename over events.jsonl, chmod target 0600
  → release lock
  → return the added, edited, or deleted canonical event
```

Rules:

- The store parses every supplied event with `EventSchema`, even when TypeScript says it is already an `Event`.
- `appendEvent` rejects unknown accounts/instruments, insufficient cash, oversells, invalid fee/withholding effects, and every other replay failure. The CLI's current load/replay preflight is removed.
- `replaceEvent` requires an existing ID and an exact stored type match. It preserves `id`, `type`, `source`, and `externalId`; changing type remains delete plus add.
- Replacement preserves the target's JSONL line position. Changing its date can still change replay order because economic date sorts before stable line order.
- `deleteEvent` requires an existing ID and returns the removed canonical event on success.
- Duplicate checks and full replay happen before the first byte of `events.jsonl` is changed.
- When replay fails, wrap the original domain cause with mutation context: mutation kind/target and the blocking event's ID, type, and date. Human output names both events and says no changes were written; JSON includes the same stable error plus structured `details`.
- A failed parse, missing target, duplicate, replay failure, active lock, or temporary-file write failure leaves the original event file unchanged.
- Temporary files live beside `events.jsonl`, have collision-resistant names, are removed in `finally`, and are never presented as history. Successful rewrites retain event order and a trailing newline; they may canonicalize existing valid decimal strings such as `50.00` to `50` without changing their value.
- Do not add `fsync`; same-filesystem rename is the durability boundary for this phase.

#### CLI command and edit contract

The command tree becomes real Commander subcommands rather than one option bag:

```text
event
├── add --file <path>
├── add
│   ├── deposit
│   ├── withdrawal
│   ├── transfer
│   ├── fx
│   ├── buy
│   ├── sell
│   ├── dividend
│   ├── interest
│   └── fee
├── edit
│   ├── deposit <id>
│   ├── withdrawal <id>
│   ├── transfer <id>
│   ├── fx <id>
│   ├── buy <id>
│   ├── sell <id>
│   ├── dividend <id>
│   ├── interest <id>
│   └── fee <id>
├── delete <id>
├── list
└── get <id>
```

Valid existing `event add <type> ...` calls retain their meaning. `event add --file <path>` remains the canonical-object path for scripts; there is no file-based edit in PR 2.

Each type owns its legal flags:

| Event type          | Type-specific fields                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| deposit, withdrawal | account, amount/currency, EUR-rate controls                                                          |
| transfer            | from/to accounts, amount/currency                                                                    |
| fx                  | account, from amount/currency, to amount/currency, optional fee                                      |
| buy, sell           | account, instrument, quantity, price amount/currency, optional fee, EUR-rate controls                |
| dividend            | account, instrument, gross amount/currency, optional foreign/domestic withholding, EUR-rate controls |
| interest            | account, gross amount/currency, optional foreign/domestic withholding, EUR-rate controls             |
| fee                 | account, amount/currency, EUR-rate controls                                                          |

Add commands also accept the shared creation fields `--id`, `--date`, `--source`, `--external-id`, and `--note`. Edit commands accept mutable shared fields such as `--date` and `--note`, but do not expose `--id`, `--source`, or `--external-id`.

Edit semantics:

- Omitted flags retain the current stored value. A no-op edit with no mutable flag is a validation error.
- `--clear-note`, `--clear-fee`, `--clear-withholding-foreign`, and `--clear-withholding-domestic` remove their optional field. Supplying both a value and its clear flag is a validation error.
- Primary money fields merge component-wise: changing only `--amount` retains the current currency; changing only `--currency` retains the amount and then revalidates the complete event.
- Adding an absent trade fee may default its currency to the effective trade-price currency, matching add behavior. Adding an absent FX fee requires its currency because either side is legal. Withholdings always use the effective gross currency.
- `event edit buy <sell-id>` is a validation error, not an implicit type conversion.
- Changing a non-EUR rate-bearing event's economic date or rate-bearing currency requires a new `--eur-per-unit` or `--fetch-rate`; silently carrying the old historical rate forward is forbidden.
- Changing the rate-bearing currency to EUR sets `eurPerUnit` to `1` and clears provenance. A manual `--eur-per-unit` clears fetched provenance. `--fetch-rate` stores fresh provenance, and `--provider` still requires it.
- Any rate fetch completes before lock acquisition. The final complete replacement is then parsed and replayed against the latest book under the lock.
- Human success names the ID, date, type, and compact transaction summary. JSON success returns the full canonical added, edited, or deleted event.
- Delete is intentionally non-interactive and irreversible. No backup is created; the README tells users to copy `FINBOOK_HOME` before a risky bulk correction.

Expected failures keep the existing process contract:

| Failure                                             | Domain type                | Exit |
| --------------------------------------------------- | -------------------------- | ---- |
| Illegal/missing flag, type mismatch, invalid replay | `validation` / `invariant` | 2    |
| Missing edit/delete target                          | `not-found`                | 3    |
| Active/uncertain lock or filesystem failure         | `storage`                  | 1    |

`--json` keeps `{ ok: false, error }` for every failure and writes nothing to stderr.

#### Target code shape

```text
packages/core/src/domain/
├── lock.ts          shared .finbook.lock acquisition, stale-owner handling, release
└── store.ts         deep book API; private unlocked load and atomic event replacement

packages/market-data/src/
└── config.ts        locked config initialization and atomic update operation

packages/cli/src/
├── program.ts       top-level command composition only
├── event-commands.ts explicit per-type add/edit/delete registration and legal options
├── event-input.ts   type-specific add/edit construction, clear semantics, rate rules
└── writes.ts        account/instrument/price/FX writes; no authoritative event replay
```

The exact split between `event-commands.ts` and `event-input.ts` may collapse to one deep event module if that reads better. The invariants matter: delete the global `EventWriteOptions` bag, keep each event type's accepted fields explicit, and do not introduce a generic command registry whose configuration is harder to understand than the nine stable variants.

Use only Node's filesystem, process, hostname, and UUID primitives plus existing dependencies. A new lock or command-framework dependency is not justified.

#### Implementation order inside the PR

1. **Pin the unsafe behavior first.** Add failing tests for direct invalid event writes, the 20→15 META edit, delete of required funding, an active lock, competing withdrawals, and an irrelevant deposit flag. Record that each fails against `main` for the intended reason.
2. **Add the lock and permission primitive.** Implement atomic acquisition, owner parsing, dead same-host reclamation, token-aware release, and owner-only modes. Wire it to account, instrument, price, FX, and initialization paths without changing their public behavior.
3. **Make config updates atomic.** Add the locked `MarketDataConfigStore` update operation and switch CLI config mutations from separate load/save calls. Keep config reads and stored schema unchanged.
4. **Deepen event add.** Move candidate replay and atomic event-file replacement into `FileBookStore.appendEvent`; remove the CLI's authoritative preflight. Make all existing add/file tests pass through this boundary before adding correction behavior.
5. **Add core replace and delete.** Preserve line position and immutable fields, annotate the blocking replay event, return canonical results, and prove byte preservation on every rejected path.
6. **Replace the CLI option bag.** Register explicit add/edit subcommands, implement patch/clear/rate rules, add delete, and retain the file-add path. Keep common helpers only for genuinely shared base, money, and EUR-rate parsing.
7. **Update contracts and focused docs.** Change `DESIGN.md` and the README correction/irreversibility sections in the same PR.
8. **Run the full gate and process-level smoke pass.** `corepack pnpm check` must pass after built-CLI concurrency and edit/delete cases, not only in-process tests.

These are implementation steps, not required commits. One PR is the review boundary; commits may group the lock, store boundary, and CLI surface when that makes the diff easier to review.

#### Required tests by layer

**Medium/core with the real temporary filesystem**

- `file-store.test.ts`: a direct `appendEvent` of a buy without cash, a sell beyond holdings, and an unknown-account event fails and preserves the event file.
- `file-store.test.ts`: valid add writes a complete candidate whose reload produces the same public glance/positions as the pre-persist replay.
- `file-store.test.ts`: replacing buy 20 META with 15 while a later sell consumes 20 fails, identifies the sell, and preserves the original bytes.
- `file-store.test.ts`: deleting the deposit required by a later buy fails and preserves bytes; deleting an independent event returns only that event and keeps all other line positions.
- `file-store.test.ts`: edit preserves `id`, `type`, `source`, `externalId`, and target line position; missing targets return not-found without a rewrite.
- `lock.test.ts`: a held valid lock rejects a second writer; a dead same-host owner is reclaimed once; a live, foreign-host, missing-owner, and malformed-owner lock is not reclaimed; failure releases a lock acquired by the operation.
- A parameterized wiring case: account, instrument, event, price, FX, and config mutations all honor the same active lock. This test exists to pin call-site wiring, not lock internals.
- A process-level concurrency case: start with 100 EUR and launch two 75 EUR withdrawals together. At most one exits 0; the other is busy or invariant; reload/replay succeeds with non-negative cash.
- POSIX-only permissions case: an existing `0755` data directory becomes `0700`; book, config, temporary, and owner files are `0600`. Skip only where the platform cannot express these modes.

**Built CLI**

- A named table runs one representative valid add command for each event type and compares the canonical JSON event with the pre-refactor shape.
- `event add deposit ... --fee-amount 9` exits 2, names the unknown flag, and appends nothing; deposit and buy help expose only their legal fields.
- Valid and malformed/unreadable `event add --file` cases prove canonical parsing and no-write failure behavior.
- `event edit buy <id> --qty ... --clear-fee` changes only those fields. Conflicting set/clear flags and a no-op edit exit 2.
- Editing through the wrong type exits 2 and writes nothing.
- Changing a rate-bearing date/currency without a new rate fails; manual, EUR, and fetched-rate replacements apply the provenance rules above.
- The 20→15 META scenario in human and JSON modes names the edited buy and blocking sell, says no changes were written, exits 2, and leaves the original event retrievable.
- `event delete <id> --json` returns the deleted canonical event; deleting an event required downstream fails with the original event still present.
- An active lock produces the stable human and JSON storage error with exit 1.

Do not use module mocks. Use pure tests only for pure input-merging helpers that have a real module interface; otherwise test through `FileBookStore`, `MarketDataConfigStore`, or the built CLI. Do not add timing assertions or rely on terminal width. Interaction assertions are justified only for lock ownership/reclamation and “rate fetch occurs before local mutation.”

#### Documentation changes in PR 2

`DESIGN.md` must:

- replace “physically append-only events file” with “ordered JSONL ledger atomically rewritten by validated corrections”;
- define the one-writer lock, owner record, dead-owner reclamation, fail-fast busy behavior, and manual uncertain-lock recovery;
- make full candidate replay authoritative for direct and CLI event writes;
- document edit immutability, line-position preservation, delete behavior, optional-field clearing, and historical-rate edit rules;
- state that successful corrections are irreversible and create no automatic backup;
- add the direct-write, concurrent-withdrawal, 20→15 META, funding-delete, strict-flag, and byte-preservation acceptance cases.

The README gets one concise correction workflow: inspect an event, perform a valid edit, show the rejected 20→15 dependent edit, delete an independent event, and warn users to copy `FINBOOK_HOME` themselves before bulk corrections. Leave the complete first-book tutorial to PR 5.

#### Compatibility, rollback, and risks

- Event, account, instrument, price, FX, and market-config record schemas do not change; no migration or schema-version bump is required.
- Existing valid `event add <type>` commands and `event add --file` remain valid. Help layout changes, and irrelevant flags that were silently ignored now fail intentionally.
- Successful event mutations may canonically reserialize existing decimal strings while preserving values and line order.
- Books written by PR 2 remain readable by the pre-PR 2 binary. An older binary ignores the lock, so do not run mixed versions concurrently.
- Code rollback is ordinary source rollback. A valid edit/delete cannot be undone by reverting code; restoring the prior data requires the user's external copy. That is the accepted no-backup trade-off.
- A killed process can leave a lock. A verifiably dead same-host owner self-heals; an uncertain owner requires manual inspection/removal. PR 3's doctor will make that diagnosis friendlier, but PR 2 errors and docs must already provide a safe recovery path.
- Atomic rename prevents a partial event line from replacing the ledger. It does not promise durability after sudden power loss without `fsync`; that remains explicitly out of scope.
- The highest implementation risk is accidentally acquiring the lock around a provider call. The focused rate-fetch test and review trace must show acquisition only around the final local mutation.
- The second risk is leaving one write path outside the lock. The parameterized active-lock wiring test covers every public mutator, including config updates.
- The third risk is moving validation into core but retaining the CLI preflight as a second authority. Delete that preflight; tests attach to the store interface and built CLI instead of duplicating the same guarantee at both layers.

#### PR 2 acceptance checklist

- [x] Every PR 2 regression test is observed failing against `main` before its implementation.
- [x] Every `FINBOOK_HOME` mutation uses the same local lock; no provider network call occurs while it is held.
- [x] Active/uncertain locks fail fast, dead same-host locks are reclaimed safely, and acquired locks release in `finally`.
- [x] Existing directories and all book/config/lock files use owner-only modes where supported.
- [x] Direct `appendEvent` performs complete replay and cannot persist unknown references, insufficient cash, or oversells.
- [x] Event add/edit/delete write only a fully replayable candidate via same-directory atomic rename.
- [x] Failed add/edit/delete operations leave `events.jsonl` byte-for-byte unchanged.
- [x] Edit preserves identity and line position; type changes require delete plus add.
- [x] The 20→15 META edit and deletion of required funding are rejected with the blocking event identified.
- [x] Strict per-type add/edit help and flag rejection replace the global option bag without breaking valid add commands.
- [x] Optional fields have explicit clear semantics, and rate-bearing date/currency edits cannot retain a stale historical rate.
- [x] Delete is non-interactive, returns the deleted event, and creates no backup or history.
- [x] Market-data config updates are one locked read-modify-write operation.
- [x] `DESIGN.md` and the focused README correction section match the implementation and irreversibility policy.
- [x] `corepack pnpm check` passes, including the built CLI and process-level concurrency cases.

#### PR 2 review focus

Reviewers should trace five guarantees end to end:

1. Every public mutator reaches the same lock, and nested store loads do not reacquire or escape it.
2. `FileBookStore`, not the CLI, owns the latest load → candidate construction → uniqueness → replay → atomic replace sequence.
3. The event-file target is untouched on every pre-rename failure, and temporary cleanup cannot remove another process's lock or file.
4. Each event command accepts only its own fields; edit merging, clearing, and EUR-rate provenance produce one valid complete replacement.
5. Network rate fetching finishes before lock acquisition, while the final write still replays against the latest on-disk book.

Avoid expanding review into Git history, backups, database durability, generalized transactions, or PR 3 presentation work. Those are deliberate non-goals, not omissions.

### PR 3 — Make history, holes, and book health actionable

**Status:** implemented on `codex/pr3-actionable-book-health`; awaiting review. PR 2 is merged, so this PR starts from `main` at `2003ef1`.

#### User-visible result

After this PR:

- `event list` and `event get` summarize the actual transaction instead of showing only date, type, ID, and account.
- Human glance and positions output always shows the resolved `asOf` and lists every valuation hole with a concrete manual or `--fetch` remedy.
- `doctor` reports whether the local book is valid, incomplete, busy, insecure, or corrupt. It does not initialize, repair, unlock, chmod, fetch, or otherwise change anything.
- A healthy or merely incomplete book produces a useful report and exit 0. Corrupt data, invalid replay, unsafe permissions, or an uncertain lock produce a structured failure and nonzero exit.
- JSON shapes for event, glance, and positions commands do not change. Doctor keeps its current summary fields and adds stable status/check details.

#### Scope

**In**

- N7's human event summaries, hole rendering, and read-only doctor.
- A small read-only inspection surface in core and market-data where needed so doctor reuses the real parsers and lock classification instead of duplicating them in the CLI.
- Built-CLI tests for all new output and exit behavior.
- Focused `DESIGN.md` and README examples for holes and doctor.

**Out**

- Any repair command, automatic stale-lock removal, permission mutation, backup, or history.
- Network connectivity checks or live provider calls from doctor.
- Event-list filtering beyond the existing account/date filters; PR 5 owns the final inspection filters.
- Test-suite restructuring, dead-state removal, fixture replacement, and standalone `pnpm test`; PR 4 owns those.
- A TUI, color-dependent status, spinners, terminal-width adaptation, metrics, or telemetry.

#### Human rendering contract

Event rows become `DATE  TYPE  ID  SUMMARY`. The summary is compact but type-specific:

```text
deposit      +800 EUR → ib
withdrawal   -100 EUR ← ib
transfer     200 EUR ib → myinvestor
fx           ib: 798 EUR → 927.04 USD; fee 1.71 EUR
buy          ib: buy 20 HROW @ 40.45 USD; fee 0.28 USD
sell         ib: sell 12 HROW @ 39.83 USD; fee 0.37 USD
dividend     ib: HROW gross 1.07 USD; net 0.91 USD
interest     ib: gross 5 EUR; net 4 EUR
fee          ib: -2 EUR
```

Notes stay out of the compact list. `event get --json` remains the lossless inspection path; human `event get` may add a second note/source line when present, but it must not dump raw JSON by default.

Glance and positions render holes after their useful partial tables:

```text
missing data
- price HROW in USD as of 2026-08-31
  add: finbook price set --instrument HROW --amount <decimal> --currency USD --as-of 2026-08-31
  or:  finbook show glance --as-of 2026-08-31 --fetch
- FX USD/EUR as of 2026-08-31
  add: finbook fx set --pair USD/EUR --rate <decimal> --as-of 2026-08-31
  or:  finbook show glance --as-of 2026-08-31 --fetch
```

Use the actual view command in the fetch remedy (`glance` or `positions`). Do not claim that fetch will succeed: it is an available next action, while the manual command is deterministic. A hole is visible incompleteness, not a command failure; the view still exits 0 unless an explicit fetch itself fails.

#### Doctor contract

Doctor aggregates named checks with a stable shape:

```ts
type DoctorCheck = {
  id: "book" | "schema" | "replay" | "market-config" | "permissions" | "lock" | "valuation";
  status: "ok" | "warning" | "error";
  message: string;
  hint?: string;
};

type DoctorReport = {
  status: "ok" | "warning" | "error";
  schemaVersion: number | null;
  eventCount: number;
  holeCount: number;
  dataPath: string;
  checks: readonly DoctorCheck[];
};
```

Rules:

- A missing/uninitialized data home is a valid empty state: report it without creating files and exit 0.
- Parse every existing book file with its production Zod schema, validate IDs/references, and replay the complete ledger. Do not invent a looser doctor parser.
- An absent market-data config is valid. If present, parse and capability-check it through `MarketDataConfigStore`'s real validation.
- Holes are warnings. They remain visible in `holeCount` and the valuation check, but do not make the command fail.
- A valid active lock is a warning because the book is temporarily busy. A definitely dead same-host lock is also a warning with the normal retry guidance; doctor leaves it untouched. A foreign-host, malformed, or incomplete owner is an error because automatic ownership cannot be established.
- Unsupported schema, malformed JSON/JSONL, failed replay, unsafe owner permissions, or an uncertain lock are errors.
- JSON success is `{ok:true,data:DoctorReport}` for `ok` and `warning`. On `error`, emit `{ok:false,error}` with the complete report under `error.details.report`, and exit 1. Human mode prints the report to stdout and one summary/hint to stderr on failure.
- Doctor must not expose holdings, event contents, provider credentials, or raw malformed payloads. File name and line number are sufficient diagnostics.

The store inspection methods are read-only and domain-neutral: they return parsed facts or typed failures. Status words, check ordering, rendering, and exit policy stay in the CLI. Reuse the existing lock-owner schema/classifier; do not build a second stale-lock algorithm.

#### Target code shape

```text
packages/core/src/domain/
├── store.ts             read-only book inspection reusing production readers/replay
└── lock.ts              exported read-only lock classification; mutation behavior unchanged

packages/market-data/src/
└── config.ts            read-only inspection that does not create a default file

packages/cli/src/
├── doctor.ts            aggregate checks and map them to status
├── human-output.ts      cohesive pure human renderers and event/hole summaries
├── program.ts           command orchestration only
└── output.ts            existing envelope and stdout/stderr discipline
```

`human-output.ts` is a presentation module, not a new adapter or port. Do not expose private table mechanics as a public package API. Built-CLI tests remain the authoritative test surface for command output.

#### Implementation order inside the PR

1. Add failing built-CLI cases for event summaries, two simultaneous hole types, and doctor healthy/warning/error states.
2. Add read-only lock, book, and market-config inspection by reusing the existing schemas and replay path. Prove a fresh home and every doctor scenario are byte-for-byte unchanged.
3. Build the doctor report and exit mapping. Keep warning versus error policy explicit in one place.
4. Add type-specific event summaries and a shared hole renderer; use it from glance and positions.
5. Update the focused `DESIGN.md` contracts and README troubleshooting examples.
6. Run `corepack pnpm check` and a manual fresh-home/corrupt-home doctor smoke pass.

#### Required tests

**Core/market-data boundary**

- Inspection of a missing home reports uninitialized and creates nothing.
- Inspection catches a schema-invalid JSONL line with file and line context and does not rewrite it.
- Inspection catches a ledger that parses but fails replay.
- Lock inspection distinguishes absent, active, definitely dead, and uncertain/malformed without reclaiming any lock.
- Market config inspection treats absence as valid and rejects a present invalid route through the production schema/capability checks.

**Built CLI**

- One table-driven event-list scenario covers all nine event summaries with visible literals.
- Glance with missing price and FX renders both subjects and exact remedies; JSON remains unchanged.
- Positions prints its resolved date and the same complete hole set.
- Doctor on a fresh home exits 0, reports uninitialized/empty, and creates no files.
- Doctor on a valid incomplete book exits 0 with `status: warning` and a valuation check.
- Doctor on corrupt JSONL and failed replay exits 1, keeps a valid JSON error envelope, identifies file/line or blocking event, and changes no bytes.
- Doctor reports active/dead locks as warnings and uncertain locks as errors without removing them.
- Doctor never invokes a provider and does not include event payloads or credentials in either output stream.

Avoid exact whitespace snapshots. Assert headings, rows, subjects, commands, streams, exit status, and JSON structure—the behavior a user or script depends on.

#### Compatibility, rollback, and risks

- No persisted schema changes and no migration.
- Event/glance/positions JSON is unchanged; human output is intentionally richer.
- Doctor's existing summary fields remain, while `status` and `checks` are additive. Its unhealthy behavior becomes meaningfully nonzero.
- Reverting the PR requires no data rollback because every new inspection path is read-only.
- The main risk is a supposedly diagnostic command mutating through `load()` or lock recovery. Byte-preservation tests on every doctor state are the guard.
- The second risk is two validation implementations drifting. Doctor must reuse production schemas, replay, capability validation, and lock classification.

#### PR 3 acceptance checklist

- [x] Every event family has a useful compact human summary.
- [x] Glance and positions show resolved date plus every hole and next action.
- [x] View JSON contracts remain unchanged and holes still do not fail a non-fetching view.
- [x] Doctor is read-only, offline, redacted, and useful on an uninitialized home.
- [x] Doctor distinguishes healthy, incomplete, busy/stale, unsafe, and corrupt states with stable checks.
- [x] Hard doctor failures are nonzero and preserve a JSON error envelope containing the report.
- [x] No new persistence, backup, repair, network, telemetry, or interactive machinery is introduced.
- [x] Focused docs match the new output and `corepack pnpm check` passes.

#### PR 3 review focus

Trace three things: whether doctor can write on any path, whether it reuses rather than mirrors validation, and whether every hole remains visible/actionable in both human views. Formatting taste matters after those guarantees are established.

### PR 4 — Make the remaining correctness guarantees explicit in tests

**Status:** planned; starts after PR 3 so output tests are not rewritten twice.

#### Outcome and scope

This is a behavior-preserving hardening PR unless a newly added guarantee exposes a real defect. It closes N8, retires tests and state that prove nothing, and makes the ordinary `pnpm test` command self-contained.

**In**

- The remaining schema, accounting, replay/query, filesystem, CLI, and provider-coordination cases in N8.
- Captured raw Yahoo and CoinGecko response fixtures at the provider gateway normalization boundary.
- Removal of dead `BookState.holes`, `tooling.test.ts`, noisy process output from lower-level tests, and over-combined/brittle cases.
- `pnpm test` building the CLI before Vitest, while `pnpm check` remains the full gate.
- Small production fixes only when a new failing case demonstrates the defect.

**Out**

- A coverage percentage, mutation-testing service, snapshot campaign, new test framework, module mocks, or live network calls.
- Re-testing every private helper or keeping both old implementation-pinning tests and new interface tests.
- Product features, output redesign, CI, performance optimization, or broad production refactors justified only by test convenience.

#### Test-design contract

- One named guarantee has one clearest owning test. Split tests when failures have different causes; parameterize only when the literals and assertion remain obvious.
- Core arithmetic and replay stay small/in-process. File behavior uses a real temporary directory. CLI behavior uses the built binary. Provider normalization uses captured fixtures and provider orchestration uses narrow in-memory adapters. HTTP retry behavior keeps the local server.
- Assert the invariant, not incidental calls. Interaction assertions are reserved for skip/fallback/partition/resume behavior where the interaction is the contract.
- When a stronger interface-level test replaces a shallow one, delete the old test in the same PR.
- Do not force Google's approximate 70/20/10 proportions. Dependency shape determines test size.

#### Implementation order inside the PR

1. Make `pnpm test` build the CLI and capture existing stray stdout so the standalone baseline is deterministic.
2. Remove `tooling.test.ts` and dead `BookState.holes`; update query-owned hole tests before deleting obsolete accounting assertions.
3. Add the schema and accounting cases, splitting the existing combined income/failure tests as they are replaced.
4. Add replay/query and filesystem cases, including reload equivalence and precise corrupt-line diagnostics.
5. Replace provider-assumption fixtures with sanitized captured raw Yahoo/CoinGecko samples; document provenance and refresh steps.
6. Add the remaining CLI and coordinator cases. Reduce large anonymous batches to a few named needs without weakening resume behavior.
7. Run `corepack pnpm test` directly, then `corepack pnpm check`, twice if any ordering/shared-state issue was found.

#### Required guarantees

Use the case inventory in N8 as the source of truth. At minimum, the PR is not complete until these deletion tests would fail:

- Removing positive/non-negative decimal guards fails the schema table.
- Allowing an oversell, excessive fee/withholding, or failed cash operation to mutate state fails focused accounting tests.
- Sorting same-date events unstably, replaying future events, or choosing the first same-date FX stamp fails query tests.
- Accepting malformed JSONL, unsupported schema, duplicate IDs, or a wrong-currency mark fails real-filesystem tests with the original files intact.
- Returning the wrong CLI exit category or reading malformed `--file` input as trusted fails built-process tests.
- Falling back after an explicit provider pin, duplicating writes for duplicate needs, or refetching completed historical batch items fails coordinator tests.
- Changing Yahoo/CoinGecko normalization to match an invented provider shape fails captured-fixture tests.

#### Compatibility, rollback, and risks

- Removing `BookState.holes` is an internal type cleanup. Public query results keep `holes`; no stored data changes.
- `pnpm test` becomes slightly slower because it builds first. This is accepted so it can be trusted independently.
- Sanitized fixtures contain no credentials or personal data and never refresh during the gate.
- The largest risk is doubling the suite with redundant tests. Review each addition against the guarantee it replaces or newly pins.
- If a new case exposes a bug, keep the smallest production fix and call it out in the PR description; do not turn the PR into an unrelated refactor.

#### PR 4 acceptance checklist

- [ ] Every N8 guarantee is either pinned by one clear test or explicitly recorded as already covered by PR 1/2/3.
- [ ] Dead state and tautological tests are gone; new interface-level tests retire redundant shallow tests.
- [ ] Provider response validation is exercised with captured, sanitized raw fixtures.
- [ ] No module mocks or live provider calls enter the normal gate.
- [ ] `pnpm test` works from a clean built-artifact state and emits no accidental application output.
- [ ] The normal-week built-CLI workflow remains the single broad acceptance path.
- [ ] `corepack pnpm check` passes reproducibly.

#### PR 4 review focus

For each new test, ask what production guarantee can be deleted to make it fail. Review production changes with normal rigor, but reject abstractions exported only to make a test easy.

### PR 5 — Finish inspection guardrails, onboarding, and the v1 contract

**Status:** planned; final PR in the improvement program.

#### User-visible result

After this PR:

- `event list` can narrow a growing ledger by type, instrument, source, account, and date range without changing ledger order.
- An instrument source binding must name an instrument that exists in the book, so a typo cannot create a valid-but-useless configuration. Currency bindings remain schema-validated but do not require a registry that finbook does not have.
- Root and command help show the common workflow and complete legal flags without becoming a manual.
- README offers one copy/paste path from empty home to a useful glance, including correction and incomplete-data recovery.
- `DESIGN.md` describes the final shipped contracts, not the original append-only or pre-market-data design.

#### Scope

**In**

- N10's inspection filters, binding guardrail, and help polish.
- N9's final README, `DESIGN.md`, acceptance-table, and non-goal alignment.
- A final built-CLI acceptance pass using the existing normal-week workflow plus focused filter/binding cases.

**Out**

- Pagination, a query language, fuzzy matching, interactive selection, saved searches, aliases, or a raw/request command.
- Account or instrument edit/delete, provider discovery over the network, a currency registry, or stricter ISO dependencies.
- Backup/history, persisted timezone, CI, app/TUI, broker imports, tax reports, or market-data performance work.

The absence of pagination is deliberate: this is a local book read from disk, and the useful missing capability is narrowing, not server-style page traversal. Reopen only when a real book makes full JSON output materially expensive.

#### Event-list contract

Add optional repeatable filters:

```text
finbook event list [--account <id>] [--type <type>...] [--instrument <id>...]
                   [--source <source>...] [--from <date>] [--to <date>] [--json]
```

Rules:

- Different filter dimensions combine with AND; repeated values within one dimension combine with OR.
- Preserve ordered-ledger order in human and JSON output. Filtering never re-sorts.
- `--instrument` matches buy, sell, and dividend events. Events without an instrument simply do not match.
- `--account` continues to match either endpoint of a transfer.
- Unknown account or instrument IDs return not-found exit 3. Unknown event types and invalid/range-inverted dates return validation exit 2.
- `--source` is an exact source ID match after boundary validation; do not add substring, regex, or case-folded semantics.
- Empty results are successful: exit 0, `[]` in JSON, `(empty)` in human output.
- Define legal event types from the core event schema/type rather than maintaining another drifting list solely for this command.

#### Source-binding contract

- Before saving `config source set --instrument X ...`, load the current book and require instrument `X` to exist.
- Perform that check before the locked config update. Instruments have no delete operation, so there is no cross-file deletion race to solve.
- A missing instrument returns exit 3 and leaves `market-data.json` byte-for-byte unchanged.
- `--currency` keeps the existing uppercase currency-shape validation and does not require a known-book lookup.
- Provider capability, disabled-state, and route validation remain owned by `MarketDataConfigStore`; the CLI does not duplicate them.

#### Help and documentation contract

- Root help names the shortest useful sequence: add account/instrument, add events, add or fetch marks, show glance, inspect/correct an event.
- Each event subcommand lists only its legal flags and includes one complete example; reuse PR 2's typed command definitions rather than a parallel help registry.
- README's first-book example uses a temporary `FINBOOK_HOME`, distinguishes deposit from transfer, includes explicit daily dates, and contains no ellipses in commands intended for copying.
- README shows incomplete human output, manual and fetched remedies, partial-fetch exit behavior, the 20→15 correction rejection, and the no-automatic-backup policy.
- README warns that financial data and provider credentials do not belong in the checkout or a remote repository.
- `DESIGN.md` removes stale milestone prose only where it contradicts shipped behavior; retain the rationale and explicit non-goals that still explain the product.

#### Implementation order inside the PR

1. Add failing built-CLI tests for filter composition/order/empty results and unknown binding subjects.
2. Add parsed filter options to `event list` and validate referenced account/instrument IDs against the loaded snapshot.
3. Pass `FileBookStore` into instrument-binding commands and reject an unknown subject before config mutation.
4. Polish root and typed-command help from the same command definitions.
5. Rewrite the README journey and reconcile `DESIGN.md` contracts/acceptance cases against PRs 1–5.
6. Run the focused commands by copying them from README, then run `corepack pnpm check`.

#### Required tests

- Repeated type/instrument/source values use OR; cross-dimension filters use AND and preserve original order.
- Transfers match either `--account`; instrument filters exclude non-instrument event types.
- Invalid event type/date and unknown account/instrument use exits 2/3 consistently in human and JSON modes.
- Empty filter results are ordinary success in both output modes.
- Unknown instrument source binding leaves config bytes unchanged; a valid instrument binding still succeeds.
- Currency binding remains allowed without an instrument/currency registry lookup.
- Root and representative typed-command help are side-effect free and contain the promised workflow/example.
- The README normal-week path remains covered by the existing built-CLI workflow rather than a second giant scenario.

#### Compatibility, rollback, and risks

- All new filters are optional and JSON event shapes are unchanged.
- Tightening instrument bindings intentionally rejects previously accepted typo/nonexistent IDs. Existing stored bindings are still readable; doctor reports an invalid existing binding only if production config validation already considers it invalid.
- No persisted schema change. Reverting the PR leaves data readable.
- The main risk is making filters disagree between human and JSON paths. Filter once, then pass the same event array to both renderers.
- The second risk is duplicating event-type or help definitions. Derive or colocate them with the typed command/schema source.

#### PR 5 acceptance checklist

- [ ] Event inspection filters compose predictably, preserve ledger order, and keep empty results successful.
- [ ] Instrument binding typos fail before any config write; currency bindings remain appropriately permissive.
- [ ] Help is complete, non-interactive, side-effect free, and consistent with the actual command tree.
- [ ] README commands are copyable and cover setup, ordinary use, holes, corrections, and script failure behavior.
- [ ] `DESIGN.md` acceptance cases and non-goals describe PRs 1–5 as shipped.
- [ ] No speculative pagination, registry, backup/history, timezone, CI, or app work is pulled in.
- [ ] `corepack pnpm check` passes and the normal-week workflow remains green.

#### PR 5 review focus

Review the user journey end to end: whether a user can find an event, understand incomplete state, avoid a binding typo, and recover from an error using only help/README. In code, focus on one filter pipeline and one source of truth for event types/help.

## Case-level workstream catalog

The sections below remain the authoritative case inventory used by the five PRs. Bug fixes begin with a failing regression test. New behavior gets its test before implementation. Every owning PR updates `DESIGN.md` when it changes a contract and ends with `corepack pnpm check`.

### N1. Make process boot and current-date behavior honest

**Status:** shipped in PR 1.

**Shape**

- Move market configuration and provider construction behind the commands that use them. Program construction and help paths must not write files.
- Treat no arguments in human mode as help and success.
- Treat `--json` without a command as a validation error, without Commander's internal `(outputHelp)` text.
- Replace UTC slicing with a pure local-calendar formatter. Inject the clock/date at the process boundary.
- Continue requiring explicit dates for events, price stamps, and FX stamps. Only current read views default.
- Improve the top-level unexpected-error mapping so an internal exception is not described as a storage failure merely because it reached `main`.

**Cases**

| Test                                                    | Input                                                           | Observable assertion                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `root help does not initialize the book`                | Fresh `FINBOOK_HOME`; run `finbook --help`                      | Exit 0, help on stdout, directory remains untouched.                    |
| `no arguments shows help without initializing the book` | Fresh home; run `finbook`                                       | Exit 0 and no book/config files.                                        |
| `json without a command is a valid validation envelope` | `finbook --json`                                                | Exit 2; stdout parses as `{ok:false}`; stderr empty; no `(outputHelp)`. |
| `current view resolves the machine-local calendar date` | Inject an instant that is next-day UTC but previous-day locally | Result `asOf` is the local day.                                         |
| `default as-of is visible`                              | `show glance` without `--as-of`                                 | Human and JSON output both contain the resolved date.                   |

### N2. Repair market-data correctness before adding more orchestration

**Status:** provider behavior shipped in PR 1. Captured raw response fixtures remain in N8/PR 4.

**Shape**

- Make latest needs bypass the persisted historical cache; retain historical cache reuse.
- Select `eur-rate:crypto` when a currency binding identifies a crypto provider; keep unbound currencies on the fiat route and make the missing-binding remedy explicit.
- Define provider capabilities once and validate routes, bindings, disabled state, and pins against it.
- Make disabled-provider semantics global.
- Give Yahoo historical queries a ten-day lookback and retain the last valid close `<= asOf`.
- Partition CoinGecko current-price batches by quote currency inside `CoinGeckoSource`.

**Cases**

| Test                                                                             | Input                                                       | Observable assertion                                               |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `historical price fetched today does not satisfy latest fetch`                   | Old historical mark with today's `retrievedAt`; latest need | Provider is called and a current observation is appended.          |
| `historical FX fetched today does not satisfy latest fetch`                      | Equivalent FX case                                          | Provider is called.                                                |
| `historical rerun reuses successful observations`                                | Partial historical batch, then identical rerun              | Previously successful needs are not requested again.               |
| `crypto rate binding selects the crypto route`                                   | BTC bound to CoinGecko/bitcoin                              | ECB is not called; CoinGecko receives identifier `bitcoin`.        |
| `unbound unsupported currency explains how to bind it`                           | Historical rate for unbound BTC                             | Failure names the currency and the `config source set` remedy.     |
| `disabled provider cannot be reached by binding or pin`                          | Disable CoinGecko, then use each path                       | No provider call; stable validation/configuration failure.         |
| `route rejects an incapable provider`                                            | Configure ECB for `price:stock`                             | Config write fails and the prior file is unchanged.                |
| `Yahoo returns Friday close for a Saturday request`                              | Captured Friday point; Saturday `asOf`                      | Friday observation is selected.                                    |
| `Yahoo returns not-found after the bounded window`                               | No points in ten days                                       | Per-need `not-found`, no future point accepted.                    |
| `CoinGecko splits mixed quote currencies`                                        | EUR- and USD-quoted crypto needs                            | Two gateway batches; both normalized outcomes succeed.             |
| `provider malformed, omitted, future, zero, and negative outcomes stay failures` | One named case per failure class                            | Nothing invalid is appended; failure kind remains distinguishable. |

### N3. Establish one canonical local mutation boundary

**Status:** shipped in PR 2.

**Shape**

- Add the local lock primitive in core and use it for book and market-config mutations.
- Deepen `FileBookStore`: event schema validation, uniqueness, replay validation, and persistence happen under one lock.
- Remove the CLI's authoritative load/replay/append sequence.
- Write event additions through a complete temporary JSONL file and atomic rename while preserving order.
- Keep price and FX observations append-one-at-a-time, but acquire the lock for each append. Never hold it during network I/O.
- Lock account, instrument, and market configuration read-modify-write operations too.
- Enforce data-directory and file permissions on existing paths where supported.
- Keep pure `apply`, replay, and queries unchanged.

**Cases**

| Test                                                           | Input                                           | Observable assertion                                             |
| -------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `direct event write rejects an unknown account`                | Call the core file adapter without the CLI      | Not-found result; event file unchanged.                          |
| `direct event write rejects insufficient cash and oversell`    | Buy without cash; sell beyond holding           | Invariant result; file unchanged.                                |
| `event write persists the replayed candidate atomically`       | Valid late historical deposit and dependent buy | Reload succeeds and derived state matches pre-persist candidate. |
| `active lock rejects a competing writer`                       | Hold lock, attempt a second mutation            | Stable busy/storage failure; no file changes.                    |
| `dead same-host lock is reclaimed`                             | Lock owner PID does not exist                   | One retry succeeds and lock is removed afterward.                |
| `lock is released after a failed mutation`                     | Candidate replay fails                          | A later valid mutation can acquire the lock.                     |
| `two competing withdrawals cannot both commit an invalid book` | 100 EUR cash; concurrent 75 EUR withdrawals     | At most one commits; final reload/replay is valid.               |
| `reload preserves derived results`                             | Derive glance/positions, reload, derive again   | Public query results are equal.                                  |
| `existing permissive data directory becomes owner-only`        | Directory mode `0755`                           | Becomes `0700`; files remain `0600` on supported systems.        |

### N4. Add validated edit and delete operations in core

**Status:** shipped in PR 2.

**Shape**

- Add core operations for replacing one event in place and removing one event.
- Require an existing target ID.
- Preserve line position for replacement.
- Enforce immutable `id`, `type`, `source`, and `externalId` for typed edits.
- Run duplicate checks and full replay on the candidate sequence.
- Return an error that identifies the requested mutation and the later event that made replay fail.
- Do not create backups, tombstones, revision records, or hidden files.

**Cases**

| Test                                                    | Input                                         | Observable assertion                                                        |
| ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `editing a funding buy below a later sale is rejected`  | Buy 20 META, sell 20, propose buy quantity 15 | Error identifies the sale; original buy remains 20 after reload.            |
| `deleting funding for a later operation is rejected`    | Deposit, then buy; delete deposit             | Insufficient-cash error; original file unchanged.                           |
| `valid edit preserves identity and sequence`            | Change a buy price while enough cash remains  | Same ID/type/source/external ID and same line position; new value persists. |
| `moving an event after its dependent event is rejected` | Edit the deposit date to after its buy        | Replay failure; original date remains.                                      |
| `valid deletion removes exactly one event`              | Delete an independent dividend                | Target absent; other lines retain order; reload/replay succeeds.            |
| `missing edit or delete target is not found`            | Unknown ID                                    | Not-found result and no rewrite.                                            |
| `failed edit and delete preserve original bytes`        | One invalid edit and deletion                 | Byte-for-byte equality before and after each failure.                       |

### N5. Replace the generic event option bag with strict type commands

**Status:** shipped in PR 2. PR 5 completes the user-facing examples in help.

**Shape**

- Build real `event add <type>` and `event edit <type> <id>` subcommands.
- Keep the visible add grammar and all valid existing flags.
- Retain `event add --file` as the canonical-object automation path.
- Give each type focused help, required options, and optional-field clearing flags. PR 5 adds complete copyable examples to the shipped command tree.
- Route both typed and file input through the canonical core operations.
- Add `event delete <id>` with no prompt or automatic backup. The exact command is the acknowledgement of irreversible intent.
- Return the added, edited, or deleted canonical event in JSON. Human success includes ID, date, type, and a short transaction summary.

**Cases**

| Test                                             | Input                                           | Observable assertion                                                        |
| ------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `deposit rejects a trade fee flag`               | `event add deposit ... --fee-amount 9`          | Exit 2; flag named; no event appended.                                      |
| `type help exposes only legal fields`            | Compare deposit and buy help                    | Deposit omits trade flags; buy includes quantity/price/fee.                 |
| `existing valid add commands keep their meaning` | One representative command for every event type | Canonical event equals the pre-refactor shape.                              |
| `file add still uses canonical validation`       | Valid and malformed event files                 | Valid event commits; malformed input exits 2 without writing.               |
| `edit type must match the stored event`          | `event edit sell` against a buy ID              | Exit 2; no mutation.                                                        |
| `edit changes only supplied mutable fields`      | Edit buy quantity and clear fee                 | Other legal fields remain unchanged; full replay succeeds.                  |
| `CLI edit exposes the downstream blocking event` | The 20→15 META scenario                         | Human and JSON errors identify both events and say no changes were written. |
| `CLI delete returns the deleted event`           | Delete an independent event                     | Exit 0; JSON contains the removed canonical event.                          |

### N6. Make explicit fetch failures impossible to mistake for success

**Status:** shipped in PR 1.

**Shape**

- Retain price and FX reports instead of discarding them in `awaitSnapshot`.
- Attempt both price and FX work so every independent success is useful.
- Reload and derive the partial view after all attempts.
- Add optional structured `details` to external errors.
- In human mode, render the view on stdout and failures on stderr. In JSON mode, emit only the error envelope on stdout with the partial view nested in details.
- Keep the existing exit 1 for external failure.

**Cases**

| Test                                                       | Input                                      | Observable assertion                                                                 |
| ---------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `partial price fetch persists successes and exits nonzero` | Two price needs: one success, one failure  | Success is on disk; exit 1; failed subject/provider/reason reported.                 |
| `partial FX fetch continues after price failure`           | Failed price plus successful FX            | FX persists; both the partial view and price failure are visible.                    |
| `human partial fetch separates data and diagnostics`       | Built CLI without `--json`                 | View on stdout, failure on stderr, exit 1.                                           |
| `JSON partial fetch keeps one valid envelope`              | Same scenario with `--json`                | Stdout parses as `{ok:false}` with counts, failures, and partial view; stderr empty. |
| `complete fetch remains ordinary success`                  | All providers succeed                      | Exit 0 and unchanged success envelope.                                               |
| `rerun reuses historical successes`                        | Partial historical fetch followed by retry | Only failed needs are requested on retry.                                            |

### N7. Make incomplete and historical state easy to read

**Status:** owned by PR 3.

**Shape**

- Add type-specific summaries to human event rows.
- Print `asOf` and hole details in both glance and positions.
- A hole line names the missing price/FX subject, affected currency, and manual/fetch next step.
- Preserve compact tables, plain text, and non-interactive behavior. Do not add color as the only signal, spinners, or terminal-width-dependent assertions.
- Expand `doctor` into read-only checks for schema parsing, full replay, data/config validity, directory/file modes, and an active/stale lock. Holes are warnings; corruption, invalid replay, or unsafe permissions are failures. `doctor` performs no network calls and repairs nothing.
- Fix the existing catch-all that labels every unexpected exception as storage when touching this output path.

**Cases**

| Test                                                      | Input                               | Observable assertion                                                    |
| --------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `event rows summarize each event family`                  | All nine event variants             | Rows show the relevant amount/instrument/accounts without opening JSON. |
| `glance lists every valuation hole`                       | Missing HROW price and USD/EUR rate | Both subjects and remedies appear, not only a count.                    |
| `positions prints as-of and holes`                        | Incomplete historical view          | Resolved date and hole details appear above/below tables.               |
| `doctor reports a fresh or healthy book without holdings` | Missing home, then valid data       | No files created; checks/counts/path only; no position values.          |
| `doctor distinguishes warnings from failure`              | Valuation hole versus corrupt JSONL | Hole is warning; corruption is nonzero with file and line.              |
| `doctor reports but does not remove an uncertain lock`    | Malformed/recent lock owner file    | Nonzero actionable report; lock remains.                                |

### N8. Close the remaining load-bearing test gaps and clean the suite

**Status:** owned by PR 4. Cases already added in PRs 1–3 are recorded rather than duplicated.

This is a focused acceptance sweep, not a coverage campaign.

**Add or strengthen**

- Schema table: invalid calendar date; zero/negative primary amounts, quantity, price, and rate; negative optional fee/withholding; malformed UTC provenance instant; canonicalization of non-default decimal values.
- Accounting: actual oversell, insufficient withdrawal/fee without state mutation, destination-currency FX fee, sell fee above proceeds, withholdings above gross, dividend quote-currency mismatch, and a partial sale across two lots.
- Replay/query: same-date append-order tie, future event excluded by `asOf`, missing-price hole, same-date FX last-wins, and asset-type/account-pocket breakdown values.
- Filesystem: schema-invalid JSON on a specific JSONL line, blank interior line, unsupported schema version, duplicate account/instrument IDs, unknown/wrong-currency price, and reload-derived equivalence.
- CLI: unknown event/instrument exit 3, invalid date filters exit 2, unreadable `--file`, and one built-process historical-rate-fetch contract. PR 2 already covers malformed file input; PR 3 owns incomplete human output.
- Provider coordination: all providers exhausted, explicit pin never falls back, fallback route does, duplicate needs do not duplicate writes, and a partial FX batch resumes only failed needs.
- Provider normalization: sanitized captured raw Yahoo and CoinGecko responses exercise the real boundary schema; fixtures include provenance and refresh notes but never refresh in the gate.

**Retire or split**

- Delete `packages/core/tests/tooling.test.ts`.
- Remove dead `BookState.holes` and the obsolete test claiming rated events do not add historical-rate holes. Valuation holes are derived by queries; event-level historical rates are mandatory.
- Split the combined income-event test into focused dividend, interest, and fee cases, or one named parameterized table with visible literals.
- Split the combined accounting failure test so oversell, unknown ID, and insufficient cash fail independently.
- Split the two-scenario as-of query test.
- Split config defaults from override persistence.
- Reduce the 50-item interrupted coordinator fixture to a few named needs and stop asserting exact incidental batch sizes.
- Separate file initialization from derived reload equivalence.
- Capture `fetch-rate.test.ts` output or move the assertion to an output-free canonical operation.
- Make `pnpm test` build the CLI first; retain `pnpm check` as the completion gate.

**Keep deliberately**

- One normal-week built-CLI workflow, even though it is large and sets up through the CLI.
- Real temporary filesystem tests for parsing, permissions, locking, atomic replacement, and reload.
- Local HTTP tests for retry and status behavior.
- Selected interaction assertions where the behavior is specifically “provider was skipped,” “fallback was attempted,” or “cache was reused.”

Do not enforce Google's approximate 70/20/10 split. Test size should follow the dependency: core logic is small; filesystem, concurrency, CLI, and localhost HTTP guarantees are medium; live provider and multi-machine tests do not belong in the normal gate.

### N9. Align the documentation with the product users will actually have

**Status:** contract changes shipped with PRs 1–3; PR 5 owns the final reconciliation and first-book journey.

**DESIGN.md**

- Replace the physical append-only event-file claim with the ordered-ledger mutation contract.
- Add edit/delete commands, immutable edit fields, candidate replay, lock behavior, and irreversibility.
- Document partial-fetch output and exit behavior.
- Document machine-local default dates versus timezone-free economic dates and UTC instants.
- Make provider capabilities, disabled semantics, crypto binding, latest-fetch behavior, Yahoo lookback, and CoinGecko partitioning explicit.
- Correct acceptance case S4: transfer has one amount currency, so cross-currency `from`/`to` cannot be represented. State the structural same-currency rule instead.
- Remove `BookState.holes` from the state description after the code cleanup; valuation holes are derived by queries.
- Add the exact acceptance cases from N1–N8 that protect new boundaries.
- Add the event-list filter and binding-subject guarantees from N10.

**README.md**

- Replace `...` examples with one copy/paste first book: account, instrument, deposit versus transfer, FX, buy, marks, glance, edit rejection, and deletion.
- Explain that event dates and as-of dates are daily economic dates.
- Show what an incomplete glance looks like and how to resolve a hole manually or with `--fetch`.
- Explain partial fetch exit behavior for scripts.
- State that edit/delete has no automatic undo; copy `FINBOOK_HOME` yourself before a risky bulk change.
- Keep secrets and book data out of the checkout and remote repositories.

### N10. Finish inspection and configuration guardrails

**Status:** owned by PR 5.

**Shape**

- Add repeatable `--type`, `--instrument`, and `--source` filters to `event list`.
- Combine different dimensions with AND and values within a dimension with OR; preserve ordered-ledger order.
- Validate filter dates/types at the CLI boundary and referenced account/instrument IDs against the loaded book.
- Require instrument source bindings to reference an existing instrument before updating market configuration.
- Keep currency bindings free of a speculative registry.
- Complete root and typed-command help from the real command definitions.

**Cases**

| Test                                                     | Input                                                   | Observable assertion                                                   |
| -------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `event filters compose without reordering`               | Repeated types plus account/instrument/source/date      | OR within a dimension, AND across dimensions, original order retained. |
| `empty event filter is successful`                       | Valid filter matching no events                         | Exit 0; `[]` in JSON and `(empty)` in human output.                    |
| `event filters distinguish invalid from missing values`  | Bad type/date; unknown account/instrument               | Exit 2 for validation, exit 3 for not-found.                           |
| `instrument binding rejects an unknown local instrument` | Valid provider/identifier, nonexistent instrument ID    | Exit 3; config bytes unchanged.                                        |
| `currency binding needs no registry entry`               | Valid uppercase currency and capable provider binding   | Binding persists normally.                                             |
| `help is complete and side-effect free`                  | Root help and representative typed add/edit subcommands | Workflow/examples visible; fresh home remains untouched.               |

## Next: worthwhile after the trust work

These items are valuable but should not delay the Now stop condition.

1. **Measure market append cost.** The coordinator currently reloads the store for each appended observation. Optimize only if a representative 100-instrument fetch or a real book exceeds roughly two seconds locally.
2. **Country/currency semantics.** Keep shape validation while crypto tickers share the currency space. Introduce stricter country or fiat types only after a real invalid-value problem; do not add a large ISO dependency preemptively.
3. **Pagination or broader queries.** Add them only if a real book makes filtered full-ledger reads materially slow or unwieldy. Do not import server-style pagination into a small local file without that evidence.

## Later: ideas with explicit triggers

### Git-style book history

Explore this when accidental valid edits need undo, correction history becomes useful, or the user wants to compare book revisions.

The revision is a mutation of the book, not the financial event itself:

```text
event:    bought 20 META
revision: changed event buy-1 from 20 META to 15 META
```

The design exploration must compare:

- An internal immutable revision log with `log`, `diff`, and `revert` commands.
- Optional use of an existing user-owned Git repository.
- Literal Git managed by finbook.

Do not assume literal Git wins. It adds repository lifecycle, binary/version availability, lock interaction, merge/conflict semantics, and accidental-remote disclosure risk. The no-backup decision means history before adoption cannot be reconstructed; a future revision system starts with the then-current book as its baseline.

### Persisted book timezone

Add an IANA timezone setting when machine-local “today” produces observed confusion across machines or travel. It changes default view resolution only; stored economic dates remain unchanged.

### CI

Add hosted CI when a second regular contributor, protected branch, or remote release process exists. Until then, the pinned local `corepack pnpm check` gate is sufficient.

### Durable latest-fetch intent

Add persisted request intent only if always-refetching latest data causes observed rate-limit or latency problems. That work requires an explicit cache invalidation rule and stored-schema/rollback design; it is not a free optimization.

## Explicit non-goals

- SQLite or another database.
- Distributed or re-entrant workflows, service queues, sagas, or network locks.
- Automatic backups in the edit/delete phase.
- Literal Git integration in the Now plan.
- Live network calls in the normal test gate.
- A percentage coverage target or a forced 70/20/10 test ratio.
- Interactive prompts, color-dependent meaning, spinners, or a TUI.
- Pagination, a query language, or saved searches without evidence from a real book.
- Metrics, tracing, telemetry, or a remote logging service.
- Broker parsers, schedulers, Effect, tax reports, or the reserved app package.
- Intraday portfolio accounting, settlement modeling, or exchange-timezone logic.
- Sync-conflict resolution or multiple live copies of `FINBOOK_HOME`.
- Encryption implemented by finbook; use OS/filesystem encryption and permissions.

## Migration, rollback, and compatibility

- Event, price, FX, account, and instrument record shapes remain unchanged in the Now plan. No data migration or schema-version bump is required.
- Existing valid add command lines and `event add --file` remain supported.
- The typed command refactor may change help layout and will begin rejecting previously ignored irrelevant flags. That is an intentional validation tightening.
- `error.details` is optional and additive. Existing consumers of `type`, `message`, and `hint` continue to work.
- An older finbook binary can read a book after an edit/delete because the stored event shapes remain valid. It cannot restore the previous value.
- Code rollback is ordinary source rollback. Data rollback after a valid edit/delete is impossible without the user's external copy; this is the accepted no-backup trade-off.
- Lock artifacts are ephemeral and are never part of a book backup or source-of-truth data.
- Power-loss durability beyond atomic rename and ordinary filesystem guarantees is out of scope until there is an observed failure.
- PR 3's doctor fields and PR 5's filters are additive. PR 5 intentionally tightens new instrument source bindings, but existing stored config remains readable.

## Stop condition

The improvement program is complete when:

1. Every confirmed defect in the table has a regression test that was observed failing before its fix.
2. Direct core writes, CLI writes, edits, and deletes all pass through the locked canonical mutation boundary.
3. The 20→15 META correction scenario is rejected with the original file intact.
4. A partial provider fetch persists successes, exposes failures, and exits nonzero in human and JSON modes.
5. Help is side-effect free, root JSON is valid, and omitted current-view dates use the machine-local day.
6. Human event history is understandable at a glance; glance and positions expose `asOf` and every hole with a next action.
7. Doctor diagnoses fresh, incomplete, busy/stale, unsafe, and corrupt local books without writing or using the network.
8. The remaining domain/storage/provider guarantees are pinned by focused tests, `pnpm test` builds what it runs, and the suite emits no accidental application output.
9. Event filters compose without reordering, and instrument source bindings reject nonexistent local instruments before writing config.
10. `DESIGN.md`, help, and README describe the shipped behavior and provide one complete copy/paste journey.
11. `corepack pnpm check` passes repeatedly, tests pass alone and in arbitrary order, and the normal-week workflow remains green.

At that point, stop. The **Next** and **Later** sections are a decision register, not permission to extend the implementation indefinitely.
