# finbook — design snapshot

Handoff for a developer who was not in the planning conversation. This file is the source of truth for v1. If something is not here, it was not agreed.

**Product name:** finbook
**Binary:** `finbook`
**Repo:** `this repository`
**Data dir:** `$FINBOOK_HOME`, default `~/.finbook`
**Audience:** one person, this machine. Backup is copy the data folder.

---

## 1. What it is

A local book of economic events that answers, at a glance:

- How much I have, and where it is
- How much I put in, and how much I gained or lost
- How the portfolio is distributed
- Enough raw facts that Spanish tax work can be done later *elsewhere*, with the original broker PDFs as the legal source

It is **not** a broker, not a trading tool, not a tax filing product, and not an official audit trail.

The home screen (CLI first) should read as:

> I have X €.
> I contributed Y €.
> I gained/lost Z €.
> It sits in these buckets.
> (Holes: lines that could not be converted to EUR.)

v1 does **not** print “this year I should declare …” or 720/721 obligation. Those are later *readers* of the same book.

### Current reality this replaces

Spreadsheets and broker statements that disagree about transfers, fees, and FX. Software earns itself because the book has rules a sheet keeps getting wrong: own-account transfers are not contributions, fees ride with lots, FX is not guessed.

A spreadsheet is still a valid cheaper path if the owner does not want to type events. That path was rejected.

---

## 2. Scope of v1

**In**

- Manual event entry (flags or one JSON object)
- Accounts, instruments, price stamps, FX stamps
- Derived glance and positions
- Typed history (list/get events)
- Local files only
- CLI only

**Out (same book, later work)**

- Broker parsers (IB, MyInvestor, Revolut X, …). When they exist they **emit these events**; they do not invent a second schema. Broker row types are not the book. IB “FX Translations P&L”, withholding as a sibling row, and “Deposit” that is really an own-account transfer must be collapsed or classified by the user/parser — never ingested raw.
- Schedulers, live price APIs, Effect, background jobs
- Desktop/web app (`packages/app` is reserved and empty)
- FIFO *report*, currency-FIFO / DGT V0282-22 figures, casillas
- 720/721 cockpit (we still store the fields those views will need)
- Q4 average cash (needs a daily series or a manual stamp)
- Fondo-to-fondo traspaso, splits, crypto-to-crypto swaps
- Matching a broker’s EUR cash to the cent

**Prediction that controls the cut:** if a normal week (transfer or deposit, fx, buy, dividend, sell) can be booked and the glance answers tengo / aporté / gané / está aquí without treating a transfer as a withdrawal, v1 is done. If a 720 number or a casilla is required before that feels useful, the cut is wrong — stop and reopen this file.

---

## 3. Core principle

The **book is the events**. Positions, weights, contributed capital, glance totals are **queries**.

You never type “current portfolio” as source of truth. A buy does not update “current price” except as a default if no stamp exists yet.

Clarity > more metrics.

---

## 4. Domain

### 4.1 Config (not events)

```ts
Account = {
  id: string           // slug, e.g. "ib"
  name: string
  platform: string     // e.g. "interactive-brokers", "myinvestor", "revolut-x"
  country: string      // ISO 3166-1 alpha-2 of custody, for later 720/721
  custodial: "broker" | "crypto-exchange" | "cash"
}

Instrument = {
  id: string           // slug, e.g. "VWCE", "HROW", "BTC"
  name: string
  type: "stock" | "etf" | "fund" | "crypto"
  quoteCurrency: string // one canonical quote currency for v1 trades and marks
  isin?: string
}
```

**One instrument, many holdings.** 10 VWCE on IB and 5 on MyInvestor is one instrument, two pockets. Glance can group by instrument or by account.

**One quote currency per instrument in v1.** Every buy, sell, dividend, and price stamp for an instrument uses its `quoteCurrency`. Multiple listings or quote currencies reopen this design; they do not get added as an ad hoc second price key.

**Cash is not an instrument.** Cash is the implied balance per account per currency after applying events.

### 4.2 Money

On disk and on the wire, decimal values never use IEEE `number`:

```ts
Money = { amount: string /* decimal */, currency: string /* ISO 4217 or crypto ticker */ }
```

Amounts, quantities, prices, rates, and weights are decimal strings at the boundary. Counts may be normal integers. In core, parse decimal strings with `decimal.js`; a `Money` wrapper **refuses** to add different currencies.

