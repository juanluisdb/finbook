# anti-slop rules (vendored snapshot)

Oxlint rules that reject patterns which satisfy the compiler while destroying the evidence you had: `unknown` in a signature, a cast with no justification, a dictionary of anything, a module mock standing in for a dependency seam.

Source: https://github.com/dmmulroy/anti-slop by Dillon Mulroy, MIT licensed. See `LICENSE`. This is a snapshot of the production `src/` directory, without its tests.

## These are meant to be read and changed

Vendored on purpose, not installed as a dependency. Each rule is an opinion, and an opinion you cannot justify locally is one that will be suppressed inline, which is worse than not having the rule. So copy this directory into the repo, read the rules, and adapt them. From that point they belong to the repo.

`references/tooling.md` in this skill has the rule-by-rule table: what each one rejects, the opinion behind it, and the case where a repo reasonably declines it. Decide each one rather than enabling the set blind.

Two consequences of vendoring:

- Upstream may have added, changed, or removed rules since this snapshot. Check the source repository if the project wants the current set.
- If the target directory already exists in the repo, read it before writing anything. Someone may have edited these rules, which is the intended use, and overwriting throws that away.

## Layout

```
anti-slop/
├── index.ts      the plugin, registering every rule by name
├── rules/        one file per rule
└── shared/       helpers used by several rules
```

## Registering it

Copy the directory somewhere that reads as tooling rather than source, for example `tools/oxlint/anti-slop/`, then point the linter's plugin entry at the copied `index.ts` and enable the rules by name. Add the copied directory to the lint and format ignore patterns, alongside the agent tool directories the repo already ignores, and preserve the patterns already there.

Verify by running the linter *and* by confirming a known violation is reported. A plugin registered wrongly reports nothing, which looks exactly like a clean repo.
