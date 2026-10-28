$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js first: https://nodejs.org/' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'Windows tar.exe is required for dependency extraction.' }
foreach ($folder in @('.local\downloads','.local\temp','.local\home','.local\nuget','.local\sdk','canvas\app\wwwroot\vendor','.local\python-runtime','.local\packages')) {
    New-Item -ItemType Directory (Join-Path $root $folder) -Force | Out-Null
}
. "$PSScriptRoot\env.ps1"
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PIP_CACHE_DIR = Join-Path $root '.local\downloads\pip-cache'
$deps = Get-Content "$PSScriptRoot\dependencies.json" -Raw | ConvertFrom-Json
function Fetch-Verified($url, $file, $algorithm, $hash) {
    if (-not (Test-Path $file)) {
        Write-Output "Downloading $url"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
    }
    if ((Get-FileHash $file -Algorithm $algorithm).Hash.ToLower() -ne $hash.ToLower()) {
        throw "Checksum mismatch; preserved for inspection: $file"
    }
}
$dotnet = Join-Path $root '.local\sdk\dotnet.exe'
if (-not (Test-Path $dotnet)) {
    $archive = Join-Path $root '.local\downloads\dotnet-sdk-win-x64.zip'
    Fetch-Verified $deps.dotnet.url $archive 'SHA512' $deps.dotnet.sha512
    Expand-Archive -LiteralPath $archive -DestinationPath "$root\.local\sdk" -Force
}
if ((& $dotnet --version).Trim() -ne $deps.dotnet.version) { throw 'Unexpected .NET SDK version.' }
$babylon = Join-Path $root 'canvas\app\wwwroot\vendor\babylon.js'
if (-not (Test-Path $babylon)) {
    $archive = Join-Path $root '.local\downloads\babylonjs.tgz'
    $bytes = [Convert]::FromBase64String($deps.babylon.integrity.Substring(7))
    $hash = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLower()
    Fetch-Verified $deps.babylon.url $archive 'SHA512' $hash
    New-Item -ItemType Directory "$root\.local\vendor" -Force | Out-Null
    & tar -xf $archive -C "$root\.local\vendor" package/babylon.js package/license.md package/NOTICE.md
    if ($LASTEXITCODE -ne 0) { throw 'Babylon archive extraction failed.' }
    Copy-Item "$root\.local\vendor\package\babylon.js" $babylon
    Copy-Item "$root\.local\vendor\package\license.md" "$root\canvas\app\wwwroot\vendor\babylon-license.md"
    Copy-Item "$root\.local\vendor\package\NOTICE.md" "$root\canvas\app\wwwroot\vendor\babylon-NOTICE.md"
}
if ((Get-FileHash $babylon -Algorithm SHA256).Hash.ToLower() -ne $deps.babylon.asset_sha256) { throw 'Unexpected Babylon.js asset; preserved for inspection.' }
$python = Join-Path $root '.local\python-runtime\python.exe'
if (-not (Test-Path $python)) {
    $archive = Join-Path $root '.local\downloads\python-embed.zip'
    Fetch-Verified $deps.python.url $archive 'SHA256' $deps.python.sha256
    Expand-Archive -LiteralPath $archive -DestinationPath "$root\.local\python-runtime" -Force
}
@('python311.zip', '.', '..\packages', 'import site') | Set-Content "$root\.local\python-runtime\python311._pth" -Encoding ASCII
$version = & $python -I -B -c 'import platform; print(platform.python_version())'
if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne $deps.python.version) { throw 'Unexpected Python version.' }
$check = "import importlib.metadata as m,sys; from pathlib import Path; versions={d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()}; missing=[s for s in Path(sys.argv[1]).read_text().splitlines() if s and versions.get(s.split('==')[0].lower().replace('_','-')) != s.split('==')[1]]; sys.exit(bool(missing))"
& $python -I -B -c $check "$PSScriptRoot\requirements.txt" 2>$null
if ($LASTEXITCODE -ne 0) {
    $wheel = Join-Path "$root\.local\downloads" $deps.pip.filename
    Fetch-Verified $deps.pip.url $wheel 'SHA256' $deps.pip.sha256
    & $python -I -B -c "import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); runpy.run_module('pip',run_name='__main__')" $wheel install --only-binary=:all: --upgrade --target "$root\.local\packages" -r "$PSScriptRoot\requirements.txt"
    if ($LASTEXITCODE -ne 0) { throw 'Local Python dependency install failed.' }
}
& $python -I -B -c $check "$PSScriptRoot\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw 'Python package versions do not match requirements.txt.' }
& $dotnet restore "$root\canvas\app\MonasMind.csproj" --verbosity quiet
if ($LASTEXITCODE -ne 0) { throw 'App restore failed.' }
& $dotnet restore "$root\canvas\host\MonasMindHost.csproj" -r win-x64 --verbosity quiet
if ($LASTEXITCODE -ne 0) { throw 'Host restore failed.' }
& "$PSScriptRoot\initialize-local.ps1"
& "$PSScriptRoot\build.ps1"
& $dotnet publish "$root\search\Program.cs" -c Release -r win-x64 --self-contained true -o "$root\.local\search" -p:PublishSingleFile=true --verbosity quiet
if ($LASTEXITCODE -ne 0) { throw 'Search program build failed.' }
& "$PSScriptRoot\install-global.ps1"
Write-Output "Ready. Restart Copilot and open Mona's Mind. Load browser-extension in Edge. No dev server required."
