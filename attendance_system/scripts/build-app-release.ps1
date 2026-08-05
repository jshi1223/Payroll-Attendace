param(
  [string]$ReleaseFile = (Join-Path $PSScriptRoot '..\app_release.json')
)

$releasePath = [System.IO.Path]::GetFullPath($ReleaseFile)
if (-not (Test-Path -LiteralPath $releasePath)) {
  throw "Release file not found: $releasePath"
}

$release = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json
$baseVersion = [string]$release.flutter_base_version
if ([string]::IsNullOrWhiteSpace($baseVersion)) {
  throw "flutter_base_version is missing in app_release.json"
}

$epoch = [DateTimeOffset]::Parse("2020-01-01T00:00:00Z")
$buildNumber = [int][Math]::Floor(([DateTimeOffset]::UtcNow - $epoch).TotalSeconds)
if ($buildNumber -le 0) {
  throw "Could not generate a valid build number."
}

$dartDefines = @("API_BASE_URL=$($release.api_base_url)")
foreach ($entry in @(
  @{ Key = "firebase_api_key"; Define = "FIREBASE_API_KEY" },
  @{ Key = "firebase_app_id"; Define = "FIREBASE_APP_ID" },
  @{ Key = "firebase_messaging_sender_id"; Define = "FIREBASE_MESSAGING_SENDER_ID" },
  @{ Key = "firebase_project_id"; Define = "FIREBASE_PROJECT_ID" },
  @{ Key = "firebase_storage_bucket"; Define = "FIREBASE_STORAGE_BUCKET" }
)) {
  $value = [string]$release.($entry.Key)
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    $dartDefines += "$($entry.Define)=$value"
  }
}

Write-Host "Building Flutter APK with version $baseVersion+$buildNumber"

Push-Location (Join-Path $PSScriptRoot '..\flutter_app')
try {
  $args = @("build", "apk", "--release")
  foreach ($define in $dartDefines) {
    $args += "--dart-define=$define"
  }
  $args += "--build-name=$baseVersion"
  $args += "--build-number=$buildNumber"
  flutter @args
}
finally {
  Pop-Location
}