Reporting currency is **EUR**. Not a setting.

Every cash movement that needs a historical EUR conversion may carry `eurPerUnit`: EUR per 1 unit of that currency **on that day**. It is `1` when the money is already EUR.

- If a non-EUR event amount has no historical `eurPerUnit`, it creates a visible `historical-rate` hole. The system must not use a current `FxStamp` as that historical rate.
- A historical-rate hole does not block current valuation when a current price/FX stamp can mark the value. It remains visible until a future explicit enrichment supplies a rate.
- If a deposit or withdrawal is missing its historical rate, `contributedEur` and `pnlEur` are `null` because the contribution basis is incomplete.
- If a live cash balance or position has no as-of valuation mark, `totalEur` is `null`; the missing mark is a `valuation` hole.
- Event-level rates are the historical rates used for later tax readers. They are never overwritten by today’s FX stamp.

### 4.3 Events

The shared base does not contain `account`, because a transfer has two accounts:

```ts
Base = {
  id: string
  date: string          // ISO date YYYY-MM-DD; trade/value date
  note?: string
  source: "manual" | string   // future parsers add their own source id
  externalId?: string   // unique together with source; import idempotency
}

AccountEvent = Base & {
  account: string       // Account.id
}

TransferEvent = Base & {
  type: "transfer"
  from: string          // Account.id
  to: string            // Account.id
  amount: Money
}
```

Variants:

| Type | Extra fields | Meaning and v1 rules |
|---|---|---|
| `deposit` | `account`, `amount: Money`, `eurPerUnit?` | Cash in from the rest of life. **Increases contributed.** Amount is positive. |
| `withdrawal` | `account`, `amount: Money`, `eurPerUnit?` | Cash out to the rest of life. **Decreases contributed.** Amount is positive. |
| `transfer` | `from`, `to`, `amount: Money` | Own account → own account. **Same currency only**, endpoints must differ, and contributed is unchanged. It has no `account` field. |
| `fx` | `account`, `from: Money`, `to: Money`, `fee?: Money` | Currency A → B on **one** account. `from.currency !== to.currency`; a fee may use either of those currencies. Not a contribution. |
| `buy` / `sell` | `account`, `instrument`, `qty` (decimal string), `price: Money`, `fee?: Money`, `eurPerUnit?` | Cash ↔ asset on the same account. `price.currency === instrument.quoteCurrency`; a trade fee, when present, uses that same currency. Contributed unchanged. |
| `dividend` | `account`, `instrument`, `gross: Money`, `withholdingForeign?: Money`, `withholdingDomestic?: Money`, `eurPerUnit?` | Cash up by **net** (gross − withholdings). Store gross. All amounts use the instrument quote currency. Contributed unchanged. |
| `interest` | `account`, `gross: Money`, `withholdingForeign?: Money`, `withholdingDomestic?: Money`, `eurPerUnit?` | Same cash rule as dividend, with no instrument. All amounts use one currency. |
| `fee` | `account`, `amount: Money`, `eurPerUnit?` | Standalone account fee, **not** attached to a trade. Amount is positive. |

All user-entered amounts, quantities, prices, and rates are positive decimal strings. Optional fees and withholdings are non-negative. Withholdings must use the gross currency. V1 rejects an oversell, any cash operation that would make a balance negative, and unknown account/instrument IDs.

**Fees on trades live on the trade**, not as a sibling `fee` event.

- A `buy`/`sell` event has one ID and its nested fee is unambiguously attached to that trade.
- Buy fee → part of native coste de adquisición (the lot).
- Sell fee → part of native valor de transmisión.
- Net cash moved = `qty * price ± fee` in the trade currency.
- A standalone `fee` event is used only when there is no associated trade.

**Transfer is same-currency only.** EUR → USD on one account is `fx`. EUR leaving MyInvestor and USD arriving at IB is `transfer` (EUR) + `fx` (on IB), or two events the user understands — never withdrawal + deposit.

**A broker “Deposit” is not automatically a `deposit`.** If the money left another owned account, it is a `transfer`. The user (or a future parser with a mapping) must classify this. Getting it wrong breaks “I contributed Y”.

**Not events**

- Price stamps and glance FX stamps
- Broker FX translation P&L / rounding crumbs
- Splits, mergers, crypto-to-crypto (`swap`) — later variants on the **same** union

