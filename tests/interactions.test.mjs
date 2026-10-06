/* SPDX-License-Identifier: MPL-2.0 */
// Native input and CSS layout are exercised by smoke_ux.py. These checks
// exercise window ownership, keyboard contracts and lifecycle independently.
import assert from "node:assert/strict";
import { test } from "node:test";

class Target {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback({ isTrusted: true, ...event });
  }
  listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}
class Node extends Target {
  constructor(doc, tag = "div") {
    super(); this.ownerDocument = doc; this.tagName = tag;
    this.children = []; this.attributes = new Map(); this.hidden = false;
    this.isConnected = true; this.value = ""; this.classNames = new Set();
    this.styleValues = new Map();
    this.style = { setProperty: (key, value) => this.styleValues.set(key, String(value)),
      getPropertyValue: key => this.styleValues.get(key) || "", removeProperty: key => this.styleValues.delete(key) };
    this.classList = { contains: name => this.classNames.has(name) };
  }
  set id(value) { this._id = value; this.ownerDocument.nodes.set(value, this); }
  get id() { return this._id; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  toggleAttribute(key, enabled) { if (enabled) this.setAttribute(key, ""); else this.removeAttribute(key); }
  append(...nodes) { for (const node of nodes) {
    if (node.parent) node.parent.children = node.parent.children.filter(value => value !== node);
    node.parent = this; node.isConnected = this.isConnected; this.children.push(node);
  } }
  insertBefore(node, before) {
    if (node.parent) node.parent.children = node.parent.children.filter(value => value !== node);
    node.parent = this; node.isConnected = this.isConnected;
    const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }
  get parentNode() { return this.parent || null; }
  get parentElement() { return this.parent || null; }
  get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; }
  replaceChildren(...nodes) { for (const node of this.children) node.isConnected = false; this.children = []; this.append(...nodes); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  focus() {
    const root = this.ownerDocument.documentElement;
    // A native field hidden by browser chrome cannot accept Firefox focus.
    // This gate catches missing pre-reveal before native shortcut delegation.
    if (this.closest("#urlbar-container") && root.getAttribute("data-orbit-focus") === "true" &&
        root.getAttribute("data-orbit-focus-address-visible") !== "true") return;
    if (this.closest("#search-container") && root.getAttribute("data-orbit-focus") === "true" &&
        root.getAttribute("data-orbit-focus-reveal") !== "true") return;
    this.ownerDocument.activeElement = this;
  }
  scrollIntoView() { this.scrolled = true; }
  matches(selector) {
    return selector.split(",").some(part => {
      const candidate = part.trim();
      if (candidate[0] === "#") return this.id === candidate.slice(1);
      const cls = candidate.match(/^\.([\w-]+)/);
      if (cls && !this.classNames.has(cls[1]) && !String(this.className || "").split(" ").includes(cls[1])) return false;
      const tag = candidate.match(/^[\w-]+/);
      if (tag && this.tagName !== tag[0]) return false;
      const attrs = [...candidate.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/g)];
      return !!(cls || tag || attrs.length) && attrs.every(([, key, value]) => this.hasAttribute(key) && (value === undefined || this.getAttribute(key) === value));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    if (selector === ".titlebar-buttonbox-container" && this.nativeTitlebars) return this.nativeTitlebars;
    return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return this.rect || { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}
let widget;
const calls = [];
const frames = new WeakMap();
// The tools menu owns its native actions and radial geometry in a separate
// suite. This stub only models its visibility/focus callbacks to the islands.
class FocusTools {
  constructor(win, callbacks) {
    this.win = win; this.callbacks = callbacks; this.visible = false; this.openCount = 0;
    this.root = new Node(win.document); this.root.id = "orbit-focus-tools-root";
    win.document.documentElement.append(this.root);
  }
  open() { this.openCount++; this.visible = true; this.callbacks.onVisibilityChange?.(true); }
  close() { this.visible = false; this.callbacks.onVisibilityChange?.(false); }
  contains(node) { return this.root.contains(node); }
  ownsPointer(x, y) { return this.visible && x >= 0 && x <= 300 && y >= 0 && y <= 220; }
  setEnabled(enabled) { this.enabled = !!enabled; }
  destroy() { this.close(); this.root.remove(); this.disposed = true; }
}
const modules = {
  CustomizableUI: { AREA_NAVBAR: "nav-bar", createWidget(value) { widget = value; } },
  OrbitFocusTools: FocusTools,
  OrbitRadial: { dismiss: (win, reason) => calls.push(["dismiss-radial", win, reason]) },
  Orbit: {
    getFrames: win => frames.get(win) || [],
    openBoard: win => calls.push(["canvas", win]),
    openFrame: (win, id) => calls.push(["frame", win, id]),
  },
};
globalThis.ChromeUtils = {
  defineESModuleGetters(target, getters) {
    for (const name of Object.keys(getters)) Object.defineProperty(target, name, { get: () => modules[name] });
  },
};
globalThis.Services = { appinfo: { OS: "WINNT" } };
const { InteractionWindow, OrbitInteractions, searchCommands } = await import("../overlay/browser/components/orbit/OrbitInteractions.sys.mjs");

function createWindow(isPrivate = false) {
  const win = new Target(); win.private = isPrivate;
  const doc = { nodes: new Map(), defaultView: win,
    createElementNS(ns, tag) { return new Node(this, tag); },
    getElementById(id) { return this.nodes.get(id) || null; },
    querySelector(selector) { return this.popup?.matches(selector) ? this.popup : this.documentElement.querySelector(selector); },
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); },
  };
  win.document = doc; doc.documentElement = new Node(doc, "window");
  const toolbox = new Node(doc); toolbox.id = "navigator-toolbox";
  const navigation = new Node(doc); navigation.id = "nav-bar"; toolbox.append(navigation);
  navigation.rect = { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 48, width: 1200, height: 48 };
  const container = new Node(doc); container.id = "urlbar-container"; navigation.append(container);
  const field = new Node(doc); field.id = "urlbar"; container.append(field);
  field.rect = { x: 300, y: 8, top: 8, left: 300, right: 900, bottom: 44, width: 600, height: 36 };
  const urlbar = new Node(doc); urlbar.id = "urlbar-input"; field.append(urlbar);
  const toolbarItems = new Node(doc); toolbarItems.id = "nav-bar-customization-target"; navigation.append(toolbarItems);
  const extension = new Node(doc, "toolbarbutton"); extension.id = "unified-extensions-button"; toolbarItems.append(extension);
  const settings = new Node(doc, "toolbarbutton"); settings.id = "PanelUI-menu-button"; toolbarItems.append(settings);
  const titlebar = new Node(doc); titlebar.id = "titlebar"; toolbox.append(titlebar);
  const tabs = new Node(doc); tabs.id = "TabsToolbar"; titlebar.append(tabs);
  const windowButtons = new Node(doc); windowButtons.classNames.add("titlebar-buttonbox-container"); tabs.append(windowButtons);
  windowButtons.rect = { x: 1090, y: 0, top: 0, left: 1090, right: 1200, bottom: 32, width: 110, height: 32 };
  doc.documentElement.append(toolbox);
  const timers = new Map(); let serial = 0; let now = 0;
  win.innerWidth = 1200; win.innerHeight = 800; win.screenX = 0; win.screenY = 0;
  win.performance = { now: () => now };
  win.setTimeout = (callback, delay = 0) => { timers.set(++serial, { callback, at: now + delay }); return serial; };
  win.clearTimeout = id => timers.delete(id);
  win.advance = milliseconds => {
    const end = now + milliseconds;
    for (let count = 0; count < 1000; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at; timers.delete(id); timer.callback();
    }
    now = end;
  };
  win.flushTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) timer.callback(); };
  win.timers = timers;
  win.MutationObserver = class {
    constructor(callback) { this.callback = callback; win.observer = this; }
    observations = [];
    observe(target, options) { this.observations.push({ target, options }); }
    notifyMutation(target, attributeName) {
      if (this.observations.some(observation => observation.options.attributes &&
        (target === observation.target || observation.options.subtree && observation.target.contains(target)) &&
        (!observation.options.attributeFilter || observation.options.attributeFilter.includes(attributeName)))) {
        this.callback([{ target, attributeName }]);
      }
    }
    disconnect() { this.disconnected = true; }
  };
  win.getComputedStyle = node => node.computedStyle || { display: "flex", visibility: "visible" };
  const browser = new Node(doc, "browser"); browser.currentURI = { spec: isPrivate ? "https://private.example/" : "https://example.com/" };
  const first = { label: isPrivate ? "Secret tab" : "Example", linkedBrowser: browser };
  let selected = first;
  win.gBrowser = {
    tabs: [first], tabContainer: new Target(),
    get selectedTab() { return selected; },
    set selectedTab(tab) { selected = tab; this.tabContainer.emit("TabSelect"); },
    get selectedBrowser() { return selected.linkedBrowser; },
    getTabForBrowser(value) { return this.tabs.find(tab => tab.linkedBrowser === value); },
    showTab(tab) { tab.hidden = false; },
  };
  win.gURLBar = { inputField: urlbar, view: { isOpen: false }, select() { urlbar.focus(); },
    get focused() { return doc.activeElement === urlbar; } };
  win.gUnifiedExtensions = { togglePanel: event => calls.push(["extensions", win, event]) };
  win.PanelUI = { show: event => calls.push(["settings", win, event]) };
  win.BrowserCommands = { openTab() { calls.push(["new-tab", win]); urlbar.focus(); },
    openPreferences: () => calls.push(["preferences", win]) };
  doc.activeElement = browser;
  return win;
}
function key(key, properties = {}) {
  return { key, code: "", isTrusted: true, defaultPrevented: false, ctrlKey: false, metaKey: false,
    altKey: false, shiftKey: false, repeat: false, preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; }, ...properties };
}

