#!/usr/bin/env python3
"""Verify native radial menus with trusted Marionette mouse and keyboard input.

Run against the packaged Orbit executable using the Marionette client from the
pinned Firefox source. Fixtures and profiles are temporary; no public website,
extension, simulated DOM input, or direct radial open method is used.
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import tempfile
import threading
import time
import traceback
from urllib.parse import urlsplit

from marionette_driver.by import By
from marionette_driver.keys import Keys
from marionette_driver.marionette import Marionette


ROOT_ID = "orbit-radial-root"
CENTER_ID = "orbit-radial-center"
POINTER_ID = "orbit-radial-smoke-mouse"


class FixturePage(BaseHTTPRequestHandler):
    """Local documents with independently targetable native context types."""

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/image.svg":
            body = (
                '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100">'
                '<rect width="180" height="100" rx="14" fill="#6b5ce7"/>'
                '<text x="20" y="60" fill="white" font-size="22">Gecko image</text>'
                '</svg>'
            ).encode()
            content_type = "image/svg+xml"
        else:
            frame = path == "/frame"
            title = "frame" if frame else path.strip("/") or "fixture"
            iframe = "" if frame else (
                '<iframe id="remote-frame" title="Cross-origin context fixture" '
                f'src="http://localhost:{self.server.server_port}/frame"></iframe>'
            )
            body = (
                '<!doctype html><html><head><meta charset="utf-8">'
                f'<title>Orbit radial {title}</title>'
                '<style>body{margin:0;padding:30px;font:18px system-ui;background:#f8f7fb;color:#252238}'
                'h1{font-size:25px;margin:0 0 20px}main{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:900px}'
                'a,input,textarea,[contenteditable]{display:block;padding:14px;border:1px solid #b8b2ca;border-radius:10px}'
                'a{background:#eae5ff}img{display:block}iframe{width:900px;height:250px;margin-top:24px;border:1px solid #ccc}'
                '#blank-target{height:100px;display:grid;place-items:center;background:#e7efe9;border-radius:10px}'
                '</style></head><body><h1 id="fixture-proof">Real Gecko radial fixture</h1><main>'
                f'<a id="link-target" href="/opened-{ "frame" if frame else "top" }">Open this real link</a>'
                '<div id="blank-target">Page context target</div>'
                '<img id="image-target" alt="Gecko context image" src="/image.svg">'
                '<input id="editable-target" value="Editable native context text">'
                '<div id="selection-target">Select this text with native input</div>'
                '<div id="contenteditable-target" contenteditable="true">Editable document selection</div>'
                f'</main>{iframe}'
                '<script>window.orbitSmokeInputEvents=[];'
                'for(const type of ["mousedown","mouseup","contextmenu","focus","blur","visibilitychange"]){'
                'window.addEventListener(type,event=>{'
                'window.orbitSmokeInputEvents.push({type,time:performance.now(),trusted:event.isTrusted,'
                'button:event.button,buttons:event.buttons,target:event.target.id||event.target.localName,'
                'screenX:event.screenX,screenY:event.screenY,visible:document.visibilityState,focused:document.hasFocus()});'
                'if(window.orbitSmokeInputEvents.length>48)window.orbitSmokeInputEvents.shift();'
                '},true);}</script></body></html>'
            ).encode("utf-8")
            content_type = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def wait_for(driver, script, label, args=(), timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = driver.execute_script(script, script_args=list(args))
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {label}")


def pointer(driver):
    return driver.actions.sequence("pointer", POINTER_ID, {"pointerType": "mouse"})


def key(driver, value):
    driver.actions.sequence("key", "orbit-radial-smoke-key").key_down(value).key_up(value).perform()


def content_point_in_chrome(driver, element):
    """Translate an actual remote document/frame element into widget pixels."""
    point = driver.execute_script('''
        const target = arguments[0];
        target.scrollIntoView({block: "nearest", inline: "nearest"});
        const box = target.getBoundingClientRect();
        const win = target.ownerDocument.defaultView;
        return {screenX: win.mozInnerScreenX + box.x + box.width / 2,
            screenY: win.mozInnerScreenY + box.y + box.height / 2};
    ''', script_args=[element])
    driver.set_context("chrome")
    return driver.execute_script('''
        return {x: Math.round(arguments[0].screenX - window.mozInnerScreenX),
            y: Math.round(arguments[0].screenY - window.mozInnerScreenY)};
    ''', script_args=[point])


def right_down(driver, element):
    point = content_point_in_chrome(driver, element)
    pointer(driver).pointer_move(point["x"], point["y"], origin="viewport").pointer_down(button=2).perform()


def right_up(driver):
    pointer(driver).pointer_up(button=2).perform()


def right_click(driver, element):
    point = content_point_in_chrome(driver, element)
    pointer(driver).pointer_move(point["x"], point["y"], origin="viewport").click(button=2).perform()


def left_click(driver, node_id):
    """Click a live chrome hit point without retaining a replaceable DOM node."""
    point = driver.execute_script('''
        const node = document.getElementById(arguments[0]);
        if (!node) throw new Error("Native chrome action is missing: " + arguments[0]);
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) throw new Error("Native chrome action is hidden: " + arguments[0]);
        return {x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2)};
    ''', script_args=[node_id])
    # Firefox localization and native-menu mutation can refresh the radial
    # between FindElement and PerformActions, replacing its center button.
    # Absolute widget coordinates target the currently rendered native chrome
    # without an element-origin reference becoming stale during deserialization.
    pointer(driver).pointer_move(point["x"], point["y"], origin="viewport").click().perform()


def radial_state(driver):
    """Read actual rendered chrome, including the native fallback popup."""
    return driver.execute_script('''
        const root = document.getElementById(arguments[0]);
        const visible = root && !root.hidden && !root.classList.contains("orbit-radial-leaving") &&
            getComputedStyle(root).display !== "none" &&
            root.getBoundingClientRect().width > 0;
        const items = visible ? [...root.querySelectorAll("[data-orbit-id]")].map(node => {
            const box = node.getBoundingClientRect();
            return {
                id: node.dataset.orbitId, depth: Number(node.dataset.orbitDepth ?? -1),
                label: node.getAttribute("aria-label") || node.textContent.trim(),
                disabled: node.getAttribute("aria-disabled") === "true" || node.disabled,
                submenu: node.getAttribute("aria-haspopup") === "menu",
                parent: node.classList.contains("orbit-radial-parent"),
                active: node.classList.contains("orbit-radial-active"),
                angle: Number(node.dataset.orbitAngle),
                start: Number(node.dataset.orbitStart), end: Number(node.dataset.orbitEnd),
                hitX: Number(node.dataset.orbitX), hitY: Number(node.dataset.orbitY),
                inner: Number(node.dataset.orbitInner), outer: Number(node.dataset.orbitOuter),
                x: box.x, y: box.y, w: box.width, h: box.height,
            };
        }) : [];
        return {
            visible: !!visible, mode: root?.dataset.mode, items,
            center: {x: Number(root?.querySelector("#orbit-radial-menu")?.dataset.orbitCenterX),
                y: Number(root?.querySelector("#orbit-radial-menu")?.dataset.orbitCenterY)},
            rings: visible ? [...root.querySelectorAll(".orbit-radial-ring")].map(ring => ({
                depth: Number(ring.dataset.orbitDepth), fan: ring.classList.contains("orbit-radial-fan"),
                anchor: Number(ring.dataset.orbitAnchor), span: Number(ring.dataset.orbitSpan),
                start: Number(ring.dataset.orbitStart), end: Number(ring.dataset.orbitEnd),
                inner: Number(ring.dataset.orbitInner), outer: Number(ring.dataset.orbitOuter),
            })) : [],
            pagePopup: document.getElementById("contentAreaContextMenu")?.state,
            tabPopup: document.getElementById("tabContextMenu")?.state,
            held: root?.classList.contains("orbit-radial-held"),
            palette: root && getComputedStyle(root).getPropertyValue("--orbit-sector-a").trim(),
            tabs: gBrowser.tabs.length,
        };
    ''', script_args=[ROOT_ID])


def wait_radial(driver, mode):
    wait_for(driver, '''
        const root = document.getElementById(arguments[0]);
        const panel = document.getElementById("orbit-radial-menu");
        return root && !root.hidden && root.dataset.mode === arguments[1] &&
            root.querySelector("[data-orbit-id]") && getComputedStyle(root).display !== "none" &&
            Number(getComputedStyle(panel).opacity) > .99;
    ''', f"native {mode} radial menu", [ROOT_ID, mode])
    state = radial_state(driver)
    assert state["pagePopup"] not in ("open", "showing"), state
    assert state["tabPopup"] not in ("open", "showing"), state
    return state


def dismiss(driver):
    driver.set_context("chrome")
    # Escape first returns from nested rings, then closes the root menu.
    for _ in range(16):
        if not radial_state(driver)["visible"]:
            break
        key(driver, Keys.ESCAPE)
    wait_closed(driver)


def wait_closed(driver):
    wait_for(driver, '''
        const root = document.getElementById(arguments[0]);
        return !root || root.hidden || getComputedStyle(root).display === "none";
    ''', "radial chrome closes and removes its input layer", [ROOT_ID])


def screenshot(driver, folder, name, screenshots):
    driver.set_context("chrome")
    settle_radial(driver)
    path = folder / f"{name}.png"
    path.write_bytes(driver.screenshot(format="binary", full=False))
    screenshots.append(path.name)
    (folder / f"{name}.json").write_text(json.dumps(radial_state(driver), indent=2) + "\n", encoding="utf-8")


def settle_radial(driver):
    # More changes the panel geometry; let its real 180ms transition finish
    # before another physical hit or a screenshot uses the documented point.
    driver.execute_async_script('''
        const complete = arguments[arguments.length - 1];
        window.setTimeout(() => complete(true), 260);
    ''')


def hover_node(driver, node_id):
    """Use the sector's documented hit point; never synthesize DOM events."""
    point = driver.execute_script('''
        const root = document.getElementById(arguments[0]);
        const node = [...root.querySelectorAll("[data-orbit-id]")]
            .find(item => item.dataset.orbitId === arguments[1]);
        if (!node) throw new Error("Radial action is not rendered: " + arguments[1]);
        const box = node.getBoundingClientRect();
        if (node.dataset.orbitX !== undefined && node.dataset.orbitY !== undefined) {
            return {x: Number(node.dataset.orbitX), y: Number(node.dataset.orbitY)};
        }
        return {x: box.x + box.width / 2, y: box.y + box.height / 2};
    ''', script_args=[ROOT_ID, node_id])
    pointer(driver).pointer_move(round(point["x"]), round(point["y"]), duration=25, origin="viewport").perform()
    wait_for(driver, '''
        const root = document.getElementById(arguments[0]);
        return [...root.querySelectorAll(".orbit-radial-active")]
            .some(node => node.dataset.orbitId === arguments[1]);
    ''', "trusted pointer reaches the requested radial sector", [ROOT_ID, node_id])


