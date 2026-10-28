param([string]$CopilotHome = $env:COPILOT_HOME)
$ErrorActionPreference = 'Stop'
if (-not $CopilotHome) { $CopilotHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.copilot' }
$root = Split-Path $PSScriptRoot -Parent
$entry = Join-Path $root 'canvas\extension.mjs'
if (-not (Test-Path (Join-Path $root '.local\bin\MonasMindHost.exe'))) { throw 'Run scripts\setup.ps1 first.' }
if (-not (Test-Path (Join-Path $root '.local\search\Program.exe'))) { throw 'Search is not built. Run scripts\setup.ps1 first.' }
$target = Join-Path $CopilotHome 'extensions\monas-mind'
New-Item -ItemType Directory -Path $target -Force | Out-Null
$loader = Join-Path $target 'extension.mjs'
$uri = ([Uri](Resolve-Path $entry).Path).AbsoluteUri
$content = "// Global registration only. Implementation and data belong to the repository.`nimport " + (ConvertTo-Json $uri -Compress) + ";`n"
if (Test-Path $loader) {
    $previous = [IO.File]::ReadAllText($loader)
    if ($previous -eq $content) { Write-Output 'Global registration already points to this checkout.'; return }
    $backup = Join-Path $root ('.local\registration-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath $loader -Destination (Join-Path $backup 'extension.mjs')
    Write-Output "Previous registration preserved at $backup"
}
[IO.File]::WriteAllText($loader, $content, [Text.UTF8Encoding]::new($false))
Write-Output "Global registration points to $entry"
Write-Output 'Reload extensions or restart Copilot to discover it. No app server was started. Existing captures and installed bundle assets were not changed.'
