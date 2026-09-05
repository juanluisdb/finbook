# Documentation instructions

Files in this directory are present-tense design snapshots for agents and engineers entering an unfamiliar area.

Code is the exact source of truth. A design document supplies the mental model, constraints, invariants, and rationale that code cannot make obvious.

## Keep one owner per topic

`PRODUCT.md` owns user-visible meaning and scope. `DESIGN.md` owns engineering structure and local-system guarantees. `MARKET_DATA.md` owns provider, routing, fetching, and caching design.

Cross-link to the owning document instead of repeating its explanation. Update the documentation index in the root `AGENTS.md` whenever a document is added, renamed, or removed.

## Write a current snapshot

Describe how the system works now. Do not record implementation history, completed plans, milestones, migration narrative, dates, or pull requests.

Lead with the subsystem’s mental model and boundary, then explain its load-bearing flows and decisions.

State a rejected alternative only when the constraint remains necessary to understand the current design. Write it as present rationale rather than a timeline.

## Point to live source

Reference source as `path::symbol`, never by line number.

Name the schema, type, function, class, configuration field, or script that owns an exact fact. Do not copy TypeScript shapes, function signatures, dependency versions, retry values, command inventories, or other details that can be read from live source.

When a source symbol, file, environment variable, command, or route changes, search `docs/` for the old name and update every affected reference in the same change.

Use a short flow diagram when control flow or data flow explains the design more clearly than prose.

## Keep the writing direct

Use plain, specific, active prose without hype, filler, decorative emoji, or conversational asides.

Keep one paragraph or bullet per source line and let the editor soft-wrap it.

Every section should help the reader understand a boundary, make a decision, or locate the source that owns the detail. Remove material that merely restates the code.
