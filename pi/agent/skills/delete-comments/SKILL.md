---
name: delete-comments
description: Purge every comment the current branch added — categorise, delete, fix the hacks they excused, and hand off a ratchet so the ban holds after the PR.
argument-hint: "Date for the ratchet handoff task in the daily note (default: nearest Thursday)"
disable-model-invocation: true
---

# Delete comments

Run on the current branch. Done means every comment the branch added is gone: tautologies and stale notes deleted, excuses replaced by a fix or an issue, decisions moved to where the repo keeps them, test narration folded into `it()` titles — and a ratchet handoff is filed so the next PR cannot regrow them.

The four categories are the user's vocabulary; use the words verbatim in every report: _tautology_, _excuse_, _stale_, _decision record_, _ratchet_.

## 0. Discover the repo's conventions

Facts are yours to find; the user only decides. Look up, without asking:

- base branch: `git symbolic-ref refs/remotes/origin/HEAD`; merge-base and the branch's added lines.
- generated or hand-off-limits code: `ignorePatterns` in the ESLint config, "never edit" notes in `AGENTS.md`. It leaves the scope.
- the home for decisions: `docs/adr/` (see `domain.md`, if present), the PR description, `AGENTS.md`.
- the issue tracker: `.scratch/<feature>/issues/NN-<slug>.md` with `Status:` lines, or the Jira key in the branch name.
- the lint setup: ESLint version, flat vs legacy config, and whether the npm registry serves new packages at all (`npm view <pkg>` is a lookup, not an install). A corporate registry that 404s a package closes the plugin route before it is proposed.
- the test docs (`docs/agents/testing.md`) and the language of `it()` titles.
- the checks gate (`npm run checks` or the repo's equivalent).

Completion: one line per fact, reported to the user before the first question.

## 1. Put the decisions to the user

Before touching a file, get answers to: the scope (branch-added comments vs whole files), whether decision records become ADRs or go to the PR body, whether excuses are fixed in this PR or filed as issues, the commit plan, and the handoff date. Word each question so "yes" accepts your recommendation, and recommend from the facts of step 0 — a repo with no `docs/adr/` and a PR body that already carries the decisions does not need ADRs.

Completion: every decision has an explicit answer.

## 2. Enumerate

Lines the branch added:

```bash
git diff $(git merge-base HEAD <base>) HEAD -- . ':!<generated>' | grep -E '^\+\s*(//|/\*|\*|\{/\*)'
```

Comment nodes and a per-file count come from ESLint itself, with the probe config from [The native ban](#the-native-ban) and `--format json`; keep the messages whose line falls inside the branch's added hunks. Inline trailing comments (`code; // why`) show up only in the ESLint pass — that is why both are run.

Completion: a table of file → comment lines → nodes, with the codebase-wide total kept for the estimate (step 6).

## 3. Categorise, then act

| Category     | Test                                                              | Action                                                                                                      |
| ------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Tautology    | The next lines say the same thing.                                | Delete. A comment narrating a test step goes into the `it()` title when the title is weaker, then is deleted. |
| Stale        | Names code that no longer exists, or repeats another comment.     | Delete.                                                                                                     |
| Excuse       | Explains why a hack is tolerable: a mock, a polyfill, a timing trick, a fixture that papers over a crash. | Delete, then fix the hack in this PR or file one issue per distinct hack (`Status: ready-for-agent`).       |
| Decision record | A _why_ with a real trade-off behind it.                      | Delete, then move it to the repo's decision home chosen in step 1. No pointer comment stays behind.          |

An excuse repeated across files is one hack: one fix, one shared helper. Delete first, fix second — a deletions-only commit reads cleanly in review, and the fix commit shows the hack gone.

Completion: the probe from step 2 reports zero branch-added comments, and every excuse has either a fix or an issue file.

## 4. Verify

- The repo's gate is green (`npm run checks` or its equivalent) before every commit.
- Each fix is _proven_: the test covering it fails when the fix is reverted. A test that stays green under a broken fix was never testing it — write the test that does.

Completion: gate green, every fix reverted-and-restored once with the expected red.

## 5. Close the source

Deleting comments without changing what produces them is a treadmill. Propose one line for `AGENTS.md` / the code conventions doc: _comments are banned; decisions go to `<home>`; test narration goes into `it()` titles_. The lint rule (step 7) enforces it; the line stops the next agent-written PR from regrowing comments in the first place.

Completion: the line exists in the repo's conventions doc, or the user declined it on record.

## 6. Estimate

Report two numbers: the branch (lines and nodes shed) and the codebase (the ratchet's starting budget). Percentages come from the non-generated line count of the repo.

## 7. Ratchet handoff

Write the handoff document for the next session; its content is fixed:

1. `lint:comments` — the native ban at `warn` + `--max-warnings <N>`; N measured on the base branch **at run time**, after this PR merges.
2. Wiring into the checks script and its doc (`docs/agents/checks.md`).
3. The convention line from step 5 if it is not merged yet.
4. Repeat `/delete-comments` on the base branch, lowering N each time; at N = 0 switch the rule to `error` and drop the flag.

Destination, by the argument date (default: the nearest Thursday):

- `D:\Z\ObVault` exists → the document as `07-Work/<client>/<repo>/<YYYY-MM-DD> <slug> handoff.md`, plus a `- [ ]` task with a wikilink to it in that date's daily note — through the `obsidian-notes` skill, its step 0 first.
- Otherwise → the temp directory, as the `handoff` skill does.

Completion: the handoff exists at its destination and the daily-note task (when the vault exists) is in place.

## The native ban

ESLint core bans every comment without a plugin:

```js
'no-warning-comments': ['warn', { terms: [''], location: 'anywhere' }]
```

The empty term compiles to a regex that matches every comment — line, block, JSDoc, trailing, JSX `{/* */}` (verified on ESLint 8.57.1). Directive comments (`// eslint-disable-next-line`, `// @ts-ignore`) are flagged too; a directive exempts itself by carrying `-- no-warning-comments` in its description. The _ratchet_: the rule at `warn` plus `--max-warnings <N>` in a dedicated script — a PR with a new comment fails, a PR that deletes comments lowers N, and N only ever goes down.

A legacy `.eslintrc` cannot load a local rule without a package (`plugins` must be `string[]`), and corporate registries often 404 such packages. Reach for the native rule first; a plugin only when the user asks for one and the registry serves it.
