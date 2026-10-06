/* SPDX-License-Identifier: MPL-2.0 */
// These exercise original native action routing, live permissions, and anchor
// ownership. Real Gecko input/popup positioning is covered by smoke_ux.py.
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";

class Target {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, properties = {}) { for (const callback of this.listeners.get(type) || []) callback({type, ...properties}); }
  count() { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
}
class Node extends Target {
  constructor(doc, id = "") {
    super(); this.ownerDocument = doc; this.id = id; this.children = [];
    this.isConnected = true; this.attributes = new Map(); this.classes = new Set();
    this.styles = new Map(); this.style = {
      setProperty: (name, value, priority = "") => this.styles.set(name, [String(value), priority]),
      getPropertyValue: name => this.styles.get(name)?.[0] || "",
      getPropertyPriority: name => this.styles.get(name)?.[1] || "",
      removeProperty: name => this.styles.delete(name),
    };
    this.classList = {add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name)};
  }
  append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.parentNode = this; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  querySelector(selector) { return selector === ".unified-extensions-item-action-button" ? this.actionButton : null; }
  querySelectorAll() { return this.options || []; }
  focus() { this.ownerDocument.activeElement = this; }
  remove() { this.isConnected = false; }
  hidePopup() { this.hiddenCalls = (this.hiddenCalls || 0) + 1; }
}
class View {
  constructor(win, options) { this.win = win; this.options = options; }
  show(model) {
    this.model = model;
    this.root ||= new Node(this.win.document, `${this.options.idPrefix}-root`);
    this.panel ||= new Node(this.win.document, `${this.options.idPrefix}-menu`);
    this.root.append(this.panel);
    this.geometry = {center: {x: 220, y: 220}, radius: 135};
    if (model.focus) this.panel.focus();
  }
  refresh(update) { Object.assign(this.model, update); }
  hide(reason) { this.model?.onDismiss(reason); this.hidden = reason; }
  destroy() { this.destroyed = true; this.root?.remove(); }
}
const calls = [];
const modules = {OrbitRadialView: View, OrbitRadial: {dismiss: (win, reason) => calls.push(["dismiss", win, reason])},
  Orbit: {openBoard: win => calls.push(["canvas", win])}};
globalThis.ChromeUtils = {defineESModuleGetters(target, getters) {
  for (const name of Object.keys(getters)) Object.defineProperty(target, name, {get: () => modules[name]});
}};
const {OrbitFocusTools, focusExtensionItems} = await import("../overlay/browser/components/orbit/OrbitFocusTools.sys.mjs");

