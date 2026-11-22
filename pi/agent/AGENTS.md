# Global rules

## Модели zai (GLM): флагман или flash

Провайдер zai — две модели: `glm-5.3` (флагман) и `glm-5.3-flash` (~9× дешевле и быстрее). Распределяй по типу работы:

- Флагман: сложный дебаг, рефакторинг через много файлов, архитектура и планирование, ревью нетривиальных изменений, длинные автономные цепочки — ошибка на раннем шаге стоит дороже экономии.
- Flash: батч-правки, форматирование, суммаризации, классификация, fan-out сабагентов, короткие вопросы.

Модель сабагента задавай явно в вызове `subagent`: рутине — `"model": "glm-5.3-flash"`, сложному — флагман.

Изображения: `glm-5.3` принимает только текст; анализ скриншотов и картинок — на `glm-5.3-flash` (см. скилл chrome-devtools-mcp).

## Node (fnm)

Node versions are managed by fnm; a repo pins its version in `.nvmrc`. Before running `npm`/`node`/`npx` in a repo, run: `eval "$(fnm env)" && fnm use` (fnm reads `.nvmrc` from the current directory).

## Obsidian (vault D:\Z\ObVault)

Any work with Obsidian notes or tasks goes only through the **obsidian-notes** skill: read `C:\Users\JohnDoe_it\.pi\agent\skills\obsidian-notes\SKILL.md` first, then execute its steps exactly. Call the `mcp__obsidian__*` tools only inside those steps.

## bash on Windows (Git Bash / MSYS2)

The command reaches bash through argv, and MSYS2 mangles backslashes: `\\` collapses to `\`, and `\U`, `\s`, etc. inside quotes lose their backslash entirely. Therefore:

- Use forward-slash paths in bash commands: `C:/Users/...` or `/c/Users/...` (msys-style). Backslash paths (`C:\Users\...`) get mangled the same way.
- Quote paths containing spaces, still with forward slashes: `"C:/Program Files/Git/bin/bash.exe"`.
- Write multiline scripts containing backslashes to a temp file with `write`, then run that file with `node` or `bash`; transport mangles inline `\\` (heredoc, sed, awk, printf patterns, JSON with escaping). The same applies to one-liners: `node -e` and `sed -i` with regex metacharacters (`$`, `\n`, `(`, `)`, `{`) or `$`-interpolation inside double quotes break the same way — put those in a temp file too.
- Boundary: the `read`/`edit`/`write` and MCP tools still accept plain Windows paths (`C:\...`) — only commands inside `bash` are affected.

## Git worktrees

- A fresh worktree has no `node_modules`: run the project's install (`npm ci`) inside it before any script, or they die with `ERR_MODULE_NOT_FOUND`.
- Remove a worktree from the main checkout, never from inside it. A pi session, dev server, or MCP process running in the worktree locks the directory, and you cannot stop someone else's pi session from your session — ask the user to close it first, then run `git worktree remove` from the main checkout.
