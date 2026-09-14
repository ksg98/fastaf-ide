# Development Setup

## Prerequisites

- **Node.js 24+** (the repository version is pinned in [`.nvmrc`](https://github.com/sstraus/tuicommander/blob/main/.nvmrc))
- **Rust** (stable toolchain via rustup)
- **Tauri CLI** (`cargo install tauri-cli`)
- **git** and **gh** (GitHub CLI) for git/GitHub features

> **Windows users:** See the [Windows-specific prerequisites](#windows-prerequisites) section below before proceeding.

## Install Dependencies

```bash
pnpm install
```

## Development

### Native Tauri App

```bash
pnpm tauri dev
```

Starts the Vite dev server and Tauri app. Frontend files use Vite HMR; Rust changes require restarting the development process.

### Browser Mode

When the MCP server is enabled in settings, the frontend can run standalone:

```bash
pnpm dev
```

Connects to the Rust HTTP server via WebSocket/REST.

> **Note:** `pnpm dev` runs `scripts/dev-server.mjs`, not `vite` directly. The dev server is pinned to port 1421 (Tauri's `devUrl`), so the launcher checks the port first: if this checkout is already serving there it prints `reusing it` and exits 0 — the second Tauri app attaches to the running server. Starting a second Vite would wipe the shared `node_modules/.vite/deps` cache and kill hot reload for the session already running. If the port is held by another checkout or a stray process, the launcher fails with an explicit message instead of serving the wrong sources.

## Build

```bash
pnpm tauri build
```

Produces platform-specific installers:
- macOS: `.dmg` and `.app`
- Windows: `.nsis` (`.exe` setup installer)
- Linux: `.deb` and `.AppImage`

> **Note:** The `.msi` bundle may fail on Windows due to WiX tooling issues. Use `--bundles nsis` to produce a working `.exe` installer:
> ```bash
> cargo tauri build --bundles nsis
> ```

## Testing

```bash
pnpm test              # Run all tests
pnpm test:coverage     # Coverage report
```

**Test tiers:**
- Tier 1: Pure functions (utils, type transformations)
- Tier 2: Store logic (state management)
- Tier 3: Component rendering
- Tier 4: Integration (hooks + stores)

**Framework:** Vitest + SolidJS Testing Library + happy-dom

**Coverage:** ~80%+

## Project Structure

See [Architecture Overview](../architecture/overview.md) for full directory structure.

## Key Files

| File | Purpose |
|------|---------|
| `src/App.tsx` | Central orchestrator |
| `src-tauri/src/lib.rs` | Rust app setup, command registration |
| `src-tauri/src/pty.rs` | PTY session management |
| `src/hooks/useAppInit.ts` | App initialization |
| `src/stores/terminals.ts` | Terminal state |
| `src/stores/repositories.ts` | Repository state |
| `SPEC.md` | Feature specification |
| `ideas/index.md` | Feature concepts under evaluation |

## Configuration

App config stored in platform config directory:
- macOS: `~/Library/Application Support/tuicommander/`
- Linux: `~/.config/tuicommander/`
- Windows: `%APPDATA%/tuicommander/`

See [Configuration docs](../backend/config.md) for all config files.

## Makefile Targets

```bash
make dev         # Tauri dev mode
make build       # Production build
make test        # Run tests
make lint        # Run linter
make docs        # Build this documentation + search index into docs/book
make docs-serve  # …and serve it at http://127.0.0.1:8123
make clean       # Clean build artifacts
```

---

## Documentation Site

The book you are reading is [mdBook](https://rust-lang.github.io/mdBook/), built
by `scripts/build-docs.sh` and deployed to GitHub Pages by
`.github/workflows/website.yml`. The script is the single source of truth — CI
runs the same one, so a local build matches the deployed site.

```bash
make docs-serve     # build + serve; open http://127.0.0.1:8123
```

Requires `mdbook` (`brew install mdbook` or `cargo install mdbook`) and `npx`.

Search is [Pagefind](https://pagefind.app/), generated after the mdBook build,
which is why `file://` previews have no search — the index is fetched over HTTP.
mdBook's own elasticlunr search is disabled in `book.toml`.

Adding a page means adding it to `SUMMARY.md`: mdBook only renders — and
Pagefind only indexes — chapters listed there.

---

## Windows Prerequisites

Building on Windows requires a few extra tools beyond the standard prerequisites. Install them in this order.

### 1. Visual Studio Build Tools (C++ compiler)

Download and install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and select the **"Desktop development with C++"** workload. VS Build Tools 2019 or later is fine.

Or via winget:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```

### 2. Rust

```powershell
winget install Rustlang.Rustup
```

Restart your terminal after installation, then verify:
```powershell
rustc --version
cargo --version
```

### 3. Node.js

```powershell
winget install OpenJS.NodeJS.LTS
```

### 4. CMake

Required to compile `whisper-rs` (the on-device dictation library).

```powershell
winget install Kitware.CMake
```

### 5. LLVM 18 (libclang — required for whisper-rs bindings)

`whisper-rs` uses `bindgen` to generate Rust bindings for `whisper.cpp`, which requires `libclang`. **Use LLVM 18** — LLVM 19+ produces broken bindings for this crate on Windows.

Download the LLVM 18 installer from [GitHub releases](https://github.com/llvm/llvm-project/releases/tag/llvmorg-18.1.8) (`LLVM-18.1.8-win64.exe`) and install it. Then set the environment variable so `bindgen` can find it:

```powershell
# Add to your PowerShell profile or set permanently in System Environment Variables
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
```

> If you have LLVM 22+ installed (e.g. from winget), install LLVM 18 to a separate directory and point `LIBCLANG_PATH` there instead.

### 6. Tauri CLI

```powershell
cargo install tauri-cli --version "^2"
```

### Full Windows Build Command

Always set `LIBCLANG_PATH` before building:

```powershell
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"   # adjust path if LLVM 18 is elsewhere
cargo tauri build --bundles nsis
```

The installer will be at:
```
src-tauri\target\release\bundle\nsis\FastAF_0.x.x_x64-setup.exe
```

### Windows Known Issues

| Symptom | Cause | Fix |
|---|---|---|
| `whisper-rs-sys` build fails with "couldn't find libclang" | LLVM not installed or `LIBCLANG_PATH` not set | Install LLVM 18 and set `LIBCLANG_PATH` |
| `whisper-rs-sys` compile error: `attempt to compute 1_usize - 296_usize` | LLVM 19+ generates broken bindings for this crate | Use LLVM 18 specifically |
| WiX `.msi` bundle fails | WiX `light.exe` tooling issue | Use `--bundles nsis` instead |
| App window opens but shows a **black screen** | Navigation guard in `lib.rs` blocked `http://tauri.localhost/` (Windows' internal Tauri URL) | Fixed in current code — `tauri.localhost` is explicitly allowed |
| `Update check failed: windows-x86_64-nsis not found` | Custom local build isn't listed in official release manifest | Harmless — auto-update simply won't trigger |