function fixture() {
  const win = new Target(); win.innerWidth = 1280; win.innerHeight = 800;
  const doc = {createElementNS: () => new Node(doc), nodes: new Map()};
  doc.documentElement = new Node(doc, "root");
  doc.getElementById = id => doc.nodes.get(id) || null;
  win.document = doc;
  for (const id of ["navigator-toolbox", "downloads-button", "unified-extensions-button", "PanelUI-menu-button"]) {
    doc.nodes.set(id, new Node(doc, id)); doc.documentElement.append(doc.nodes.get(id));
  }
  const browser = new Node(doc, "browser");
  const tab = {linkedBrowser: browser};
  win.gBrowser = {selectedBrowser: browser, selectedTab: tab, tabContainer: new Target()};
  doc.activeElement = browser;
  win.policies = [];
  win.gUnifiedExtensions = {
    getActivePolicies: () => win.policies.filter(policy => policy.active !== false && policy.canAccessWindow(win)),
    browserActionFor: policy => policy.delegate,
    openPanel: (...args) => calls.push(["extensions-panel", win, ...args]),
  };
  win.DownloadsPanel = {showPanel: (...args) => calls.push(["downloads", win, ...args])};
  win.PanelUI = {show: event => calls.push(["browser-menu", win, event]),
    showSubView: (...args) => calls.push(["subview", win, ...args]), showMoreToolsPanel: (...args) => calls.push(["more-tools", win, ...args])};
  win.openPreferences = (...args) => calls.push(["preferences", win, ...args]);
  win.BrowserAddonUI = {openAddonsMgr: (...args) => calls.push(["addons", win, ...args])};
  win.PlacesCommandHook = {bookmarkPage: () => calls.push(["bookmark", win]), showPlacesOrganizer: (...args) => calls.push(["library", win, ...args])};
  win.gCustomizeMode = {enter: () => calls.push(["customize", win])};
  const timers = new Map(); let serial = 0;
  win.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, {fn, ms}); return id; };
  win.clearTimeout = id => timers.delete(id);
  const callbacks = {onVisibilityChange: visible => calls.push(["visible", win, visible]),
    onNativePopup: (popup, opened) => calls.push(["popup", win, popup, opened]),
    onCommands: () => calls.push(["commands", win]), onExit: () => calls.push(["exit", win])};
  const tools = new OrbitFocusTools(win, callbacks); tools.setEnabled(true);
  return {win, doc, tools, timers, browser, tab, flush(ms = null) {
    for (const [id, timer] of [...timers]) if (ms === null || timer.ms === ms) { timers.delete(id); timer.fn(); }
  }};
}
function extension(f, {id = "capture@test", allowed = true, enabled = true, popup = "", connected = true} = {}) {
  const node = new Node(f.doc, `${id}-widget`); node.isConnected = connected;
  const button = new Node(f.doc, `${id}-action`); node.actionButton = button; node.append(button);
  const state = {enabled, popup, allowed};
  const widget = {node, anchor: button};
  const delegate = {widget: {forWindow: win => win === f.win ? widget : null},
    action: {isShownForTab: () => state.enabled, getProperty: () => "Capture extension", getPopupUrl: () => state.popup},
    triggerAction: win => calls.push(["native-action", win, id])};
  const policy = {id, canAccessWindow: win => state.allowed && win === f.win, delegate, extension: {name: "Capture"}};
  f.win.policies.push(policy);
  return {policy, node, button, widget, state, delegate};
}
const pointer = properties => ({isTrusted: true, type: "pointerup", button: 0, ...properties});
const key = properties => ({isTrusted: true, type: "keydown", key: "Enter", ...properties});
const act = (f, id, event = pointer()) => f.tools.activate({id}, event);