### 4.4 Stamps (not events)

```ts
PriceStamp = { instrument, price: Money, asOf: date }
FxStamp    = { pair: "USD/EUR" /* quote = EUR per 1 USD */, rate: string, asOf: date }
```

A `PriceStamp.price.currency` must equal the instrument’s `quoteCurrency`. EUR has an implicit FX rate of `1`; every other currency needs an `FxStamp` to be valued in EUR.

Glance and positions as-of `D` use the last stamp with `asOf <= D`. A buy’s price is **not** a mark unless no earlier price stamp exists; then the last trade price may be used as a fallback, still dated. If no price or FX mark exists, the affected value is a valuation hole.

Events are also filtered by `event.date <= D` before replay. Same-date events use their append order as the stable tie-breaker.

### 4.5 Derived state

Pure function: `(state, event) → Result<state, DomainError>`.

```
state
  cash[account][currency]          // Money
  lots[account][instrument]        // qty + native cost (fee-inclusive) + event ids
  contributedEur                   // known rated deposits − withdrawals
  holes                            // event/valuation holes with source and reason
```

v1 may reduce lots on sell **proportionally** so holdings look right. That is **not** the official FIFO report. FIFO matching (valores homogéneos, one instrument across accounts as required later) is a later reader of the same lots.

Glance:

```
totalEur        = marked positions + cash using as-of stamps;
                  null if any live value cannot be marked
contributedEur  = net deposits/withdrawals with historical rates;
                  null if a deposit/withdrawal rate is missing
pnlEur          = totalEur − contributedEur when both are known;
                  otherwise null
holes           = historical-rate and valuation holes
byPlatform, byAssetType, byCurrency, cash, weights
asOf            = the date asked
```

A missing historical rate on a buy, sell, dividend, interest, or standalone fee remains a visible hole, but does not by itself make a currently markable position unknown. `Z` on the home screen is `pnlEur` when available; it is not “IRPF this year” and not currency-FIFO P&L.

---

## 5. Spanish tax — store inputs, do not file

The app does not prepare or present taxes. Original documents stay with the owner.

**Store (cheap, needed later)**

- Dates, quantities, native prices, fees on the lot
- `eurPerUnit` on each cash movement
- Dividend/interest **gross** and foreign/domestic withholding
- Account `country` and `custodial` (720 vs 721 vs neither)
- Instrument `isin`
- 31 Dec values = positions × price stamps as-of that day

**Do not compute in v1**

- Whether 720/721 is obligatory (thresholds 50k / +20k, Q4 average cash)
- Convenio / double-tax credit
- Official FIFO report
- Currency lots / DGT consulta **V0282-22** figures
- Fondo traspasos

### Multi-currency (blogs are interpretations, not a filing spec)

Two different numbers must not be mixed:

| | Glance (v1) | Informal IRPF note (later) |
|---|---|---|
| Sale | EUR wealth now vs contributed | **P&L in native**, then × EUR rate **on the sale day** |
| Currency | cash × today’s FX stamp | USD/GBP is its own FIFO asset |
| Dividend | cash went up | gross × rate that day; **net** foreign cash opens a currency lot at that rate |
| Stock loss in USD | units/cash moved | native loss × sale rate, **and** those dollars leave currency FIFO |

If you convert P&L to EUR on the buy date *and* again when you sell the dollars, you count the same move twice.

**Future historical-rate enrichment.** A future parser may supply `eurPerUnit` before emitting an event. A future explicit enrichment command may fetch a historical rate from an API for an existing hole. That enrichment must retain the event id, effective date, source, and retrieval time; it must not silently rewrite the original event, use a current `FxStamp` as the historical rate, or present the result as an official tax calculation. Until then, v1 leaves the hole visible.

v1 already stores enough raw shape for a later V0282-22 reader: every cash delta has `date + native money + optional eurPerUnit`. Do not add a `currency_lot` event type. Do not show those figures on the glance.

References the planner used (informal, not law):
https://bovedainversion.com/declaracion-de-irpf-multidivisa/
https://www.invirtiendopocoapoco.com/fiscalidad-en-cuentas-multidivisa/

---

## 6. Worked example (clean numbers, not an IB row)