test("search matches all normalized words without interpreting navigation", () => {
  const commands = [{ label: "Résumé report", detail: "https://example.com/", keywords: "work" }, { label: "Other", detail: "" }];
  assert.deepEqual(searchCommands(commands, "ＲÉＳＵＭÉ work"), [commands[0]]);
  assert.deepEqual(searchCommands(commands, "https://malicious.example/"), []);
  assert.equal(searchCommands(commands, "", 1).length, 1);
});
test("trusted shortcut toggles once and uses native Mac accelerator", () => {
  const win = createWindow(); const state = new InteractionWindow(win);
  state.keydown(key(" ", { ctrlKey: true, shiftKey: true, code: "Space", isTrusted: false }));
  assert.equal(state.palette.hidden, true);
  state.keydown(key(" ", { ctrlKey: true, shiftKey: true, code: "Space" }));
  assert.equal(state.palette.hidden, false); assert.equal(win.document.activeElement, state.input);
  state.keydown(key(" ", { ctrlKey: true, shiftKey: true, code: "Space", repeat: true }));
  assert.equal(state.palette.hidden, false);
  state.keydown(key("Escape")); assert.equal(state.palette.hidden, true);
  Services.appinfo.OS = "Darwin";
  state.keydown(key(" ", { ctrlKey: true, shiftKey: true })); assert.equal(state.palette.hidden, true);
  state.keydown(key(" ", { metaKey: true, shiftKey: true })); assert.equal(state.palette.hidden, false);
  Services.appinfo.OS = "WINNT"; state.destroy();
});
test("keyboard selection wraps, updates ARIA and keeps Enter on Close safe", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.open();
  const count = state.results.length;
  state.keydown(key("ArrowUp")); assert.equal(state.selection, count - 1);
  assert.equal(state.input.getAttribute("aria-activedescendant"), `orbit-command-option-${count - 1}`);
  state.keydown(key("ArrowDown")); assert.equal(state.selection, 0);
  state.keydown(key("End")); assert.equal(state.selection, count - 1);
  state.keydown(key("Home")); assert.equal(state.selection, 0);
  const previousCalls = calls.length;
  state.keydown(key("Tab")); assert.equal(win.document.activeElement.id, "orbit-command-close");
  state.keydown(key("Enter")); assert.equal(state.palette.hidden, true); assert.equal(calls.length, previousCalls);
  state.open(); state.input.value = "no matching tab"; state.update();
  assert.equal(state.empty.hidden, false); assert.equal(state.input.hasAttribute("aria-activedescendant"), false);
  state.keydown(key("Enter")); assert.equal(state.palette.hidden, false); state.destroy();
});
test("query rerenders do not accumulate window cleanup listeners", () => {
  const state = new InteractionWindow(createWindow()); state.open(); const count = state.cleanups.length;
  for (let i = 0; i < 100; i++) { state.input.value = i % 2 ? "tab" : ""; state.update(); }
  assert.equal(state.cleanups.length, count); state.destroy();
});
test("IME confirmation never activates and native navigation closes the modal without interception", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.open();
  const before = calls.length;
  state.keydown(key("Enter", { isComposing: true }));
  assert.equal(state.palette.hidden, false); assert.equal(calls.length, before);
  const navigate = key("l", { ctrlKey: true }); state.keydown(navigate);
  assert.equal(state.palette.hidden, true); assert.equal(navigate.defaultPrevented, false);
  state.destroy();
});
test("palette returns focus to revealed toolbar or real browser after dismissing a wheel", () => {
  const win = createWindow(); const state = new InteractionWindow(win);
  const radial = new Node(win.document); radial.id = "orbit-radial-root";
  const panel = new Node(win.document); radial.append(panel); panel.focus();
  state.open(); assert.deepEqual(calls.at(-1), ["dismiss-radial", win, "command-palette"]);
  state.close(); assert.equal(win.document.activeElement, win.gBrowser.selectedBrowser);
  win.gURLBar.select(); state.open(); state.setFocusMode(true); state.close();
  assert.equal(state.revealed, true); assert.equal(win.document.activeElement.id, "urlbar-input");
  state.destroy();
});
test("tab activation expands its own group, reveals tab, and rejects stale tabs", () => {
  const win = createWindow(); const state = new InteractionWindow(win);
  const browser = new Node(win.document); browser.currentURI = { spec: "https://work.example/" };
  const tab = { label: "Grouped work", linkedBrowser: browser, hidden: true, group: { label: "Project", collapsed: true } };
  win.gBrowser.tabs.push(tab); state.open(); state.input.value = "work Project"; state.update();
  assert.equal(state.results.length, 1); const command = state.results[0]; state.keydown(key("Enter"));
  assert.equal(win.gBrowser.selectedTab, tab); assert.equal(tab.hidden, false); assert.equal(tab.group.collapsed, false);
  assert.equal(win.document.activeElement, browser);
  win.gBrowser.tabs = win.gBrowser.tabs.filter(value => value !== tab); win.gBrowser.selectedTab = win.gBrowser.tabs[0];
  command.run(); assert.notEqual(win.gBrowser.selectedTab, tab); state.destroy();
});
test("frame commands and private tabs stay in their originating window", () => {
  const normal = createWindow(); const privateWin = createWindow(true);
  frames.set(normal, [{ id: "work-frame", title: "Research board", tabCount: 2 }]);
  frames.set(privateWin, [{ id: "private-frame", title: "Secret workspace", tabCount: 1 }]);
  const normalState = new InteractionWindow(normal); const privateState = new InteractionWindow(privateWin);
  assert.equal(searchCommands(normalState.commands(), "Secret").length, 0);
  assert.equal(searchCommands(privateState.commands(), "Research").length, 0);
  privateState.open(); privateState.input.value = "Secret workspace"; privateState.update(); privateState.activate();
  assert.deepEqual(calls.at(-1), ["frame", privateWin, "private-frame"]);
  normalState.destroy(); privateState.destroy();
});
test("new tab command leaves native address-field focus intact", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.open();
  state.input.value = "New tab"; state.update(); state.keydown(key("Enter"));
  assert.deepEqual(calls.at(-1), ["new-tab", win]);
  assert.equal(win.document.activeElement.id, "urlbar-input"); state.destroy();
});
test("focus mode is reversible, restores controls and reveals before Ctrl+L", () => {
  const win = createWindow(); const state = new InteractionWindow(win); win.gURLBar.select();
  state.keydown(key("F", { altKey: true, shiftKey: true }));
  assert.equal(state.focusMode, true); assert.equal(state.chip.hidden, false);
  assert.equal(win.document.activeElement, win.gBrowser.selectedBrowser);
  assert.equal(state.root.getAttribute("data-orbit-focus"), "true");
  const revealKey = key("l", { ctrlKey: true }); state.keydown(revealKey);
  assert.equal(revealKey.defaultPrevented, false); assert.equal(state.revealed, true);
  assert.equal(state.root.getAttribute("data-orbit-focus-address-expanded"), "true");
  win.gURLBar.select(); state.scheduleConceal(); win.flushTimers(); assert.equal(state.revealed, true);
  win.gBrowser.selectedBrowser.focus(); state.scheduleConceal(); win.flushTimers(); assert.equal(state.revealed, false);
  state.keydown(key("Escape")); assert.equal(state.focusMode, false); assert.equal(state.chip.hidden, true);
  assert.equal(state.root.hasAttribute("data-orbit-focus"), false); state.destroy();
});
function islandVisible(state, island) {
  return state.root.getAttribute(`data-orbit-focus-${island}-visible`) === "true";
}
test("focus islands are independent and ignore untrusted or passing corner hovers", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  for (const island of ["address", "window", "tools"]) assert.equal(islandVisible(state, island), false);
  state.toolsHotzone.emit("mouseenter", { isTrusted: false }); win.advance(200);
  assert.equal(islandVisible(state, "tools"), false);
  state.toolsHotzone.emit("mouseenter"); win.advance(100); state.toolsHotzone.emit("mouseleave"); win.advance(100);
  assert.equal(islandVisible(state, "tools"), false, "Passing through the corner must cancel its dwell");
  state.addressHotzone.emit("mouseenter");
  assert.equal(islandVisible(state, "address"), true);
  assert.equal(state.root.hasAttribute("data-orbit-focus-address-expanded"), false, "Hover reveals the compact native address field");
  assert.equal(islandVisible(state, "window"), false); assert.equal(islandVisible(state, "tools"), false);
  state.windowHotzone.emit("mouseenter"); win.advance(139);
  assert.equal(islandVisible(state, "window"), false); win.advance(1);
  assert.equal(islandVisible(state, "window"), true); assert.equal(islandVisible(state, "tools"), false);
  assert.equal(state.root.hasAttribute("data-orbit-focus-reveal"), false, "An island must never reveal the whole toolbar");
  state.destroy();
});
test("island grace permits pointer travel and reentry cancels conceal", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  state.windowHotzone.emit("mouseenter"); win.advance(140); state.windowHotzone.emit("mouseleave");
  win.advance(349); assert.equal(islandVisible(state, "window"), true); win.advance(1);
  assert.equal(islandVisible(state, "window"), false);
  state.addressHotzone.emit("mouseenter"); state.addressHotzone.emit("mouseleave"); win.advance(250);
  state.addressHotzone.emit("mouseenter"); win.advance(200);
  assert.equal(islandVisible(state, "address"), true, "Returning to the island cancels the previous grace timeout");
  state.addressHotzone.emit("mouseleave"); win.advance(350); assert.equal(islandVisible(state, "address"), false);
  state.destroy();
});
test("native address focus expands only the address island and keeps Firefox shortcuts intact", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  const input = win.gURLBar.inputField;
  const address = win.document.getElementById("urlbar-container");
  state.keydown(key("l", { ctrlKey: true }));
  win.gURLBar.select(); address.emit("focusin", { target: input });
  assert.equal(islandVisible(state, "address"), true);
  assert.equal(state.root.getAttribute("data-orbit-focus-address-expanded"), "true");
  assert.equal(islandVisible(state, "tools"), false); assert.equal(islandVisible(state, "window"), false);
  state.scheduleConceal("address"); win.advance(1000); assert.equal(islandVisible(state, "address"), true);
  win.gBrowser.selectedBrowser.focus(); address.emit("focusout", { target: input }); win.advance(350);
  assert.equal(islandVisible(state, "address"), false);
  const shortcut = key("l", { ctrlKey: true }); state.keydown(shortcut);
  assert.equal(shortcut.defaultPrevented, false); assert.equal(islandVisible(state, "address"), true);
  assert.equal(state.root.getAttribute("data-orbit-focus-address-expanded"), "true");
  state.destroy();
});
test("clicking the compact real address island expands it without replacing the input", () => {
  const win = createWindow(); const state = new InteractionWindow(win); const input = win.gURLBar.inputField;
  const address = win.document.getElementById("urlbar-container"); state.setFocusMode(true);
  state.addressHotzone.emit("mouseenter");
  address.emit("mousedown", { target: input, isTrusted: false });
  assert.equal(state.root.hasAttribute("data-orbit-focus-address-expanded"), false);
  address.emit("mousedown", { target: input });
  assert.equal(state.root.getAttribute("data-orbit-focus-address-expanded"), "true");
  assert.equal(win.gURLBar.inputField, input); assert.equal(input.parentNode.id, "urlbar");
  assert.equal(islandVisible(state, "tools"), false); assert.equal(islandVisible(state, "window"), false);
  state.destroy();
});
test("native address and new-tab shortcuts reveal before Firefox receives the key", () => {
  const originalOS = Services.appinfo.OS;
  try {
    const cases = [
      ["WINNT", "l", { ctrlKey: true }], ["WINNT", "k", { ctrlKey: true }],
      ["WINNT", "e", { ctrlKey: true }], ["WINNT", "t", { ctrlKey: true }],
      ["WINNT", "d", { altKey: true }], ["WINNT", "F6", {}],
      ["WINNT", "F6", { shiftKey: true }], ["Darwin", "l", { metaKey: true }],
    ];
    for (const [os, name, modifiers] of cases) {
      Services.appinfo.OS = os;
      const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
      win.gURLBar.select(); assert.equal(win.document.activeElement, win.gBrowser.selectedBrowser, "The concealed native URL field cannot accept focus");
      const shortcut = key(name, modifiers); state.keydown(shortcut);
      assert.equal(shortcut.defaultPrevented, false); assert.equal(shortcut.stopped, undefined);
      assert.equal(islandVisible(state, "address"), true, `${os} ${name} must reveal before its native handler`);
      assert.equal(state.root.getAttribute("data-orbit-focus-address-expanded"), "true");
      assert.equal(islandVisible(state, "window"), false); assert.equal(islandVisible(state, "tools"), false);
      if (name === "t") win.BrowserCommands.openTab(); else win.gURLBar.select();
      assert.equal(win.document.activeElement, win.gURLBar.inputField);
      win.advance(350); assert.equal(islandVisible(state, "address"), true, "Native input focus holds the revealed island");
      state.destroy();
    }
  } finally { Services.appinfo.OS = originalOS; }
});
test("native address shortcuts dismiss commands before original shortcut handling", () => {
  for (const [name, modifiers] of [["k", { ctrlKey: true }], ["e", { ctrlKey: true }], ["d", { altKey: true }], ["F6", {}]]) {
    const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true); state.open();
    const shortcut = key(name, modifiers); state.keydown(shortcut);
    assert.equal(state.palette.hidden, true); assert.equal(shortcut.defaultPrevented, false); assert.equal(shortcut.stopped, undefined);
    win.gURLBar.select(); assert.equal(win.document.activeElement, win.gURLBar.inputField); state.destroy();
  }
});
test("command New tab reveals the real input before invoking Firefox", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true); state.open();
  const openTab = win.BrowserCommands.openTab;
  win.BrowserCommands.openTab = () => {
    assert.equal(islandVisible(state, "address"), true, "Reveal must precede the native New tab command");
    assert.equal(state.root.getAttribute("data-orbit-focus-address-expanded"), "true");
    openTab();
  };
  state.input.value = "New tab"; state.update(); state.keydown(key("Enter"));
  assert.equal(state.palette.hidden, true); assert.equal(win.document.activeElement, win.gURLBar.inputField);
  assert.equal(islandVisible(state, "tools"), false); assert.equal(islandVisible(state, "window"), false); state.destroy();
});
test("a configured native search widget stays usable and folds after its edit or popup", () => {
  const win = createWindow(); const doc = win.document;
  const container = new Node(doc); container.id = "search-container";
  const search = new Node(doc); search.id = "searchbar";
  const input = new Node(doc, "input"); search.append(input); container.append(search);
  doc.getElementById("nav-bar").append(container);
  const state = new InteractionWindow(win); state.setFocusMode(true);
  input.focus(); assert.equal(doc.activeElement, win.gBrowser.selectedBrowser);
  const nativeSearch = key("k", { ctrlKey: true }); state.keydown(nativeSearch);
  assert.equal(nativeSearch.defaultPrevented, false); assert.equal(nativeSearch.stopped, undefined);
  assert.equal(state.root.getAttribute("data-orbit-focus-reveal"), "true");
  input.focus(); doc.getElementById("navigator-toolbox").emit("focusin", { target: input });
  state.scheduleConceal("address"); win.advance(350); assert.equal(doc.activeElement, input);
  assert.equal(state.root.getAttribute("data-orbit-focus-reveal"), "true", "Native search focus keeps its original widget usable");
  const popup = new Node(doc, "panel"); popup.anchorNode = input; state.popupChanged(popup, true);
  win.gBrowser.selectedBrowser.focus(); doc.getElementById("navigator-toolbox").emit("focusout", { target: input }); win.advance(350);
  assert.equal(state.root.getAttribute("data-orbit-focus-reveal"), "true", "Native search suggestions keep their original anchor usable");
  const dismissPopup = key("Escape"); state.keydown(dismissPopup);
  assert.equal(dismissPopup.defaultPrevented, false); assert.equal(state.focusMode, true);
  state.popupChanged(popup, false); win.advance(350); assert.equal(state.root.hasAttribute("data-orbit-focus-reveal"), false);
  state.keydown(key("e", { ctrlKey: true })); input.focus();
  const revertSearch = key("Escape"); state.keydown(revertSearch);
  assert.equal(revertSearch.defaultPrevented, false); win.advance(0);
  assert.equal(doc.activeElement, win.gBrowser.selectedBrowser); assert.equal(state.root.hasAttribute("data-orbit-focus-reveal"), false);
  assert.equal(state.focusMode, true); assert.equal(container.parentNode.id, "nav-bar"); state.destroy();
});
test("slow pointer travel through the tools corridor stays open and leaving starts grace", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  assert.equal(state.focusTools.enabled, true);
  state.toolsHotzone.emit("mouseenter"); win.advance(140); state.toolsHotzone.emit("mouseleave");
  win.advance(200); win.emit("mousemove", { clientX: 100, clientY: 100 }); win.advance(800);
  assert.equal(islandVisible(state, "tools"), true, "A slow approach across the empty corridor must remain reachable");
  win.emit("mousemove", { clientX: 900, clientY: 400 }); win.advance(349);
  assert.equal(islandVisible(state, "tools"), true); win.advance(1); assert.equal(islandVisible(state, "tools"), false);
  state.toolsHotzone.emit("mouseenter"); win.advance(140); state.toolsHotzone.emit("mouseleave");
  win.emit("mousemove", { clientX: 100, clientY: 100, isTrusted: false }); win.advance(350);
  assert.equal(islandVisible(state, "tools"), false, "Untrusted motion cannot hold an island open");
  state.setFocusMode(false); assert.equal(state.focusTools.enabled, false); state.destroy();
});
test("window blur cancels island approaches and folds controls without losing mode or owned popups", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  state.toolsHotzone.emit("mouseenter"); win.advance(140); state.windowHotzone.emit("mouseenter");
  const popup = new Node(win.document, "panel"); popup.anchorNode = win.gURLBar.inputField; state.popupChanged(popup, true);
  win.emit("blur"); assert.equal(win.timers.size, 0); assert.equal(state.focusMode, true); assert.equal(state.focusTools.enabled, true);
  assert.equal(islandVisible(state, "tools"), false); assert.equal(islandVisible(state, "window"), false);
  assert.equal(islandVisible(state, "address"), true); assert.equal(state.islands.address.popups.has(popup), true);
  state.popupChanged(popup, false); win.advance(350); assert.equal(islandVisible(state, "address"), false); state.destroy();
});
test("owned native popups keep their island alive without revealing unrelated controls", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  const panel = new Node(win.document, "panel"); panel.anchorNode = win.gURLBar.inputField;
  const second = new Node(win.document, "panel"); second.anchorNode = win.gURLBar.inputField;
  state.popupChanged(panel, true); state.popupChanged(second, true); state.scheduleConceal("address"); win.advance(1000);
  assert.equal(islandVisible(state, "address"), true); assert.equal(islandVisible(state, "tools"), false);
  state.popupChanged(panel, false); win.advance(350);
  assert.equal(islandVisible(state, "address"), true, "One closed panel must not conceal another native panel's anchor");
  state.popupChanged(second, false); win.advance(350); assert.equal(islandVisible(state, "address"), false);
  const unrelated = new Node(win.document, "menupopup"); unrelated.triggerNode = win.gBrowser.selectedBrowser;
  state.popupChanged(unrelated, true); win.advance(350);
  assert.equal(islandVisible(state, "address"), false); assert.equal(islandVisible(state, "tools"), false);
  const extension = new Node(win.document, "panel"); extension.anchorNode = win.document.getElementById("unified-extensions-button");
  const before = state.focusTools.openCount;
  state.popupChanged(extension, true); state.scheduleConceal("tools"); win.advance(1000);
  assert.equal(state.islands.tools.popups.has(extension), true);
  assert.equal(islandVisible(state, "tools"), false, "A native panel replaces the radial menu instead of being covered by it");
  assert.equal(state.focusTools.openCount, before); assert.equal(islandVisible(state, "address"), false);
  state.popupChanged(extension, false); win.advance(350);
  assert.equal(state.islands.tools.popups.has(extension), false); assert.equal(islandVisible(state, "tools"), false);
  state.destroy();
});
test("native window controls retain their DOM owner and focus markers restore without observer loops", () => {
  const win = createWindow(); const state = new InteractionWindow(win);
  const box = new Node(win.document); box.rect = { width: 100, height: 30 };
  const navigation = win.document.getElementById("nav-bar"); navigation.nativeTitlebars = [box]; navigation.append(box);
  box.setAttribute("data-orbit-focus-window-controls", "previous"); state.setFocusMode(true);
  assert.equal(box.getAttribute("data-orbit-focus-window-controls"), "true");
  assert.equal(box.parentNode, navigation);
  const container = win.document.getElementById("urlbar-container");
  assert.equal(container.getAttribute("data-orbit-focus-address"), "true"); assert.equal(container.parentNode, navigation);
  let layouts = 0; const update = state.updateFocusLayout.bind(state); state.updateFocusLayout = () => { layouts++; update(); };
  win.observer.callback([{ attributeName: "data-orbit-focus-address-visible" }]); assert.equal(layouts, 0);
  box.computedStyle = { visibility: "hidden", display: "none" };
  win.observer.notifyMutation(box, "collapsed"); assert.equal(layouts, 1, "Native titlebar ownership changes inside the toolbox must update the island");
  assert.notEqual(box.getAttribute("data-orbit-focus-window-controls"), "true");
  state.setFocusMode(false); assert.equal(box.getAttribute("data-orbit-focus-window-controls"), "previous");
  assert.equal(container.hasAttribute("data-orbit-focus-address"), false);
  state.destroy(); assert.equal(win.observer.disconnected, true);
});
test("Escape dismisses focus tools first, then restores the ordinary browser", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  state.toolsHotzone.emit("mouseenter"); win.advance(140); assert.equal(state.focusTools.visible, true);
  state.keydown(key("Escape")); assert.equal(state.focusTools.visible, false); assert.equal(state.focusMode, true);
  state.keydown(key("Escape")); assert.equal(state.focusMode, false);
  for (const island of ["address", "window", "tools"]) assert.equal(islandVisible(state, island), false);
  state.destroy();
});
test("Escape leaves native popup dismissal to Firefox before exiting focus", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  const suggestions = new Node(win.document, "panel"); suggestions.anchorNode = win.gURLBar.inputField;
  state.popupChanged(suggestions, true);
  const dismissSuggestions = key("Escape"); state.keydown(dismissSuggestions);
  assert.equal(dismissSuggestions.defaultPrevented, false); assert.equal(state.focusMode, true);
  state.popupChanged(suggestions, false); state.keydown(key("Escape")); assert.equal(state.focusMode, false);
  state.destroy();
});
test("Escape in the real address field preserves Firefox edit reversion before collapsing", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true);
  state.keydown(key("l", { ctrlKey: true }));
  win.gURLBar.select(); win.document.getElementById("urlbar-container").emit("focusin", { target: win.gURLBar.inputField });
  const revertEdit = key("Escape"); state.keydown(revertEdit);
  assert.equal(revertEdit.defaultPrevented, false, "Firefox must receive Escape to revert an address edit");
  assert.equal(win.document.activeElement, win.gURLBar.inputField, "Native edit handling runs before deferred focus restoration");
  win.advance(0); assert.equal(win.document.activeElement, win.gBrowser.selectedBrowser);
  assert.equal(islandVisible(state, "address"), false); assert.equal(state.focusMode, true);
  state.keydown(key("Escape")); assert.equal(state.focusMode, false); state.destroy();
});
test("focus mode and pending island timers remain scoped to each private or normal window", () => {
  const normal = createWindow(); const privateWin = createWindow(true);
  const normalState = new InteractionWindow(normal); const privateState = new InteractionWindow(privateWin);
  normalState.setFocusMode(true); privateState.setFocusMode(true);
  privateState.toolsHotzone.emit("mouseenter"); privateWin.advance(140);
  assert.equal(islandVisible(privateState, "tools"), true); assert.equal(islandVisible(normalState, "tools"), false);
  normalState.windowHotzone.emit("mouseenter"); normalState.setFocusMode(false); normal.advance(1000);
  assert.equal(islandVisible(normalState, "window"), false); assert.equal(privateState.focusMode, true);
  normalState.destroy(); assert.equal(islandVisible(privateState, "tools"), true); privateState.destroy();
});
test("native fullscreen/customization exits focus and radial owns its Escape", () => {
  const win = createWindow(); const state = new InteractionWindow(win);
  win.fullScreen = true; state.setFocusMode(true); assert.equal(state.focusMode, false);
  win.fullScreen = false; state.root.setAttribute("customizing", "true"); state.setFocusMode(true); assert.equal(state.focusMode, false);
  state.root.removeAttribute("customizing"); state.setFocusMode(true);
  const radial = new Node(win.document); radial.id = "orbit-radial-root"; radial.classNames.add("orbit-radial-visible");
  const escape = key("Escape"); state.keydown(escape); assert.equal(escape.defaultPrevented, false); assert.equal(state.focusMode, true);
  win.emit("beforecustomization"); assert.equal(state.focusMode, false);
  state.setFocusMode(true); win.emit("DOMFullscreen:Entered"); assert.equal(state.focusMode, false); state.destroy();
});
test("destroy removes window/tab listeners, pending conceal and injected UI", () => {
  const win = createWindow(); const state = new InteractionWindow(win); state.setFocusMode(true); state.scheduleConceal();
  assert.ok(win.timers.size); state.destroy(); state.destroy();
  assert.equal(win.listenerCount(), 0); assert.equal(win.gBrowser.tabContainer.listenerCount(), 0);
  assert.equal(win.document.getElementById("navigator-toolbox").listenerCount(), 0);
  assert.equal(win.document.getElementById("urlbar-container").listenerCount(), 0);
  assert.equal(win.timers.size, 0); assert.equal(state.palette.isConnected, false); assert.equal(state.chip.isConnected, false);
  for (const island of ["address", "tools", "window"]) {
    assert.equal(state[`${island}Hotzone`].isConnected, false);
    assert.equal(islandVisible(state, island), false);
  }
  assert.equal(state.focusTools.disposed, true);
  state.open(); assert.equal(state.palette.hidden, true);
});
test("toolbar command is trusted, works in private windows and uninitializes independently", () => {
  const normal = createWindow(); const privateWin = createWindow(true);
  OrbitInteractions.init(normal); OrbitInteractions.init(privateWin); assert.equal(widget.showInPrivateBrowsing, true);
  const privateNode = new Node(privateWin.document);
  widget.onCommand({ isTrusted: false, currentTarget: privateNode });
  assert.equal(privateWin.document.getElementById("orbit-command-palette").hidden, true);
  widget.onCommand({ isTrusted: true, currentTarget: privateNode });
  assert.equal(privateWin.document.getElementById("orbit-command-palette").hidden, false);
  assert.equal(normal.document.getElementById("orbit-command-palette").hidden, true);
  OrbitInteractions.uninit(privateWin); assert.equal(privateWin.listenerCount(), 0);
  OrbitInteractions.uninit(normal); assert.equal(normal.listenerCount(), 0);
});
