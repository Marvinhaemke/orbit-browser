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

CANVAS_URI = "chrome://browser/content/orbit/orbit.html"


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


def chord(driver, *values):
    """Use trusted native key actions for browser commands and navigation."""
    action = driver.actions.sequence("key", "orbit-native-ux-key")
    for value in values:
        action.key_down(value)
    for value in reversed(values):
        action.key_up(value)
    action.perform()


def new_handle(driver, previous, label):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        handles = set(driver.window_handles) - previous
        if handles:
            assert len(handles) == 1, f"{label} created multiple unexpected tabs: {handles}"
            return handles.pop()
        time.sleep(0.1)
    raise AssertionError(f"{label} did not create a native browser handle")


def native_canvas_ready(driver):
    driver.set_context("chrome")
    return wait_for(driver, '''
        const browser = gBrowser.selectedBrowser;
        const doc = browser.contentDocument;
        const viewport = doc?.getElementById("viewport");
        const box = viewport?.getBoundingClientRect();
        return browser.currentURI.spec === "chrome://browser/content/orbit/orbit.html" &&
            doc?.documentURI === browser.currentURI.spec && doc.nodePrincipal.isSystemPrincipal &&
            doc.readyState === "complete" && !!browser.contentWindow.OrbitCanvasBridge &&
            box?.width > 400 && box?.height > 250 &&
            doc.getElementById("save-status")?.textContent !== "Loading workspace…";
    ''', "real native New Tab canvas document, bridge, and layout")


def open_native_canvas_tab(driver, toolbar=False):
    driver.set_context("chrome")
    before = set(driver.window_handles)
    if toolbar:
        button = driver.find_element(By.ID, "tabs-newtab-button")
        box = button.rect
        assert box["width"] > 0 and box["height"] > 0, "Native tab-strip plus button is not visible"
        driver.actions.sequence("pointer", "orbit-native-ux-mouse", {"pointerType": "mouse"}).click(button).perform()
    else:
        chord(driver, Keys.CONTROL, "t")
    handle = new_handle(driver, before, "Native + button" if toolbar else "Ctrl+T")
    native_canvas_ready(driver)
    focus = driver.execute_script('''
        return {focused: gURLBar.focused, value: gURLBar.value,
            overlay: document.getElementById("orbit-canvas-overlay")?.hidden !== false,
            uri: gBrowser.selectedBrowser.currentURI.spec};
    ''')
    assert focus["focused"] and not focus["value"] and focus["overlay"], focus
    # Marionette's ordinary tab switch focuses the browser itself. Bind the
    # already-selected native tab without changing the user's URL-bar focus.
    driver.switch_to_window(handle, focus=False)
    return handle


def click_canvas_element(driver, element):
    """Target a real canvas node through the native window widget."""
    point = driver.execute_script('''
        const node = arguments[0];
        node.scrollIntoView({block: "nearest", inline: "nearest"});
        const box = node.getBoundingClientRect();
        const win = node.ownerDocument.defaultView;
        return {x: win.mozInnerScreenX + box.x + box.width / 2,
            y: win.mozInnerScreenY + box.y + box.height / 2};
    ''', script_args=[element])
    driver.set_context("chrome")
    widget = driver.execute_script('''
        return {x: Math.round(arguments[0].x - window.mozInnerScreenX),
            y: Math.round(arguments[0].y - window.mozInnerScreenY)};
    ''', script_args=[point])
    driver.actions.sequence("pointer", "orbit-native-ux-mouse", {"pointerType": "mouse"}).pointer_move(
        widget["x"], widget["y"], origin="viewport").click().perform()


