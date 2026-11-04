$ErrorActionPreference = 'Stop'
$root = if ($env:TUIC_TEST_TMP_ROOT) { $env:TUIC_TEST_TMP_ROOT } else { Join-Path (Resolve-Path '..') '.tmp/tuic-tests' }
New-Item -ItemType Directory -Path $root -Force | Out-Null
$root = (Resolve-Path $root).Path
$lines = @(
    "TUIC_TEST_TMP_ROOT=$root"
    "TMPDIR=$root"
    "TMP=$root"
    "TEMP=$root"
)
[System.IO.File]::AppendAllText(
    $env:NEXTEST_ENV,
    ($lines -join "`n") + "`n",
    [System.Text.UTF8Encoding]::new($false)
)
