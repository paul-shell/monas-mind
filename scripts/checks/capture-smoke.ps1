param([Parameter(Mandatory=$true)][string]$Origin)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$bundle = $root
$uri = [Uri]$Origin
if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') { throw 'Use the local Release preview origin.' }
$Origin = $uri.GetLeftPart([UriPartial]::Authority)
$manifest = Get-Content "$bundle\browser-extension\manifest.json" -Raw | ConvertFrom-Json
$config = Get-Content "$bundle\browser-extension\config.json" -Raw | ConvertFrom-Json
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = $sha.ComputeHash([Convert]::FromBase64String($manifest.key)) } finally { $sha.Dispose() }
$id = -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
$icon = 'data:image/png;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes("$root\canvas\app\wwwroot\favicon.png"))
$body = @{title='Mona setup smoke check (synthetic)';url='https://example.com/mona-setup-check';html='<html><body><h1>Mona setup check</h1><p>QuartzBadger verifies portable source search and conversion.</p></body></html>';omitted=0;favicon=$icon} | ConvertTo-Json -Compress
$created = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47633/api/browser-capture' -ContentType 'application/json' -Headers @{Origin="chrome-extension://$id";'X-Mona-Capability'=$config.capability} -Body $body
try {
    $sources = Invoke-RestMethod "$Origin/api/captures" -Headers @{Origin=$Origin}
    $source = $null
    foreach ($item in $sources) { if ($item.id -eq $created.id) { $source = $item; break } }
    if (-not $source -or $source.markdown -notmatch 'QuartzBadger') { throw 'Capture conversion did not persist expected text.' }
    if (-not $source.python.StartsWith($bundle, [StringComparison]::OrdinalIgnoreCase)) { throw 'Capture used a different bundle Python.' }
    $png = Invoke-WebRequest -UseBasicParsing "$Origin/$($source.favicon)"
    if ($png.StatusCode -ne 200 -or $png.Headers['Content-Type'] -notmatch 'image/png') { throw 'Stored favicon did not serve as PNG.' }
    $result = & node "$bundle\search\tools.mjs" search QuartzBadger | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not ($result.results | Where-Object source_id -eq $created.id)) { throw 'Search missed actual persisted capture.' }
    $read = & node "$bundle\search\tools.mjs" read $created.id | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $read.text -notmatch 'QuartzBadger' -or $read.url -ne $source.url) { throw 'Read/citation did not match captured source.' }
    Write-Output "PASS: captured HTML -> local Python -> saved Markdown/PNG -> search -> exact read/citation. Synthetic ID: $($created.id)"
} finally {
    Invoke-RestMethod -Method Post "$Origin/api/captures/$($created.id)/hide" -Headers @{Origin=$Origin} | Out-Null
    Write-Output 'Synthetic check hidden from Sources/search; files retained in ignored captures for evidence.'
}
