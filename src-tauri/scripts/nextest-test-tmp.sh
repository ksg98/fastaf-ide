#!/bin/sh
set -eu

root=${TUIC_TEST_TMP_ROOT:-"$(cd .. && pwd)/.tmp/tuic-tests"}
mkdir -p "$root"
root=$(cd "$root" && pwd)
{
    printf 'TUIC_TEST_TMP_ROOT=%s\n' "$root"
    printf 'TMPDIR=%s/\n' "$root"
    printf 'TMP=%s/\n' "$root"
    printf 'TEMP=%s/\n' "$root"
} >> "$NEXTEST_ENV"
