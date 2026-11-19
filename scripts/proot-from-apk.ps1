<#
.SYNOPSIS
  Puts the four proot libraries into android/app/src/main/jniLibs/arm64-v8a, without Linux tooling.

.DESCRIPTION
  Android only lets an app execute files that ship inside the APK as lib*.so, so the shell needs proot
  as native libraries. CI builds them with scripts/fetch-proot.sh (needs bash, ar and patchelf). This
  script takes the same four files out of an APK that CI already built - the published "latest" release,
  or any APK you point it at - so a local Windows build has a working shell too.

  jniLibs/ is gitignored on purpose: these are binaries, and CI is the source of truth for them.

.PARAMETER Apk
  An APK file to read. Default: download the "latest" release of the repo.

.PARAMETER Repo
  owner/name to download from when -Apk is not given.

.EXAMPLE
  scripts/proot-from-apk.ps1

.EXAMPLE
  scripts/proot-from-apk.ps1 -Apk .\chronicle.apk
#>
param(
  [string]$Apk = '',
  [string]$Repo = 'amon28/chronicle-harness'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'android/app/src/main/jniLibs/arm64-v8a'
$want = @('libproot.so', 'libproot-loader.so', 'libtalloc.so', 'libandroid-shmem.so')

function Get-GitHubToken {
  if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }
  try {
    $nl = [char]10
    $cred = ('protocol=https' + $nl + 'host=github.com' + $nl + $nl) | git credential fill 2>$null
    $p = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
    if ($p) { return $p }
  } catch { }
  return ''
}

function Get-Curl {
  $c = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $c) { $c = Get-Command curl -ErrorAction SilentlyContinue }
  if (-not $c) { throw 'curl is needed to download the APK; pass -Apk instead' }
  return $c.Source
}

if (-not $Apk) {
  $token = Get-GitHubToken
  $apiHeaders = @{ 'User-Agent' = 'chronicle-dev'; Accept = 'application/vnd.github+json' }
  if ($token) { $apiHeaders['Authorization'] = "token $token" }
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/latest" -Headers $apiHeaders
  } catch {
    throw "Could not read the latest release of $Repo ($($_.Exception.Message)). A private repo needs a token: set GITHUB_TOKEN, or sign in so git has a credential, or pass -Apk."
  }
  $asset = $rel.assets | Where-Object { $_.name -eq 'chronicle.apk' } | Select-Object -First 1
  if (-not $asset) { throw "No chronicle.apk in the latest release of $Repo" }
  $Apk = Join-Path $env:TEMP 'chronicle-latest.apk'
  Write-Host ("Downloading {0} - {1:N1} MB, release updated {2}" -f $asset.name, ($asset.size / 1MB), $rel.updated_at)
  # the release's /download/ URL 404s for this repo; the asset endpoint with an octet-stream accept works
  $curl = Get-Curl
  $curlArgs = @('-fsSL', '-H', 'Accept: application/octet-stream', '-H', 'User-Agent: chronicle-dev', '-o', $Apk)
  if ($token) { $curlArgs += @('-H', ('Authorization: token ' + $token)) }
  $curlArgs += $asset.url
  & $curl @curlArgs
  if ($LASTEXITCODE -ne 0) { throw "curl failed with exit $LASTEXITCODE" }
  Write-Host ("  {0:N1} MB" -f ((Get-Item $Apk).Length / 1MB))
}

if (-not (Test-Path $Apk)) { throw "No APK at $Apk" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $Apk).Path)
New-Item -ItemType Directory -Force $out | Out-Null
$got = @()
try {
  foreach ($e in $zip.Entries) {
    $leaf = Split-Path $e.FullName -Leaf
    if ($e.FullName -eq "lib/arm64-v8a/$leaf" -and $want -contains $leaf) {
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $out $leaf), $true)
      $got += $leaf
    }
  }
} finally {
  $zip.Dispose()
}

$missing = $want | Where-Object { $got -notcontains $_ }
Get-ChildItem $out -ErrorAction SilentlyContinue | ForEach-Object { "  {0,-22} {1,8:N0} bytes" -f $_.Name, $_.Length }
if ($missing) {
  Write-Warning "Not found in the APK: $($missing -join ', '). Was it built without proot (scripts/fetch-proot.sh)?"
  exit 1
}
Write-Host "proot ready in $out - a local build now has a working shell."
