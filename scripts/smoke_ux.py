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
from zipfile import ZipFile

from marionette_driver.addons import Addons
from marionette_driver.by import By
from marionette_driver.keys import Keys
from marionette_driver.marionette import Marionette

from smoke_radial import (
    FixturePage, ROOT_ID, activate, assert_context_cleanup, assert_parent_fans,
    dismiss, find_action, hover_node, left_click, page_menu, pointer, radial_state,
    select_fixture, settle_radial, wait_for,
)
from smoke_test import canvas_shortcut, chord, native_canvas_ready, new_handle, open_canvas

TOOLS_ROOT_ID = "orbit-focus-tools-root"
EXTENSION_ID = "orbit-focus-smoke@orbit.invalid"


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
    if name.startswith("ux-focus"):
        result.setdefault("focus_states", {})[name] = focus_state(driver)


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
        const address = document.getElementById("urlbar-container");
        const tabs = document.getElementById("tabbrowser-tabs");
        const geometry = node => {
            const rect = node?.getBoundingClientRect();
            const style = node && getComputedStyle(node);
            return {x: rect?.x, y: rect?.y, width: rect?.width, height: rect?.height,
                right: rect?.right, bottom: rect?.bottom, visibility: style?.visibility,
                opacity: style?.opacity, pointerEvents: style?.pointerEvents,
                shadow: style?.boxShadow, radius: style?.borderRadius};
        };
        const box = geometry(toolbox);
        const chipBox = geometry(chip);
        const controls = [...document.querySelectorAll('[data-orbit-focus-window-controls="true"]')];
        const tools = document.getElementById(arguments[0]);
        return {enabled: root.getAttribute("data-orbit-focus") === "true",
            addressVisible: root.getAttribute("data-orbit-focus-address-visible") === "true",
            addressExpanded: root.getAttribute("data-orbit-focus-address-expanded") === "true",
            windowVisible: root.getAttribute("data-orbit-focus-window-visible") === "true",
            toolsVisible: root.getAttribute("data-orbit-focus-tools-visible") === "true",
            chipVisible: !chip.hidden && chipBox.width > 0 && chipBox.height > 0,
            toolboxTop: box.y, toolboxBottom: box.bottom,
            viewport: {width: innerWidth, height: innerHeight},
            address: geometry(address), windowControls: controls.map(geometry),
            addressMarked: address.getAttribute("data-orbit-focus-address") === "true",
            addressVisibility: getComputedStyle(address).visibility,
            tabVisibility: getComputedStyle(tabs).visibility,
            focusedAddress: gURLBar.focused,
            toolsOpen: !!tools && !tools.hidden && getComputedStyle(tools).display !== "none",
            autocompleteOpen: gURLBar.view.isOpen};
    ''', script_args=[TOOLS_ROOT_ID])


def record_focus_probe(driver, result, label):
    """Record native hit testing and trusted event delivery without changing UI."""
    driver.set_context("chrome")
    probe = driver.execute_script('''
        const describe = node => ({tag: node?.localName, id: node?.id,
            classes: typeof node?.className === "string" ? node.className : node?.getAttribute?.("class")});
        const geometry = node => {
            const rect = node?.getBoundingClientRect();
            const style = node && getComputedStyle(node);
            return {...describe(node), x: rect?.x, y: rect?.y, width: rect?.width, height: rect?.height,
                right: rect?.right, bottom: rect?.bottom, display: style?.display,
                visibility: style?.visibility, opacity: style?.opacity, pointerEvents: style?.pointerEvents,
                overflow: style?.overflow, overflowX: style?.overflowX, overflowY: style?.overflowY,
                position: style?.position, contain: style?.contain, zIndex: style?.zIndex,
                minHeight: style?.minHeight, maxHeight: style?.maxHeight,
                dragging: style?.getPropertyValue("-moz-window-dragging")};
        };
        const address = document.getElementById("urlbar-container");
        const input = gURLBar.inputField;
        const ancestors = [];
        for (let node = address; node; node = node.parentElement) ancestors.push(geometry(node));
        const hit = node => {
            const rect = node.getBoundingClientRect();
            const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
            return {point: {x, y}, top: describe(document.elementFromPoint(x, y)),
                stack: document.elementsFromPoint(x, y).map(describe)};
        };
        return {address: hit(address), input: {...geometry(input), ...hit(input)}, ancestors,
            active: geometry(document.activeElement),
            focusedElement: describe(Services.focus.focusedElement),
            rootAttributes: Object.fromEntries([...document.documentElement.attributes]
                .filter(attribute => attribute.name.startsWith("data-orbit-focus"))
                .map(attribute => [attribute.name, attribute.value])),
            trustedEvents: window.orbitUXFocusEvents?.slice(-80)};
    ''')
    probe["state"] = focus_state(driver)
    try:
        driver.set_context("content")
        probe["contentEvents"] = driver.execute_script("return window.orbitSmokeInputEvents || [];")
    finally:
        driver.set_context("chrome")
    result.setdefault("focus_probes", {})[label] = probe


def diagnose_focus_hit_testing(driver, result, folder):
    """After a failed real click, isolate CSS causes in the disposable profile.

    These transient styles never participate in a passing test. The caller
    preserves and re-raises the original failure regardless of probe results.
    """
    driver.set_context("chrome")
    if not focus_state(driver)["enabled"]:
        return
    scope = ':root[data-orbit-focus="true"]:not([data-orbit-focus-reveal="true"])'
    variants = {
        "a-pointer-auto": f'''{scope} #navigator-toolbox,
            {scope} #navigator-toolbox [data-orbit-focus-island-parent="true"] {{
                pointer-events: auto !important;
            }}''',
        "b-positive-marked-ancestors": f'''{scope} #navigator-toolbox[data-orbit-focus-island-parent="true"],
            {scope} #navigator-toolbox [data-orbit-focus-island-parent="true"] {{
                height: 64px !important; min-height: 64px !important; max-height: 64px !important;
                margin-block: 0 !important; padding-block: 0 !important;
            }}
            {scope} #navigator-toolbox > :is(toolbar, #titlebar):not([data-orbit-focus-island-parent="true"]),
            {scope} #TabsToolbar:not([data-orbit-focus-island-parent="true"]) {{
                height: 0 !important; min-height: 0 !important; max-height: 0 !important;
                margin-block: 0 !important; padding-block: 0 !important;
            }}''',
        "c-positive-overlay-ancestors": f'''{scope} #navigator-toolbox,
            {scope} #navigator-toolbox :is(toolbar, #titlebar),
            {scope} #navigator-toolbox [data-orbit-focus-island-parent="true"] {{
                height: 64px !important; min-height: 64px !important; max-height: 64px !important;
                margin: 0 !important; padding-block: 0 !important;
            }}
            {scope} #navigator-toolbox :is(toolbar, #titlebar) {{
                position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important;
            }}''',
    }

    def reset_editing():
        driver.set_context("chrome")
        editing = driver.execute_script('''return gURLBar.view.isOpen ||
            document.getElementById("urlbar-container").contains(document.activeElement);''')
        if editing:
            chord(driver, Keys.ESCAPE)
            settle_radial(driver)
        move_to_content(driver, click=True)
        wait_focus_idle(driver)

    try:
        for name, css in variants.items():
            entry = result.setdefault("focus_style_probes", {}).setdefault(name, {})
            try:
                reset_editing()
                driver.execute_script('''
                    document.getElementById("orbit-smoke-native-hit-probe")?.remove();
                    const sheet = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
                    sheet.id = "orbit-smoke-native-hit-probe";
                    sheet.textContent = arguments[0];
                    document.documentElement.append(sheet);
                ''', script_args=[css])
                for target in ("container", "input", "padding"):
                    reset_editing()
                    hover_focus_zone(driver, "address")
                    label = f"style-{name}-{target}"
                    record_focus_probe(driver, result, label + "-before")
                    point = driver.execute_script('''
                        const container = document.getElementById("urlbar-container");
                        const node = arguments[0] === "input" ? gURLBar.inputField : container;
                        const box = node.getBoundingClientRect();
                        return {x: Math.round(box.x + (arguments[0] === "padding" ? 8 : box.width / 2)),
                            y: Math.round(box.y + box.height / 2), width: box.width, height: box.height};
                    ''', script_args=[target])
                    entry[target] = {"point": point}
                    pointer(driver).pointer_move(point["x"], point["y"], duration=35, origin="viewport").click().perform()
                    settle_radial(driver)
                    record_focus_probe(driver, result, label + "-after")
                    entry[target]["state"] = focus_state(driver)
                    screenshot(driver, folder, f"ux-focus-probe-{name}-{target}", result)
            except Exception:
                entry["error"] = traceback.format_exc()
                record_focus_probe(driver, result, f"style-{name}-failure")
            finally:
                try:
                    reset_editing()
                except Exception:
                    entry["cleanup_error"] = traceback.format_exc()
                finally:
                    driver.execute_script('document.getElementById("orbit-smoke-native-hit-probe")?.remove();')
    finally:
        driver.execute_script('document.getElementById("orbit-smoke-native-hit-probe")?.remove();')
        result["diagnostic_styles_removed"] = driver.execute_script('return !document.getElementById("orbit-smoke-native-hit-probe");')


def hover_focus_zone(driver, zone):
    """Move from real content into the native chrome's independently owned hotzone."""
    driver.set_context("chrome")
    point = driver.execute_script('''
        const node = document.getElementById(arguments[0]);
        const box = node.getBoundingClientRect();
        if (node.hidden || !box.width || !box.height) throw new Error("Focus hotzone is not available");
        return {x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2)};
    ''', script_args=[f"orbit-focus-{zone}-hotzone"])
    pointer(driver).pointer_move(point["x"], point["y"], duration=35, origin="viewport").perform()
    attribute = f"data-orbit-focus-{zone}-visible"
    wait_for(driver, 'return document.documentElement.getAttribute(arguments[0]) === "true";',
             f"trusted pointer reveals only the native {zone} island", [attribute])
    settle_radial(driver)
    return focus_state(driver)


def move_to_content(driver, click=False):
    driver.set_context("chrome")
    point = driver.execute_script('return {x: Math.round(innerWidth / 2), y: Math.round(innerHeight * .68)};')
    action = pointer(driver).pointer_move(point["x"], point["y"], duration=35, origin="viewport")
    if click:
        action.click()
    action.perform()


def wait_focus_idle(driver):
    wait_for(driver, '''
        const root = document.documentElement;
        return root.getAttribute("data-orbit-focus") === "true" &&
            !["address", "window", "tools"].some(name =>
                root.getAttribute("data-orbit-focus-" + name + "-visible") === "true") &&
            root.getAttribute("data-orbit-focus-address-expanded") !== "true";
    ''', "each floating island recedes independently after native focus returns to content")
    settle_radial(driver)


def assert_focus_geometry(state, compact=None):
    assert state["enabled"] and state["addressMarked"] and state["chipVisible"], state
    assert state["tabVisibility"] == "hidden", state
    if state["addressVisible"]:
        box = state["address"]
        assert box["visibility"] == "visible" and box["width"] > 180 and box["height"] > 20, state
        assert 0 <= box["x"] < box["right"] <= state["viewport"]["width"] + 1, state
        assert 0 <= box["y"] < box["bottom"] < 140, state
        assert abs((box["x"] + box["right"]) / 2 - state["viewport"]["width"] / 2) < 3, state
        assert box["radius"] != "0px" and box["shadow"] != "none", state
        if compact is not None:
            assert box["width"] > compact["address"]["width"] + 60, (compact, state)
    if state["windowVisible"]:
        visible = [box for box in state["windowControls"]
                   if box["visibility"] == "visible" and box["width"] > 0 and box["height"] > 0]
        assert visible, state
        for box in visible:
            assert 0 <= box["x"] < box["right"] <= state["viewport"]["width"] + 1, state
            assert 0 <= box["y"] < box["bottom"] < 100, state
            assert box["radius"] != "0px" and box["shadow"] != "none", state


def tools_state(driver):
    return driver.execute_script('''
        const root = document.getElementById(arguments[0]);
        const visible = !!root && !root.hidden && !root.classList.contains("orbit-radial-leaving") &&
            getComputedStyle(root).display !== "none";
        return {visible, mode: root?.dataset.mode,
            items: visible ? [...root.querySelectorAll("[data-orbit-id]")].map(node => ({
                id: node.dataset.orbitId, disabled: node.getAttribute("aria-disabled") === "true",
                depth: Number(node.dataset.orbitDepth ?? -1),
                submenu: node.getAttribute("aria-haspopup") === "menu"})) : []};
    ''', script_args=[TOOLS_ROOT_ID])


def hover_tool(driver, action_id, duration=35):
    point = driver.execute_script('''
        const root = document.getElementById(arguments[0]);
        const node = [...root.querySelectorAll("[data-orbit-id]")].find(item => item.dataset.orbitId === arguments[1]);
        if (!node || node.getAttribute("aria-disabled") === "true") throw new Error("Missing enabled native tool: " + arguments[1]);
        return {x: Number(node.dataset.orbitX), y: Number(node.dataset.orbitY)};
    ''', script_args=[TOOLS_ROOT_ID, action_id])
    pointer(driver).pointer_move(round(point["x"]), round(point["y"]), duration=duration, origin="viewport").perform()
    wait_for(driver, '''return [...document.getElementById(arguments[0]).querySelectorAll(".orbit-radial-active")]
        .some(node => node.dataset.orbitId === arguments[1]);''', "trusted pointer reaches the native tools action",
             [TOOLS_ROOT_ID, action_id])
    settle_radial(driver)


def activate_tool(driver, action_id):
    hover_tool(driver, action_id)
    hover_tool(driver, action_id)
    pointer(driver).click().perform()


def open_tools(driver):
    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    hover_focus_zone(driver, "tools")
    wait_for(driver, '''const root = document.getElementById(arguments[0]);
        return root && !root.hidden && root.querySelector("[data-orbit-id]") &&
            getComputedStyle(root).display !== "none";''', "top-left dwell opens the tools radial", [TOOLS_ROOT_ID])
    settle_radial(driver)
    state = focus_state(driver)
    assert state["toolsOpen"] and not state["addressVisible"] and not state["windowVisible"], state
    return tools_state(driver)


def dismiss_tools(driver):
    for _ in range(8):
        if not tools_state(driver)["visible"]:
            break
        chord(driver, Keys.ESCAPE)
    wait_for(driver, '''const root = document.getElementById(arguments[0]);
        return !root || root.hidden || getComputedStyle(root).display === "none";''',
             "native tools radial dismisses without exiting focus mode", [TOOLS_ROOT_ID])
    assert focus_state(driver)["enabled"]


def assert_native_popup_anchor(driver, popup_id=None, extension_id=None):
    assert driver.execute_script('''
        const panels = [...document.querySelectorAll("panel")].filter(panel => panel.state === "open");
        const panel = arguments[0] ? document.getElementById(arguments[0]) : panels.find(panel =>
            [...panel.querySelectorAll("browser")].some(browser =>
                WebExtensionPolicy.getByURI(browser.currentURI)?.id === arguments[1]));
        const anchor = panel?.anchorNode || panel?.triggerNode;
        const rect = anchor?.getBoundingClientRect();
        const style = anchor && getComputedStyle(anchor);
        return panel?.state === "open" && !!anchor?.isConnected &&
            (anchor.classList.contains("orbit-focus-native-anchor") ||
                !!anchor.closest(".orbit-focus-native-anchor")) &&
            rect.width > 0 && rect.height > 0 && style.visibility === "visible" &&
            0 <= rect.x && rect.right <= innerWidth + 1 && 0 <= rect.y && rect.bottom <= innerHeight + 1;
    ''', script_args=[popup_id, extension_id]), "A native popup must remain anchored to its original, visible Firefox widget inside the window"


def install_extension_fixture(driver, folder):
    """Seed an isolated real extension; all action activation remains trusted input."""
    path = folder / "focus-fixture.xpi"
    manifest = {
        "manifest_version": 2, "name": "Orbit native focus fixture", "version": "1.0",
        "incognito": "not_allowed",
        "browser_specific_settings": {"gecko": {"id": EXTENSION_ID}},
        "browser_action": {"default_title": "Native focus fixture", "default_popup": "popup.html"},
    }
    with ZipFile(path, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("popup.html", '<!doctype html><meta charset="utf-8"><title>Native extension proof</title>'
                         '<style>body{font:16px system-ui;padding:18px;min-width:240px}</style>'
                         '<p id="native-focus-extension-proof">Firefox owns this extension popup.</p>')
    assert Addons(driver).install(str(path), temp=True) == EXTENSION_ID
    driver.set_context("chrome")
    wait_for(driver, 'return !!WebExtensionPolicy.getByID(arguments[0])?.active;',
             "the real temporary extension policy activates", [EXTENSION_ID])


def run_focus_checks(driver, handle, url, result, folder):
    """Verify separated focus islands against original native Firefox controls."""
    checks = result["checks"]
    select_fixture(driver, handle)
    driver.set_context("chrome")
    assert focus_state(driver)["addressVisibility"] == "visible"
    original = driver.execute_script('''
        window.orbitUXNativeAddress = document.getElementById("urlbar-container");
        window.orbitUXNativeWindowBoxes = [...document.querySelectorAll(".titlebar-buttonbox-container")]
            .map(node => ({node, parent: node.parentNode, next: node.nextSibling}));
        const box = gBrowser.selectedBrowser.getBoundingClientRect();
        return {contentTop: box.y, contentHeight: box.height};
    ''')
    install_extension_fixture(driver, folder)
    driver.execute_script('''
        window.orbitUXFocusEvents = [];
        const describe = node => ({tag: node?.localName, id: node?.id});
        for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "focus", "focusin", "blur", "focusout"]) {
            window.addEventListener(type, event => {
                if (!document.documentElement.hasAttribute("data-orbit-focus")) return;
                window.orbitUXFocusEvents.push({type, trusted: event.isTrusted, time: performance.now(),
                    target: describe(event.target), path: event.composedPath().map(describe),
                    clientX: event.clientX, clientY: event.clientY,
                    screenX: event.screenX, screenY: event.screenY,
                    button: event.button, buttons: event.buttons, active: describe(document.activeElement)});
                if (window.orbitUXFocusEvents.length > 100) window.orbitUXFocusEvents.shift();
            }, true);
        }
    ''')
    chord(driver, Keys.ALT, Keys.SHIFT, "f")
    wait_for(driver, '''return document.documentElement.getAttribute("data-orbit-focus") === "true" &&
        !document.getElementById("orbit-focus-chip").hidden;''', "trusted focus shortcut enables a visible escape control")
    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    idle = focus_state(driver)
    assert_focus_geometry(idle)
    assert idle["addressVisibility"] == "hidden" and not idle["toolsOpen"], idle
    assert driver.execute_script('''return document.getElementById("urlbar-container") === window.orbitUXNativeAddress &&
        window.orbitUXNativeWindowBoxes.every(({node, parent, next}) =>
            node.isConnected && node.parentNode === parent && node.nextSibling === next);''')
    content = driver.execute_script('''const box = gBrowser.selectedBrowser.getBoundingClientRect();
        return {top: box.y, height: box.height};''')
    assert content["top"] < original["contentTop"] and content["height"] > original["contentHeight"], (original, content)
    record_focus_probe(driver, result, "initial-idle")
    screenshot(driver, folder, "ux-focus-initial-idle", result)
    checks.append("Idle focus mode gives real content more space while retaining the original native address and window-control nodes in their original parents")

    compact = hover_focus_zone(driver, "address")
    assert_focus_geometry(compact)
    assert compact["addressVisible"] and not compact["addressExpanded"] and not compact["focusedAddress"], compact
    assert not compact["windowVisible"] and not compact["toolsVisible"], compact
    assert driver.execute_script('''
        const input = gURLBar.inputField, box = input.getBoundingClientRect();
        const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return document.getElementById("urlbar-container").contains(target);
    '''), "The approach sensor must not intercept clicks on the revealed native input"
    record_focus_probe(driver, result, "compact-before-click")
    screenshot(driver, folder, "ux-focus-initial-address-compact", result)
    left_click(driver, "urlbar-container")
    record_focus_probe(driver, result, "compact-after-click")
    wait_for(driver, '''return gURLBar.focused &&
        document.documentElement.getAttribute("data-orbit-focus-address-expanded") === "true";''',
             "a trusted click expands and focuses the original native address bar")
    settle_radial(driver)
    expanded = focus_state(driver)
    record_focus_probe(driver, result, "expanded-after-click")
    screenshot(driver, folder, "ux-focus-initial-address-expanded", result)
    assert_focus_geometry(expanded, compact)
    assert not expanded["windowVisible"] and not expanded["toolsVisible"], expanded
    checks.append("Approaching the top center reveals a compact floating address island; clicking it expands and focuses the original Firefox URL bar independently")

    chord(driver, Keys.CONTROL, "a")
    address = driver.execute_script("return gURLBar.inputField;")
    address.send_keys(url + "focus-address-proof")
    wait_for(driver, '''return gURLBar.view.isOpen && gURLBar.inputField.value === arguments[0];''',
             "trusted address typing uses Firefox's native autocomplete view", [url + "focus-address-proof"])
    assert focus_state(driver)["addressExpanded"] and focus_state(driver)["enabled"]
    assert driver.execute_script('''
        const view = document.querySelector(".urlbarView");
        const rect = view.getBoundingClientRect();
        return !!gURLBar.inputField.closest("toolbar") && view.matches(":popover-open") &&
            rect.width > 300 && rect.height > 20 && rect.bottom >
                document.getElementById("urlbar-container").getBoundingClientRect().bottom;
    '''), "The floating native address must retain its real top-layer suggestions outside the hidden toolbar"
    chord(driver, Keys.ESCAPE)
    wait_for(driver, "return !gURLBar.view.isOpen;", "Escape dismisses native address suggestions")
    assert focus_state(driver)["enabled"], "Closing autocomplete unexpectedly exited focus mode"
    chord(driver, Keys.CONTROL, "l")
    wait_for(driver, '''return gURLBar.focused &&
        document.documentElement.getAttribute("data-orbit-focus-address-expanded") === "true";''',
             "Ctrl+L expands and selects the native floating URL bar")
    address = driver.execute_script("return gURLBar.inputField;")
    address.send_keys(url + "focus-address-proof")
    wait_for(driver, 'return gURLBar.view.isOpen && document.querySelector(".urlbarView-row");',
             "native autocomplete repaints its visit suggestion")
    point = driver.execute_script('''
        const row = [...document.querySelectorAll(".urlbarView-row")].find(row => !row.hidden);
        const box = row.getBoundingClientRect();
        if (!box.width || !box.height) throw new Error("Native URL suggestion is not rendered");
        return {x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2)};
    ''')
    pointer(driver).pointer_move(point["x"], point["y"], duration=35, origin="viewport").click().perform()
    wait_for(driver, 'return gBrowser.selectedBrowser.currentURI.spec === arguments[0];',
             "a trusted suggestion click navigates the actual Gecko browser from the native address island", [url + "focus-address-proof"])
    driver.set_context("content")
    wait_for(driver, 'return document.title === "Orbit radial focus-address-proof" && !!document.getElementById("fixture-proof");',
             "the typed real HTTP document renders")
    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    checks.append("The expanded address island keeps real top-layer Firefox autocomplete, Escape-to-dismiss, Ctrl+L selection, and trusted suggestion navigation without leaving focus mode")

    for label, values in (("Alt+D", (Keys.ALT, "d")),
                          ("Ctrl+K", (Keys.CONTROL, "k")), ("F6", (Keys.F6,))):
        chord(driver, *values)
        wait_for(driver, '''return gURLBar.focused &&
            document.documentElement.getAttribute("data-orbit-focus-address-expanded") === "true";''',
                 f"{label} keeps its real native address/search focus in the floating island")
        assert focus_state(driver)["enabled"]
        move_to_content(driver, click=True)
        wait_focus_idle(driver)
    checks.append("Native Alt+D, Ctrl+K search, and F6 focus traversal reveal and focus the original address field without exposing the other islands")

    driver.execute_script('''
        window.orbitUXCustomizableUI = ChromeUtils.importESModule(
            "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs").CustomizableUI;
        if (window.orbitUXCustomizableUI.getPlacementOfWidget("search-container"))
            throw new Error("The disposable profile unexpectedly starts with a custom search widget");
        window.orbitUXCustomizableUI.addWidgetToArea("search-container", window.orbitUXCustomizableUI.AREA_NAVBAR);
    ''')
    try:
        wait_for(driver, 'return !!document.getElementById("searchbar");', "Firefox creates its actual customized search widget")
        chord(driver, Keys.CONTROL, "k")
        wait_for(driver, '''const search = document.getElementById("searchbar");
            return search?.contains(document.activeElement) &&
                document.documentElement.getAttribute("data-orbit-focus-reveal") === "true" &&
                getComputedStyle(search).visibility === "visible";''',
                 "Ctrl+K reveals and focuses Firefox's real custom search widget")
        assert focus_state(driver)["enabled"]
        move_to_content(driver, click=True)
        wait_for(driver, 'return !document.documentElement.hasAttribute("data-orbit-focus-reveal");',
                 "the full native strip recedes again after custom search loses focus")
        wait_focus_idle(driver)
        assert focus_state(driver)["tabVisibility"] == "hidden"
    finally:
        driver.set_context("chrome")
        driver.execute_script('window.orbitUXCustomizableUI.removeWidgetFromArea("search-container");')
    checks.append("A genuinely customized native search widget retains Ctrl+K focus through a temporary toolbar reveal, which recedes again when focus returns to the webpage")

    previous = set(driver.window_handles)
    chord(driver, Keys.CONTROL, "t")
    canvas = new_handle(driver, previous, "Focus-mode native New Tab shortcut")
    native_canvas_ready(driver)
    wait_for(driver, '''return gURLBar.focused && !gURLBar.value &&
        document.documentElement.getAttribute("data-orbit-focus-address-expanded") === "true";''',
             "Ctrl+T retains the empty native address focus above a new real canvas tab")
    assert focus_state(driver)["enabled"]
    driver.switch_to_window(canvas, focus=False)
    chord(driver, Keys.CONTROL, "w")
    select_fixture(driver, handle)
    driver.set_context("chrome")
    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    checks.append("Native Ctrl+T opens a real canvas tab with an expanded empty address island, and Ctrl+W restores the website without exiting focus mode")

    controls = hover_focus_zone(driver, "window")
    assert_focus_geometry(controls)
    assert controls["windowVisible"] and not controls["addressVisible"] and not controls["toolsVisible"], controls
    assert driver.execute_script('''
        return [...document.querySelectorAll('[data-orbit-focus-window-controls="true"]')]
            .every(node => window.orbitUXNativeWindowBoxes.some(entry => entry.node === node));
    '''), "The window island must expose original OS controls rather than cloned buttons"
    move_to_content(driver)
    wait_focus_idle(driver)
    checks.append("Approaching the top right independently reveals rounded original minimize, maximize, and close controls; leaving the island hides them")

    state = open_tools(driver)
    assert state["mode"] == "focus-tools" and state["items"], state
    # A continuous diagonal approach must survive longer than the conceal
    # timer while crossing decorative gaps in the native circular menu.
    hover_tool(driver, "orbit-focus-settings", duration=850)
    wait_for(driver, '''return [...document.getElementById(arguments[0]).querySelectorAll("[data-orbit-id]")]
        .some(node => node.dataset.orbitId === "orbit-focus-preferences");''',
             "the settings branch opens a locally anchored tools fan", [TOOLS_ROOT_ID])
    settle_radial(driver)
    assert driver.execute_script('''const root = document.getElementById(arguments[0]);
        return [...root.querySelectorAll(".orbit-radial-ring")].some(ring =>
            Number(ring.dataset.orbitDepth) > 0 && ring.classList.contains("orbit-radial-fan") &&
            Number(ring.dataset.orbitSpan) < Math.PI * 2 - .01);''', script_args=[TOOLS_ROOT_ID])
    dismiss_tools(driver)
    move_to_content(driver)
    wait_focus_idle(driver)
    checks.append("Top-left dwell opens a separate circular tools radial, a slow continuous corner-to-menu approach remains usable, settings fan from their parent, and Escape preserves focus mode")

    open_tools(driver)
    activate_tool(driver, "orbit-focus-downloads")
    wait_for(driver, 'return document.getElementById("downloadsPanel")?.state === "open";',
             "the radial downloads action opens the original native downloads panel")
    assert_native_popup_anchor(driver, "downloadsPanel")
    assert focus_state(driver)["enabled"] and not tools_state(driver)["visible"]
    chord(driver, Keys.ESCAPE)
    wait_for(driver, 'return document.getElementById("downloadsPanel")?.state === "closed";',
             "Escape closes the native downloads panel")
    assert focus_state(driver)["enabled"]
    checks.append("The tools Downloads leaf opens Firefox's original panel, and native popup dismissal preserves focus mode")

    open_tools(driver)
    hover_tool(driver, "orbit-focus-settings")
    previous = set(driver.window_handles)
    activate_tool(driver, "orbit-focus-preferences")
    preferences = new_handle(driver, previous, "Native settings radial action")
    driver.switch_to_window(preferences)
    driver.set_context("chrome")
    wait_for(driver, 'return gBrowser.selectedBrowser.currentURI.spec.startsWith("about:preferences");',
             "the tools Settings leaf opens Firefox's real preferences tab")
    assert focus_state(driver)["enabled"]
    chord(driver, Keys.CONTROL, "w")
    driver.switch_to_window(handle)
    driver.set_context("chrome")
    checks.append("The tools Settings leaf opens the real native preferences tab, and closing that tab restores the website in focus mode")

    open_tools(driver)
    hover_tool(driver, "orbit-focus-extensions")
    activate_tool(driver, "orbit-focus-extensions-panel")
    wait_for(driver, 'return document.getElementById("unified-extensions-panel")?.state === "open";',
             "the tools Extensions panel leaf opens Firefox's original extension-management popup")
    assert_native_popup_anchor(driver, "unified-extensions-panel")
    wait_for(driver, '''return [...document.querySelectorAll("unified-extensions-item")]
        .some(node => node.getAttribute("extension-id") === arguments[0]);''',
             "the native extension panel contains the actual temporary extension", [EXTENSION_ID])
    assert focus_state(driver)["enabled"]
    chord(driver, Keys.ESCAPE)
    wait_for(driver, 'return document.getElementById("unified-extensions-panel")?.state === "closed";',
             "Escape closes the native extensions panel")
    assert focus_state(driver)["enabled"]
    open_tools(driver)
    hover_tool(driver, "orbit-focus-extensions")
    activate_tool(driver, f"orbit-focus-extension:{EXTENSION_ID}")
    wait_for(driver, '''
        return [...document.querySelectorAll("panel")].filter(panel => panel.state === "open")
            .flatMap(panel => [...panel.querySelectorAll("browser")]).some(browser =>
            browser.currentURI?.spec.endsWith("/popup.html") &&
            WebExtensionPolicy.getByURI(browser.currentURI)?.id === arguments[0]);
    ''', "the radial browser action opens its actual Firefox-owned extension popup", [EXTENSION_ID])
    assert_native_popup_anchor(driver, extension_id=EXTENSION_ID)
    assert focus_state(driver)["enabled"] and not tools_state(driver)["visible"]
    chord(driver, Keys.ESCAPE)
    wait_for(driver, '''return ![...document.querySelectorAll("panel")].filter(panel => panel.state === "open")
        .flatMap(panel => [...panel.querySelectorAll("browser")]).some(browser =>
        WebExtensionPolicy.getByURI(browser.currentURI)?.id === arguments[0]);''',
             "native extension popup dismissal removes its remote popup browser", [EXTENSION_ID])
    assert focus_state(driver)["enabled"]
    checks.append("The tools extension fan preserves Firefox's original extension panel and activates a real installed extension's original browser action and isolated popup")

    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    driver.set_window_rect(width=900, height=760)
    settle_radial(driver)
    compact_narrow = hover_focus_zone(driver, "address")
    assert_focus_geometry(compact_narrow)
    left_click(driver, "urlbar-container")
    settle_radial(driver)
    assert_focus_geometry(focus_state(driver), compact_narrow)
    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    assert_focus_geometry(hover_focus_zone(driver, "window"))
    move_to_content(driver)
    wait_focus_idle(driver)
    open_tools(driver)
    dismiss_tools(driver)
    driver.maximize_window()
    settle_radial(driver)
    assert_focus_geometry(hover_focus_zone(driver, "window"))
    move_to_content(driver)
    wait_focus_idle(driver)
    assert_focus_geometry(hover_focus_zone(driver, "address"))
    driver.set_window_rect(width=1400, height=1000)
    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    checks.append("Compact and expanded native address islands, corner controls, and tools remain inside the viewport after resizing, maximizing, and restoring the window")

    chord(driver, Keys.ESCAPE)
    wait_for(driver, 'return !document.documentElement.hasAttribute("data-orbit-focus");', "Escape exits idle focus mode")
    assert not focus_state(driver)["chipVisible"] and focus_state(driver)["addressVisibility"] == "visible"
    assert driver.execute_script('''return document.getElementById("urlbar-container") === window.orbitUXNativeAddress &&
        window.orbitUXNativeWindowBoxes.every(({node, parent, next}) =>
            node.isConnected && node.parentNode === parent && node.nextSibling === next) &&
        !document.querySelector('[data-orbit-focus-address], [data-orbit-focus-window-controls]');''')
    checks.append("Escape from idle focus restores the ordinary browser layout and removes every native-control focus marker")

    chord(driver, Keys.ALT, Keys.SHIFT, "f")
    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    left_click(driver, "orbit-focus-reveal")
    wait_for(driver, '''return gURLBar.focused &&
        document.documentElement.getAttribute("data-orbit-focus-address-expanded") === "true";''',
             "the visible focus chip expands the address island")
    left_click(driver, "orbit-focus-exit")
    wait_for(driver, 'return !document.documentElement.hasAttribute("data-orbit-focus");', "focus chip exits focus mode")
    checks.append("The visible Address bar and Exit focus chip buttons remain physically reachable and restore native browser focus")

    # Preserve Firefox's alternative tab layout and the row that owns OS buttons.
    driver.execute_script('Services.prefs.setBoolPref("sidebar.verticalTabs", true);')
    wait_for(driver, 'return document.getElementById("sidebar-container")?.contains(document.getElementById("tabbrowser-tabs"));',
             "Firefox moves its real tab strip into the native vertical-tabs sidebar")
    sidebar_width = driver.execute_script('return document.getElementById("sidebar-container").getBoundingClientRect().width;')
    chord(driver, Keys.ALT, Keys.SHIFT, "f")
    move_to_content(driver, click=True)
    wait_focus_idle(driver)
    assert driver.execute_script('return document.getElementById("sidebar-container").getBoundingClientRect().width < 1;')
    assert_focus_geometry(hover_focus_zone(driver, "window"))
    move_to_content(driver)
    wait_focus_idle(driver)
    assert_focus_geometry(hover_focus_zone(driver, "address"))
    left_click(driver, "orbit-focus-exit")
    wait_for(driver, 'return !document.documentElement.hasAttribute("data-orbit-focus");', "focus exit restores vertical tabs")
    assert driver.execute_script('return document.getElementById("sidebar-container").getBoundingClientRect().width;') >= sidebar_width - 1
    driver.execute_script('Services.prefs.clearUserPref("sidebar.verticalTabs");')
    wait_for(driver, 'return !document.getElementById("sidebar-container")?.contains(document.getElementById("tabbrowser-tabs"));',
             "the original horizontal native tab layout returns")
    checks.append("Focus hides the actual vertical tab strip, reveals OS controls from their native navigation-row owner, and restores the original sidebar width on exit")

    driver.set_context("content")
    driver.navigate(url)
    wait_for(driver, 'return !!document.getElementById("fixture-proof");', "the original capture fixture returns after address navigation")
    driver.set_context("chrome")


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

    run_focus_checks(driver, handle, url, result, folder)

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
        move_to_content(driver, click=True)
        wait_focus_idle(driver)
        color = "dark" if dark else "light"
        screenshot(driver, folder, f"ux-focus-{color}", result)
        compact = hover_focus_zone(driver, "address")
        assert_focus_geometry(compact)
        assert not compact["addressExpanded"] and not compact["focusedAddress"], compact
        screenshot(driver, folder, f"ux-focus-address-compact-{color}", result)
        left_click(driver, "urlbar-container")
        wait_for(driver, '''return gURLBar.focused &&
            document.documentElement.getAttribute("data-orbit-focus-address-expanded") === "true";''',
                 "native address expands before visual signoff")
        settle_radial(driver)
        assert_focus_geometry(focus_state(driver), compact)
        screenshot(driver, folder, f"ux-focus-address-expanded-{color}", result)
        move_to_content(driver, click=True)
        wait_focus_idle(driver)
        assert_focus_geometry(hover_focus_zone(driver, "window"))
        screenshot(driver, folder, f"ux-focus-window-{color}", result)
        move_to_content(driver)
        wait_focus_idle(driver)
        open_tools(driver)
        hover_tool(driver, "orbit-focus-extensions")
        wait_for(driver, '''return [...document.getElementById(arguments[0]).querySelectorAll("[data-orbit-id]")]
            .some(node => node.dataset.orbitId === arguments[1]);''', "the actual extension browser action paints in its native tools fan",
                 [TOOLS_ROOT_ID, f"orbit-focus-extension:{EXTENSION_ID}"])
        screenshot(driver, folder, f"ux-focus-tools-{color}", result)
        dismiss_tools(driver)
        left_click(driver, "orbit-focus-exit")
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
    chord(driver, Keys.ALT, Keys.SHIFT, "f")
    state = open_tools(driver)
    hover_tool(driver, "orbit-focus-extensions")
    assert not any(item["id"] == f"orbit-focus-extension:{EXTENSION_ID}" for item in tools_state(driver)["items"]), state
    dismiss_tools(driver)
    left_click(driver, "orbit-focus-exit")
    checks.append("The focus tools extension fan preserves the real extension's private-window permission and excludes a not-allowed browser action")
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
    Addons(driver).uninstall(EXTENSION_ID)
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
                record_focus_probe(driver, result, "failure")
                result["failure_radial"] = radial_state(driver)
                result["failure_board"] = board(driver)
                screenshot(driver, report.parent, "ux-failure", result)
                if "a trusted click expands and focuses the original native address bar" in result["error"]:
                    diagnose_focus_hit_testing(driver, result, report.parent)
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
