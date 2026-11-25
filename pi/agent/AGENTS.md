# Global rules

## Downloads and installs: ask first

Anything leaving the current project gets an explicit yes before it runs: global packages (`npm i -g`, `pip install`, `dotnet tool install`), system installers (`winget`/`choco`/`scoop`, exe/msi), files saved to disk (binaries, archives, distributions). Name what you are about to fetch and from where, then wait for confirmation — a task implying the outcome ("enable that Windows feature") is not consent (precedent: ViVeTool.exe fetched from GitHub unprompted). A subagent cannot ask the user directly: report the intended download to the parent and let it confirm.

Runs without confirmation: `npm ci`/`npm install` from a repo lockfile, the `npx` package cache, and skill steps whose whole point is installation (keepass-update).

## Bulk file ops outside repos: list, then wait

A move/delete sweep over files outside working repos (Start Menu, ProgramData, scoop apps, `Desktop` archives) starts only after the full path list is printed and the user confirms. A backup archive complements the confirmation, never replaces it (precedent: custom Pi launchers swept into a Start Menu archive as "junk").

## Subagent models: flash by default

Defaults are pinned in `~/.pi/agent/settings.json` (`subagents.defaultModel` = `zai/glm-5.3-flash`, flagship for `reviewer`/`oracle`). Leave `model` unset in `subagent` calls; a per-run override is a conscious exception (a heavy task handed to a worker → flagship). Screenshots and images go to `glm-5.4` only, so a subagent that has to look at one runs with `model: zai/glm-5.4` (see the chrome-devtools-mcp skill).

## Node (fnm)

Node versions are managed by fnm; a repo pins its version in `.nvmrc`. Before running `npm`/`node`/`npx` in a repo, run `eval "$(fnm env)" && fnm use` (fnm reads `.nvmrc` from the current directory).

## Serena or grep (via codemode)

Serena tools are `mcp__serena__*` in codemode. Route the search:

- Text — strings, TODOs, error messages — → `rg` in bash.
- A symbol rename or refactor → collect usages with `find_referencing_symbols` first: grep misses `import { X as Y }` and `export *` barrels and false-positives on antd aliases.
- After prop or interface edits → `get_diagnostics_for_file` before any build.
- An unfamiliar file over ~300 lines → `get_symbols_overview` first; read the whole file only for implementation details.

## Obsidian (vault D:\Z\ObVault)

All Obsidian work — notes, tasks — goes through the **obsidian-notes** skill: read its SKILL.md first and execute its steps exactly; `mcp__obsidian__*` tools run only inside those steps. The obsidian MCP server starts `"enabled": false` in `~/.pi/agent/mcp.json`; once the user has enabled it (`/mcp` → obsidian → Enable) it stays enabled permanently — never disable it back (a failed-connection warning in sessions without Obsidian is accepted). The skill's step 0 starts Obsidian itself (`scripts/launch.sh`, waits for the Local REST API) and asks the user only to enable the server the first time.

## bash on Windows (Git Bash / MSYS2)

Commands reach bash through argv, and MSYS2 mangles backslashes: `\\` collapses to `\`, and `\U`, `\s`, etc. inside quotes lose the backslash entirely. Therefore:

- Use forward-slash paths in bash commands — `C:/Users/...` or `/c/Users/...`; backslash paths mangle the same way.
- Quote paths containing spaces, still with forward slashes: `"C:/Program Files/Git/bin/bash.exe"`.
- Put multiline scripts containing backslashes in a temp file via `write`, then run it with `node` or `bash`: transport mangles inline `\\` (heredocs, sed/awk/printf patterns, escaped JSON). Same for one-liners — `node -e`, `sed -i` — with regex metacharacters (`$`, `\n`, `(`, `)`, `{`) or `$`-interpolation inside double quotes.
- Boundary: the `read`/`edit`/`write` and MCP tools still accept plain Windows paths (`C:\...`) — only commands executed inside `bash` are affected.

## Git worktrees

- A fresh worktree has no `node_modules`: run the project's install (`npm ci`) inside it before any script, or they die with `ERR_MODULE_NOT_FOUND`.
- Remove a worktree from the main checkout, never from inside it. A pi session, dev server, or MCP process running in the worktree locks the directory, and one session cannot stop someone else's pi session — ask the user to close it first, then run `git worktree remove` from the main checkout.

## Confluence (internal docs)

Reading Confluence goes only through the **confluence-docs** skill: Confluence is behind SSO, so the user saves the page by hand (Export to Word or Ctrl+S → HTML), `to-md` converts it to markdown, the user strips PII manually, and `mdcheck` (gitleaks + a suspects scan) gates the agent read. Never `curl`/`fetch_content` a Confluence URL, and never read a raw `.docx`/`.html` — read only a `.md` that passed `mdcheck` (exit 0, or exit 3 explicitly cleared by the user). «Read» is any channel — `read`, cat, grep, node scripts, fragments included — and fresh `to-md` output (or a re-convert) is raw until it passes the gate; `to-md` runs `mdcheck` itself and exits with its code. Exit 1 (secrets) is a hard stop: the user must edit the file, findings are never argued away.
