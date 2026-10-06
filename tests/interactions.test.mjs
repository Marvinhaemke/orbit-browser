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
    this.classList = { contains: name => this.classNames.has(name) };
  }
  set id(value) { this._id = value; this.ownerDocument.nodes.set(value, this); }
  get id() { return this._id; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  toggleAttribute(key, enabled) { if (enabled) this.setAttribute(key, ""); else this.removeAttribute(key); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.isConnected = false; this.children = []; this.append(...nodes); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolled = true; }
  querySelectorAll() { return this.nativeTitlebars || []; }
  getBoundingClientRect() { return this.rect || { width: 0, height: 0 }; }
}
let widget;
const calls = [];
const frames = new WeakMap();
const modules = {
  CustomizableUI: { AREA_NAVBAR: "nav-bar", createWidget(value) { widget = value; } },
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
    querySelector() { return this.popup || null; },
  };
  win.document = doc; doc.documentElement = new Node(doc, "window");
  const toolbox = new Node(doc); toolbox.id = "navigator-toolbox";
  const navigation = new Node(doc); navigation.id = "nav-bar"; toolbox.append(navigation);
  const urlbar = new Node(doc); urlbar.id = "urlbar-input"; navigation.append(urlbar);
  doc.documentElement.append(toolbox);
  const timers = new Map(); let serial = 0;
  win.setTimeout = callback => { timers.set(++serial, callback); return serial; };
  win.clearTimeout = id => timers.delete(id);
  win.flushTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); };
  win.timers = timers;
  win.MutationObserver = class {
    constructor(callback) { this.callback = callback; win.observer = this; }
    observe(target, options) { this.target = target; this.options = options; }
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
  win.gURLBar = { select() { urlbar.focus(); } };
  win.BrowserCommands = { openTab() { calls.push(["new-tab", win]); urlbar.focus(); } };
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
  win.gURLBar.select(); state.scheduleConceal(); win.flushTimers(); assert.equal(state.revealed, true);
  win.gBrowser.selectedBrowser.focus(); state.scheduleConceal(); win.flushTimers(); assert.equal(state.revealed, false);
  state.keydown(key("Escape")); assert.equal(state.focusMode, false); assert.equal(state.chip.hidden, true);
  assert.equal(state.root.hasAttribute("data-orbit-focus"), false); state.destroy();
});
test("focus mode preserves visible navigation-row window buttons and avoids observer loops", () => {
  const win = createWindow(); const state = new InteractionWindow(win);
  const box = new Node(win.document); box.rect = { width: 100, height: 30 };
  win.document.getElementById("nav-bar").nativeTitlebars = [box]; state.setFocusMode(true);
  assert.equal(state.root.hasAttribute("data-orbit-focus-nav-titlebar"), true);
  let layouts = 0; const update = state.updateFocusLayout.bind(state); state.updateFocusLayout = () => { layouts++; update(); };
  win.observer.callback([{ attributeName: "data-orbit-focus-reveal" }]); assert.equal(layouts, 0);
  box.computedStyle = { visibility: "hidden", display: "none" };
  win.observer.callback([{ attributeName: "verticaltabs" }]); assert.equal(layouts, 1);
  assert.equal(state.root.hasAttribute("data-orbit-focus-nav-titlebar"), false);
  state.destroy(); assert.equal(win.observer.disconnected, true);
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
  assert.equal(win.timers.size, 0); assert.equal(state.palette.isConnected, false); assert.equal(state.chip.isConnected, false);
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
