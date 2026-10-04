#!/usr/bin/env python3
"""Exercise the packaged native browser through its actual chrome and Gecko.

Install the Marionette client from the same pinned Firefox source first. Every
run uses a disposable profile, headless browser, and local HTTP fixture server.
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import traceback

from marionette_driver.marionette import Marionette
from marionette_driver.by import By
from marionette_driver.keys import Keys


class FixturePage(BaseHTTPRequestHandler):
    def do_GET(self):
        body = (
            '<!doctype html><meta charset="utf-8"><title>Orbit Gecko smoke</title>'
            '<h1 id="native-gecko-proof">Rendered by native Gecko</h1>'
            '<a href="/second">Second page</a>'
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def wait_for(driver, script: str, label: str, timeout: float = 30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = driver.execute_script(script)
        if result:
            return result
        time.sleep(0.2)
    raise AssertionError(f"Timed out waiting for {label}")


def click_canvas_button(driver):
    button = driver.find_element(By.ID, "orbit-canvas-button")
    try:
        driver.actions.sequence("pointer", "orbit-toolbar-mouse", {"pointerType": "mouse"}).click(button).perform()
    finally:
        driver.actions.release()


def canvas_shortcut(driver):
    try:
        driver.actions.sequence("key", "orbit-hotkey").key_down(Keys.ALT).key_down(Keys.SHIFT).key_down("o").key_up("o").key_up(Keys.SHIFT).key_up(Keys.ALT).perform()
    finally:
        driver.actions.release()


def canvas_visible(driver):
    return driver.execute_script('''
        const overlay = document.getElementById("orbit-canvas-overlay");
        const frame = document.getElementById("orbit-canvas-frame");
        const viewport = frame?.contentDocument?.getElementById("viewport");
        const bounds = viewport?.getBoundingClientRect();
        return !!overlay && !overlay.hidden && bounds?.width > 400 && bounds?.height > 250;
    ''')


def open_canvas(driver):
    if not canvas_visible(driver):
        click_canvas_button(driver)
        wait_for(driver, '''
            const overlay = document.getElementById("orbit-canvas-overlay");
            const frame = document.getElementById("orbit-canvas-frame");
            const viewport = frame?.contentDocument?.getElementById("viewport");
            const bounds = viewport?.getBoundingClientRect();
            return !!overlay && !overlay.hidden && bounds?.width > 400 && bounds?.height > 250;
        ''', "toolbar opens a visible canvas")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--report", type=Path, default=Path("test-results/smoke.json"))
    args = parser.parse_args()
    report = args.report.resolve()
    report.parent.mkdir(parents=True, exist_ok=True)
    checks = []
    driver = None
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixturePage)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/"
    result = {"binary": str(args.binary.resolve()), "passed": False, "checks": checks}
    try:
        with tempfile.TemporaryDirectory(prefix="orbit-native-smoke-") as workspace:
            driver = Marionette(
                bin=str(args.binary.resolve()), app="fxdesktop", port=0,
                headless=True, startup_timeout=90, socket_timeout=60,
                workspace=workspace, gecko_log=str(report.parent / "gecko.log"),
                app_args=["-no-remote", "--remote-allow-system-access"],
                prefs={"browser.startup.page": 0, "browser.startup.homepage": "about:blank"},
            )
            driver.start_session()
            driver.set_context("content")
            driver.navigate(url)
            assert driver.execute_script('return document.getElementById("native-gecko-proof").textContent') == "Rendered by native Gecko"
            checks.append("Real HTTP document rendered by Gecko")

            driver.set_context("chrome")
            wait_for(driver, 'return !!window.gBrowserInit?.delayedStartupFinished && !!window.OrbitChrome;', "native startup category registration")
            native = driver.execute_script('''
                return {
                    tabs: !!window.gBrowser,
                    devtools: !!document.getElementById("menu_devToolbox"),
                    widget: !!document.getElementById("orbit-canvas-button"),
                    updatesBlocked: !Services.policies.isAllowed("appUpdate"),
                    splitEnabled: Services.prefs.getBoolPref("browser.tabs.splitView.enabled", false)
                };
            ''')
            assert native["tabs"] and native["widget"], native
            assert native["updatesBlocked"], "Packaged DisableAppUpdate policy was not applied"
            assert native["splitEnabled"], "Native split view preference is disabled"
            checks.append("Native Orbit startup, toolbar registration, and update policy")

            open_canvas(driver)
            board = wait_for(driver, '''
                const frame = document.getElementById("orbit-canvas-frame");
                const doc = frame?.contentDocument;
                return doc?.readyState === "complete" && !!doc.getElementById("viewport") &&
                    doc.getElementById("save-status")?.textContent !== "Loading workspace…";
            ''', "packaged native canvas document")
            assert board
            assert driver.execute_script('return document.getElementById("orbit-canvas-frame").contentDocument.nodePrincipal.isSystemPrincipal;')
            checks.append("Packaged privileged canvas HTML, CSS, and JavaScript loaded")

            icon = driver.execute_script('''
                const button = document.getElementById("orbit-canvas-button");
                const image = button.querySelector(".toolbarbutton-icon");
                const bounds = image?.getBoundingClientRect();
                return {
                    image: button.getAttribute("image"), src: image?.getAttribute("src"),
                    width: bounds?.width, height: bounds?.height, pressed: button.getAttribute("aria-pressed")
                };
            ''')
            assert icon["image"] == "chrome://browser/content/orbit/orbit.svg", icon
            assert icon["src"] == icon["image"] and icon["width"] > 0 and icon["height"] > 0, icon
            assert icon["pressed"] == "true", icon
            checks.append("Physical toolbar click opens a visible canvas with its packaged icon")
            click_canvas_button(driver)
            wait_for(driver, 'return document.getElementById("orbit-canvas-overlay").hidden;', "toolbar closes the canvas")
            canvas_shortcut(driver)
            wait_for(driver, 'return !document.getElementById("orbit-canvas-overlay").hidden;', "Alt+Shift+O opens the canvas")
            assert canvas_visible(driver)
            canvas_shortcut(driver)
            wait_for(driver, 'return document.getElementById("orbit-canvas-overlay").hidden;', "Alt+Shift+O closes the canvas")
            open_canvas(driver)
            checks.append("Toolbar and keyboard shortcut both open and close the canvas")

            driver.execute_script('document.getElementById("orbit-canvas-frame").contentDocument.getElementById("import-tabs").click();')
            wait_for(driver, 'return window.OrbitChrome.getBoard()?.items.some(item => item.type === "tab" && item.url === arguments[0]);'.replace("arguments[0]", json.dumps(url)), "real tabs imported into canvas")
            checks.append("Canvas imports metadata from real Firefox tabs")
            wait_for(driver, 'return !!document.getElementById("orbit-canvas-frame").contentDocument.querySelector(".item.card");', "imported tab card is rendered")
            (report.parent / "orbit-canvas.png").write_bytes(driver.screenshot(format="binary", full=False))
            result["canvas_screenshot"] = "orbit-canvas.png"

            before = driver.execute_script('return gBrowser.tabs.length;')
            handles_before = set(driver.window_handles)
            opened = driver.execute_script('return window.OrbitChrome.openTab({url: arguments[0]});', script_args=[url + "opened"])
            assert opened["id"] and driver.execute_script('return gBrowser.tabs.length;') == before + 1
            deadline = time.monotonic() + 30
            new_handles = set(driver.window_handles) - handles_before
            while not new_handles and time.monotonic() < deadline:
                time.sleep(0.2)
                new_handles = set(driver.window_handles) - handles_before
            assert len(new_handles) == 1, "Native tab opening did not create one browser handle"
            driver.switch_to_window(new_handles.pop())
            driver.set_context("content")
            wait_for(driver, 'return !!document.getElementById("native-gecko-proof");', "new native tab's HTTP page")
            assert driver.get_url() == url + "opened", "Automation did not reach the newly opened tab"
            driver.set_context("chrome")
            open_canvas(driver)
            checks.append("Canvas opens a real native tab and renders its page")

            tabs = driver.execute_script('return window.OrbitChrome.listTabs();')
            first = next(tab for tab in tabs if tab["url"] == url + "opened")
            board_state = {
                "version": 1, "camera": {"x": 0, "y": 0, "zoom": 1},
                "frames": [{"id": "smoke-frame", "title": "Native frame", "color": "#9782ca", "x": 0, "y": 0, "w": 900, "h": 700}],
                "items": [
                    {"id": "smoke-tab-one", "type": "tab", "frameId": "smoke-frame", "tabId": first["id"], "title": "Existing real tab", "url": first["url"], "userContextId": 0, "x": 40, "y": 70, "w": 250, "h": 180},
                    {"id": "smoke-tab-two", "type": "tab", "frameId": "smoke-frame", "title": "Restored real tab", "url": url + "frame", "userContextId": 0, "x": 350, "y": 70, "w": 250, "h": 180},
                    {"id": "smoke-note", "type": "note", "text": "A native saved note", "color": "#fff1ad", "x": 80, "y": 320, "w": 220, "h": 160},
                ],
                "connections": [{"id": "smoke-connection", "from": "smoke-tab-one", "to": "smoke-note"}],
                "strokes": [{"id": "smoke-stroke", "color": "#9782ca", "width": 3, "points": [{"x": 1, "y": 1}, {"x": 50, "y": 40}]}],
            }
            saved = driver.execute_script('return window.OrbitChrome.saveBoard(arguments[0]);', script_args=[board_state])
            assert saved["items"][2]["text"] == "A native saved note"
            frame_before = driver.execute_script('return gBrowser.tabs.length;')
            frame_opened = driver.execute_script('return window.OrbitChrome.openFrame("smoke-frame");')
            assert frame_opened["opened"] == 2
            assert driver.execute_script('return gBrowser.tabs.length;') == frame_before + 1
            driver.execute_script('window.OrbitChrome.openFrame("smoke-frame");')
            assert driver.execute_script('return gBrowser.tabs.length;') == frame_before + 1, "Repeated frame opening duplicated live tabs"
            checks.append("Frame opens and restores real tabs together without duplicating live tabs")
            persisted = driver.execute_script('return JSON.stringify(ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs").SessionStore.getWindowState(window));')
            assert "A native saved note" in persisted and "smoke-connection" in persisted and "smoke-stroke" in persisted
            checks.append("Notes, connections, frames, and drawings persist through native SessionStore")

            open_canvas(driver)
            driver.execute_script('window.OrbitChrome.peek({url: arguments[0]});', script_args=[url + "peek"])
            wait_for(driver, 'return document.getElementById("orbit-peek-browser")?.currentURI.spec === arguments[0];'.replace("arguments[0]", json.dumps(url + "peek")), "native Gecko link preview")
            assert driver.execute_script('return document.getElementById("orbit-peek-browser").getAttribute("type");') == "content"
            driver.execute_script('window.OrbitChrome.closePeek();')
            assert driver.execute_script('return !document.getElementById("orbit-peek-browser");')
            checks.append("Peek uses a real Gecko content browser and closes cleanly")

            split = driver.execute_script('return window.OrbitChrome.split({url: arguments[0]});', script_args=[url + "split"])
            assert split["left"] and split["right"] and split["left"] != split["right"]
            assert driver.execute_script('return gBrowser.selectedTab.splitview?.tabs.length;') == 2
            checks.append("Comparison creates Firefox's native two-tab split view")
            result["passed"] = True
            driver.delete_session()
            driver.cleanup()
            driver = None
    except Exception:
        result["error"] = traceback.format_exc()
        raise
    finally:
        if driver:
            try:
                driver.cleanup()
            except Exception:
                pass
        server.shutdown()
        server.server_close()
        report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()