def find_item(driver, predicate, description):
    """Follow only actual rendered More rings to a requested native node."""
    for _ in range(12):
        state = radial_state(driver)
        matching = [item for item in state["items"] if predicate(item)]
        if matching:
            return matching[-1]
        more = [item for item in state["items"] if item["id"].startswith("orbit-more-")]
        assert more, f"Native node {description!r} missing: {state}"
        deepest = max(more, key=lambda item: item["depth"])
        before = [item["id"] for item in state["items"]]
        hover_node(driver, deepest["id"])
        wait_for(driver, '''
            const root = document.getElementById(arguments[0]);
            return JSON.stringify([...root.querySelectorAll("[data-orbit-id]")].map(node => node.dataset.orbitId)) !== arguments[1];
        ''', "More expands another native action ring", [ROOT_ID, json.dumps(before)])
        settle_radial(driver)
    raise AssertionError(f"Native node {description!r} was not reachable through More")


def find_action(driver, node_id):
    item = find_item(driver, lambda item: item["id"] == node_id, node_id)
    assert not item["disabled"], f"Native command {node_id} is unexpectedly disabled: {item}"
    return item


def activate(driver, node_id):
    hover_node(driver, node_id)
    settle_radial(driver)
    # Hovering a leaf in an older ring can close deeper rings and move the
    # panel. Read its new documented hit point before the actual button click.
    hover_node(driver, node_id)
    pointer(driver).click().perform()


