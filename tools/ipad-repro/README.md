# iPad touch-scroll repro (#1329-a31a)

Drives Mobile Safari in the iPad Simulator with real touches (XCUITest), against the real UI
served by Vite with a fake backend. Xcode here has no Simulator.app, so XCUITest is the only
touch injector.

1. `python3 tools/ipad-repro/mock_backend.py` (fake API on :9891, 6 repos x 8 branches, 120 files)
2. `pnpm exec vite --config tools/ipad-repro/vite.config.ts` (:5188, type-checker overlay off)
3. Build once: `xcodebuild build-for-testing -project tools/ipad-repro/xcui/Swipe.xcodeproj -scheme SwipeUITests -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath <dd>`
4. `run.sh TAG URL X Y DX DY HOLD STEPS` (paths and the simulator UDID are set at the top of the script; TAPX/TAPY taps first, e.g. to open the Files panel). Screenshots land in `out/`.

`repro.html` is a plain scroll list with the real `global.css` and `useMouseDrag` listeners
(`?css=none|global&drag=0|1&touchaction=<value>`), for isolating CSS and listener effects.
