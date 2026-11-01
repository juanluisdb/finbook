# Market-data subsystem

`packages/market-data` turns recorded portfolio exposures into validated, dated local price and FX observations. Explicit historical acquisition saves useful progress, reuses completed work, and leaves portfolio reads independent of the network. Historical event-rate lookup is a separate input operation.

`packages/market-data/src/coordinator.ts::MarketDataCoordinator.updateHistory` delegates acquisition to `packages/market-data/src/history.ts::HistoryUpdater`. The subsystem never changes transactions, schedules work, or fetches without an invoking caller. Core sees normalized economic dates and decimal strings rather than provider payloads.

## Follow the acquisition flow

```text
recorded events -> end-of-day core queries -> required exposure intervals
    -> subtract intact source-matching checks -> newest unchecked ranges
    -> include catch-up from latest saved eligible observation
    -> native provider range / batched FX feed -> validate whole response
    -> retain relevant interval and catch-up dates -> append observations
    -> persist range check -> report saved, reused, empty and failed work
```

`packages/provider-sdk/src/index.ts` owns the public economic-data contract and schemas. `packages/market-data/src/contracts.ts` owns internal normalized observations, source interfaces, book configuration, and route keys. Adapters own source identifiers, network protocols, available depth, and timestamp translation. Accounting and valuation remain in core.

## Keep valuation and event evidence separate

Price and FX stamps value holdings and cash on an economic date. They never change event history. Historical EUR rates prepare contribution events and explicitly requested reporting evidence; the CLI embeds the rate and its provenance into the event.

A saved valuation stamp cannot supply an event's historical rate. Looking up an event rate cannot append a valuation stamp. CoinGecko's closing-date translation applies to portfolio observations, while its event-rate lookup preserves the selected observation's own effective date.

Fetched provenance records the provider and UTC retrieval instant. Retrieval time never replaces the economic date. For crypto closing observations, the source row at midnight UTC starting the following day represents the preceding day's close. Other sources retain their quoted economic dates.

## Route without guessing

Provider package metadata declares capabilities; there is no closed catalog or implicit default route. `packages/market-data/src/config.ts::effectiveRoute` reads explicit ordered routes and removes disabled IDs without filtering unavailable packages out of the source-selection identity. Adding a package selects nothing; clearing a route leaves no hidden default.

A source binding pins one local instrument or currency to a provider-specific identifier. A historical event-rate request may also explicitly pin a provider. Pinned selection never silently falls back. Unbound historical-rate routes require the current fiat-rate capability at execution; explicit currency bindings and overrides may use either declared historical-rate capability without a currency-kind registry. Package replacement can invalidate a capability for new work while leaving saved configuration inspectable. Unpinned routes may try their next configured provider after failure.

Instrument bindings require an existing local instrument. Currency bindings validate the currency shape; the book has no separate currency registry. Stored configuration validates structural shape and duplicate bindings independently of installed code. New source/route assignments validate installed metadata and the relevant instrument capability before committing. Removal and disabling remain possible when referenced code is missing. Selection rejects disabled providers and empty effective routes before adapter I/O.

Resolution precedence lives in `packages/market-data/src/routing.ts::selectPriceProviders`, `packages/market-data/src/routing.ts::selectFxProviders`, and `packages/market-data/src/routing.ts::selectHistoricalEurRateProviders`.

Yahoo supplies fund history. EODHD supports stock history and explicit fund bindings. It uses raw closes matching the units held on the economic date; split-adjusted Yahoo stock history is not eligible. Stock exchange identifiers must be configured correctly. ETF and ETC automatic history has no official adapter; manual marks remain usable.

CoinGecko supplies crypto instrument history and bound crypto-currency FX. ECB supplies fiat FX and historical contribution rates. A new provider must not require changes to core accounting or valuation.

## Acquire history from recorded exposures

`packages/market-data/src/history-plan.ts::historyRequirements` queries core at event-date boundaries. Held instruments require prices. Foreign cash and held instruments' quote currencies require FX. Subjects are deduplicated across accounts and adjacent exposures merge. Sold assets and spent currencies remain historical requirements; no parallel accounting state is introduced.

`packages/market-data/src/history.ts::HistoryUpdater` subtracts matching checked intervals and sorts unchecked work by newest required end date. `packages/market-data/src/history-date.ts::completedHistoryDate` supplies the preceding completed UTC date with the existing morning publication allowance. The limit advances at 06:00 UTC and implies no background scheduling.

Logical portfolio intervals differ from source request windows. Without an eligible predecessor, adapters request available context. Otherwise the new request includes history since the latest saved eligible observation. Retention includes every relevant catch-up date, even behind the newly unchecked interval, plus a predecessor needed to value the exposure's start. Unrelated pre-exposure history is not retained.

Catch-up runs only when there is new unchecked work. Repeating a completed cutoff makes no request. Old checks do not expire, and there is no rolling correction scan or recheck command. Late interior observations before the last saved mark, corrections to old dates, and final values published after a sold exposure ends may remain absent. Stored new observations naturally change derived historical views.