def page_menu(driver, handle, target="link-target", frame=False):
    select_fixture(driver, handle)
    driver.set_context("chrome")
    driver.execute_script('''
        window.orbitSmokePopupHiddenBefore = window.orbitSmokePopupLifecycle?.popuphidden || 0;
    ''')
    driver.set_context("content")
    if frame:
        driver.switch_to_frame(driver.find_element(By.ID, "remote-frame"))
        wait_for(driver, 'return !!document.getElementById("link-target");', "remote frame ready")
    right_click(driver, driver.find_element(By.ID, target))
    driver.set_context("chrome")
    return wait_radial(driver, "context")


def assert_context_cleanup(driver):
    wait_closed(driver)
    wait_for(driver, '''
        return window.orbitSmokePopupLifecycle.popuphidden > window.orbitSmokePopupHiddenBefore &&
            !window.gContextMenu;
    ''', "native popuphidden cleanup clears the original Firefox context object")
    state = radial_state(driver)
    assert state["pagePopup"] not in ("open", "showing"), state


def assert_tab_release_cleanup(driver):
    """Allow the native release/context message to arrive before checking it."""
    wait_closed(driver)
    settle_radial(driver)
    state = radial_state(driver)
    assert not state["visible"], state
    assert state["pagePopup"] not in ("open", "showing"), state
    assert state["tabPopup"] not in ("open", "showing"), state


def held_tabs(driver, handle):
    select_fixture(driver, handle)
    right_down(driver, driver.find_element(By.ID, "blank-target"))
    driver.set_context("chrome")
    state = wait_radial(driver, "tabs")
    assert state["held"], "The held wheel must appear before releasing the right button"
    return state


def assert_max_eight(driver):
    rings = {}
    for item in radial_state(driver)["items"]:
        if item["depth"] >= 0:
            rings.setdefault(item["depth"], set()).add(item["id"])
    assert rings and all(len(items) <= 8 for items in rings.values()), rings
    return {str(depth): sorted(items) for depth, items in rings.items()}


