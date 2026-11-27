# Global rules

## Downloads and installs: ask first

Anything leaving the current project gets an explicit yes before it runs: global packages (`npm i -g`, `pip install`, `dotnet tool install`), system installers (`winget`/`choco`/`scoop`, exe/msi), files saved to disk (binaries, archives, distributions). Name what you are about to fetch and from where, then wait for confirmation — a task implying the outcome ("enable that Windows feature") is not consent (precedent: ViVeTool.exe fetched from GitHub unprompted). A subagent cannot ask the user directly: report the intended download to the parent and let it confirm.

Runs without confirmation: `npm ci`/`npm install` from a repo lockfile, the `npx` package cache, and skill steps whose whole point is installation (keepass-update).

## Bulk file ops outside repos: list, then wait

A move/delete sweep over files outside working repos (Start Menu, ProgramData, scoop apps, `Desktop` archives) starts only after the full path list is printed and the user confirms. A backup archive complements the confirmation, never replaces it (precedent: custom Pi launchers swept into a Start Menu archive as "junk").

## Subagents: flash by default; worker briefs carry the stuck rule

Defaults are pinned in `~/.pi/agent/settings.json` (`subagents.defaultModel` = `zai/glm-5.3-flash`, flagship for `reviewer`/`oracle`). Leave `model` unset in `subagent` calls; a per-run override is a conscious exception (a heavy task handed to a worker → flagship). Screenshots and images go to `glm-5.4` only, so a subagent that has to look at one runs with `model: zai/glm-5.4` (see the chrome-devtools-mcp skill).

Every worker brief ends with the **stuck rule**: the same command failing twice with the same error → stop, report the error verbatim, return the partial result. Without it a worker loops until the 30-minute timeout (precedent: 2026-11-23, $0.41 and 88 bytes of output).

## Node (fnm)

Node versions are managed by fnm; a repo pins its version in `.nvmrc`. Before running `npm`/`node`/`npx` in a repo, run `eval "$(fnm env)" && fnm use` (fnm reads `.nvmrc` from the current directory).

## Obsidian (vault D:\Z\ObVault)

All Obsidian work — notes, tasks — goes through the **obsidian-notes** skill: read its SKILL.md first and execute its steps exactly; `mcp__obsidian__*` tools run only inside those steps. The obsidian MCP server starts `"enabled": false` in `~/.pi/agent/mcp.json`; once the user has enabled it (`/mcp` → obsidian → Enable) it stays enabled permanently — never disable it back (a failed-connection warning in sessions without Obsidian is accepted). The skill's step 0 starts Obsidian itself (`scripts/launch.sh`, waits for the Local REST API) and asks the user only to enable the server the first time.

## bash on Windows (Git Bash / MSYS2)

Bash hands every command to Windows programs through MSYS2, which rewrites backslashes, `$…`, `{…}` and POSIX paths on the way. Three recipes keep all sides happy, plus one boundary to remember:

- **Paths in bash**: forward slashes — `C:/Users/...` or `/c/Users/...`, quoted when they contain spaces (`"C:/Program Files/Git/bin/bash.exe"`). Temp files go to `~/tmp/<name>` — `/tmp` exists for bash only; node and PowerShell see `C:\Users\…\AppData\Local\Temp` there instead.
- **PowerShell**: `write` a `.ps1`, then run `pwsh -NoProfile -ExecutionPolicy Bypass -File <path>` — pwsh 7 reads BOM-less UTF-8, Cyrillic included. Inline `-Command "…"` only when the text has no `$`: bash expands `$_`, `$env:` and friends before PowerShell sees them.
- **Scripts containing `\`, `$`, `{}`, `(`** — `node -e`, `sed`, `awk`, heredocs, escaped JSON — go into a file via `write`, run as `node <file>` / `bash <file>`.
- `read`/`edit`/`write` and MCP tools take plain `C:\...` paths; only what runs inside bash is rewritten.

## Git worktrees

- A fresh worktree has no `node_modules`: run the project's install (`npm ci`) inside it before any script, or they die with `ERR_MODULE_NOT_FOUND`.
- Remove a worktree from the main checkout, never from inside it. A pi session, dev server, or MCP process running in the worktree locks the directory, and one session cannot stop someone else's pi session — ask the user to close it first, then run `git worktree remove` from the main checkout.

## Confluence (internal docs)

A Confluence link or a request to read internal docs goes through the **confluence-docs** skill: read its SKILL.md first and follow it — Confluence sits behind SSO, and the skill is the only sanctioned path to its content.
