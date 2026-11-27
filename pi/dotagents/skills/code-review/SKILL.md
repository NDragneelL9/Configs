---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along three axes: Standards (does the code follow this repo's documented coding standards?), Spec (does the code match what the originating issue/spec asked for?), and Security (does the diff introduce exploitable behaviour — leaked secrets, injection, weakened auth?). Runs the reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\"."
---

Three-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?
- **Security**: does the diff introduce exploitable behaviour — secrets, injection, weakened auth, dangerous defaults?

All three axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings. Start every sub-agent with a fresh context window.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`, etc.). If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Write both to files the sub-agents can read — they have no shell, and `watchdog_diff` covers only uncommitted changes: `mkdir -p .scratch/reviews && git diff <fixed-point>...HEAD > .scratch/reviews/<branch>.patch && git log <fixed-point>..HEAD --oneline > .scratch/reviews/<branch>.commits.txt`. A reviewer without the patch reconstructs the change from worker reports and loses hunk attribution.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside the parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in the tracker doc.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards and security sources

Search the repo for every file that documents how code should be written. When `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, it must be on the list. Also note any security documentation — `SECURITY.md`, a threat model, auth conventions — for the Security sub-agent.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

On top of whatever the repo documents, the Security axis always carries the **threat baseline** below: a fixed set of exploitable-behaviour checks that applies even when a repo documents nothing. Two rules bind it:

- **Tooling overrides.** Skip what the repo's scanners already enforce — secret scanning, SAST, dependency audit. Report a scanner only when the diff weakens or bypasses it.
- **Severity, not verdict.** Every finding carries severity (high/medium/low) and confidence (confirmed/suspected). A suspected pattern is still reported with its hunk quoted; triage belongs to the human, not the reviewer.

Each threat reads *what it is* → *how to fix*; match it against the diff:

- **Leaked Secret**: a credential, API key, token, private key, or connection string enters the diff — committed, logged, echoed, or embedded in a fixture. → strip it from the diff, rotate anything that touched the repo, read live values from the environment.
- **Injection**: untrusted input concatenated into SQL, a shell command, HTML, a URL, or a file path — string-built queries, `eval`, unescaped interpolation. → parameterize the query, escape the output, and for paths resolve then verify the root.
- **Weakened Auth**: a new endpoint, route, script, or handler reachable without an authorization check, or a check the diff removes, broadens, or gates behind a `skip`/`force` flag. → default-deny: the check ships with the new surface.
- **Insecure Default**: TLS verification off, wildcard CORS, `http://` to a sensitive target, guessable IDs, weak randomness for tokens. → flip to the safe default; an unsafe one needs the spec demanding it in writing.
- **Untrusted Execution**: build or CI scripts piping network content into a shell (`curl | sh`), running repo-supplied hooks, or exposing secrets to fork-sourced input. → pin the source, verify a hash, keep the secret gated.
- **Destructive Input**: a delete, overwrite, drop, or sweep whose target comes from user or request input. → validate the target against an allowlist, dry-run by default.
- **Instruction Injection**: text from files, APIs, or web pages flows into a prompt, command builder, or `eval` — untrusted content treated as instructions. → treat it as data: delimit it, label it, never interpolate it into execution.

### 4. Spawn the sub-agents in parallel

Issue the sub-agent calls together, in the foreground, and aggregate the reports they return.

**Standards sub-agent prompt** should include:

- The paths of the patch and commit-list files, with the note that the patch is the review target (read it first; `watchdog_diff` shows only uncommitted changes).
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The paths of the patch and commit-list files (same note as above).
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

**Security sub-agent prompt** should include:

- The paths of the patch and commit-list files (same note as above).
- The security documentation found in step 3, **plus the threat baseline from step 3 pasted in full** (the sub-agent has no other access to it).
- The brief: "Report, per finding: the hunk quoted, the threat in one line, the fix in one line, severity (high/medium/low), and confidence (confirmed/suspected). Judge what the diff introduces or changes — not a repo-wide audit. Skip what the repo's scanners enforce unless the diff weakens one. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the three reports under `## Standards`, `## Spec`, and `## Security` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the axes are deliberately separate (see _Why separate axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

## Why separate axes

A change can pass one axis and fail another:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**
- Code that matches the spec and every convention while leaking a token or opening an unguarded endpoint → **Standards and Spec pass, Security fail.**

Reporting them separately stops one axis from masking the others.