def assert_parent_fans(driver):
    """Verify the packaged SVG matches its real parent and hit coordinates."""
    state = radial_state(driver)
    assert state["rings"] and not state["rings"][0]["fan"], state
    assert math.isclose(state["rings"][0]["span"], math.tau, abs_tol=0.0001), state
    fans = [ring for ring in state["rings"] if ring["fan"]]
    assert fans, f"No child fan rendered: {state}"
    for ring in fans:
        parent = next(item for item in state["items"]
                      if item["parent"] and item["depth"] == ring["depth"] - 1)
        assert math.isclose(ring["anchor"], parent["angle"], abs_tol=0.0001), (ring, parent)
        assert 0 < ring["span"] <= math.radians(160) + 0.0001, ring
        assert math.isclose((ring["start"] + ring["end"]) / 2,
                            parent["angle"], abs_tol=0.0001), (ring, parent)
        children = [item for item in state["items"] if item["depth"] == ring["depth"]]
        assert children, ring
        for item in children:
            distance = math.hypot(item["hitX"] - state["center"]["x"],
                                  item["hitY"] - state["center"]["y"])
            assert ring["inner"] < distance < ring["outer"], (ring, item)
            delta = math.atan2(math.sin(item["angle"] - parent["angle"]),
                               math.cos(item["angle"] - parent["angle"]))
            assert abs(delta) <= ring["span"] / 2 + 0.0001, (ring, item)
    return state


def blank_fan_point(driver, held=False):
    state = assert_parent_fans(driver)
    ring = state["rings"][-1]
    radius = (ring["inner"] + ring["outer"]) / 2
    browser = driver.execute_script('''
        const box = gBrowser.selectedBrowser.getBoundingClientRect();
        return {left: box.left, right: box.right, top: box.top, bottom: box.bottom};
    ''')
    # A held release needs a real content target for Firefox's ContextMenu
    # actor. Keep the blank test point within the selected browser, even when
    # deep menu clamping positions part of its circumference above the page.
    point = None
    for offset in (0, -.3, .3, -.6, .6, -.9, .9, -1.2, 1.2):
        angle = ring["anchor"] + math.pi + offset
        candidate = {"x": round(state["center"]["x"] + math.cos(angle) * radius),
                     "y": round(state["center"]["y"] + math.sin(angle) * radius)}
        if (browser["left"] + 12 < candidate["x"] < browser["right"] - 12 and
                browser["top"] + 12 < candidate["y"] < browser["bottom"] - 12):
            point = candidate
            break
    assert point, (state, browser)
    hit = driver.execute_script('''
        const node = document.elementFromPoint(arguments[0].x, arguments[0].y);
        return {root: !!node?.closest("#orbit-radial-root"),
            command: node?.closest("[data-orbit-id]")?.dataset.orbitId,
            tag: node?.localName, id: node?.id};
    ''', script_args=[point])
    assert not hit["root"] and not hit.get("command"), (point, hit, state)
    # While held, the whole radial is correctly pointer transparent. Geometry
    # above identifies the blank arc; native hit testing still targets content.
    if held:
        assert hit["tag"] == "browser", (point, hit, state)
    return point


def select_fixture(driver, handle):
    driver.set_context("content")
    driver.switch_to_window(handle)
    driver.switch_to_frame()
    fixture_uri = driver.execute_script("return location.href;")
    # Marionette selectTab waits for TabSelect, not the async native browser
    # switch. Its already-loaded document can exist while the widget still
    # displays the old tab. Wait for the selected layers and actual focus
    # before a new trusted gesture; do not retry an unsuccessful gesture.
    driver.set_context("chrome")
    wait_for(driver, '''
        const switcher = gBrowser._switcher;
        return gBrowser.selectedBrowser.currentURI.spec === arguments[0] &&
            (!switcher || (!switcher.switchInProgress &&
                switcher.visibleTab === gBrowser.selectedTab && switcher.switchPaintId === -1));
    ''', "selected native browser finishes its tab switch", [fixture_uri])
    driver.set_context("content")
    wait_for(driver, '''
        return !!document.getElementById("fixture-proof") &&
            document.visibilityState === "visible";
    ''', "fixture tab is visible")
    # Marionette's browser.focus() runs after TabSelect, before the async tab
    # switch can finish adjusting focus. Establish focus with one real primary
    # click on an inert target after the visible browser is ready
    # before the tested right-button gesture. Keep existing focused fields and
    # selections intact when the content document already has focus.
    if not driver.execute_script("return document.hasFocus();"):
        point = content_point_in_chrome(driver, driver.find_element(By.ID, "blank-target"))
        pointer(driver).pointer_move(point["x"], point["y"], origin="viewport").click().perform()
        driver.set_context("content")
    wait_for(driver, "return document.hasFocus();", "trusted setup click focuses the visible fixture")


def set_theme(driver, dark):
    driver.set_context("chrome")
    response = driver.execute_async_script('''
        const complete = arguments[arguments.length - 1];
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        AddonManager.getAddonByID(arguments[0]).then(addon => {
            if (!addon) throw new Error("Packaged Firefox theme missing");
            return addon.enable();
        }).then(() => complete(true), error => complete({error: String(error)}));
    ''', script_args=[f'firefox-compact-{"dark" if dark else "light"}@mozilla.org'])
    assert response is True, response


