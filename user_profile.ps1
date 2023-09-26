# set PowerShell to UTF-8
[console]::InputEncoding = [console]::OutputEncoding = New-Object System.Text.UTF8Encoding

# Prompt 
Import-Module posh-git
Import-Module Terminal-Icons

# Oh-my-posh init
$omp_config = Join-Path $PSScriptRoot ".\dragneell9.omp.json"
oh-my-posh --init --shell pwsh --config $omp_config | Invoke-Expression
# PSReadLine
Set-PSReadLineKeyHandler -Chord 'Ctrl+d' -Function DeleteChar
Set-PSReadLineOption -PredictionSource History

# # Fzf
Set-PsFzfOption -PSReadlineChordReverseHistory 'Ctrl+r'

# Utilities
function which ($command) {
  Get-Command -Name $command -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Path -ErrorAction SilentlyContinue
}

# general Aliases
Set-Alias ll ls
Set-Alias grep findstr
Set-Alias clr clear
function Code-Reopen { & code . -r }
Set-Alias cdr Code-Reopen
function Code-NewWindown { & code . -n }
Set-Alias cdn Code-NewWindown
Set-Alias ink 'C:\Users\nell_\AppData\Local\inkdrop\Inkdrop.exe'

# git aliases
Set-Alias gt git

function Get-GitStatus { & git status $args }
Set-Alias gts Get-GitStatus

function Get-GitLog { & git log --graph --decorate $args }
Set-Alias gtl Get-GitLog

function Set-GitAdd { & git add $args }
Set-Alias gta Set-GitAdd

function Set-GitCommit { & git commit $args }
Set-Alias gtc Set-GitCommit

function Set-GitPush { & git push $args }
Set-Alias gtp Set-GitPush

function Get-GitBranch { & git branch $args }
Set-Alias gtb Get-GitBranch

function Get-GitRemote { & git remote update $args }
Set-Alias gru Get-GitRemote

# docker aliases
function Run-DckCmp { & docker-compose $args }
Set-Alias dc Run-DckCmp

# npm aliases
function Run-NpmRun { & npm run $args }
Set-Alias nr Run-NpmRun
