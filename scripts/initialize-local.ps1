$ErrorActionPreference = 'Stop'
$config = Join-Path (Split-Path $PSScriptRoot -Parent) 'browser-extension\config.json'
if (-not (Test-Path $config)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    @{ capability = [Convert]::ToBase64String($bytes) } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding ASCII
}
Write-Output 'Local capture configuration ready (existing capability preserved).'
