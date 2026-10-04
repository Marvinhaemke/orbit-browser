/* SPDX-License-Identifier: MPL-2.0 */
// These unit checks exercise Orbit's data boundary and native-call contract.
// Native rendering and Gecko lifecycle are verified separately by smoke_native.py.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const uri = value => {
  const parsed = new URL(value);
  return {
    spec: parsed.href,
    host: parsed.hostname,
    userPass: parsed.username + parsed.password,
    schemeIs: scheme => parsed.protocol === `${scheme}:`,
  };
};
let serial = 0;
let writes = 0;
let reads = 0;
const windows = new WeakMap();
const tabs = new WeakMap();
const modules = {
  PrivateBrowsingUtils: { isWindowPrivate: win => win.private },
  ContextualIdentityService: { getPublicIdentityFromId: id => id === 2 ? { userContextId: 2 } : null },
  CustomizableUI: { AREA_NAVBAR: "nav-bar", createWidget() {} },
  SessionStore: {
    getCustomWindowValue(win, key) { reads++; return windows.get(win)?.[key] || ""; },
    setCustomWindowValue(win, key, value) { writes++; windows.set(win, { ...windows.get(win), [key]: value }); },
    getCustomTabValue(tab, key) { reads++; return tabs.get(tab)?.[key] || ""; },
    setCustomTabValue(tab, key, value) { writes++; tabs.set(tab, { ...tabs.get(tab), [key]: value }); },
  },
};
globalThis.ChromeUtils = {
  defineESModuleGetters(target, getters) {
    for (const key of Object.keys(getters)) {
      Object.defineProperty(target, key, { get: () => modules[key] });
    }
  },
  predictRemoteTypeForURI: () => "webIsolated=https://example.com",
  generateQI: () => () => {},
};
globalThis.Services = {
  io: { newURI: uri },
  uuid: { generateUUID: () => `{00000000-0000-0000-0000-${String(++serial).padStart(12, "0")}}` },
  scriptSecurityManager: { createNullPrincipal: attrs => ({ isSystemPrincipal: false, originAttributes: attrs }) },
  prefs: { getBoolPref: () => true },
};
globalThis.Ci = { nsIReferrerInfo: { EMPTY: 0 }, nsIWebProgress: { NOTIFY_LOCATION: 16 } };
globalThis.Cc = {
  "@mozilla.org/referrer-info;1": { createInstance: () => ({ init() {} }) },
};

