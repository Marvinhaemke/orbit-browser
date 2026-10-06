#!/usr/bin/env python3
"""Verify Orbit commands, focus mode, and canvas capture in native Firefox.

Fixture tabs and the board are seeded through the existing privileged bridge;
every new interaction uses trusted keyboard or native-widget pointer input.
Run with the Marionette client from the pinned Firefox source.
"""

from __future__ import annotations

import argparse
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import traceback

from marionette_driver.by import By
from marionette_driver.keys import Keys
from marionette_driver.marionette import Marionette

from smoke_radial import (
    FixturePage, ROOT_ID, activate, assert_context_cleanup, assert_parent_fans,
    dismiss, find_action, hover_node, left_click, page_menu, pointer, radial_state,
    select_fixture, settle_radial, wait_for,
)
from smoke_test import canvas_shortcut, chord, native_canvas_ready, new_handle, open_canvas


def initialize_bridge(driver):
    """The existing bridge requires its real, loaded canvas document."""
    driver.set_context("chrome")
    open_canvas(driver)
    wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame")?.contentDocument;
        return doc?.readyState === "complete" && doc.getElementById("save-status")?.textContent !== "Loading workspace…";
    ''', "the guarded native overlay document finishes loading")
    canvas_shortcut(driver)
    wait_for(driver, 'return document.getElementById("orbit-canvas-overlay").hidden;', "physical canvas shortcut restores the website")


def palette_state(driver):
    return driver.execute_script('''
        const palette = document.getElementById("orbit-command-palette");
        const input = document.getElementById("orbit-command-input");
        return {visible: !!palette && !palette.hidden && getComputedStyle(palette).display !== "none",
            focused: document.activeElement === input, query: input?.value,
            active: document.activeElement?.id,
            rows: [...document.querySelectorAll("#orbit-command-results [data-orbit-command-id]")]
                .map(row => ({id: row.dataset.orbitCommandId, label: row.textContent,
                    selected: row.getAttribute("aria-selected") === "true"})),
            empty: !document.getElementById("orbit-command-empty")?.hidden};
    ''')


def open_palette(driver, toolbar=False):
    driver.set_context("chrome")
    assert not palette_state(driver)["visible"], "Palette should start closed"
    if toolbar:
        left_click(driver, "orbit-command-button")
    else:
        chord(driver, Keys.CONTROL, Keys.SHIFT, " ")
    wait_for(driver, '''
        const palette = document.getElementById("orbit-command-palette");
        return !palette.hidden && document.activeElement === document.getElementById("orbit-command-input");
    ''', "trusted shortcut or toolbar opens and focuses Orbit commands")


def search(driver, query, expected_id=None):
    field = driver.find_element(By.ID, "orbit-command-input")
    field.send_keys(query)
    wait_for(driver, '''
        const input = document.getElementById("orbit-command-input");
        const rows = [...document.querySelectorAll("#orbit-command-results [data-orbit-command-id]")];
        return input.value === arguments[0] && (arguments[1] === null ||
            rows.some(row => row.dataset.orbitCommandId === arguments[1]));
    ''', "trusted typed search refreshes the native command results", [query, expected_id])
    return palette_state(driver)


def palette_closed(driver):
    wait_for(driver, 'return document.getElementById("orbit-command-palette").hidden;', "Orbit commands close")


def screenshot(driver, folder, name, result):
    driver.set_context("chrome")
    settle_radial(driver)
    (folder / f"{name}.png").write_bytes(driver.screenshot(format="binary", full=False))
    result["screenshots"].append(f"{name}.png")


def capture(driver, handle, kind, target="blank-target"):
    page_menu(driver, handle, target)
    find_action(driver, "orbit-send-to-canvas")
    hover_node(driver, "orbit-send-to-canvas")
    wait_for(driver, '''
        return !!document.querySelector('[data-orbit-id="' + arguments[0] + '"]');
    ''', "hover fans out actual native canvas capture actions", [f"orbit-canvas-{kind}"])
    settle_radial(driver)
    assert_parent_fans(driver)
    find_action(driver, f"orbit-canvas-{kind}")
    activate(driver, f"orbit-canvas-{kind}")
    assert_context_cleanup(driver)


def board(driver):
    return driver.execute_script("return window.OrbitChrome.getBoard();")


def focus_state(driver):
    return driver.execute_script('''
        const root = document.documentElement;
        const toolbox = document.getElementById("navigator-toolbox");
        const chip = document.getElementById("orbit-focus-chip");
        const box = toolbox.getBoundingClientRect();
        const chipBox = chip.getBoundingClientRect();
        const address = document.getElementById("urlbar-container");
        const tabs = document.getElementById("tabbrowser-tabs");
        return {enabled: root.getAttribute("data-orbit-focus") === "true",
            revealed: root.getAttribute("data-orbit-focus-reveal") === "true",
            chipVisible: !chip.hidden && chipBox.width > 0 && chipBox.height > 0,
            toolboxTop: box.top, toolboxBottom: box.bottom,
            addressVisibility: getComputedStyle(address).visibility,
            tabVisibility: getComputedStyle(tabs).visibility,
            focusedAddress: gURLBar.focused};
    ''')


def force_default_theme(driver, dark):
    driver.execute_script('Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[0]);',
                          script_args=[1 if dark else 0])
    wait_for(driver, '''
        return document.documentElement.dataset.orbitTheme === "default" &&
            window.matchMedia("(prefers-color-scheme: dark)").matches === arguments[0] &&
            getComputedStyle(document.documentElement).getPropertyValue("--orbit-chrome-base").trim() === arguments[1];
    ''', "default native Orbit colors finish painting", [dark, "#151b2c" if dark else "#e9eef5"])


def run_checks(driver, handle, url, result, folder):
    checks = result["checks"]
    initialize_bridge(driver)
    driver.execute_script('''
        window.orbitSmokePopupLifecycle = {popupshowing: 0, popuphiding: 0, popuphidden: 0};
        const popup = document.getElementById("contentAreaContextMenu");
        for (const name of Object.keys(window.orbitSmokePopupLifecycle))
            popup.addEventListener(name, () => window.orbitSmokePopupLifecycle[name]++);
    ''')
    fixture = driver.execute_script('''
        const one = window.OrbitChrome.openTab({url: arguments[0] + "alpha", background: true});
        const two = window.OrbitChrome.openTab({url: arguments[0] + "beta", background: true});
        return {one, two};
    ''', script_args=[url])
    wait_for(driver, '''
        return [...gBrowser.tabs].filter(tab => [arguments[0] + "alpha", arguments[0] + "beta"]
            .includes(tab.linkedBrowser.currentURI.spec)).every(tab => tab.label.startsWith("Orbit radial")) &&
            [...gBrowser.tabs].filter(tab => [arguments[0] + "alpha", arguments[0] + "beta"]
            .includes(tab.linkedBrowser.currentURI.spec)).length === 2;
    ''', "two real HTTP tabs render for command search", [url])
    driver.execute_script('''
        const alpha = [...gBrowser.tabs].find(tab => tab.linkedBrowser.currentURI.spec === arguments[0] + "alpha");
        const group = gBrowser.addTabGroup([alpha], {label: "Liquid research", color: "cyan"});
        group.collapsed = true;
        window.orbitUXGroup = group;
    ''', script_args=[url])
    seeded = {
        "version": 1, "camera": {"x": 68, "y": 78, "zoom": 1},
        "frames": [{"id": "ux-frame", "title": "Orbital reading room", "color": "#70ded3",
                    "x": 0, "y": 0, "w": 900, "h": 500}],
        "items": [
            {"id": "ux-alpha", "type": "tab", "frameId": "ux-frame", "tabId": fixture["one"]["id"],
             "title": "Existing alpha", "url": url + "alpha", "userContextId": 0,
             "x": 40, "y": 70, "w": 248, "h": 160},
            {"id": "ux-restored", "type": "tab", "frameId": "ux-frame", "title": "Restore reading page",
             "url": url + "frame-restore", "userContextId": 0, "x": 350, "y": 70, "w": 248, "h": 160},
        ], "connections": [], "strokes": [],
    }
    driver.execute_script("return window.OrbitChrome.saveBoard(arguments[0]);", script_args=[seeded])

    before_tabs = driver.execute_script("return gBrowser.tabs.length;")
    before_board = board(driver)
    page_menu(driver, handle, "link-target")
    open_palette(driver)
    wait_for(driver, '''
        const radial = document.getElementById("orbit-radial-root");
        return (!radial || radial.hidden || getComputedStyle(radial).display === "none") && !window.gContextMenu;
    ''', "opening commands removes the radial input layer and cleans up Firefox's native context")
    assert driver.execute_script("return gBrowser.tabs.length;") == before_tabs
    assert board(driver) == before_board
    chord(driver, Keys.ESCAPE)
    palette_closed(driver)
    checks.append("Opening commands while a webpage radial is visible closes its native context without activating a tab or capture")

    chord(driver, Keys.CONTROL, "l")
    assert driver.execute_script("return gURLBar.focused;")
    open_palette(driver)
    search(driver, "orbit-ux-no-such-match-849201")
    wait_for(driver, '''return !document.querySelector("#orbit-command-results button") &&
        !document.getElementById("orbit-command-empty").hidden;''', "empty command search stays local")
    before = driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;")
    chord(driver, Keys.ENTER)
    assert palette_state(driver)["visible"] and driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;") == before
    chord(driver, Keys.ESCAPE)
    palette_closed(driver)
    assert driver.execute_script("return gURLBar.focused;"), "Escape should restore the previous URL-bar focus"
    checks.append("Trusted command shortcut, local empty search, and Escape preserve the page and restore native focus")

    open_palette(driver, toolbar=True)
    initial = palette_state(driver)
    assert len(initial["rows"]) >= 6 and initial["rows"][0]["selected"], initial
    chord(driver, Keys.ARROW_DOWN)
    assert palette_state(driver)["rows"][1]["selected"]
    chord(driver, Keys.ARROW_UP)
    assert palette_state(driver)["rows"][0]["selected"]
    chord(driver, Keys.TAB)
    assert palette_state(driver)["active"] == "orbit-command-close"
    chord(driver, Keys.TAB)
    assert palette_state(driver)["focused"]
    chord(driver, Keys.ESCAPE)
    palette_closed(driver)
    checks.append("The native toolbar command button, arrow navigation, and keyboard focus loop work")

    open_palette(driver)
    state = search(driver, "liquid research alpha")
    assert len(state["rows"]) == 1 and state["rows"][0]["id"].startswith("tab:"), state
    chord(driver, Keys.ENTER)
    palette_closed(driver)
    wait_for(driver, '''return gBrowser.selectedBrowser.currentURI.spec === arguments[0] &&
        !window.orbitUXGroup.collapsed;''', "search selects the real tab and expands its collapsed native group", [url + "alpha"])
    checks.append("Searching tab titles and native group names selects the actual tab and expands a collapsed group")

    count = driver.execute_script("return gBrowser.tabs.length;")
    for attempt in range(2):
        open_palette(driver)
        state = search(driver, "orbital reading room", "frame:ux-frame")
        assert len(state["rows"]) == 1, state
        chord(driver, Keys.ENTER)
        palette_closed(driver)
        wait_for(driver, '''return [...gBrowser.tabs].some(tab => tab.linkedBrowser.currentURI.spec === arguments[0]);''',
                 "frame command restores its missing native HTTP tab", [url + "frame-restore"])
        assert driver.execute_script("return gBrowser.tabs.length;") == count + 1, "Frame command duplicated existing live tabs"
    checks.append("Frame search opens its real tabs together and repeated activation preserves live tab identities")

    old_handles = set(driver.window_handles)
    open_palette(driver)
    state = search(driver, "new tab", "action:new-tab")
    assert len(state["rows"]) == 1, state
    chord(driver, Keys.ENTER)
    canvas = new_handle(driver, old_handles, "New tab command")
    native_canvas_ready(driver)
    assert driver.execute_script("return gURLBar.focused && !gURLBar.value;"), "Command New Tab lost the native empty address focus"
    driver.switch_to_window(canvas, focus=False)
    checks.append("The New tab command opens a real canvas tab with an empty, focused native address bar")

    select_fixture(driver, handle)
    driver.set_context("chrome")
    assert focus_state(driver)["addressVisibility"] == "visible"
    chord(driver, Keys.ALT, Keys.SHIFT, "f")
    wait_for(driver, '''return document.documentElement.getAttribute("data-orbit-focus") === "true" &&
        !document.getElementById("orbit-focus-chip").hidden;''', "trusted focus shortcut enables a visible escape control")
    settle_radial(driver)
    hidden = focus_state(driver)
    assert hidden["enabled"] and hidden["chipVisible"] and not hidden["revealed"], hidden
    assert hidden["addressVisibility"] == "hidden" and hidden["tabVisibility"] == "hidden", hidden
    chord(driver, Keys.CONTROL, "l")
    wait_for(driver, '''return gURLBar.focused && document.documentElement.getAttribute("data-orbit-focus-reveal") === "true";''',
             "Ctrl+L reveals the real native address bar in focus mode")
    chord(driver, Keys.ESCAPE)
    wait_for(driver, 'return !document.documentElement.hasAttribute("data-orbit-focus");', "Escape exits focus mode")
    assert not focus_state(driver)["chipVisible"]
    checks.append("Focus mode recedes real browser controls, Ctrl+L reveals them, and Escape restores the toolbar")

    select_fixture(driver, handle)
    driver.set_context("chrome")
    chord(driver, Keys.ALT, Keys.SHIFT, "f")
    settle_radial(driver)
    left_click(driver, "orbit-focus-reveal")
    wait_for(driver, '''return gURLBar.focused && document.documentElement.getAttribute("data-orbit-focus-reveal") === "true";''',
             "the visible focus chip reveals browser controls")
    left_click(driver, "orbit-focus-exit")
    wait_for(driver, 'return !document.documentElement.hasAttribute("data-orbit-focus");', "focus chip exits focus mode")
    checks.append("Focus mode's visible Show controls and Exit focus buttons remain physically reachable")

    count = len(board(driver)["items"])
    tab_count = driver.execute_script("return gBrowser.tabs.length;")
    capture(driver, handle, "page")
    first = board(driver)
    saved_page = next(item for item in first["items"] if item.get("url") == url)
    assert saved_page["tabId"] and saved_page["userContextId"] == 0 and len(first["items"]) == count + 1
    assert driver.execute_script("return gBrowser.tabs.length;") == tab_count
    assert driver.execute_script('return document.getElementById("orbit-capture-toast")?.textContent.includes("Card added");')
    capture(driver, handle, "page")
    assert len(board(driver)["items"]) == count + 1
    assert driver.execute_script('return document.getElementById("orbit-capture-toast")?.textContent.includes("Already");')
    checks.append("Send to canvas captures the actual page and native tab identity, gives feedback, and avoids duplicate cards")

    capture(driver, handle, "link", "link-target")
    link = next(item for item in board(driver)["items"] if item.get("url") == url + "opened-top")
    assert link["title"] == "Open this real link" and not link.get("tabId"), link
    assert driver.execute_script("return gBrowser.tabs.length;") == tab_count
    checks.append("Link capture saves the actual target and link title without opening or replacing a browser tab")

    select_fixture(driver, handle)
    driver.set_context("content")
    from smoke_radial import content_point_in_chrome
    point = content_point_in_chrome(driver, driver.find_element(By.ID, "editable-target"))
    pointer(driver).pointer_move(point["x"], point["y"], origin="viewport").click().perform()
    chord(driver, Keys.CONTROL, "a")
    capture(driver, handle, "selection", "editable-target")
    text = "Editable native context text\n\nSource: " + url
    assert any(item.get("text") == text for item in board(driver)["items"]), board(driver)
    persisted = driver.execute_script('''return ChromeUtils.importESModule(
        "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs").SessionStore.getCustomWindowValue(window, "orbit-board-v1");''')
    stored = json.loads(persisted)
    assert any(item.get("text") == text for item in stored["items"])
    assert any(item.get("url") == url + "opened-top" for item in stored["items"])
    checks.append("Trusted selected text becomes a source-linked canvas note and normal captures persist in native SessionStore")

    # Default Orbit palette is tested separately from explicit Firefox themes.
    for dark in (True, False):
        driver.set_context("chrome")
        force_default_theme(driver, dark)
        page_menu(driver, handle, "link-target")
        hover_node(driver, "orbit-send-to-canvas")
        wait_for(driver, 'return !!document.querySelector(\'[data-orbit-id="orbit-canvas-link"]\');', "capture fan paints")
        settle_radial(driver)
        assert_parent_fans(driver)
        shapes = driver.execute_script('''
            const root = document.getElementById(arguments[0]);
            return {options: [...root.querySelectorAll(".orbit-radial-option-surface")].map(node => node.localName),
                backing: root.querySelector(".orbit-radial-backing")?.getAttribute("pointer-events"),
                shadow: getComputedStyle(root.querySelector(".orbit-radial-center")).boxShadow};
        ''', script_args=[ROOT_ID])
        assert shapes["options"] and all(tag == "circle" for tag in shapes["options"]), shapes
        assert shapes["backing"] == "none" and shapes["shadow"] != "none", shapes
        screenshot(driver, folder, f'ux-capture-{ "dark" if dark else "light" }', result)
        dismiss(driver)
        assert_context_cleanup(driver)
        open_palette(driver)
        search(driver, "frame", "frame:ux-frame")
        screenshot(driver, folder, f'ux-commands-{ "dark" if dark else "light" }', result)
        chord(driver, Keys.ESCAPE)
        palette_closed(driver)
        select_fixture(driver, handle)
        driver.set_context("chrome")
        chord(driver, Keys.ALT, Keys.SHIFT, "f")
        settle_radial(driver)
        screenshot(driver, folder, f'ux-focus-{ "dark" if dark else "light" }', result)
        chord(driver, Keys.ESCAPE)
    checks.append("Native webpage radial menus use circular canvas-style controls, and capture, commands, and focus render in default dark and light Orbit colors")

    public_before = board(driver)
    previous = set(driver.window_handles)
    chord(driver, Keys.CONTROL, Keys.SHIFT, "p")
    private = new_handle(driver, previous, "Private browser shortcut")
    driver.switch_to_window(private)
    driver.set_context("chrome")
    wait_for(driver, '''return !!window.gBrowserInit?.delayedStartupFinished && !!window.OrbitChrome &&
        !!document.getElementById("orbit-command-palette");''', "private native window registers Orbit interactions")
    initialize_bridge(driver)
    open_palette(driver)
    state = search(driver, "orbital reading room")
    assert not state["rows"] and state["empty"], state
    chord(driver, Keys.ESCAPE)
    palette_closed(driver)
    driver.set_context("content")
    driver.navigate(url + "private")
    private = driver.current_window_handle
    wait_for(driver, 'return !!document.getElementById("fixture-proof");', "private HTTP fixture renders")
    driver.set_context("chrome")
    driver.execute_script('''
        window.orbitSmokePopupLifecycle = {popupshowing: 0, popuphiding: 0, popuphidden: 0};
        const popup = document.getElementById("contentAreaContextMenu");
        for (const name of Object.keys(window.orbitSmokePopupLifecycle))
            popup.addEventListener(name, () => window.orbitSmokePopupLifecycle[name]++);
    ''')
    capture(driver, private, "page")
    private_board = board(driver)
    assert len(private_board["items"]) == 1 and private_board["items"][0]["url"] == url + "private", private_board
    assert not driver.execute_script('''return ChromeUtils.importESModule(
        "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs").SessionStore.getCustomWindowValue(window, "orbit-board-v1");''')
    driver.close_chrome_window()
    driver.switch_to_window(handle)
    driver.set_context("chrome")
    assert board(driver) == public_before, "Private capture leaked into the normal canvas"
    checks.append("Private command search excludes normal frames and private capture stays in that window's memory without SessionStore or normal-board writes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--report", type=Path, default=Path("test-results/ux.json"))
    args = parser.parse_args()
    report = args.report.resolve()
    report.parent.mkdir(parents=True, exist_ok=True)
    result = {"binary": str(args.binary.resolve()), "passed": False, "checks": [], "screenshots": []}
    driver = None
    workspace_context = tempfile.TemporaryDirectory(prefix="orbit-native-ux-")
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixturePage)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/"
    try:
        driver = Marionette(
            bin=str(args.binary.resolve()), app="fxdesktop", port=0,
            headless=True, startup_timeout=90, socket_timeout=60,
            workspace=workspace_context.name, gecko_log=str(report.parent / "ux-gecko.log"),
            app_args=["-no-remote", "--remote-allow-system-access"],
            prefs={"browser.startup.page": 0, "browser.startup.homepage": "about:blank",
                   "remote.events.async.mouse.enabled": True,
                   "browser.tabs.warnOnClose": False, "browser.warnOnQuit": False},
        )
        driver.start_session()
        driver.set_window_rect(width=1400, height=1000)
        driver.set_context("content")
        driver.navigate(url)
        handle = driver.current_window_handle
        wait_for(driver, 'return !!document.getElementById("fixture-proof");', "real Gecko UX fixture")
        driver.set_context("chrome")
        wait_for(driver, '''return !!window.gBrowserInit?.delayedStartupFinished && !!window.OrbitChrome &&
            !!document.getElementById("orbit-command-palette");''', "native Orbit interaction registration")
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
                result["failure_palette"] = palette_state(driver)
                result["failure_focus"] = focus_state(driver)
                result["failure_radial"] = radial_state(driver)
                result["failure_board"] = board(driver)
                screenshot(driver, report.parent, "ux-failure", result)
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
        try:
            workspace_context.cleanup()
        except Exception:
            result["workspace_cleanup_error"] = traceback.format_exc()
        server.shutdown()
        server.server_close()
        report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()
