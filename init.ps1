# Install command-line apps
# Install pwsh
winget install --id Microsoft.PowerShell --source winget

# Install Git
winget install -e --id Git.Git

# Install PowerToys
winget install Microsoft.PowerToys --source winget

# Install scoop
# First line is Optional: Needed to run a remote script the first time
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
irm get.scoop.sh | iex

# Install curl sudo
scoop install curl sudo
scoop bucket add extras
scoop bucket add nerd-fonts
scoop install Hack-NF

# Install Oh-my-posh
Install-Module posh-git -Scope CurrentUser -Force 
scoop install https://github.com/JanDeDobbeleer/oh-my-posh/releases/latest/download/oh-my-posh.json

# Install Terminal-Icons
Install-Module -Name Terminal-Icons -Repository -PSGallery -Force

# Install nvm 
scoop install nvm

# Install z jump folder 
scoop install z

# Install PSReadLine
Install-Module -Name PSReadLine -AllowPrerelease -Scope CurrentUser -Force -SkipPublisherCheck

# Create powershell dir
mkdir $env:USERPROFILE\.config\powershell

# Coping profiles to .config folder under user profile
$config_path = Join-Path $env:USERPROFILE ".config\powershell"
Copy-Item user_profile.ps1 $config_path\user_profile.ps1
Copy-Item dragneell9.omp.json $config_path\dragneell9.omp.json

# Use pwsh config file from pwsh profille
'. $env:USERPROFILE\.config\powershell\user_profile.ps1' >> $PROFILE.CurrentUserCurrentHost

echo "Installation completed"