def create_native_note(driver, text):
    native_canvas_ready(driver)
    before = driver.execute_script('''
        return gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge.getBoard().items.map(item => item.id);
    ''')
    driver.set_context("content")
    click_canvas_element(driver, driver.find_element(By.CSS_SELECTOR, '[data-tool="note"]'))
    point = driver.execute_script('''
        const doc = gBrowser.selectedBrowser.contentDocument;
        const viewport = doc.getElementById("viewport");
        const box = viewport.getBoundingClientRect();
        // The canvas fills the page; stay clear of its floating top menu.
        const header = doc.querySelector(".board-header").getBoundingClientRect();
        return {x: viewport.ownerDocument.defaultView.mozInnerScreenX + box.right - 250 - window.mozInnerScreenX,
            y: viewport.ownerDocument.defaultView.mozInnerScreenY + Math.max(box.top + 150, header.bottom + 40) - window.mozInnerScreenY};
    ''')
    driver.actions.sequence("pointer", "orbit-native-ux-mouse", {"pointerType": "mouse"}).pointer_move(
        round(point["x"]), round(point["y"]), origin="viewport").click().perform()
    note = wait_for(driver, '''
        return gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge.getBoard().items.find(item =>
            item.type === "note" && !arguments[0].includes(item.id));
    '''.replace("arguments[0]", json.dumps(before)), "trusted canvas click creates a saved note")
    driver.set_context("content")
    textarea = driver.find_element(By.CSS_SELECTOR, f'[data-id="{note["id"]}"] textarea')
    click_canvas_element(driver, textarea)
    driver.set_context("content")
    textarea.send_keys(text)
    driver.set_context("chrome")
    wait_for(driver, '''
        return gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge.getBoard().items.some(item =>
            item.id === arguments[0] && item.text === arguments[1]);
    '''.replace("arguments[0]", json.dumps(note["id"])).replace("arguments[1]", json.dumps(text)),
             "typed canvas note persists through the native bridge")
    return note["id"]


def canvas_document_note(driver, note_id, text):
    native_canvas_ready(driver)
    return wait_for(driver, '''
        return gBrowser.selectedBrowser.contentDocument.querySelector(arguments[0])?.value === arguments[1];
    '''.replace("arguments[0]", json.dumps(f'[data-id="{note_id}"] textarea')).replace("arguments[1]", json.dumps(text)),
                    "shared native canvas page renders the saved note")


def verify_canvas_launcher(driver, result):
    """The canvas search field hands off to Firefox's real address bar."""
    native_canvas_ready(driver)
    driver.set_context("content")
    click_canvas_element(driver, driver.find_element(By.ID, "greeting"))
    wait_for(driver, "return !gURLBar.focused;", "a click in the canvas moves focus away from the address bar")
    driver.set_context("content")
    click_canvas_element(driver, driver.find_element(By.ID, "address-launcher"))
    wait_for(driver, "return gURLBar.focused;", "the canvas launcher focuses Firefox's native address bar")
    state = driver.execute_script('''
        const doc = gBrowser.selectedBrowser.contentDocument;
        return {greeting: doc.getElementById("greeting").textContent,
            summary: doc.getElementById("board-summary").textContent,
            launcher: doc.getElementById("address-launcher").value,
            shortcutRows: doc.querySelectorAll("#shortcut-list .shortcut").length,
            shortcutsHidden: doc.getElementById("shortcuts").hidden,
            value: gURLBar.value, uri: gBrowser.selectedBrowser.currentURI.spec,
            fullPage: (() => {
                const view = doc.getElementById("viewport").getBoundingClientRect();
                return Math.abs(view.width - doc.defaultView.innerWidth) < 1 && Math.abs(view.height - doc.defaultView.innerHeight) < 1;
            })(),
            floating: doc.defaultView.getComputedStyle(doc.querySelector(".sidebar")).position === "fixed" &&
                doc.defaultView.getComputedStyle(doc.querySelector(".board-header")).position === "absolute"};
    ''')
    result["canvas_launcher"] = state
    assert state["greeting"].startswith("Good ") and state["summary"], state
    assert state["uri"] == CANVAS_URI and not state["value"] and not state["launcher"], state
    assert state["fullPage"] and state["floating"], state
    # A fresh disposable profile has no frequent sites, so the row stays out of the way.
    assert state["shortcutsHidden"] == (state["shortcutRows"] == 0), state
    result["checks"].append("The canvas fills the whole page under floating side and top menus, its greeting renders, and its search field focuses Firefox's real address bar without navigating")