CLIPBOARD_SCRIPT = '''
    try {
        const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
        transferable.init(null);
        transferable.addDataFlavor("text/plain");
        Services.clipboard.getData(transferable, Services.clipboard.kGlobalClipboard);
        const text = {};
        transferable.getTransferData("text/plain", text);
        return text.value.QueryInterface(Ci.nsISupportsString).data;
    } catch (_) { return ""; }
'''


def wait_clipboard(driver, expected):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        actual = driver.execute_script(CLIPBOARD_SCRIPT)
        if actual == expected:
            return actual
        time.sleep(0.1)
    raise AssertionError(f"Native clipboard mismatch: {actual!r}; expected {expected!r}")


def native_tab_count(driver):
    return driver.execute_script("return gBrowser.tabs.length;")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--report", type=Path, default=Path("test-results/radial.json"))
    args = parser.parse_args()
    report = args.report.resolve()
    report.parent.mkdir(parents=True, exist_ok=True)
    result = {"binary": str(args.binary.resolve()), "passed": False, "checks": [], "screenshots": []}
    driver = None
    workspace_context = tempfile.TemporaryDirectory(prefix="orbit-native-radial-")
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixturePage)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/"
    try:
        driver = Marionette(
            bin=str(args.binary.resolve()), app="fxdesktop", port=0,
            headless=True, startup_timeout=90, socket_timeout=60,
            workspace=workspace_context.name, gecko_log=str(report.parent / "radial-gecko.log"),
            app_args=["-no-remote", "--remote-allow-system-access"],
            prefs={
                "browser.startup.page": 0, "browser.startup.homepage": "about:blank",
                # Actions state belongs to a BrowsingContext (driver.sys.mjs
                # 268); down in content and up in chrome silently drops up.
                # Exact-pin async dispatch (driver.sys.mjs171-184,
                # Actions.sys.mjs1661) uses the topChromeWindow native widget
                # for actual remote content/chrome hit testing. Keep every
                # pointer action in that ONE chrome context instead.
                "remote.events.async.mouse.enabled": True,
            },
        )
        driver.start_session()
        driver.set_window_rect(width=1400, height=1000)
        driver.set_context("content")
        driver.navigate(url)
        handle = driver.current_window_handle
        wait_for(driver, 'return !!document.getElementById("fixture-proof");', "real Gecko fixture")
        driver.set_context("chrome")
        wait_for(driver, 'return !!window.gBrowserInit?.delayedStartupFinished && !!window.OrbitChrome;', "native Orbit startup")
        assert driver.execute_script('''
            return Services.prefs.getBoolPref("remote.events.async.mouse.enabled", false);
        '''), "Trusted pointer input must use Firefox's native async widget dispatch"
        run_checks(driver, handle, url, result, report.parent)
        result["passed"] = True
        driver.actions.release()
        driver.delete_session()
        driver.cleanup()
        driver = None
    except Exception:
        result["error"] = traceback.format_exc()
        if driver:
            try:
                driver.set_context("chrome")
                result["failure_state"] = radial_state(driver)
                screenshot(driver, report.parent, "radial-failure", result["screenshots"])
                result["failure_native_browser"] = driver.execute_script('''
                    const switcher = gBrowser._switcher;
                    return {selectedURI: gBrowser.selectedBrowser.currentURI.spec,
                        selectedTab: gBrowser.selectedTab.label, activeWindow: Services.focus.activeWindow === window,
                        activeElement: document.activeElement?.localName, activeElementId: document.activeElement?.id,
                        focusedElement: Services.focus.focusedElement?.localName,
                        focusedElementId: Services.focus.focusedElement?.id,
                        switching: switcher?.switchInProgress, paintId: switcher?.switchPaintId,
                        visibleTab: switcher?.visibleTab?.label, requestedTab: switcher?.requestedTab?.label};
                ''')
                driver.set_context("content")
                driver.switch_to_frame()
                result["failure_content_input"] = driver.execute_script('''
                    return {uri: location.href, visible: document.visibilityState, focused: document.hasFocus(),
                        activeElement: document.activeElement?.localName, activeElementId: document.activeElement?.id,
                        screenX: window.mozInnerScreenX, screenY: window.mozInnerScreenY,
                        events: window.orbitSmokeInputEvents || []};
                ''')
            except Exception:
                result["capture_error"] = traceback.format_exc()
        raise
    finally:
        if driver:
            try:
                driver.set_context("chrome")
                driver.actions.release()
            except Exception:
                result["input_cleanup_error"] = traceback.format_exc()
            try:
                driver.cleanup()
            except Exception:
                result["browser_cleanup_error"] = traceback.format_exc()
        # Stop Firefox before deleting its live profile. Previously the with
        # block deleted cache files before this finally ran on a failed check,
        # so WinError 32 replaced the useful assertion traceback.
        try:
            workspace_context.cleanup()
        except Exception:
            result["workspace_cleanup_error"] = traceback.format_exc()
        server.shutdown()
        server.server_close()
        report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2), flush=True)


