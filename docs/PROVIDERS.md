# Authoring a data provider

A provider is a trusted Node-compatible JavaScript package supplying economic observations. It receives remote identifiers and requested dates, never the book, transaction history, balances, file adapter, or write callbacks. TypeScript authors compile to JavaScript before installation.

`packages/provider-sdk/src/index.ts` owns the public metadata schemas, request/result schemas, inferred types, and `ProviderFactory`. Ordinary package exports choose the public entry; the custom `finbook` field in `package.json` describes identity, capabilities, and environment input names. This field is a finbook convention rather than a Node plugin standard.

`examples/fund-navs/package.json` and `examples/fund-navs/index.js` form a complete runnable package with an invented fund NAV. It has no network dependency or account requirement. From the repository root, after building finbook:

```sh
export FINBOOK_HOME="$(mktemp -d)"
export FINBOOK_PROVIDERS_HOME="$(mktemp -d)"
finbook provider add ./examples/fund-navs
finbook provider list
finbook account add --id broker --name Example --platform example --country ES --custodial broker
finbook instrument add --id fund --name "Example fund" --type fund --quote-currency EUR
finbook event add deposit --id initial --date 2024-09-01 --account broker --amount 1000 --currency EUR
finbook event add buy --id purchase --date 2024-09-02 --account broker --instrument fund --qty 4 --price-amount 100 --price-currency EUR --gross-amount 400
finbook config source set --instrument fund --provider example-navs --identifier EXAMPLE-FUND
finbook update
finbook show glance --as-of 2024-09-02
```

The expected value is EUR 1,020: four units at EUR 105 plus EUR 600 cash. The example publishes one invented observation; it is not a live market feed. Offline views remain usable after removing its package. Replacing its code does not expire completed history checks.

## Implement the economic boundary

The synchronous default factory receives a parsed record containing only declared environment values that are present. It returns an ordinary success/failure result. A successful value contains only the asynchronous operations declared by metadata. Construct clients in the factory; perform source I/O in operations. No registration helper, initialization hook, or runtime version marker is required.

Implement only supported operations. Instrument history returns economic dates and actual prices/currencies; FX history returns currency-to-EUR pairs and rates; event-rate lookup returns EUR per native unit and its effective date. `PriceHistoryOutcomeSchema`, `FxHistoryOutcomeSchema`, and `EurRateOutcomeSchema` define their exact shapes. Batch results echo every request once; order may differ. Missing, duplicated, or unrelated outcomes fail validation.

`from` and `through` delimit the inclusive logical period. `sourceFrom`, when supplied, includes catch-up from a saved observation. Without it, retrieve available context rather than only rows after the logical start. The host retains relevant history and any needed predecessor. Preserve valid empty results; do not turn transport, credential, identifier, or parsing failures into successful empty arrays.

Validate remote payloads at the adapter boundary. Use decimal strings, positive values, actual quoted currencies, and economic dates. Stock closes must match the historical units held. Crypto valuation date D uses the UTC midnight starting D+1; event-rate lookup retains its own effective-date convention. Source access limits must not fabricate missing history.

The host validates complete foreign results and request association, then adds local instrument identity, canonical metadata source ID, and its retrieval timestamp. Authors must not return ledger stamps or provenance. Provider failures use `ProviderFailureSchema`; thrown exceptions become generic safe failures. Neither errors nor provider output may contain credentials. The host redacts known declared environment values from expected diagnostics, but trusted provider code still has normal local Node privileges.

For typed authors, use `ProviderFactory` and the inferred request/result types from the SDK. The JavaScript example uses a JSDoc type import, which adds no runtime dependency. `createRetryingFetch` is optional shared HTTP support; authors may use ordinary clients instead. The SDK carries no source-specific client.

## Install and inspect deliberately

Build a usable public entry before addition. Finbook uses npm to install an exact selected registry version or a packaged copy of a local directory, with package lifecycle scripts disabled. Editing the original folder has no effect until explicit re-add. Only explicitly selected direct packages are inspected; transitive dependencies are not scanned as plugins.

`ProviderPackages` owns the managed directory, static catalog, package subprocesses, and ESM entry resolution. Listing declarations does not import provider modules, initialize clients, authenticate, or verify access. `ProviderRuntime` imports and creates a needed provider lazily for new acquisition work. A fully reused range needs no module or credentials.

Code installation is shared; source mappings, explicit category routes, and disabled IDs belong to each book. Installing code selects no sources. Removing code leaves all book settings and facts intact. Missing packages affect new acquisition, while config inspection/removal and saved-data valuation continue to work.

One fail-fast filesystem lock serializes provider-backed acquisition and package mutation across books. Offline reads remain available. Abandoned locks require manual inspection and removal after confirming no process uses that directory. Package-tool failure can leave code changed or unavailable; inspect and reinstall rather than assuming rollback. The financial book is never part of a package operation.