def verify_overlay_launcher(driver, url, result):
    """Over a page, the canvas search field behaves like Ctrl+L: the canvas
    stays in front while the address bar is in use and steps aside once the
    address bar opens a page."""
    open_canvas(driver)
    driver.set_context("chrome")
    before = driver.execute_script('return {uri: gBrowser.selectedBrowser.currentURI.spec, tabs: gBrowser.tabs.length};')
    point = driver.execute_script('''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        const box = doc.getElementById("address-launcher").getBoundingClientRect();
        const frame = doc.defaultView;
        return {x: Math.round(frame.mozInnerScreenX + box.x + box.width / 2 - window.mozInnerScreenX),
            y: Math.round(frame.mozInnerScreenY + box.y + box.height / 2 - window.mozInnerScreenY)};
    ''')
    driver.actions.sequence("pointer", "orbit-overlay-mouse", {"pointerType": "mouse"}).pointer_move(
        point["x"], point["y"], origin="viewport").click().perform()
    wait_for(driver, "return gURLBar.focused;", "the overlay canvas field focuses Firefox's address bar")
    state = driver.execute_script('''
        return {overlay: !document.getElementById("orbit-canvas-overlay").hidden,
            uri: gBrowser.selectedBrowser.currentURI.spec};
    ''')
    assert state["overlay"] and state["uri"] == before["uri"], f"The canvas field left the overlay canvas: {state}"
    chord(driver, Keys.ESCAPE)
    time.sleep(0.5)
    assert driver.execute_script('return !document.getElementById("orbit-canvas-overlay").hidden;'), \
        "Escape in the address bar closed the canvas instead of the address bar"
    if not driver.execute_script("return gURLBar.focused;"):
        chord(driver, Keys.CONTROL, "l")
        wait_for(driver, "return gURLBar.focused;", "Ctrl+L focuses the address bar over the canvas")
    target = url + "from-canvas-address"
    driver.find_element(By.ID, "urlbar-input").send_keys(target, Keys.ENTER)
    wait_for(driver, '''
        return document.getElementById("orbit-canvas-overlay").hidden &&
            gBrowser.selectedBrowser.currentURI.spec === arguments[0];
    '''.replace("arguments[0]", json.dumps(target)), "the canvas steps aside for the page the address bar opens")
    assert driver.execute_script("return gBrowser.tabs.length;") == before["tabs"], "The address bar opened an extra tab"
    result["overlay_launcher"] = {"before": before["uri"], "after": target}
    result["checks"].append("Over a page, the canvas search field and Escape keep the canvas in front of Firefox's address bar, which then opens its page in place of the canvas")


def click_in_canvas(driver, selector, label):
    """A trusted pointer click on an element of the overlay canvas document."""
    point = driver.execute_script('''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        const node = doc.querySelector(arguments[0]);
        if (!node) return null;
        node.scrollIntoView({block: "nearest"});
        const box = node.getBoundingClientRect();
        const frame = doc.defaultView;
        return {x: Math.round(frame.mozInnerScreenX + box.x + box.width / 2 - window.mozInnerScreenX),
            y: Math.round(frame.mozInnerScreenY + box.y + box.height / 2 - window.mozInnerScreenY)};
    ''', script_args=[selector])
    assert point, f"The canvas has no {label} ({selector})"
    try:
        driver.actions.sequence("pointer", "orbit-tray-mouse", {"pointerType": "mouse"}).pointer_move(
            point["x"], point["y"], origin="viewport").pause(80).click().perform()
    finally:
        driver.actions.release()