```
2026-03-03  deposit   ib     800 EUR
2026-03-03  fx        ib     798 EUR → 927.04 USD     fee 1.71 EUR
2026-03-03  buy       ib     20 HROW @ 40.45 USD      fee 0.28 USD    eurPerUsd 0.861
2026-06-25  dividend  ib     META  1.07 USD           withholdForeign 0.16 USD   eurPerUsd 0.925
2026-08-05  sell      ib     12 HROW @ 39.83 USD      fee 0.37 USD    eurPerUsd 0.866
```

If the 800 EUR left MyInvestor, the first line is `transfer` myinvestor → ib, not `deposit`.

A future IB parser maps “Buy + commission” → one `buy`, “Dividend + Foreign Tax” → one `dividend`, and **drops** translation P&L.

---

## 7. Data on disk

```
$FINBOOK_HOME/          # default ~/.finbook
  meta.json             # { schemaVersion }
  accounts.json
  instruments.json
  events.jsonl          # append-only book
  prices.jsonl
  fx.jsonl
```

- Inspectable files. Backup = copy this folder.
- Never commit this folder. Never write the book into the git checkout.
- `events.jsonl`, `prices.jsonl`, and `fx.jsonl` are append-only. For a repeated price or FX key at the same date, the last appended record wins.
- `source` + `externalId` unique when `externalId` is present (parser retries).
- A corrupt JSONL line fails that line and identifies its file and line number; do not silently skip.
- File mode: owner-only where the OS allows (`0600`).
- Parse at the boundary with Zod. Downstream sees the parsed type, never the raw line.

Override `FINBOOK_HOME` for tests (temp dir) and if the owner later keeps the folder in a sync path. v1 is still **one live copy**. Sync conflicts are out of scope.

---

## 8. CLI

Agent-friendly. Noun → verb. **No prompts.** Every command accepts `--json`. Data on stdout, noise on stderr. Missing required flags → fail fast, exit 2, list what is missing.

```
finbook doctor
finbook account add|list|get
finbook instrument add|list|get
finbook event add <type> …          # flags
finbook event add --file …          # same object
finbook event list [--account] [--from] [--to]
finbook event get <id>
finbook price set|list
finbook fx set|list                 # glance rates, not tax rates
finbook show glance [--as-of]
finbook show positions [--as-of]
```

Human tables by default. JSON envelope is stable (additive only):

```ts
{ ok: true, data: T } | { ok: false, error: { type: string, message: string, hint: string } }
```

Monetary fields in `data` use `Money` (`amount` is a decimal string). Quantities, rates, and weights are decimal strings; counts may be integers. A `null` EUR total means the corresponding value is incomplete under §4.5. Human tables may format these values for readability.

Exit codes: `0` success (including empty lists), `2` validation, `3` not found, `1` unexpected bug.

Flags and `--file` share **one** Zod object per command. `--file` contains one canonical command object. The CLI does not re-implement domain rules; it calls core.

`doctor`: schema version, event count, hole count, data path. Works even if the book is empty. Does not dump holdings unless asked.

---

## 9. Architecture

```
finbook/
  packages/core     # schema, Money, apply, queries
  packages/cli      # finbook binary
  packages/app      # reserved, empty until a later design
```

- `core` is in-process, deterministic, no I/O in apply/query.
- Filesystem adapter is a **local-substitutable** dependency (real temp dir in tests). Not a port with a fake in-memory repo unless a second store appears.
- Brokers and HTTP prices are **not** ports in v1. One adapter is a hypothetical seam.
- When a second price source exists: `Prices.asOf(instrument, date)` with file adapter + HTTP adapter. HTTP stays in the adapter. Core does not get rewritten. Fetchers emit **stamps**, not events.
- When a parser exists: it emits **events**. Same rule.
- **Do not add Effect** for a future API. v1 is parse → apply → append → print. Thrown exceptions = bugs. Expected failures = the `ok: false` union, one shape from core to `--json`.

Clock and ID generation are injected (or passed in) so tests do not freeze global time.

---

## 10. Stack (pinned)