def run_checks(driver, handle, url, result, folder):
    checks = result["checks"]
    driver.execute_script('''
        window.orbitSmokePopupLifecycle = {popupshowing: 0, popuphiding: 0, popuphidden: 0};
        const popup = document.getElementById("contentAreaContextMenu");
        for (const name of Object.keys(window.orbitSmokePopupLifecycle)) {
            popup.addEventListener(name, () => window.orbitSmokePopupLifecycle[name]++);
        }
    ''')

    # Native widget hit testing targets the actual remote content document.
    # The held tab wheel must not steal the target from ContextMenuChild.
    for dark in (True, False):
        set_theme(driver, dark)
        state = page_menu(driver, handle)
        assert not state["held"], state
        find_action(driver, "context-copylink")
        assert_max_eight(driver)
        screenshot(driver, folder, f'radial-context-{"dark" if dark else "light"}', result["screenshots"])
        dismiss(driver)
        assert_context_cleanup(driver)
    checks.append("Trusted webpage right-click opens the native Context radial in Firefox dark and light themes")

    page_menu(driver, handle)
    before = native_tab_count(driver)
    expected = url + "opened-top"
    left_click(driver, CENTER_ID)
    wait_for(driver, "return gBrowser.tabs.length === arguments[0] + 1;", "context center creates one native tab", [before])
    wait_for(driver, "return [...gBrowser.tabs].some(tab => tab.linkedBrowser.currentURI.spec === arguments[0]);", "context center loads the real link", [expected])
    assert_context_cleanup(driver)
    checks.append("Context center opens its actual HTTP link in a real Firefox tab")

    page_menu(driver, handle)
    find_action(driver, "context-copylink")
    before = native_tab_count(driver)
    activate(driver, "context-copylink")
    wait_clipboard(driver, expected)
    assert_context_cleanup(driver)
    assert native_tab_count(driver) == before
    checks.append("Native Copy Link command writes the real target to Firefox's clipboard")

    page_menu(driver, handle, "image-target")
    find_action(driver, "context-copyimage")
    activate(driver, "context-copyimage")
    wait_clipboard(driver, url + "image.svg")
    assert_context_cleanup(driver)
    checks.append("Native image context preserves and executes Copy Image Link")

    page_menu(driver, handle, "editable-target")
    find_action(driver, "context-selectall")
    activate(driver, "context-selectall")
    assert_context_cleanup(driver)
    select_fixture(driver, handle)
    selection = driver.execute_script('''
        const field = document.getElementById("editable-target");
        return {start: field.selectionStart, end: field.selectionEnd, length: field.value.length};
    ''')
    assert selection["start"] == 0 and selection["end"] == selection["length"], selection
    page_menu(driver, handle, "editable-target")
    find_action(driver, "context-copy")
    activate(driver, "context-copy")
    wait_clipboard(driver, "Editable native context text")
    assert_context_cleanup(driver)
    checks.append("Native editable Select All and Copy keep the correct focused content field")

    page_menu(driver, handle, frame=True)
    find_action(driver, "context-copylink")
    activate(driver, "context-copylink")
    iframe_link = url.replace("127.0.0.1", "localhost") + "opened-frame"
    wait_clipboard(driver, iframe_link)
    assert_context_cleanup(driver)
    page_menu(driver, handle, frame=True)
    left_click(driver, CENTER_ID)
    wait_for(driver, "return [...gBrowser.tabs].some(tab => tab.linkedBrowser.currentURI.spec === arguments[0]);", "remote-frame link opens in a real native tab", [iframe_link])
    assert_context_cleanup(driver)
    checks.append("Remote iframe right-click preserves actor ownership for clipboard and native tab commands")

    page_menu(driver, handle, frame=True)
    frame_branch = find_action(driver, "frame")
    assert frame_branch["submenu"], "Firefox's native Frame menu was flattened or dropped"
    count_before = native_tab_count(driver)
    selected_before = driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;")
    hover_node(driver, "frame")
    wait_for(driver, '''
        return [...document.getElementById(arguments[0]).querySelectorAll("[data-orbit-id]")]
            .some(node => node.dataset.orbitId === "context-openframeintab");
    ''', "hovering Firefox's Frame branch opens its native commands", [ROOT_ID])
    settle_radial(driver)
    find_action(driver, "context-viewframesource")
    hover_node(driver, "context-viewframesource")
    assert native_tab_count(driver) == count_before, "Hovering a native submenu fired a tab command"
    assert driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;") == selected_before
    rings = assert_max_eight(driver)
    assert max(map(int, rings)) >= 1, "Native submenu did not form an outer ring"
    assert_parent_fans(driver)
    screenshot(driver, folder, "radial-context-native-frame", result["screenshots"])
    find_action(driver, "context-openframeintab")
    activate(driver, "context-openframeintab")
    wait_for(driver, "return gBrowser.tabs.length === arguments[0] + 1;", "native Frame command creates one real tab", [count_before])
    wait_for(driver, "return [...gBrowser.tabs].some(tab => tab.linkedBrowser.currentURI.spec === arguments[0]);", "native Frame command loads its actual remote document", [url.replace("127.0.0.1", "localhost") + "frame"])
    assert_context_cleanup(driver)
    checks.append("Firefox's real Frame submenu expands on hover, preserves its native overflow, and opens the frame through its original command")

    # Real native pages/groups produce More chains at the root and within a
    # group. Every subtree comes from Firefox's current gBrowser model.
    driver.set_context("chrome")
    fixture = driver.execute_script('''
        const colors = ["blue", "purple", "cyan", "orange", "yellow", "pink", "green", "gray", "red"];
        const groups = [];
        const tabs = [];
        for (let index = 0; index < 10; index++) {
            const members = [];
            const count = index === 9 ? 12 : 1;
            for (let leaf = 0; leaf < count; leaf++) {
                const suffix = "group-" + (index + 1) + "-tab-" + (leaf + 1);
                const tab = gBrowser.addWebTab(arguments[0] + suffix, {
                    inBackground: true, skipAnimation: true, bulkOrderedOpen: true,
                });
                members.push(tab);
                tabs.push(tab);
            }
            const group = gBrowser.addTabGroup(members, {
                id: "orbit-smoke-group-" + index,
                label: "Orbit Native Group " + (index + 1),
                color: colors[index % colors.length], insertBefore: members[0],
            });
            if (index === 9) group.collapsed = true;
            groups.push(group);
        }
        const internal = gBrowser.addTrustedTab("about:preferences", {inBackground: true, skipAnimation: true});
        internal.label = "Orbit Internal Preferences";
        groups[9].addTabs([internal]);
        const switchTarget = gBrowser.addWebTab(arguments[0] + "tab-switch-target", {
            inBackground: true, skipAnimation: true,
        });
        window.orbitSmokeNativeGroups = groups;
        window.orbitSmokeNativeTabs = tabs;
        window.orbitSmokeSwitchTarget = switchTarget;
        window.orbitSmokeInternalTab = internal;
        return {groups: groups.length, collapsed: groups[9].collapsed, totalTabs: gBrowser.tabs.length};
    ''', script_args=[url])
    assert fixture["groups"] == 10 and fixture["collapsed"], fixture
    wait_for(driver, '''
        return window.orbitSmokeNativeTabs.every(tab =>
            tab.label === "Orbit radial " + tab.linkedBrowser.currentURI.spec.split("/").pop()) &&
            window.orbitSmokeSwitchTarget.label === "Orbit radial tab-switch-target";
    ''', "real grouped tab fixture titles", timeout=45)

    for dark in (True, False):
        set_theme(driver, dark)
        state = held_tabs(driver, handle)
        before = native_tab_count(driver)
        selected_before = driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;")
        group = find_item(driver, lambda item: "Orbit Native Group 10" in item["label"], "last actual native group")
        hover_node(driver, group["id"])
        wait_for(driver, '''
            return [...document.getElementById(arguments[0]).querySelectorAll("[data-orbit-id]")]
                .some(node => node.textContent.includes("group-10-tab-"));
        ''', "hovering native group opens its tab ring", [ROOT_ID])
        leaf = find_item(driver, lambda item: "group-10-tab-12" in item["label"], "last tab in native collapsed group")
        hover_node(driver, leaf["id"])
        assert native_tab_count(driver) == before
        assert driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;") == selected_before, "Hovering switched the selected tab"
        rings = assert_max_eight(driver)
        assert max(map(int, rings)) >= 2, f"Native groups and More did not form three rings: {rings}"
        assert_parent_fans(driver)
        screenshot(driver, folder, f'radial-tabs-nested-{"dark" if dark else "light"}', result["screenshots"])
        right_up(driver)
        wait_for(driver, "return gBrowser.selectedBrowser.currentURI.spec === arguments[0];", "held release selects actual grouped tab", [url + "group-10-tab-12"])
        assert_tab_release_cleanup(driver)
        assert driver.execute_script('''
            const tab = gBrowser.selectedTab;
            const box = tab.getBoundingClientRect();
            return !tab.hidden && box.width > 0 && box.height > 0;
        '''), "Selecting a collapsed group's tab did not reveal the real native tab"
        driver.execute_script("window.orbitSmokeNativeGroups[9].collapsed = true;")
    checks.append("RMB-down displays Tabs immediately; actual collapsed groups and More expand to three rings with at most eight choices per ring")
    checks.append("Hover never activates; RMB release over a nested leaf selects and reveals the real native tab")
    checks.append("Native Frame, tab groups, and recursive More submenus fan out symmetrically from their actual parent within 160 degrees")

    held_tabs(driver, handle)
    group = find_item(driver, lambda item: "Orbit Native Group 10" in item["label"], "native group for blank fan release")
    hover_node(driver, group["id"])
    wait_for(driver, '''
        return [...document.getElementById(arguments[0]).querySelectorAll("[data-orbit-id]")]
            .some(node => node.textContent.includes("group-10-tab-"));
    ''', "native group fan opens before testing its blank arc", [ROOT_ID])
    leaf = find_item(driver, lambda item: "group-10-tab-12" in item["label"], "nested leaf before blank fan release")
    hover_node(driver, leaf["id"])
    settle_radial(driver)
    point = blank_fan_point(driver, held=True)
    selected_before = driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;")
    before = native_tab_count(driver)
    pointer(driver).pointer_move(point["x"], point["y"], duration=25, origin="viewport").perform()
    right_up(driver)
    wait_radial(driver, "context")
    assert driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;") == selected_before
    assert native_tab_count(driver) == before, "Blank fan release activated a hidden or previously hovered tab"
    dismiss(driver)
    assert_context_cleanup(driver)
    checks.append("Releasing RMB in a blank outer-fan arc keeps the selected tab and opens page actions without activating the previous leaf")

    held_tabs(driver, handle)
    target = find_item(driver, lambda item: "tab-switch-target" in item["label"], "ungrouped real native tab")
    hover_node(driver, target["id"])
    right_up(driver)
    wait_for(driver, "return gBrowser.selectedBrowser.currentURI.spec === arguments[0];", "held release selects ungrouped tab", [url + "tab-switch-target"])
    assert_tab_release_cleanup(driver)
    checks.append("Ungrouped real Firefox tabs remain reachable through the same held gesture")

    held_tabs(driver, handle)
    group = find_item(driver, lambda item: "Orbit Native Group 10" in item["label"], "native group containing Firefox settings")
    hover_node(driver, group["id"])
    wait_for(driver, '''
        return [...document.getElementById(arguments[0]).querySelectorAll("[data-orbit-id]")]
            .some(node => node.textContent.includes("group-10-tab-"));
    ''', "native group opens again", [ROOT_ID])
    internal_label = driver.execute_script("return window.orbitSmokeInternalTab.label;")
    internal = find_item(driver, lambda item: item["label"] == internal_label, "actual Firefox settings tab")
    hover_node(driver, internal["id"])
    right_up(driver)
    wait_for(driver, "return gBrowser.selectedTab === window.orbitSmokeInternalTab && gBrowser.selectedBrowser.currentURI.spec === 'about:preferences';", "held release reaches Firefox's internal settings page")
    assert_tab_release_cleanup(driver)
    checks.append("Native internal Firefox pages remain in collapsed group rings and can be selected")

    # The menu's own hierarchy must preserve native overflow branches rather
    # than discard everything after the first ring.
    state = page_menu(driver, handle, "blank-target")
    more = [item for item in state["items"] if item["id"].startswith("orbit-more-")]
    assert more, f"Page context did not preserve its native overflow actions: {state}"
    hover_node(driver, more[0]["id"])
    wait_for(driver, '''
        return [...document.getElementById(arguments[0]).querySelectorAll("[data-orbit-depth]")]
            .some(node => Number(node.dataset.orbitDepth) >= 1);
    ''', "native Context overflow forms a second ring", [ROOT_ID])
    assert_max_eight(driver)
    assert_parent_fans(driver)
    settle_radial(driver)
    screenshot(driver, folder, "radial-context-actions", result["screenshots"])
    point = blank_fan_point(driver)
    before = native_tab_count(driver)
    clipboard_before = driver.execute_script(CLIPBOARD_SCRIPT)
    pointer(driver).pointer_move(point["x"], point["y"], origin="viewport").click().perform()
    assert_context_cleanup(driver)
    assert native_tab_count(driver) == before, "Clicking blank fan space executed an unrelated tab command"
    assert driver.execute_script(CLIPBOARD_SCRIPT) == clipboard_before, "Clicking blank fan space executed an unrelated copy command"
    checks.append("Native page action overflow remains reachable in a second Context ring")
    checks.append("Empty outer-fan arcs pass native SVG hit testing to the page and a trusted outside click dismisses the radial")

    page_menu(driver, handle)
    key(driver, Keys.ESCAPE)
    assert_context_cleanup(driver)
    page_menu(driver, handle)
    # A real navigation-bar click lies outside the content wheel.
    left_click(driver, "urlbar-input")
    assert_context_cleanup(driver)
    checks.append("Escape and a trusted outside click dismiss the native radial without a fallback popup")
    result["final_state"] = radial_state(driver)
    result["native_popup_lifecycle"] = driver.execute_script("return window.orbitSmokePopupLifecycle;")


if __name__ == "__main__":
    main()
