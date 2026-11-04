#!/usr/bin/env bash
# Guard: `make dev` must launch on the shared production config directory, and
# `make test` and `make agent-test` keep separate isolated defaults.
#
# Written as a bare `TUIC_APP_INSTANCE?=tuic-test`, that default is a *global*
# make variable — its position in the file buys nothing — so `make dev` expanded
# it too and started Boss's daily driver against an empty
# `instances/tuic-test/`: every repository appeared to have vanished. The fix is
# a target-specific assignment, which no reader can tell from the broken form by
# looking at it. Hence this check, which asks make what it actually expands.
#
# It regressed once with the fix already written (2026-09-14, archived unapplied
# under .claude/yagni/) and cost a second scare on 2026-09-17.
set -euo pipefail

cd "$(dirname "$0")/.."

# Absence of the token is NOT a usable answer on its own: `make -n` erroring
# out, or a recipe reshaped so the literal `TUIC_APP_INSTANCE=` token stops
# appearing, both print nothing — and nothing is also the *correct* expectation
# for `make dev`. So the two "I saw nothing" cases report a sentinel no `expect`
# can match, and dump make's diagnostics. `set -euo pipefail` does not cover
# this: a command substitution in argument position never fires errexit.
#
# Diagnostics go to stderr; stdout is the value the caller compares.
parsed_instance() { # <make-output> <make-rc>
	local out="$1" rc="$2" match
	if [ "$rc" -ne 0 ]; then
		printf '      make -n exited %d:\n' "$rc" >&2
		printf '%s\n' "$out" | sed 's/^/      /' >&2
		echo '<make-failed>'
		return
	fi
	# Anchored left so a future MY_TUIC_APP_INSTANCE cannot pass for this one.
	match=$(printf '%s\n' "$out" |
		grep -oE '(^|[[:space:]])TUIC_APP_INSTANCE=[^[:space:]]*' | head -1) || true
	if [ -z "$match" ]; then
		printf '      make -n printed no TUIC_APP_INSTANCE= token at all\n' >&2
		echo '<no-token>'
		return
	fi
	printf '%s\n' "${match#*=}"
}

# No inherited opinion on the variable: a stray `export TUIC_APP_INSTANCE` in
# the developer's shell would otherwise mask the very defaults under test.
instance_for() {
	local out rc
	out=$(env -u TUIC_APP_INSTANCE MAKEFLAGS= make -n "$@" 2>&1) && rc=0 || rc=$?
	parsed_instance "$out" "$rc"
}

# The documented `TUIC_APP_INSTANCE=<id> make test` form. Environment origin is
# a different path through make's precedence model than a command-line one, and
# it is the origin that beats a target-specific `?=` silently.
instance_for_env() { # <value> <make-args...>
	local value="$1" out rc
	shift
	out=$(TUIC_APP_INSTANCE="$value" MAKEFLAGS= make -n "$@" 2>&1) && rc=0 || rc=$?
	parsed_instance "$out" "$rc"
}

fail=0
expect() {
	local label="$1" want="$2" got="$3"
	if [ "$got" != "$want" ]; then
		echo "  ✗ $label: expected TUIC_APP_INSTANCE='$want', got '$got'"
		fail=1
	fi
}

# The daily driver stays on the shared config dir; empty means "no instance".
expect "make dev" "" "$(instance_for dev)"
# The throwaway verification target keeps its isolated namespace.
expect "make test" "tuic-test" "$(instance_for test)"
# The agent target uses dedicated arguments, not the daily driver's env variable.
agent_plan=$(env -u CARGO_TARGET_DIR MAKEFLAGS= make --no-print-directory agent-test AGENT_TEST_DRY_RUN=1)
if ! printf '%s' "$agent_plan" | python3 -c 'import json,sys; p=json.load(sys.stdin); assert p["environment"]["TUIC_APP_INSTANCE"] == "agent-test"; assert p["environment"]["TUIC_PORT"] == "19876"'; then
	echo "  ✗ make agent-test lost its isolated defaults"
	fail=1
fi
# A target-specific `?=` must still yield to an explicit override, both ways.
expect "make test TUIC_APP_INSTANCE=scope-check" "scope-check" \
	"$(instance_for test TUIC_APP_INSTANCE=scope-check)"
expect "make test TUIC_APP_INSTANCE=" "" "$(instance_for test TUIC_APP_INSTANCE=)"
expect "TUIC_APP_INSTANCE=scope-check make test" "scope-check" \
	"$(instance_for_env scope-check test)"
expect "TUIC_APP_INSTANCE= make test" "" "$(instance_for_env "" test)"

# The expectations above name their targets, so a NEW target that repeats the
# original mistake passes until someone hand-adds a line for it. This catches
# the shape instead: an assignment at the start of a line is global whatever it
# is called, `target: TUIC_APP_INSTANCE?=…` is not. Spaces are allowed before
# it — make accepts those on a variable line — but a TAB is the recipe prefix,
# and `\tTUIC_APP_INSTANCE=…` in the `dev` recipe is exactly the export we want.
global_assignment=$(grep -nE '^ *TUIC_APP_INSTANCE[[:space:]]*\??=' Makefile || true)
if [ -n "$global_assignment" ]; then
	echo "  ✗ Makefile: TUIC_APP_INSTANCE assigned globally (use 'target: VAR?=…'):"
	printf '%s\n' "$global_assignment" | sed 's/^/      /'
	fail=1
fi

exit $fail