def verify_tab_tray(driver, url, result):
    """The canvas's open-tabs tray lists real tabs, files a chosen one into a
    frame, and closes it while its card and the overlay canvas stay."""
    open_canvas(driver)
    driver.set_context("chrome")
    target = url + "tray"
    selected_before = driver.execute_script("return gBrowser.selectedBrowser.currentURI.spec;")
    tab_id = driver.execute_script('return window.OrbitChrome.openTab({url: arguments[0], background: true}).id;', script_args=[target])
    row = f'.tray-tab[data-tab-id="{tab_id}"]'
    wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        const live = window.OrbitChrome.listTabs();
        return !!doc.querySelector(arguments[0]) &&
            doc.querySelectorAll(".tray-tab").length === live.length &&
            doc.getElementById("open-count").textContent === String(live.length);
    '''.replace("arguments[0]", json.dumps(row)), "the tray lists every open website, including a background tab")
    # window.OrbitChrome is the overlay canvas's own bridge, and a canvas is
    # never sent its own saves. Save as browser chrome, so the visible overlay
    # hears about the new frame the way it hears about any other canvas's edit.
    driver.execute_script('''
        const state = ChromeUtils.importESModule("moz-src:///browser/components/orbit/Orbit.sys.mjs").Orbit._windows.get(window);
        const board = state.getBoard();
        if (!board.frames.some(frame => frame.id === "smoke-tray-frame")) {
            board.frames.push({id: "smoke-tray-frame", title: "Tray frame", color: "#70ded3", x: 3000, y: 3000, w: 600, h: 400});
            state.saveBoard(board);
        }
    ''')
    wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        return [...doc.querySelectorAll("#frame-list .frame-nav")].some(nav => nav.textContent.includes("Tray frame"));
    ''', "the overlay canvas hears about a frame added by browser chrome")
    click_in_canvas(driver, row, "tray row for the background tab")
    wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        return doc.querySelector(arguments[0])?.getAttribute("aria-selected") === "true" &&
            !doc.getElementById("tray-actions").hidden &&
            [...doc.getElementById("tray-frame").options].some(option => option.value === "smoke-tray-frame");
    '''.replace("arguments[0]", json.dumps(row)), "a click selects the row and offers the board's frames")
    driver.execute_script('document.getElementById("orbit-canvas-frame").contentDocument.getElementById("tray-frame").value = "smoke-tray-frame";')
    click_in_canvas(driver, "#tray-add", "tray Add button")
    wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        const card = window.OrbitChrome.getBoard().items.find(item => item.type === "tab" && item.tabId === arguments[0]);
        return card?.frameId === "smoke-tray-frame" && card.url === arguments[1] &&
            doc.querySelector(arguments[2] + " .tray-place")?.textContent.includes("Tray frame") &&
            !!doc.querySelector(`.item.card[data-id="${card.id}"]`);
    '''.replace("arguments[0]", json.dumps(tab_id)).replace("arguments[1]", json.dumps(target)).replace("arguments[2]", json.dumps(row)),
        "Add files the tab's card into the chosen frame")
    click_in_canvas(driver, row + " .tray-close", "tray close button")
    wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        return !gBrowser.tabs.some(tab => !tab.closing && tab.linkedBrowser.currentURI.spec === arguments[0]) &&
            !doc.querySelector(arguments[1]);
    '''.replace("arguments[0]", json.dumps(target)).replace("arguments[1]", json.dumps(row)), "the tray's close button closes the real tab")
    state = driver.execute_script('''
        const card = window.OrbitChrome.getBoard().items.find(item => item.type === "tab" && item.url === arguments[0]);
        return {overlay: !document.getElementById("orbit-canvas-overlay").hidden, card: card?.frameId || null,
            selected: gBrowser.selectedBrowser.currentURI.spec};
    ''', script_args=[target])
    assert state["overlay"], f"Closing a tab from the tray hid the canvas: {state}"
    assert state["card"] == "smoke-tray-frame", f"The closed tab's card left the canvas: {state}"
    assert state["selected"] == selected_before, f"Closing a background tab changed the selected page: {state}"
    result["tab_tray"] = {"tab": target, "frame": state["card"]}
    result["checks"].append("The canvas tray lists real tabs, files one into a frame, and closes it while its card and the canvas stay")


def verify_tab_overview(driver, result, folder):
    """Tab overview opens the overlay canvas with a tile per open website and
    a real Gecko snapshot of a loaded page; Escape leaves only the overview."""
    driver.set_context("chrome")
    if canvas_visible(driver):
        click_canvas_button(driver)
        wait_for(driver, 'return document.getElementById("orbit-canvas-overlay").hidden;', "canvas closes before the overview")
    driver.execute_script('ChromeUtils.importESModule("moz-src:///browser/components/orbit/Orbit.sys.mjs").Orbit.openOverview(window);')
    wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame")?.contentDocument;
        const panel = doc?.getElementById("overview");
        return !document.getElementById("orbit-canvas-overlay").hidden && panel && !panel.hidden &&
            doc.documentElement.dataset.orbitOverview === "true" &&
            doc.querySelectorAll(".overview-tile").length === window.OrbitChrome.listTabs().length;
    ''', "Tab overview opens the overlay canvas with a tile per open website")
    preview = wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        const image = doc.querySelector('.overview-shot img[src^="data:image/jpeg;base64,"]');
        return image?.complete && image.naturalWidth > 40 && image.naturalHeight > 20 ?
            {width: image.naturalWidth, height: image.naturalHeight} : null;
    ''', "Firefox draws a real snapshot of a loaded website for its tile", timeout=45)
    (folder / "orbit-tab-overview.png").write_bytes(driver.screenshot(format="binary", full=False))
    result["overview_screenshot"] = "orbit-tab-overview.png"
    chord(driver, Keys.ESCAPE)
    wait_for(driver, '''
        const doc = document.getElementById("orbit-canvas-frame").contentDocument;
        return doc.getElementById("overview").hidden && !doc.documentElement.dataset.orbitOverview;
    ''', "Escape leaves the overview")
    assert driver.execute_script('return !document.getElementById("orbit-canvas-overlay").hidden;'), \
        "Escape in the overview closed the whole canvas"
    chord(driver, Keys.ESCAPE)
    wait_for(driver, 'return document.getElementById("orbit-canvas-overlay").hidden;', "a second Escape closes the canvas")
    result["tab_overview"] = {"preview": preview}
    result["checks"].append("Tab overview shows every open website with real Gecko snapshots; Escape returns to the canvas, then closes it")


def verify_native_newtab_ux(driver, fixture_handle, url, result, folder):
    """Exercise the browser's real new-tab commands and isolated workspaces."""
    checks = result["checks"]
    if canvas_visible(driver):
        click_canvas_button(driver)
        wait_for(driver, 'return document.getElementById("orbit-canvas-overlay").hidden;', "overlay closes before opening real New Tab pages")
    identity = wait_for(driver, '''
        return document.documentElement.classList.contains("orbit-browser-chrome") &&
            document.documentElement.dataset.orbitTheme === "default" &&
            !!document.getElementById("orbit-chrome-styles");
    ''', "packaged default Orbit browser theme")
    assert identity
    result["brand"] = driver.execute_script('''
        return {name: Services.strings.createBundle("chrome://branding/locale/brand.properties")
                .GetStringFromName("brandShortName"),
            engineName: Services.appinfo.name,
            theme: Services.prefs.getStringPref("extensions.activeThemeID", ""),
            sheet: document.getElementById("orbit-chrome-styles").href,
            lagoon: getComputedStyle(document.documentElement).getPropertyValue("--orbit-chrome-lagoon").trim(),
            periwinkle: getComputedStyle(document.documentElement).getPropertyValue("--orbit-chrome-periwinkle").trim()};
    ''')
    assert result["brand"]["name"] == "Orbit", result["brand"]
    assert result["brand"]["sheet"] == "chrome://browser/content/orbit/orbit-chrome.css", result["brand"]
    assert result["brand"]["lagoon"] and result["brand"]["periwinkle"], result["brand"]
    checks.append("Native application branding and packaged Orbit chrome theme load with the default identity")

    first = open_native_canvas_tab(driver)
    assert driver.execute_script('''
        return gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge.getBoard().items.some(item =>
            item.id === "smoke-note" && item.text === "A native saved note");
    '''), "Ctrl+T did not share the existing native window canvas workspace"
    driver.execute_script('window.orbitSmokeStaleCanvasBridge = gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge;')
    verify_canvas_launcher(driver, result)
    note_id = create_native_note(driver, "Canvas New Tab shared native note")
    second = open_native_canvas_tab(driver, toolbar=True)
    canvas_document_note(driver, note_id, "Canvas New Tab shared native note")
    checks.append("Ctrl+T and the physical native + button open privileged canvas tabs with an empty focused address bar")

    driver.set_context("content")
    textarea = driver.find_element(By.CSS_SELECTOR, f'[data-id="{note_id}"] textarea')
    click_canvas_element(driver, textarea)
    chord(driver, Keys.CONTROL, "a")
    driver.set_context("content")
    changed = "Canvas New Tab note edited from a second canvas"
    textarea.send_keys(changed)
    driver.set_context("chrome")
    canvas_document_note(driver, note_id, changed)
    wait_for(driver, '''
        return gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge.getBoard().items.some(item =>
            item.id === arguments[0] && item.text === arguments[1]);
    '''.replace("arguments[0]", json.dumps(note_id)).replace("arguments[1]", json.dumps(changed)),
             "second native canvas saves the physically edited note")
    driver.switch_to_window(first)
    canvas_document_note(driver, note_id, changed)
    saved = driver.execute_script('''
        return ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs")
            .SessionStore.getCustomWindowValue(window, "orbit-board-v1");
    ''')
    assert changed in saved and "smoke-connection" in saved and "smoke-stroke" in saved, saved
    checks.append("Two live native canvas tabs share edits and preserve frames, connections, and drawings through SessionStore")

    chord(driver, Keys.CONTROL, "w")
    driver.switch_to_window(second)
    driver.set_context("chrome")
    assert driver.execute_script('''
        try { window.orbitSmokeStaleCanvasBridge.getBoard(); return false; }
        catch (_) { return true; }
    '''), "Closed canvas retained access to the native privileged bridge"
    driver.execute_script('window.orbitSmokeNavigatedCanvasBridge = gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge;')
    chord(driver, Keys.CONTROL, "l")
    assert driver.execute_script("return gURLBar.focused;"), "Ctrl+L did not focus the native address bar"
    driver.find_element(By.ID, "urlbar-input").send_keys(url + "newtab-navigation", Keys.ENTER)
    wait_for(driver, 'return gBrowser.selectedBrowser.currentURI.spec === arguments[0];'.replace("arguments[0]", json.dumps(url + "newtab-navigation")), "typed address navigates the real canvas tab")
    driver.set_context("content")
    wait_for(driver, 'return !!document.getElementById("native-gecko-proof");', "typed address renders the actual HTTP document")
    driver.set_context("chrome")
    assert driver.execute_script('''
        try { window.orbitSmokeNavigatedCanvasBridge.getBoard(); return false; }
        catch (_) { return true; }
    '''), "Navigated HTTP page retained access to the old privileged canvas bridge"
    checks.append("Typing an address navigates the real New Tab browser; closed and navigated canvas documents lose privileged bridge access")

    public_canvas = open_native_canvas_tab(driver)
    canvas_document_note(driver, note_id, changed)
    themes = []
    for dark in (True, False):
        driver.set_context("chrome")
        driver.execute_script('Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[0]);', script_args=[1 if dark else 0])
        wait_for(driver, 'return window.matchMedia("(prefers-color-scheme: dark)").matches === arguments[0];'.replace("arguments[0]", json.dumps(dark)), "default Orbit theme follows the forced native color scheme")
        palette = wait_for(driver, '''
            const root = document.documentElement;
            const doc = gBrowser.selectedBrowser.contentDocument;
            const logo = doc.querySelector(".wordmark > svg.orbit-logo");
            const box = logo?.getBoundingClientRect();
            const viewport = doc.getElementById("viewport");
            const native = getComputedStyle(root);
            const canvas = doc.defaultView.getComputedStyle(doc.documentElement);
            const expectedDark = arguments[0];
            const expectedBase = expectedDark ? "#151b2c" : "#e9eef5";
            const chromeBase = native.getPropertyValue("--orbit-chrome-base").trim();
            const canvasBase = canvas.getPropertyValue("--orbit-base").trim();
            // The native theme notification invalidates CSS after matchMedia
            // changes. Wait for both real documents' painted palette tokens;
            // an immediately sampled MQL can otherwise label light CSS dark.
            if (window.matchMedia("(prefers-color-scheme: dark)").matches !== expectedDark ||
                doc.defaultView.matchMedia("(prefers-color-scheme: dark)").matches !== expectedDark ||
                chromeBase !== expectedBase || canvasBase !== expectedBase) return false;
            const urlbarNode = document.querySelector("#urlbar .urlbar-background");
            if (!urlbarNode) throw new Error("Pinned Firefox URL-bar background is missing");
            const urlbar = getComputedStyle(urlbarNode);
            return root.dataset.orbitTheme === "default" && box?.width > 0 && box?.height > 0 && {
                chromeBase,
                chromeInk: native.getPropertyValue("--orbit-chrome-ink").trim(),
                canvasBase,
                canvasInk: canvas.getPropertyValue("--ink").trim(),
                canvasBackground: doc.defaultView.getComputedStyle(viewport).backgroundColor,
                toolbox: getComputedStyle(document.getElementById("navigator-toolbox")).backgroundImage,
                urlbarShadow: urlbar.boxShadow,
                logoWidth: box.width, logoHeight: box.height,
                title: doc.title, wordmark: doc.querySelector(".wordmark").textContent.trim()};
        '''.replace("arguments[0]", json.dumps(dark)), "settled native Orbit chrome/canvas palette, sculpted surfaces, and packaged logo")
        assert palette["chromeBase"] and palette["chromeInk"] and palette["canvasBase"], palette
        assert palette["chromeBase"] != palette["chromeInk"], palette
        assert palette["toolbox"] != "none" and palette["urlbarShadow"] != "none", palette
        assert "orbit" in palette["wordmark"].lower() and "Orbit" in palette["title"], palette
        themes.append(palette)
        driver.execute_async_script('const complete = arguments[arguments.length - 1]; window.setTimeout(complete, 280);')
        name = f'orbit-newtab-{"dark" if dark else "light"}.png'
        (folder / name).write_bytes(driver.screenshot(format="binary", full=False))
        result.setdefault("newtab_screenshots", []).append(name)
    assert themes[0]["chromeBase"] != themes[1]["chromeBase"], themes
    assert themes[0]["canvasBackground"] != themes[1]["canvasBackground"], themes
    result["native_palettes"] = themes
    checks.append("The packaged default Orbit identity renders distinct dark and light browser chrome and liquid canvas surfaces with a visible orbital logo")

    before = set(driver.window_handles)
    chord(driver, Keys.CONTROL, Keys.SHIFT, "p")
    private_start = new_handle(driver, before, "Ctrl+Shift+P")
    driver.switch_to_window(private_start)
    driver.set_context("chrome")
    wait_for(driver, 'return !!window.gBrowserInit?.delayedStartupFinished && !!window.OrbitChrome;', "new private native window startup")
    open_native_canvas_tab(driver)
    assert driver.execute_script('''
        return ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs")
            .PrivateBrowsingUtils.isWindowPrivate(window) &&
            !gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge.getBoard().items.some(item =>
                item.id === arguments[0] || item.id === "smoke-note");
    ''', script_args=[note_id]), "Private canvas inherited normal-window workspace data"
    private_note = create_native_note(driver, "Private canvas memory only")
    open_native_canvas_tab(driver)
    canvas_document_note(driver, private_note, "Private canvas memory only")
    assert not driver.execute_script('''
        return ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs")
            .SessionStore.getCustomWindowValue(window, "orbit-board-v1");
    '''), "Private canvas wrote its board into persistent native SessionStore"
    # Closing a chrome window on the shortcut's keydown destroys Marionette's
    # action context before it can dispatch keyups. Use its native window-close
    # command for lifecycle cleanup after the physical private-canvas checks.
    driver.close_chrome_window()
    driver.switch_to_window(public_canvas)
    canvas_document_note(driver, note_id, changed)
    assert not driver.execute_script('''
        return gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge.getBoard().items.some(item =>
            item.id === arguments[0]);
    ''', script_args=[private_note]), "Private canvas note leaked into normal-window workspace"
    before = set(driver.window_handles)
    chord(driver, Keys.CONTROL, Keys.SHIFT, "p")
    private_start = new_handle(driver, before, "second Ctrl+Shift+P")
    driver.switch_to_window(private_start)
    driver.set_context("chrome")
    wait_for(driver, 'return !!window.gBrowserInit?.delayedStartupFinished && !!window.OrbitChrome;', "second private native window startup")
    open_native_canvas_tab(driver)
    assert not driver.execute_script('''
        return gBrowser.selectedBrowser.contentWindow.OrbitCanvasBridge.getBoard().items.some(item =>
            item.id === arguments[0]);
    ''', script_args=[private_note]), "Closed private-window board survived into a new private session"
    driver.close_chrome_window()
    driver.switch_to_window(fixture_handle)
    driver.set_context("chrome")
    checks.append("Native private canvas tabs share only their window's in-memory board, never persist it, and discard it when the private window closes")


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
    workspace_context = tempfile.TemporaryDirectory(prefix="orbit-native-smoke-")
    try:
        driver = Marionette(
            bin=str(args.binary.resolve()), app="fxdesktop", port=0,
            headless=True, startup_timeout=90, socket_timeout=60,
            workspace=workspace_context.name, gecko_log=str(report.parent / "gecko.log"),
            app_args=["-no-remote", "--remote-allow-system-access"],
            prefs={"browser.startup.page": 0, "browser.startup.homepage": "about:blank",
                   # These checks drive the full native toolbar; smoke_ux.py covers
                   # the default focus-mode window separately.
                   "browser.orbit.focus.default": False,
                   "remote.events.async.mouse.enabled": True,
                   "browser.tabs.warnOnClose": False, "browser.warnOnQuit": False},
        )
        driver.start_session()
        driver.set_window_rect(width=1400, height=1000)
        driver.set_context("content")
        driver.navigate(url)
        fixture_handle = driver.current_window_handle
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

        verify_native_newtab_ux(driver, fixture_handle, url, result, report.parent)
        verify_overlay_launcher(driver, url, result)
        verify_tab_tray(driver, url, result)
        verify_tab_overview(driver, result, report.parent)

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
        if driver:
            try:
                driver.set_context("chrome")
                (report.parent / "orbit-canvas-failure.png").write_bytes(driver.screenshot(format="binary", full=False))
                result["failure_state"] = driver.execute_script('''
                    const browser = gBrowser.selectedBrowser;
                    const doc = browser.contentDocument;
                    return {uri: browser.currentURI.spec, title: doc?.title,
                        principal: doc?.nodePrincipal.isSystemPrincipal,
                        bridge: !!browser.contentWindow?.OrbitCanvasBridge,
                        address: gURLBar.value, focused: gURLBar.focused,
                        activeElement: document.activeElement?.id,
                        theme: document.documentElement.dataset.orbitTheme,
                        mediaDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
                        tabs: gBrowser.tabs.length};
                ''')
            except Exception:
                result["capture_error"] = traceback.format_exc()
        raise
    finally:
        if driver:
            try:
                driver.cleanup()
            except Exception:
                result["browser_cleanup_error"] = traceback.format_exc()
        # The browser must exit before deleting Windows' live profile files;
        # otherwise WinError 32 masks the original native assertion failure.
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