class Node extends EventTarget {
  constructor(doc, tag = "div") {
    super();
    this.ownerDocument = doc;
    this.ownerGlobal = doc.win;
    this.tagName = tag;
    this.style = {};
    this.attributes = {};
    this.children = [];
    this.contentDocument = null;
  }
  set id(value) { this._id = value; this.ownerDocument.nodes.set(value, this); }
  get id() { return this._id; }
  set src(value) { this.contentDocument = { documentURI: value, nodePrincipal: { isSystemPrincipal: true } }; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
  remove() { this.removed = true; }
  focus() {}
}

function createWindow(isPrivate = false) {
  const win = new EventTarget();
  win.private = isPrivate;
  win.document = {
    win,
    nodes: new Map(),
    createElementNS(ns, tag) { return new Node(this, tag); },
    getElementById(id) { return this.nodes.get(id); },
  };
  new Node(win.document).id = "browser";
  const nativeBrowser = url => ({ currentURI: uri(url), contentPrincipal: { isSystemPrincipal: false }, referrerInfo: {}, focus() {} });
  const first = { label: "Example", userContextId: 0, linkedBrowser: nativeBrowser("https://example.com/"), pinned: false };
  let selected = first;
  win.gBrowser = {
    tabs: [first],
    tabContainer: new EventTarget(),
    get selectedTab() { return selected; },
    set selectedTab(tab) { selected = tab; this.tabContainer.dispatchEvent(new Event("TabSelect")); },
    get selectedBrowser() { return selected.linkedBrowser; },
    addTab(url, options) {
      assert.equal(options.allowInheritPrincipal, false);
      assert.equal(options.triggeringPrincipal.isSystemPrincipal, false);
      const tab = { label: url, userContextId: options.userContextId, linkedBrowser: nativeBrowser(url), options };
      this.tabs.push(tab);
      this.tabContainer.dispatchEvent(new Event("TabOpen"));
      return tab;
    },
    removeTab(tab) { this.tabs = this.tabs.filter(candidate => candidate !== tab); },
    addTabSplitView(tabList, options) {
      this.split = { tabList, options };
      return this.split;
    },
    createBrowser(options) {
      const browser = new Node(win.document, "browser");
      browser.options = options;
      browser.currentURI = uri("about:blank");
      browser.loadURI = (url, params) => { browser.currentURI = url; browser.loadOptions = params; };
      browser.addProgressListener = callback => { browser.progress = callback; };
      browser.removeProgressListener = () => { browser.progress = null; };
      browser.stop = () => { browser.stopped = true; };
      browser.destroy = () => { browser.destroyed = true; };
      return browser;
    },
  };
  return win;
}

const source = await readFile(new URL("../overlay/browser/components/orbit/Orbit.sys.mjs", import.meta.url), "utf8");
const { Orbit } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const board = () => ({
  version: 1,
  camera: { x: 0, y: 0, zoom: 1 },
  frames: [{ id: "frame-1", x: 0, y: 0, w: 700, h: 400, title: "Research", color: "#d4daf2" }],
  items: [{ id: "item-1", type: "tab", x: 20, y: 50, w: 248, h: 160, title: "Mozilla", url: "https://www.mozilla.org/", userContextId: 2, frameId: "frame-1" }],
  connections: [],
  strokes: [],
});

test("board rejects privileged URL schemes, credentials, invalid geometry and dangling references", () => {
  const win = createWindow();
  Orbit.openBoard(win);
  const bridge = win.OrbitChrome;
  for (const url of ["javascript:alert(1)", "chrome://browser/content/browser.xhtml", "file:///etc/passwd", "https://user:password@example.com/"]) {
    const invalid = board();
    invalid.items[0].url = url;
    assert.throws(() => bridge.saveBoard(invalid));
  }
  const invalid = board();
  invalid.camera.zoom = Infinity;
  assert.throws(() => bridge.saveBoard(invalid));
  invalid.camera.zoom = 1;
  invalid.items[0].frameId = "missing-frame";
  assert.throws(() => bridge.saveBoard(invalid));
  invalid.items[0].frameId = "frame-1";
  invalid.connections.push({ id: "connection-1", from: "item-1", to: "missing-item" });
  assert.throws(() => bridge.saveBoard(invalid));
  Orbit.uninit(win);
});

test("native frames create real tabs in their containers and reuse recorded tab ids", () => {
  const win = createWindow();
  Orbit.openBoard(win);
  const saved = win.OrbitChrome.saveBoard(board());
  saved.items[0].url = "https://changed.invalid/";
  assert.equal(win.OrbitChrome.getBoard().items[0].url, "https://www.mozilla.org/");
  const result = win.OrbitChrome.openFrame("frame-1");
  assert.equal(result.opened, 1);
  assert.equal(win.gBrowser.tabs.length, 2);
  assert.equal(win.gBrowser.selectedTab.options.userContextId, 2);
  assert.equal(win.gBrowser.selectedTab.options.triggeringPrincipal.originAttributes.userContextId, 2);
  assert.equal(win.OrbitChrome.getBoard().items[0].tabId, result.selected);
  Orbit.openBoard(win);
  win.OrbitChrome.openFrame("frame-1");
  assert.equal(win.gBrowser.tabs.length, 2, "reopening a frame reuses its native tab");
  Orbit.uninit(win);
});

test("background Add keeps the canvas visible and duplicate native tabs get distinct ids", () => {
  const win = createWindow();
  Orbit.openBoard(win);
  const first = win.gBrowser.selectedTab;
  const added = win.OrbitChrome.openTab({ url: "https://www.mozilla.org/", background: true });
  assert.equal(win.gBrowser.selectedTab, first);
  assert.equal(win.document.getElementById("orbit-canvas-overlay").hidden, false);
  const original = win.gBrowser.tabs[1];
  const duplicate = { ...original, linkedBrowser: { ...original.linkedBrowser } };
  tabs.set(duplicate, { ...tabs.get(original) });
  win.gBrowser.tabs.push(duplicate);
  const described = win.OrbitChrome.listTabs();
  assert.equal(described[1].id, added.id);
  assert.notEqual(described[2].id, added.id);
  Orbit.uninit(win);
});

test("private boards and tab ids never read or write SessionStore custom values", () => {
  const win = createWindow(true);
  Orbit.openBoard(win);
  const before = { reads, writes };
  const privateBoard = board();
  privateBoard.items[0].userContextId = 0;
  assert.equal(win.OrbitChrome.getBoard(), null);
  win.OrbitChrome.saveBoard(privateBoard);
  win.OrbitChrome.listTabs();
  win.OrbitChrome.openFrame("frame-1");
  assert.deepEqual({ reads, writes }, before);
  const bridge = win.OrbitChrome;
  Orbit.uninit(win);
  assert.equal(win.OrbitChrome, undefined);
  assert.throws(() => bridge.getBoard(), /packaged canvas/);
});

test("bridge revokes access after iframe navigation or a non-system document", () => {
  const win = createWindow();
  Orbit.openBoard(win);
  const frame = win.document.getElementById("orbit-canvas-frame");
  frame.contentDocument.nodePrincipal.isSystemPrincipal = false;
  assert.throws(() => win.OrbitChrome.listTabs(), /packaged canvas/);
  frame.contentDocument.nodePrincipal.isSystemPrincipal = true;
  frame.contentDocument.documentURI = "https://example.com/";
  assert.throws(() => win.OrbitChrome.saveBoard(board()), /packaged canvas/);
  Orbit.uninit(win);
});

test("native split refuses pinned tabs and creates two native panes", () => {
  const win = createWindow();
  Orbit.openBoard(win);
  win.gBrowser.selectedTab.pinned = true;
  assert.throws(() => win.OrbitChrome.split({ url: "https://mozilla.org/" }), /unpinned/);
  assert.equal(win.gBrowser.tabs.length, 1);
  win.gBrowser.selectedTab.pinned = false;
  const result = win.OrbitChrome.split({ url: "https://mozilla.org/", userContextId: 2 });
  assert.equal(win.gBrowser.split.tabList.length, 2);
  assert.equal(win.gBrowser.selectedTab.options.userContextId, 2);
  assert.ok(result.left && result.right);
  assert.equal(win.document.getElementById("orbit-canvas-overlay").hidden, true);
  Orbit.uninit(win);
});

test("real peek uses native remote browser and disposes listeners on close", () => {
  const win = createWindow();
  Orbit.openBoard(win);
  win.OrbitChrome.peek({ url: "https://example.com/peek", userContextId: 2 });
  const preview = win.document.getElementById("orbit-peek-browser");
  assert.equal(preview.options.userContextId, 2);
  assert.equal(preview.docShellIsActive, true);
  assert.equal(preview.loadOptions.triggeringPrincipal.isSystemPrincipal, false);
  win.OrbitChrome.closePeek();
  assert.equal(preview.stopped, true);
  assert.equal(preview.destroyed, true);
  assert.equal(preview.progress, null);
  Orbit.uninit(win);
});
