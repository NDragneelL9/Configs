# set PowerShell to UTF-8
[console]::InputEncoding = [console]::OutputEncoding = New-Object System.Text.UTF8Encoding

# Prompt 
Import-Module posh-git
Import-Module Terminal-Icons

# ENV variables
$env:PYTHONIOENCODING = "UTF-8"

# Oh-my-posh init
$omp_config = Join-Path $PSScriptRoot ".\dragneell9.omp.json"
oh-my-posh --init --shell pwsh --config $omp_config | Invoke-Expression
# PSReadLine
Set-PSReadLineOption -PredictionSource History
Set-PSReadLineOption -PredictionViewStyle ListView
Set-PSReadLineOption -MaximumHistoryCount 1024 -HistoryNoDuplicates
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
function Open-Aamc { & z 'D:\Work\aamc\outlook-workday-integration' }
Set-Alias aamc Open-Aamc
function Open-AQCOM { & z 'D:\Work\AQCOM\' }
Set-Alias aqcom Open-AQCOM
function Run-ExplRun { & explorer . }
Set-Alias e. Run-ExplRun
function Run-Exit { exit }
Set-Alias q Run-Exit

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

function Set-GitPull { & git pull $args }
Set-Alias gtpl Set-GitPull

function Set-GitRestore { & git restore . $args }
Set-Alias grs Set-GitRestore

function Get-GitBranch { & git branch $args }
Set-Alias gtb Get-GitBranch

function Get-GitDiff { & git diff $args }
Set-Alias gtd Get-GitDiff

function Set-GitCheckout { & git checkout $args }
Set-Alias gtcc Set-GitCheckout

function Get-GitRemote { & git remote update $args }
Set-Alias gru Get-GitRemote

# docker aliases
function Run-DckCmp { & docker-compose $args }
Set-Alias dc Run-DckCmp

# npm aliases
function Run-NpmRun { & npm run $args }
Set-Alias nr Run-NpmRun

Set-Alias pn pnpm
Set-Alias pnx pnpm dlx
