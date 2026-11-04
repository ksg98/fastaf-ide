import XCTest

// Drives Mobile Safari with real touches. Env (TEST_RUNNER_ prefix on the host):
//   OUT   screenshot dir      X,Y  start point (0..1 of screen)   DX,DY  swipe delta (0..1)
//   HOLD  seconds to hold before dragging (0 = plain swipe)       STEPS  number of swipes
final class SwipeUITests: XCTestCase {
    func testSwipe() throws {
        let env = ProcessInfo.processInfo.environment
        func d(_ k: String, _ def: Double) -> Double { Double(env[k] ?? "") ?? def }
        let out = env["OUT"] ?? NSTemporaryDirectory()
        let tag = env["TAG"] ?? "run"
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.activate()
        sleep(2)
        func shot(_ name: String) {
            let png = XCUIScreen.main.screenshot().pngRepresentation
            try? png.write(to: URL(fileURLWithPath: "\(out)/\(tag)-\(name).png"))
        }
        if let tx = Double(env["TAPX"] ?? ""), let ty = Double(env["TAPY"] ?? "") {
            safari.coordinate(withNormalizedOffset: CGVector(dx: tx, dy: ty)).tap()
            sleep(2)
        }
        shot("0-before")
        let start = safari.coordinate(withNormalizedOffset: CGVector(dx: d("X", 0.5), dy: d("Y", 0.7)))
        let end = safari.coordinate(withNormalizedOffset: CGVector(dx: d("X", 0.5) + d("DX", 0), dy: d("Y", 0.7) + d("DY", -0.4)))
        let hold = d("HOLD", 0.05)
        for i in 1...Int(d("STEPS", 1)) {
            start.press(forDuration: hold, thenDragTo: end)
            sleep(1)
            shot("\(i)-after")
            let hud = safari.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'st='")).firstMatch
            let txt = hud.waitForExistence(timeout: 2) ? hud.label : "HUD-not-found"
            try? txt.write(toFile: "\(out)/\(tag).txt", atomically: true, encoding: .utf8)
        }
    }
}