| Layer | Pin |
|---|---|
| Runtime | Node `^24.19.0` (Active LTS). Project must refuse Node 26. |
| Package manager | pnpm `11.24.0` (`packageManager` field) |
| Language | TypeScript `7.0.2` |
| Node types | `@types/node` `24.13.3` |
| Modules | `"type": "module"`, `module`/`moduleResolution`: `nodenext` |
| Build | `tsc -b` project references → `dist/`. Bin runs `dist`. No Bun, no Deno, no tsx as the product path. |
| Lint | oxlint `1.80.0` + `@oxlint/plugins` `1.80.0` + oxlint-tsgolint `7.0.2001`, `--type-aware` + copied anti-slop rules |
| Format | oxfmt `0.65.0` |
| Test | Vitest `4.1.11`. No module mocks. |
| Schema | Zod `4.4.3`. Types inferred from schemas. One library. |
| Money | decimal.js `10.6.0` |
| CLI parser | commander `15.0.0` (argv + help only; Zod still owns the object). Optional flip: drop commander for `util.parseArgs`. |
| Dates | ISO `YYYY-MM-DD` + injected clock. No luxon. |
| Monorepo | pnpm workspaces only. No Turbo. |

`engines`: `node: ^24.19.0`. `.node-version`: `24`.

tsconfig on from day one: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `skipLibCheck`. Target **ES2024**.

Gate: `pnpm check` = `tsc -b && oxlint --type-aware && oxfmt --check && vitest`.

No CI until someone wants it; then it runs the **same** command. Until then the gate is mandatory locally (say so in `AGENTS.md` when that file is written — last, from what the gates cannot hold).

**Not in the install:** Effect, neverthrow, citty, clipanion, eslint next to oxlint, Clack/inquirer, ora, dotenv (parse `FINBOOK_HOME` once at boot).

The developer’s unqualified `node` on this machine may be 26. The **project** pins 24 (`node@24` is installed keg-only). Fail loudly on the wrong major.

If TypeScript 7 + Vitest is broken on day one, drop TypeScript to `5.9.3`. That is not a data-model change.

---

## 11. Tests and acceptance cases

Write each behavior test first, then implement until it passes. A behavior commit is committed only when `pnpm check` is green. Tests attach to the same interfaces callers use; do not import private helpers to make a test easier.

Dependency strategy:

- Core domain tests are in-process and deterministic. Pass the clock and ID generator; do not freeze globals.
- File-store tests use a real temporary `FINBOOK_HOME`, not an in-memory fake.
- CLI tests spawn the built `dist` binary with a temporary data directory. They do not mock modules.
- Tests assert the invariant itself, not an incidental object shape or implementation detail.

### Schema and boundary cases

| ID | Input | Observable outcome |
|---|---|---|
| S1 | A valid `buy` with decimal-string amounts | Parses into the trusted event type and serializes decimal values as strings. |
| S2 | A JSON number in `Money.amount` | Rejected at the boundary; no raw value reaches core. |
| S3 | Invalid ISO date, non-positive primary amount/quantity/price/rate, negative fee, or non-canonical currency | Rejected with a validation error. |
| S4 | A transfer with `from`/`to` in different currencies, equal endpoints, or an `account` field | Rejected; a valid transfer has two endpoints and no `account` field. |
| S5 | A trade or price stamp whose currency differs from `Instrument.quoteCurrency` | Rejected. |
| S6 | Withholding in a currency different from gross, or a trade fee in a currency different from price | Rejected in v1. |

### Core accounting and query cases

| ID | Input | Observable outcome |
|---|---|---|
| A1 | `deposit` 800 EUR into `ib` | Contributed increases by 800 and `cash[ib][EUR]` increases by 800. |
| A2 | A rated EUR withdrawal | Cash and contributed both decrease by the withdrawal amount. |
| A3 | Transfer 200 EUR from `ib` to `myinvestor` | Cash moves between accounts; contributed and total wealth are unchanged. |
| A4 | FX 798 EUR → 927.04 USD with a EUR fee | Source cash, destination cash, and fee cash change correctly; contributed is unchanged. |
| A5 | Buy 20 HROW at 40.45 USD with a 0.28 USD fee | USD cash decreases by net cost; holding is 20; native lot cost includes the fee. |
| A6 | Sell 12 of a 20-unit holding with a sell fee | Holding becomes 8; cash increases by net proceeds; contributed is unchanged. |
| A7 | Dividend gross 1.07 USD with 0.16 USD withholding, and an equivalent interest event | Cash increases by 0.91 USD; gross and withholding remain stored; contributed is unchanged. |
| A8 | Standalone account fee | Cash decreases; it is not attached to a lot or trade. |
| A9 | Unknown account/instrument, oversell, or operation that makes cash negative | Returns an expected domain error and does not mutate state. |
| A10 | Same instrument held on two accounts | One instrument is grouped across two account holdings; account and instrument weights are correct. |
| A11 | Non-EUR buy without historical `eurPerUnit`, with a current price/FX stamp | Native position remains; current mark is possible; a `historical-rate` hole is visible. |
| A12 | Deposit/withdrawal without historical `eurPerUnit` | Current cash may be marked, but `contributedEur` and `pnlEur` are `null` and the hole identifies the event. |
| A13 | `show ... --as-of D` with later price/FX stamps and later-dated events | Only events dated ≤ D and the last stamps dated ≤ D are used. |
| A14 | Events appended in June then May | Replay orders them by event date, using append order for same-date ties; the late May event is included correctly. |
| A15 | Missing price fallback and missing FX stamp | Last trade price may provide the documented price fallback; missing non-EUR FX creates a valuation hole. |

