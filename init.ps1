# Сетап нового ПК (Windows) под репо Configs: инструменты, pwsh-профиль, omp-тема, pi.
# Идемпотентный: установленное пропускается, повторный запуск безопасен.
# Запуск из корня клона: powershell -ExecutionPolicy Bypass -File init.ps1
# Для Linux-машин отдельная история: bashrc_profile в корне репо.

$ErrorActionPreference = 'Stop'

function Test-Cmd([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Ensure-Winget([string]$Id, [string]$ProbeCmd) {
  if (Test-Cmd $ProbeCmd) { "skip: $Id (уже установлен)"; return }
  "install: $Id"
  winget install -e --id $Id --source winget --accept-source-agreements --accept-package-agreements
}

function Ensure-ScoopPkg([string]$Name) {
  if (scoop prefix $Name 2>$null) { "skip: scoop $Name"; return }
  "install: scoop $Name"
  scoop install $Name
}

# --- 1. Базовые инструменты (winget) ---
Ensure-Winget 'Microsoft.PowerShell' 'pwsh'
Ensure-Winget 'Git.Git' 'git'
Ensure-Winget 'Schniz.fnm' 'fnm'       # node-менеджер (nvm больше не используется)
Ensure-Winget 'GitHub.cli' 'gh'

# --- 2. scoop + пакеты ---
if (-not (Test-Cmd scoop)) {
  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
  irm get.scoop.sh | iex
}
$bucketList = (scoop bucket list | Out-String)
foreach ($b in 'extras', 'nerd-fonts') {
  if ($bucketList -notmatch $b) { "bucket add: $b"; scoop bucket add $b }
}
Ensure-ScoopPkg curl
Ensure-ScoopPkg sudo
Ensure-ScoopPkg z
Ensure-ScoopPkg Hack-NF
Ensure-ScoopPkg terminal-icons
Ensure-ScoopPkg gitleaks

# --- 3. oh-my-posh (scoop-манифест из релиза) ---
if (-not (Test-Cmd oh-my-posh)) {
  "install: oh-my-posh"
  scoop install https://github.com/JanDeDobbeleer/oh-my-posh/releases/latest/download/oh-my-posh.json
}

# --- 4. PS-модули ---
# PSReadLine отдельно не ставим: нужная версия входит в состав PowerShell 7.
if (-not (Get-Module -ListAvailable posh-git)) {
  "install: posh-git"
  Install-Module posh-git -Scope CurrentUser -Force
}

# --- 5. Node через fnm (нужен pi и npm ci на шаге 7) ---
if (-not (Test-Cmd node)) {
  "install: node (fnm LTS)"
  fnm install --lts
  fnm default lts-latest
}
fnm env --shell powershell | Out-String | Invoke-Expression

# --- 6. Профиль + omp-тема: прямо в Documents\PowerShell ---
# (pwsh на Windows грузит профиль только отсюда; ~/.config/powershell — Unix-layout, не используется)
$psDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'PowerShell'
New-Item -ItemType Directory -Force -Path $psDir | Out-Null
foreach ($f in 'Microsoft.PowerShell_profile.ps1', 'dragneell9.omp.json') {
  $src = Join-Path $PSScriptRoot $f
  $dst = Join-Path $psDir $f
  if (Test-Path $dst) {
    if (Compare-Object (Get-Content $src) (Get-Content $dst)) {
      "WARN: $f в Documents отличается от репо — на машине живая версия главнее: прогони bash sync.sh и закоммить дрейф"
    } else { "skip: $f уже на месте" }
  } else {
    Copy-Item $src $dst
    "copied: $f -> $psDir"
  }
}

# --- 7. pi coding agent + конфигурация из pi/ ---
if (-not (Test-Cmd pi)) {
  "install: pi (managed installer)"
  powershell -c "irm https://pi.dev/install.ps1 | iex"
}
$bash = (Get-Command bash -ErrorAction SilentlyContinue).Source
if (-not $bash) { $bash = 'C:\Program Files\Git\bin\bash.exe' }
& $bash (Join-Path $PSScriptRoot 'pi/restore.sh')
if ($LASTEXITCODE -ne 0) { throw "pi/restore.sh завершился с кодом $LASTEXITCODE" }

""
"Готово. Осталось вручную (секреты и машинно-зависимое):"
"1. auth.json — ключи провайдеров (zai и т.д.): запусти pi и войди в каждый провайдер."
"2. Obsidian: сертификат Local REST API -> ~/.pi/agent/obsidian-local-rest-api.crt,"
"   затем в pi: /mcp -> obsidian -> Enable (после этого сервер остаётся включённым)."
"3. confluence-docs: зависимости скилла (node) — `npm ci` в `~/.pi/agent/skills/confluence-docs/scripts/`;"
"   шаг check в SKILL.md подскажет план установки."
"4. bashrc_profile — для Linux-машин, на Windows не используется."
