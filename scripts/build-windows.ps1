param(
    [string]$WebView2Version = "1.0.3405.78"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$projectRootResolved = [System.IO.Path]::GetFullPath($projectRoot)
$cacheRoot = Join-Path $projectRoot "windows\.cache"
$sdkRoot = Join-Path $projectRoot "windows\webview2-sdk"
$packagePath = Join-Path $cacheRoot "Microsoft.Web.WebView2.$WebView2Version.nupkg"
$archivePath = Join-Path $cacheRoot "Microsoft.Web.WebView2.$WebView2Version.zip"
$distParent = Join-Path $projectRoot "dist"
$distRoot = Join-Path $distParent "Spotify Lite"
$zipOutput = Join-Path $distParent "Spotify-Lite-Windows.zip"

$distParentResolved = [System.IO.Path]::GetFullPath($distParent)
$distRootResolved = [System.IO.Path]::GetFullPath($distRoot)
if (-not $distParentResolved.StartsWith($projectRootResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Invalid dist path: $distParentResolved"
}
if (-not $distRootResolved.StartsWith($distParentResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Invalid app dist path: $distRootResolved"
}

New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
New-Item -ItemType Directory -Path $distParent -Force | Out-Null

if (-not (Test-Path -LiteralPath $sdkRoot)) {
    if (-not (Test-Path -LiteralPath $packagePath)) {
        $packageVersion = $WebView2Version.ToLowerInvariant()
        $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$packageVersion/microsoft.web.webview2.$packageVersion.nupkg"
        Invoke-WebRequest -Uri $url -OutFile $packagePath
    }

    Copy-Item -LiteralPath $packagePath -Destination $archivePath -Force
    Expand-Archive -LiteralPath $archivePath -DestinationPath $sdkRoot -Force
}

$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
    throw "The .NET Framework 4.x compiler was not found."
}

if (Test-Path -LiteralPath $distRoot) {
    Remove-Item -LiteralPath $distRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

$coreDll = Join-Path $sdkRoot "lib\net462\Microsoft.Web.WebView2.Core.dll"
$formsDll = Join-Path $sdkRoot "lib\net462\Microsoft.Web.WebView2.WinForms.dll"
$loaderDll = Join-Path $sdkRoot "runtimes\win-x64\native\WebView2Loader.dll"
$launcher = Join-Path $projectRoot "windows\SpotifyLiteLauncher.cs"
$icon = Join-Path $projectRoot "assets\spotify-lite.ico"
$executable = Join-Path $distRoot "Spotify Lite.exe"
$requiredFiles = @($coreDll, $formsDll, $loaderDll, $launcher, $icon)

foreach ($path in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing required file: $path"
    }
}

& $compiler /nologo /target:winexe /platform:x64 /out:$executable /win32icon:$icon /reference:$coreDll /reference:$formsDll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $launcher
if ($LASTEXITCODE -ne 0) {
    throw "Windows compilation failed."
}

$appFiles = @(
    "index.html",
    "app.js",
    "styles.css",
    "sw.js",
    "manifest.webmanifest",
    "README.md",
    "LICENSE"
)

Copy-Item -LiteralPath @($coreDll, $formsDll, $loaderDll) -Destination $distRoot
foreach ($file in $appFiles) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $distRoot
}
Copy-Item -LiteralPath (Join-Path $projectRoot "config.example.js") -Destination (Join-Path $distRoot "config.js")
Copy-Item -LiteralPath (Join-Path $projectRoot "assets") -Destination $distRoot -Recurse

if (Test-Path -LiteralPath $zipOutput) {
    Remove-Item -LiteralPath $zipOutput -Force
}
Compress-Archive -Path (Join-Path $distRoot "*") -DestinationPath $zipOutput -CompressionLevel Optimal

Write-Host "Build created: $zipOutput"
