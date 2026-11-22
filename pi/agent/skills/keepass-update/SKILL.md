---
name: keepass-update
description: "Обновление KeePass 2.x и плагина KeeTheme на этой машине: сверка версий с keepass.info, скачивание, проверка SHA-256, тихая установка с UAC. Use when the user asks to update KeePass or check for a new KeePass version."
---

# KeePass update

Источник — только официальный сайт https://keepass.info/ (бинарники сайт отдаёт через SourceForge). KeePass установлен в `C:\Program Files\KeePass Password Safe 2`, пакет Inno Setup: обновляется поверх, плагины и настройки сохраняются.

## 1. Текущая установленная версия

```bash
powershell -NoProfile -Command "(Get-Item 'C:/Program Files/KeePass Password Safe 2/KeePass.exe').VersionInfo.ProductVersion"
```

Критерий: получена версия вида `2.XX.Y.0`. Если KeePass.exe по пути нет — остановиться и спросить пользователя, где установлен.

## 2. Последняя версия с сайта

```bash
curl -sS https://keepass.info/download.html | grep -oE 'KeePass-2\.[0-9]+-Setup\.exe' | sort -uV | tail -1
```

Даст `KeePass-2.XX-Setup.exe`; из него взять `VER=2.XX`. Сравнить с первыми двумя компонентами установленной версии: если совпадают — сообщить «уже актуальна» и закончить.

## 3. Скачать установщик

```bash
curl -sSL -o "C:/Users/JohnDoe_it/AppData/Local/Temp/KeePass-$VER-Setup.exe" "https://sourceforge.net/projects/keepass/files/KeePass%202.x/$VER/KeePass-$VER-Setup.exe/download"
```

SourceForge редиректит на зеркало — `-L` обязателен.

## 4. Сверить SHA-256

Хэш с официальной страницы целостности (8 hex-групп = SHA-256; 5 и 4 группы — SHA-1/MD5, не те):

```bash
curl -sS https://keepass.info/integrity.html | grep -A4 "KeePass-$VER-Setup.exe" | grep -oE '[0-9A-F]{8}( [0-9A-F]{8}){7}' | tr -d ' '
```

```bash
powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 'C:/Users/JohnDoe_it/AppData/Local/Temp/KeePass-$VER-Setup.exe').Hash"
```

Критерий: хэши совпали (без учёта регистра). Расхождение — стоп, установщик не запускать, сообщить пользователю.

## 5. Убедиться, что KeePass не запущен

```bash
tasklist //FI "IMAGENAME eq KeePass.exe" | grep -i keepass
```

Если процесс есть — попросить пользователя закрыть KeePass самому и дождаться подтверждения (открытая база живёт в памяти, убивать процесс нельзя).

## 6. Скачать KeeTheme, совместимый с новой версией

Инсталлятор KeePass обновляет только программу — плагины в `...\Plugins\` остаются как есть, поэтому KeeTheme обновляется вручную. Релизы: https://github.com/xatupal/KeeTheme (`releases/latest` у репозитория отдаёт 404 — использовать список `/releases`):

```bash
curl -sS https://api.github.com/repos/xatupal/KeeTheme/releases | grep -E '"tag_name"|"name":' | head -2
```

Совместимость с версией KeePass названа в заголовке релиза (например, `Dll compatible with KeePass v2.62`). Взять самый новый совместимый релиз и скачать оба его ассета:

```bash
curl -sS https://api.github.com/repos/xatupal/KeeTheme/releases | grep -oE 'https://github.com/xatupal/KeeTheme/releases/download/[^"]+' | head -2
curl -sSL -o C:/Users/JohnDoe_it/AppData/Local/Temp/KeeTheme.dll  <url-dll>
curl -sSL -o C:/Users/JohnDoe_it/AppData/Local/Temp/KeeTheme.plgx <url-plgx>
```

Критерий: в temp лежат KeeTheme.dll и KeeTheme.plgx из релиза, чей заголовок называет новую версию KeePass. Совместимого релиза нет — пропустить шаг, предупредить пользователя, что старый плагин может работать неправильно.

## 7. Установка с UAC

Bash-сессия не имеет прав администратора. Логику установки — во временный .ps1 (пишется инструментом `write`), запускать одной bash-строкой без `$_` — инлайн-`$_` в `powershell -Command "..."` интерполируется bash'ем и ломается (правило в AGENTS.md).

`C:/Users/JohnDoe_it/AppData/Local/Temp/kp_update.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Start-Transcript "$env:TEMP\kp_update.log" -Force
$dir = 'C:\Program Files\KeePass Password Safe 2'
$p = Start-Process -FilePath 'C:\Users\JohnDoe_it\AppData\Local\Temp\KeePass-2.XX-Setup.exe' `
    -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait -PassThru
Write-Output "InstallerExitCode: $($p.ExitCode)"
if (Test-Path 'C:\Users\JohnDoe_it\AppData\Local\Temp\KeeTheme.plgx') {
    Copy-Item 'C:\Users\JohnDoe_it\AppData\Local\Temp\KeeTheme.dll'  "$dir\Plugins\KeeTheme.dll"  -Force
    Copy-Item 'C:\Users\JohnDoe_it\AppData\Local\Temp\KeeTheme.plgx' "$dir\Plugins\KeeTheme.plgx" -Force
    Write-Output "KeeThemeDll: $((Get-Item "$dir\Plugins\KeeTheme.dll").VersionInfo.ProductVersion)"
}
Stop-Transcript
```

Запуск (перед ним предупредить: появится UAC-диалог — нажать «Да»):

```bash
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:/Users/JohnDoe_it/AppData/Local/Temp/kp_update.ps1' -Wait"
```

Критерий: в `C:/Users/JohnDoe_it/AppData/Local/Temp/kp_update.log` есть `InstallerExitCode: 0`, а при обновлённом плагине — ещё и `KeeThemeDll: <версия>`. Копирование KeeTheme идёт в том же elevated-скрипте — UAC-запрос один на всё. Отказ от UAC — ошибка RunAs в stderr; остановиться, не повторять молча.

## 8. Проверить и убрать за собой

Повторить шаг 1 — версия должна стать `2.XX.0.0`. Удалить из temp установщик, KeeTheme.dll, KeeTheme.plgx, kp_update.ps1, kp_update.log. Сообщить пользователю старую и новую версии KeePass и KeeTheme.

## Заметки

- PowerShell-профиль этой машины сыплет ошибками (Terminal-Icons) — всегда `-NoProfile`.
- В Plugins лежат обе формы плагина (KeeTheme.dll и KeeTheme.plgx) — заменять обе, иначе в списке плагинов окажутся разные версии.
- Папка загрузок на этой машине — `D:/Downloads`, а не `C:/Users/JohnDoe_it/Downloads`: если пользователь говорит «установщик в Downloads», искать там.