### File-store cases

| ID | Input | Observable outcome |
|---|---|---|
| P1 | Append events, prices, and FX stamps, then reload | Reloaded state and queries equal the in-memory result. |
| P2 | Existing event with the same `source` and `externalId` | Append is rejected and the file is unchanged. |
| P3 | A corrupt JSONL line | Load fails with the file and line number; the line is never silently skipped. |
| P4 | A fresh data directory and a supported POSIX filesystem | Required files/directories use owner-only permissions where the OS permits. |
| P5 | Two price or FX records with the same logical key and date | The last appended record is the value used by queries. |

### CLI cases

| ID | Input | Observable outcome |
|---|---|---|
| C1 | Empty `FINBOOK_HOME`; run `doctor` | Succeeds and reports schema version, zero event count, zero holes, and data path without dumping holdings. |
| C2 | Missing required `--account` with `--json` | Exit 2; stdout contains the stable `ok: false` envelope and `hint` names the missing flag. |
| C3 | Unknown account/instrument/event ID | Exit 3 with a not-found error. |
| C4 | The same command supplied by flags and by `--file` | Both produce the same canonical Zod input and core result. |
| C5 | A successful and failed `--json` command | Data/error stays on stdout; diagnostics stay on stderr; the envelope shape is stable. |
| C6 | `show glance --json` with complete and incomplete data | Includes `asOf`, `totalEur`, `contributedEur`, `pnlEur`, `holes`, and breakdowns; money and decimal values use the wire conventions in §8. |
| C7 | The worked normal week from §6 | The glance distinguishes contribution, transfer, income, fees, holdings, and holes as designed. |
| C8 | Run the CLI under an unsupported Node major | Fails loudly before doing work. |

Do **not** test FIFO tax matching, V0282-22, 720/721 obligations, broker parsing, live prices, or scheduler behavior in v1.

---

## 12. Full implementation plan

Every behavior commit writes its test case first, then the implementation, and is committed only while the available gate is green. No intentionally red commits. From the tooling commit onward, every commit must pass `pnpm check`. The plan stops at v1 CLI; `packages/app` remains empty.

### Target repository shape

```text
finbook/
  package.json                 # workspace metadata, pins, scripts, bin-facing commands
  pnpm-workspace.yaml
  pnpm-lock.yaml
  .node-version
  .gitignore
  tsconfig.base.json           # shared strict compiler options
  tsconfig.json                # project references
  vitest.config.ts
  oxlint.config.ts             # type-aware lint and local JS/TS plugin registration
  .oxfmtrc.json                # formatter configuration
  .oxfmtignore                # vendored plugin and agent-artifact exclusions
  tools/
    assert-node.mjs
    oxlint/anti-slop/          # vendored and locally owned rules
  packages/
    core/
      package.json
      tsconfig.json
      src/                      # schemas, money, apply, replay, queries, file store
      tests/                    # core and file-store tests
    cli/
      package.json
      tsconfig.json
      src/                      # boot, commands, output, exit mapping
      tests/                    # built-binary CLI tests
    app/
      .gitkeep                  # reserved; not a workspace package in v1
  README.md
  AGENTS.md
```

`@finbook/core` owns the domain and the local filesystem adapter. `@finbook/cli` owns environment boot, Commander argv parsing, human formatting, JSON envelopes, and process exit codes. The core never reads the environment or performs I/O from `apply`, `replay`, or queries.

