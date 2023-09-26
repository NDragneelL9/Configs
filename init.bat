:: Coping profiles to .config folder under user profile
set config_path=%USERPROFILE%\.config\powershell
copy /y user_profile.ps1 %config_path%\user_profile.ps1
copy /y dragneell9.omp.json %config_path%\dragneell9.omp.json