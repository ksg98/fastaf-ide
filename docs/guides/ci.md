# Continuous Integration

Four GitHub Actions workflows compile Rust:

| Workflow | Trigger | What it compiles |
|---|---|---|
| [`ci.yml`](https://github.com/sstraus/tuicommander/blob/main/.github/workflows/ci.yml) | pull request, push to `main` | clippy + `cargo nextest` + doctests on Linux, `tuic-remote` without the desktop feature, macOS and Windows builds on push |
| [`release.yml`](https://github.com/sstraus/tuicommander/blob/main/.github/workflows/release.yml) | version tag | the signed artifacts users install |
| [`nightly.yml`](https://github.com/sstraus/tuicommander/blob/main/.github/workflows/nightly.yml) | push to `main` | the rolling `nightly` release |
| [`audit.yml`](https://github.com/sstraus/tuicommander/blob/main/.github/workflows/audit.yml) | Monday 09:00 UTC | `cargo install cargo-audit`, then the advisory scan |

## The Rust toolchain is pinned

Every `dtolnay/rust-toolchain` step takes its version from a workflow-level
`RUST_VERSION` variable:

```yaml
env:
  RUST_VERSION: "1.98.0"

# ...

      - name: Install Rust ${{ env.RUST_VERSION }}
        uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: ${{ env.RUST_VERSION }}
```

The action's `toolchain` input overrides the `@stable` branch default, so the
branch name in `uses:` no longer decides the compiler.

### Why

`@stable` on its own floats. The day rustup publishes a new stable, the compiler
changes under the repository with no commit to point at: fresh clippy lints and
rustfmt reflows become a red `main` for whoever pushes next, not for whoever
wrote the code. That has happened three times — `7db734f9`, `20e58629`, and the
1.98 lints cleared on 2026-08-31 while CI was still green on an older stable, so
the tree failed locally and passed in CI at the same commit.

Pinning also makes the release reproducible: a tag built today and rebuilt in six
months uses the same compiler.

### How to bump the pin

1. Install the target toolchain locally (`rustup toolchain install <version>`)
   and make it the default for this checkout.
2. From `src-tauri/`, confirm both gates are clean:

   ```bash
   cargo clippy --all-targets -- -D warnings
   cargo fmt --check
   ```

   Fix whatever the new compiler flags. This is the work the pin defers to a
   deliberate moment instead of ambushing the next push.
3. Raise `RUST_VERSION` in **all four** workflows — `ci.yml`, `release.yml`,
   `nightly.yml`, `audit.yml` — in a single commit.
4. Push. CI runs on the new toolchain as part of that commit, so any breakage
   lands on its author and is bisectable.

Never raise the pin in one workflow only: `ci.yml` would then vouch for a
compiler that `release.yml` does not use.

> The local `rustc` is not pinned by a `rust-toolchain.toml`, on purpose —
> contributors keep their own rustup default. `cargo fmt --check` and clippy are
> the contract; the CI pin is what makes that contract stable over time.

## Note on clippy scope

CI runs `cargo clippy -- -D warnings`, which lints the default targets. The
`--all-targets` form in the bump checklist above is stricter — it also lints test
and bench code — so a clean local `--all-targets` run implies CI's narrower one.