### Milestone 0 — green repository scaffold

| Commit | Change | Evidence before commit |
|---|---|---|
| M0.1 `chore: pin runtime and workspace` | Create the private root package, `packageManager`, Node engines, `.node-version`, pnpm workspace, lockfile, `.gitignore`, and reserved app directory. | Pinned pnpm install succeeds on Node 24; generated lockfile is committed. |
| M0.2 `chore: add TypeScript project references` | Add shared and package tsconfigs with strict flags, `@finbook/core` and `@finbook/cli` package shells, ESM metadata, `dist` output, and the CLI bin entrypoint. | `tsc -b` succeeds; core builds before CLI; the emitted bin has the Node shebang. |
| M0.3 `chore: establish the quality gate` | Add Vitest, Oxlint with type awareness, Oxfmt, the vendored anti-slop plugin under `tools/oxlint/anti-slop`, ignore rules, and root scripts for `typecheck`, `lint`, `format:check`, `test`, and `check`. | `pnpm check` succeeds; a temporary known anti-slop violation is rejected, proving the plugin is registered. |
| M0.4 `feat(cli): add runtime guard and empty doctor` | Add the Node-major guard, one-time `FINBOOK_HOME` parsing, safe data-path resolution, and an empty-book `doctor` that works before any data exists. | Empty `doctor` works in human and JSON modes; unsupported Node fails before work; the data path is outside the checkout. |
| M0.5 `docs: add README and AGENTS.md` | Document the product boundary, mandatory gate, parsing/error/test conventions, and scaffold usage. This is the last scaffolding commit, after compiler/lint/format/test opinions are enforced by files. | `pnpm check` succeeds and a fresh contributor can find the gate and run the empty doctor. |

**M0 acceptance:** a clean checkout can install with the pinned toolchain, build both packages, run `pnpm check`, reject the wrong Node major, and run `doctor` against an empty temporary data directory without writing the book into the checkout.

### Milestone 1 — trusted domain schema

| Commit | Change | Cases |
|---|---|---|
| M1.1 `feat(core): add money and config schemas` | Add decimal-string parsing/canonical serialization, `Money`, date/currency/ID schemas, `Account`, `Instrument.quoteCurrency`, `Meta`, parsed types, and domain error/result types. | S1–S3 |
| M1.2 `feat(core): add event and stamp schemas` | Add the discriminated event union, transfer-without-`account` shape, same-currency trade/withholding rules, stamp schemas, and cross-field validation. | S4–S6 |

**M1 acceptance:** invalid wire data is rejected at the boundary, valid data reaches core only as inferred trusted types, and no schema has a parallel hand-written type.

### Milestone 2 — deterministic accounting engine

| Commit | Change | Cases |
|---|---|---|
| M2.1 `feat(core): apply cash events` | Implement pure `apply` and `Result` error handling for deposits, withdrawals, transfers, FX, account lookup, cash invariants, and unchanged contribution rules. | A1–A4, A9 |
| M2.2 `feat(core): apply positions and income` | Add proportional lots, buy/sell fees nested on trades, dividends, interest, standalone fees, quote-currency checks, and oversell/negative-cash rejection. | A5–A10 |
| M2.3 `feat(core): replay and derive glance` | Add chronological replay, stable same-date ordering, as-of filtering, price/FX marking, price fallback, holes, positions, weights, and null handling for incomplete EUR totals. | A11–A15 |

**M2 acceptance:** the §6 worked week can be represented in memory; the glance answers the defined questions without file or network access; applying an invalid event returns an error and leaves state unchanged.

### Milestone 3 — durable local book

| Commit | Change | Cases |
|---|---|---|
| M3.1 `feat(core): add filesystem book store` | Create/load `meta.json`, config JSON, and append-only JSONL files; parse every line with Zod; return file/line-aware corruption errors. | P1, P3 |
| M3.2 `feat(core): add append policies` | Enforce `source` + `externalId` idempotency, last-appended stamp semantics, owner-only modes where supported, safe directory creation, and reload equivalence. | P2, P4, P5 |

**M3 acceptance:** copying `FINBOOK_HOME` is a complete backup; append/reload produces the same derived result; malformed data is loud and never silently skipped.

### Milestone 4 — CLI read surface