Yahoo preserves exchange-local NAV dates. EODHD retains raw closes. ECB reads its historical feed once per compatible batch and inverts foreign units per EUR into EUR per foreign unit.

`packages/provider-coingecko/src/coingecko.ts::CoinGeckoSource` requests daily midnight rows through the installed SDK. It translates closing date D into source midnight on D+1 and never substitutes an intraday point. Demo access is bounded to its rolling available horizon; requests for earlier history retain available later values while older portfolio dates remain unknown. A successful check establishes acquisition under that source's access limits, not complete market coverage or an observation on every day.

## Reuse durable checks

`packages/market-data/src/history-checks.ts::HistoryChecks` owns append-only `market-history.jsonl` under the book lock. Each check records subject, effective route/binding identity, logical interval, check instant, serving provider, and retained normalized observations. Credentials never enter that identity.

`packages/market-data/src/history-checks.ts::checkIsIntact` requires referenced facts still to exist before a check suppresses work. Valid empty results are reusable. Errors receive no successful check. New subjects, changed source selection, and earlier transactions can introduce unchecked work.

Each observation is appended before its check is saved. Interrupted commits retain earlier stamps and leave the range retryable. An unchanged fetched fact retains its retrieval identity; a changed latest candidate is appended. Storage failures stop acquisition. Provider failures preserve completed subjects and remain explicit in the report.

The refresh lock spans a complete asynchronous update; ordinary book locks cover only local reads and commits. A shared provider-code lock surrounds actual new source work, excluding code replacement/removal and other provider-backed operations across books. A fully reused update acquires no code lock or provider module. Network waits do not hold the book lock. Competing updates fail fast. Abandoned or uncertain locks stop work for manual recovery and are never reclaimed automatically.

## Preserve manual choices

Manual marks win same-date selection against fetched marks. Update saves differing provider candidates and reports both values while keeping the manual choice. An explicit price or FX entry is the correction path. Whole-book acquisition has no bulk replacement option.

`packages/market-data/src/history.ts::HistoryUpdateReport` carries checked, reused, empty and failed intervals, saved counts, and conflicts. CLI update failures include the saved-work report; subsequent offline views expose remaining unknown values and the evidence actually selected. Acquisition success is not a freshness guarantee.

## Keep configuration and failures explicit

`packages/market-data/src/config.ts::MarketDataConfigStore` stores non-secret routes, disabled providers, and bindings in `market-data.json`, validates reads, and replaces writes atomically under the book lock. Inspection returns an empty source configuration without creating a missing file.

`packages/cli/src/main.ts::main` parses process environment values. `packages/market-data/src/provider-runtime.ts::ProviderRuntime` passes only declared present values to the selected factory. CoinGecko can use public access or the configured Demo credential; EODHD requires its configured API credential. Credentials never enter configuration, observations, output, logs, or successful-check identities. No paid-tier selection or subscription management is provided.

`packages/provider-sdk/src/index.ts::ProviderFailureSchema` distinguishes unsupported, not found, rate limited, unauthorized, unavailable, and invalid response. Adapters validate source payloads before normalization. The runtime validates the complete economic result, currency/pair, economic date, and exact batch request echoes before adding local identity and host provenance. Historical orchestration receives trusted normalized marks rather than parsing foreign data again. Provider errors cannot masquerade as empty successful ranges.

`packages/provider-sdk/src/http.ts::createRetryingFetch` centralizes bounded transient retries. EODHD performs one bounded request without retrying to keep quota cost predictable. SDK payloads remain inside their adapters and are not persisted.

## Verify the surviving boundaries

Adapter tests exercise sanitized source fixtures and controlled gateways or HTTP behavior. The ordinary gate has no live provider calls. Historical update tests exercise range reuse, catch-up, publication delays, source changes, validation, interruption, batching, fallback, and refresh-lock exclusion with temporary books.

Built-CLI tests replace HTTP at the process boundary and verify mixed holdings, sold assets, foreign cash, closing dates, offline agreement, explicit corrections, partial failure, and removed fetch flags. Event-rate tests independently verify contribution-rate behavior and the absence of valuation side effects.

## Load optional code only for needed work

`packages/market-data/src/packages.ts::ProviderPackages` keeps selected code in a managed directory separate from all books. Its normal package manifest and lockfile track direct selected packages; the static catalog reads their metadata and public exports without importing them. Broken declarations are reported individually, and duplicate logical IDs are conflicts. No transitive dependency scanning occurs.

`ProviderRuntime` lazily creates a source once per operation and catches import, factory, and operation exceptions at the foreign boundary. Expected failures redact declared environment values; raw package subprocess output is withheld. One bad source does not prevent independent subjects from saving useful marks. [PROVIDERS.md](PROVIDERS.md) owns authoring and package-contract details.

Logical source IDs, route order, identifiers, and instrument meaning determine successful-check identity. Installed version, code hash, credentials, and availability do not expire old checks. Dangling references remain inspectable/editable, and saved valuation never depends on installed code.
