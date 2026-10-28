$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
$root = Split-Path $PSScriptRoot -Parent
$dotnet = Join-Path $root '.local\sdk\dotnet.exe'
& $dotnet publish (Join-Path $root 'canvas\app\MonasMind.csproj') -c Release --no-restore --output (Join-Path $root '.local\publish') --verbosity minimal
if ($LASTEXITCODE -ne 0) { throw "App publish failed: $LASTEXITCODE" }
& $dotnet publish (Join-Path $root 'canvas\host\MonasMindHost.csproj') -c Release -r win-x64 --self-contained true --no-restore -o (Join-Path $root '.local\bin') -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:BundleWebAssets=true -p:DebugType=None -p:DebugSymbols=false --verbosity minimal
if ($LASTEXITCODE -ne 0) { throw "Single-file host publish failed: $LASTEXITCODE" }
Write-Output "Single-file Windows host: $root\.local\bin\MonasMindHost.exe"