| Commit | Change | Cases |
|---|---|---|
| M4.1 `feat(cli): add command contracts and output mapping` | Map Commander argv into one Zod command object, implement stable JSON envelopes, human errors, exit codes, stdout/stderr separation, and help text. | C2–C5 |
| M4.2 `feat(cli): add read commands` | Implement account/instrument/event list/get, stamp list, and the real filesystem-backed `doctor`. | C1, C3 |
| M4.3 `feat(cli): add glance and positions` | Implement `show glance` and `show positions`, including `--as-of`, human tables, JSON Money values, holes, and breakdowns. | C6 |

**M4 acceptance:** every read command works from an empty and populated temporary book, and scripts can rely on the documented envelope and exit codes.

### Milestone 5 — CLI write surface

| Commit | Change | Cases |
|---|---|---|
| M5.1 `feat(cli): add account and instrument writes` | Implement `account add` and `instrument add`, including quote currency, duplicate IDs, validation, and persistence. | S5, C4 |
| M5.2 `feat(cli): add event writes` | Implement every event variant through flags and `--file`; both paths produce the same canonical Zod input; core remains the only domain-rule implementation. | S4, S6, A1–A10, C4 |
| M5.3 `feat(cli): add price and FX writes` | Implement `price set` and `fx set`, append semantics, as-of validation, and the complete §6 normal-week flow. | A13, A15, C7 |

**M5 acceptance:** a fresh `FINBOOK_HOME` can be populated entirely through the CLI, reloaded, queried, and inspected with `doctor`; the normal-week prediction in §2 holds.

### Milestone 6 — v1 stop and hardening

| Commit | Change | Evidence |
|---|---|---|
| M6.1 `chore: harden v1 edges` | Exercise empty, one-item, many-item, long-note, missing-mark, malformed-file, duplicate, wrong-runtime, and permission paths; remove temporary scaffolding. | Full S/A/P/C suite and manual smoke script pass. |
| M6.2 `docs: record v1 boundary` | Finalize README examples, CLI help, known limitations, and the no-app/no-parser/no-network boundary. | `pnpm check` passes; no tax/FIFO behavior is exposed accidentally. |

**v1 stop condition:** a normal week of transfer or deposit, FX, buy, dividend, sell, and fee can be entered without turning a transfer into a contribution; glance and positions are correct as-of a date; typed history is inspectable; holes are explicit; and all acceptance cases pass. Do not add the app, broker parsers, live prices, schedulers, CI, or tax reports as part of this milestone.

---

## 13. Security and privacy (v1)

Threat: the owner’s disk, a copy of the folder, or an agent echoing `--json` into a chat.

- Single user, no auth, no network in v1.
- Do not log secrets (there are none) or dump the full book in `doctor`.
- Data classification: financial holdings. Collect only what the book needs.
- No multi-tenant anything.

---

## 14. Decisions already closed

Do not reopen these without changing this file.

- Event ledger from day one, not position snapshots.
- v1 = glance + typed history, not the full PRD UI.
- CLI first; app later on the same core.
- Price/FX stamps ≠ events; tax FX lives on the event.
- One instrument, many holdings; cash implied.
- One `quoteCurrency` per instrument in v1.
- EUR reporting; current stamps never replace historical event rates.
- Missing historical rates remain visible holes until explicit future enrichment.
- Native amounts always stored as decimal strings on disk and wire.
- Transfer ≠ contribution ≠ sale; transfer has `from`/`to`, not `account`.
- Trade fees are nested on `buy`/`sell`; standalone `fee` is unrelated to a trade.
- Same-currency trade fees and withholdings only in v1.
- No short positions or negative cash in v1.
- Events replay by date, with append order as the same-date tie-breaker.
- Withholding is a field, not a second event.
- No Effect, no parsers, no live prices, no scheduler in v1.
- Name is **finbook**, English throughout (code, CLI, docs).
- Stack as in §10.

---

## 15. Open only if implementation forces it

- Exact storage and provenance model for future historical-FX enrichment. The v1 rule is fixed: no network, no silent rate substitution, visible hole.
- Multiple quote currencies/listings for one instrument.
- Commander → `parseArgs` if the extra dependency is hated.
- TypeScript 7 → 5.9.3 if the toolchain is broken.
- oxfmt → Prettier 3.9.6 if oxfmt is painful.

Everything required for v1 is decided. These are either explicit future work or toolchain contingencies. Build milestone M0.