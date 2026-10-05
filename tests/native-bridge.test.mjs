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
const browserWindows = new Set();
let widgetProperties;
const modules = {
  AboutNewTab: { newTabURL: "about:newtab" },
  OrbitRadial: { init() {}, uninit() {} },
  OrbitTheme: { init() {}, uninit() {} },
  PrivateBrowsingUtils: { isWindowPrivate: win => win.private },
  ContextualIdentityService: { getPublicIdentityFromId: id => id === 2 ? { userContextId: 2 } : null },
  CustomizableUI: {
    AREA_NAVBAR: "nav-bar",
    createWidget(properties) {
      widgetProperties = properties;
      for (const win of browserWindows) attachWidget(win);
    },
  },
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
    // Matches the pinned Node WebIDL: documentGlobal exists, ownerGlobal does not.
    this.documentGlobal = doc.defaultView;
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

function attachWidget(win) {
  const node = new Node(win.document, "toolbarbutton");
  node.id = widgetProperties.id;
  widgetProperties.onCreated(node);
  node.addEventListener("command", event => widgetProperties.onCommand(event));
  return node;
}

function createWindow(isPrivate = false) {
  const win = new EventTarget();
  win.private = isPrivate;
  win.document = {
    win,
    defaultView: win,
    nodes: new Map(),
    createElementNS(ns, tag) { return new Node(this, tag); },
    getElementById(id) { return this.nodes.get(id); },
  };
  browserWindows.add(win);
  if (widgetProperties) attachWidget(win);
  new Node(win.document).id = "browser";
  const nativeBrowser = url => ({ ownerDocument: win.document, currentURI: uri(url), contentPrincipal: { isSystemPrincipal: false }, referrerInfo: {}, focus() { this.focused = true; } });
  const first = { label: "Example", userContextId: 0, linkedBrowser: nativeBrowser("https://example.com/"), pinned: false };
  let selected = first;
  win.gBrowser = {
    tabs: [first],
    tabContainer: new EventTarget(),
    get selectedTab() { return selected; },
    set selectedTab(tab) { selected = tab; this.tabContainer.dispatchEvent(new Event("TabSelect")); },
    get selectedBrowser() { return selected.linkedBrowser; },
    getTabForBrowser(browser) { return this.tabs.find(tab => tab.linkedBrowser === browser); },
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
  win.gURLBar = { focused: false, select() { this.focused = true; } };
  return win;
}

function createCanvasTab(win) {
  const browser = {
    ownerDocument: win.document,
    currentURI: uri("chrome://browser/content/orbit/orbit.html"),
    browsingContext: { currentWindowGlobal: { isCurrentGlobal: true } },
    focus() {},
  };
  const canvas = {
    document: { documentURI: browser.currentURI.spec, nodePrincipal: { isSystemPrincipal: true } },
    docShell: { chromeEventHandler: browser },
  };
  canvas.document.defaultView = canvas;
  browser.contentDocument = canvas.document;
  const tab = { label: "Orbit Canvas", linkedBrowser: browser, userContextId: 0 };
  win.gBrowser.tabs.push(tab);
  return { canvas, browser, tab };
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

test("native toolbar command opens and closes the canvas in the button's own window", () => {
  const win = createWindow();
  Orbit.init(win);
  assert.equal(modules.AboutNewTab.newTabURL, "chrome://browser/content/orbit/orbit.html", "native new-tab service routes to the real canvas document");
  const button = win.document.getElementById("orbit-canvas-button");
  assert.equal(button.ownerGlobal, undefined, "the removed Gecko API must not exist in the test");
  assert.equal(button.attributes.image, "chrome://browser/content/orbit/orbit.svg");
  assert.equal(win.document.getElementById("orbit-canvas-overlay"), undefined);
  button.dispatchEvent(new Event("command"));
  assert.equal(win.document.getElementById("orbit-canvas-overlay").hidden, false);
  assert.equal(button.attributes["aria-pressed"], "true");
  button.dispatchEvent(new Event("command"));
  assert.equal(win.document.getElementById("orbit-canvas-overlay").hidden, true);
  assert.equal(button.attributes["aria-pressed"], "false");

  const second = createWindow();
  Orbit.init(second);
  second.document.getElementById("orbit-canvas-button").dispatchEvent(new Event("command"));
  assert.equal(second.document.getElementById("orbit-canvas-overlay").hidden, false);
  assert.equal(win.document.getElementById("orbit-canvas-overlay").hidden, true);
  Orbit.uninit(second);
  Orbit.uninit(win);
});

test("native new-tab canvas connects without creating an overlay or taking URL bar focus", () => {
  const win = createWindow();
  const { canvas, browser, tab } = createCanvasTab(win);
  win.gBrowser.selectedTab = tab;
  win.gURLBar.focused = true;
  const bridge = Orbit.connectCanvas(canvas);
  assert.equal(Orbit.connectCanvas(canvas), bridge, "one bridge belongs to each document");
  assert.equal(win.document.getElementById("orbit-canvas-overlay"), undefined);
  assert.equal(browser.currentURI.spec, "chrome://browser/content/orbit/orbit.html");
  assert.equal(win.gURLBar.focused, true);
  assert.equal(bridge.listTabs().length, 1, "canvas documents are not imported as website cards");
  bridge.saveBoard(board());
  assert.equal(bridge.getBoard().items[0].url, "https://www.mozilla.org/");
  const result = bridge.openTab({ url: "https://www.mozilla.org/", userContextId: 2 });
  assert.equal(win.gBrowser.selectedBrowser.currentURI.spec, result.url);
  assert.equal(win.gBrowser.selectedTab.options.userContextId, 2);
  assert.equal(bridge.getBoard().version, 1, "background canvas document remains authorized after TabSelect");
  Orbit.uninit(win);
  assert.throws(() => bridge.getBoard(), /packaged canvas/);
});

test("multiple native canvases and the toolbar canvas share board edits without echoing the author", () => {
  const win = createWindow();
  Orbit.openBoard(win);
  const first = createCanvasTab(win);
  const second = createCanvasTab(win);
  const a = Orbit.connectCanvas(first.canvas);
  const b = Orbit.connectCanvas(second.canvas);
  const changes = [[], [], []];
  a.subscribe((list, change) => changes[0].push(change));
  b.subscribe((list, change) => changes[1].push(change));
  win.OrbitChrome.subscribe((list, change) => changes[2].push(change));
  a.saveBoard(board());
  assert.equal(changes[0].length, 0);
  assert.equal(changes[1][0].type, "board-changed");
  assert.equal(changes[2][0].board.items[0].url, "https://www.mozilla.org/");
  changes[1][0].board.items[0].title = "Mutation stays local";
  assert.equal(b.getBoard().items[0].title, "Mozilla");
  const edited = b.getBoard();
  edited.frames[0].title = "Connected workspace";
  b.saveBoard(edited);
  assert.equal(a.getBoard().frames[0].title, "Connected workspace");
  assert.equal(changes[0][0].board.frames[0].title, "Connected workspace");
  assert.equal(changes[1].length, 1, "author does not receive its own save");
  assert.equal(changes[2].length, 2);
  Orbit.uninit(win);
});

test("native canvas bridges reject stale, discarded, foreign and non-system documents", () => {
  const win = createWindow();
  const { canvas, browser, tab } = createCanvasTab(win);
  const bridge = Orbit.connectCanvas(canvas);
  let notifications = 0;
  bridge.subscribe(() => notifications++);
  canvas.document.nodePrincipal.isSystemPrincipal = false;
  assert.throws(() => bridge.getBoard(), /packaged canvas/);
  assert.throws(() => Orbit.connectCanvas(canvas), /packaged canvas/);
  canvas.document.nodePrincipal.isSystemPrincipal = true;
  for (const flag of ["isInBFCache", "isDiscarded"]) {
    browser.browsingContext.currentWindowGlobal[flag] = true;
    assert.throws(() => bridge.listTabs(), /current native canvas/);
    browser.browsingContext.currentWindowGlobal[flag] = false;
  }
  browser.contentDocument = { ...canvas.document };
  assert.throws(() => bridge.saveBoard(board()), /current native canvas/);
  assert.throws(() => Orbit.connectCanvas(canvas), /native browser tab/);
  browser.contentDocument = canvas.document;
  browser.currentURI = uri("https://example.com/");
  assert.throws(() => bridge.getBoard(), /current native canvas/);
  browser.currentURI = uri("chrome://browser/content/orbit/orbit.html");
  const second = createWindow();
  browser.ownerDocument = second.document;
  assert.throws(() => bridge.getBoard(), /current native canvas/);
  browser.ownerDocument = win.document;
  tab.closing = true;
  assert.throws(() => bridge.getBoard(), /current native canvas/);
  win.gBrowser.tabContainer.dispatchEvent(new Event("TabClose"));
  assert.equal(notifications, 0, "stale subscriptions are revoked before callback delivery");
  Orbit.uninit(win);
});

test("private native canvases share memory only and isolate normal and other private windows", () => {
  const win = createWindow(true);
  const a = Orbit.connectCanvas(createCanvasTab(win).canvas);
  const b = Orbit.connectCanvas(createCanvasTab(win).canvas);
  const normal = createWindow();
  const otherPrivate = createWindow(true);
  const normalBridge = Orbit.connectCanvas(createCanvasTab(normal).canvas);
  const otherBridge = Orbit.connectCanvas(createCanvasTab(otherPrivate).canvas);
  const before = { reads, writes };
  const value = board();
  value.items[0].userContextId = 0;
  a.saveBoard(value);
  a.listTabs();
  assert.equal(b.getBoard().frames[0].title, "Research");
  assert.equal(otherBridge.getBoard(), null);
  assert.deepEqual({ reads, writes }, before);
  assert.equal(normalBridge.getBoard(), null);
  Orbit.uninit(win);
  assert.throws(() => b.getBoard(), /packaged canvas/);
  Orbit.uninit(normal);
  Orbit.uninit(otherPrivate);
});

test("return from a native canvas selects an existing page and retains canvas tabs", () => {
  const win = createWindow();
  const { canvas, tab } = createCanvasTab(win);
  const first = win.gBrowser.tabs[0];
  win.gBrowser.selectedTab = tab;
  const bridge = Orbit.connectCanvas(canvas);
  bridge.hideCanvas();
  assert.equal(win.gBrowser.selectedTab, first);
  assert.equal(first.linkedBrowser.focused, true);
  assert.equal(win.gBrowser.tabs.length, 2);
  win.gBrowser.tabs = [tab];
  win.gBrowser.selectedTab = tab;
  bridge.hideCanvas();
  assert.equal(win.gBrowser.selectedTab, tab);
  assert.equal(win.gURLBar.focused, true);
  Orbit.uninit(win);
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