test("hover opens without taking text focus, corridor retains slow mouse transit, and keyboard trigger focuses", () => {
  const f = fixture(); const input = new Node(f.doc, "page-input"); input.focus();
  f.tools.open(); assert.equal(f.doc.activeElement, input); assert.equal(f.tools.view.model.focus, false);
  assert.equal(f.tools.ownsPointer(30, 30), true); assert.equal(f.tools.ownsPointer(155, 155), true);
  assert.equal(f.tools.ownsPointer(850, 350), false); assert.equal(f.tools.ownsPointer(NaN, 15), false);
  f.tools.close("conceal"); assert.equal(f.doc.activeElement, input);
  const event = {isTrusted: true, key: "Enter", preventDefault() {}, stopPropagation() {}};
  f.tools.trigger.emit("keydown", event); assert.equal(f.doc.activeElement, f.tools.view.panel);
  assert.equal(f.tools.trigger.getAttribute("aria-expanded"), "true"); f.tools.destroy();
});
test("extension discovery excludes absent or private-forbidden widgets and reads current disabled state without executing", () => {
  const f = fixture(); const before = calls.length;
  const enabled = extension(f); extension(f, {id: "private@test", allowed: false}); extension(f, {id: "detached@test", connected: false});
  const disabled = extension(f, {id: "disabled@test", enabled: false});
  const items = focusExtensionItems(f.win); assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id.endsWith("disabled@test")).disabled, true);
  enabled.state.enabled = false; disabled.state.enabled = true;
  const updated = focusExtensionItems(f.win); assert.equal(updated[0].disabled, true); assert.equal(updated[1].disabled, false);
  assert.equal(calls.length, before); f.tools.destroy();
});
test("hover conceal preserves native address focus and keyboard dismissal restores its original input", () => {
  const f = fixture(); const address = new Node(f.doc, "urlbar-container"); const input = new Node(f.doc, "urlbar-input");
  address.append(input); f.doc.nodes.set(address.id, address); f.doc.nodes.get("navigator-toolbox").append(address);
  let reveals = 0; f.tools.callbacks.onAddressReveal = () => reveals++;
  input.focus(); f.tools.open(); f.tools.close("conceal"); assert.equal(f.doc.activeElement, input); assert.equal(reveals, 0);
  f.tools.open({focus: true}); assert.equal(f.doc.activeElement, f.tools.view.panel);
  f.tools.close("escape"); assert.equal(f.doc.activeElement, input); assert.equal(reveals, 1); f.tools.destroy();
});
test("untrusted and modified events cannot execute commands or extension actions", () => {
  const f = fixture(); extension(f); f.tools.open();
  const before = calls.length;
  for (const event of [pointer({isTrusted: false}), pointer({button: 2}), pointer({ctrlKey: true}), key({isTrusted: false}), key({altKey: true}), key({isComposing: true}), key({repeat: true})]) {
    act(f, "orbit-focus-extension:capture@test", event); act(f, "orbit-focus-preferences", event);
  }
  assert.equal(calls.length, before); assert.equal(f.tools.visible, true); f.tools.destroy();
});
test("native extension delegation revalidates permissions and disabled state at activation time", () => {
  const f = fixture(); const e = extension(f); f.tools.open();
  e.state.enabled = false; act(f, "orbit-focus-extension:capture@test"); assert.equal(f.tools.visible, true);
  e.state.enabled = true; e.state.allowed = false; act(f, "orbit-focus-extension:capture@test"); assert.equal(f.tools.visible, true);
  e.state.allowed = true; e.policy.active = false; act(f, "orbit-focus-extension:capture@test"); assert.equal(f.tools.visible, true);
  e.policy.active = true; act(f, "orbit-focus-extension:capture@test");
  assert.deepEqual(calls.at(-1), ["native-action", f.win, "capture@test"]); assert.equal(f.tools.visible, false);
  assert.equal(e.button.classes.size, 0); f.tools.destroy();
});
test("real native extension popup anchor is floated without cloning or reparenting and restored after hidden", () => {
  const f = fixture(); const e = extension(f, {popup: "moz-extension://fixture/popup.html"});
  e.button.style.setProperty("--orbit-focus-anchor-left", "original", "important");
  const parent = e.button.parentNode; f.tools.open(); act(f, "orbit-focus-extension:capture@test", key());
  assert.equal(f.tools.anchor, e.button); assert.equal(e.button.parentNode, parent);
  assert.equal(e.button.classList.contains("orbit-focus-native-anchor"), true); assert.equal(f.tools.pendingNative, true);
  const popup = new Node(f.doc, "customizationui-widget-panel"); popup.anchorNode = e.button;
  f.win.emit("popupshowing", {target: popup}); assert.equal(f.tools.popups.has(popup), true); assert.equal(f.tools.pendingNative, false);
  f.tools.close("blur"); assert.equal(f.tools.anchor, e.button);
  e.button.focus();
  f.win.emit("popuphidden", {target: popup}); f.flush(0);
  assert.equal(f.tools.anchor, null); assert.equal(e.button.classList.contains("orbit-focus-native-anchor"), false);
  assert.equal(f.doc.activeElement, f.browser);
  assert.equal(e.button.style.getPropertyValue("--orbit-focus-anchor-left"), "original");
  assert.equal(e.button.style.getPropertyPriority("--orbit-focus-anchor-left"), "important"); f.tools.destroy();
});
test("Downloads and extension controls use original controllers with a visible original anchor", () => {
  const f = fixture(); f.tools.open(); act(f, "orbit-focus-downloads");
  assert.deepEqual(calls.at(-1), ["downloads", f.win, true, false]);
  assert.equal(f.tools.anchor, f.doc.nodes.get("downloads-button"));
  f.flush(2500); assert.equal(f.tools.anchor, null);
  f.tools.open(); act(f, "orbit-focus-extensions-panel");
  assert.deepEqual(calls.at(-1), ["extensions-panel", f.win, null, "extensions_panel_showing"]);
  assert.equal(f.tools.anchor, f.doc.nodes.get("unified-extensions-button")); f.tools.destroy();
});
test("native libraries, settings and manager remain browser features and never navigate arbitrary menu URLs", () => {
  const f = fixture();
  for (const [id, result] of [
    ["orbit-focus-preferences", ["preferences", f.win]],
    ["orbit-focus-privacy", ["preferences", f.win, "privacy"]],
    ["orbit-focus-manage-extensions", ["addons", f.win, "addons://list/extension"]],
    ["orbit-focus-history-library", ["library", f.win, "History"]],
    ["orbit-focus-bookmarks-library", ["library", f.win, "AllBookmarks"]],
  ]) { f.tools.open(); act(f, id, key()); assert.deepEqual(calls.at(-1), result); }
  f.tools.open(); const before = calls.length; f.tools.activate({id: "javascript:alert(1)", url: "https://unsafe.test"}, pointer());
  assert.equal(calls.length, before); assert.equal(f.tools.visible, true); f.tools.destroy();
});
test("native subviews receive the real fixed original anchor and original trusted event", () => {
  const f = fixture(); const event = key(); f.tools.open(); act(f, "orbit-focus-history-panel", event);
  assert.deepEqual(calls.at(-1), ["subview", f.win, "PanelUI-history", f.doc.nodes.get("PanelUI-menu-button"), event]);
  const unrelated = new Node(f.doc, "content-select-popup"); f.win.emit("popupshowing", {target: unrelated});
  assert.equal(f.tools.popups.size, 0); f.tools.destroy();
});
test("the original anchor survives panel transitions and closes safely on focus exit", () => {
  const f = fixture(); f.tools.open(); act(f, "orbit-focus-browser-menu");
  const anchor = f.tools.anchor; const first = new Node(f.doc, "appMenu-popup"); first.anchorNode = anchor;
  const second = new Node(f.doc, "customizationui-widget-panel"); second.anchorNode = anchor;
  f.win.emit("popupshowing", {target: first}); f.win.emit("popuphidden", {target: first}); f.win.emit("popupshowing", {target: second});
  f.flush(0); assert.equal(f.tools.anchor, anchor); assert.equal(f.tools.popups.has(second), true);
  f.tools.setEnabled(false); assert.equal(second.hiddenCalls, 1); assert.equal(f.tools.anchor, null);
  assert.equal(f.tools.popups.size, 0); assert.equal(f.tools.trigger.hidden, true);
  f.tools.open(); assert.equal(f.tools.visible, false); f.tools.destroy();
});
test("rapid reopen never accumulates view root listeners and destruction clears all window listeners and timers", () => {
  const f = fixture(); f.tools.open(); const root = f.tools.view.root; const count = root.count();
  for (let i = 0; i < 30; i++) { f.tools.close("conceal"); f.tools.open(); }
  assert.equal(root.count(), count);
  f.tools.destroy(); assert.equal(f.win.count(), 0); assert.equal(f.win.gBrowser.tabContainer.count(), 0);
  assert.equal(f.timers.size, 0); assert.equal(f.tools.trigger.isConnected, false); assert.equal(f.tools.view.destroyed, true);
});
test("separate radial views have unique native IDs, gradients and focus contracts while defaults remain stable", async () => {
  const view = await readFile(new URL("../overlay/browser/components/orbit/OrbitRadialView.sys.mjs", import.meta.url), "utf8");
  const css = await readFile(new URL("../overlay/browser/base/content/orbit/orbit-radial.css", import.meta.url), "utf8");
  assert.match(view, /idPrefix = "orbit-radial"/); assert.match(view, /this\.gradientPrefix = idPrefix === "orbit-radial" \? "orbit" : idPrefix/);
  assert.match(view, /model\.focus !== false/); assert.match(view, /this\.model\.focus === false && !this\.root\.contains\(this\.doc\.activeElement\)/);
  for (const name of ["surface", "base", "active"]) assert.match(css, new RegExp(`var\\(--orbit-gradient-${name}, url\\(#orbit-gradient-${name}\\)\\)`));
});
