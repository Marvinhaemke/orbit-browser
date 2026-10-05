/* SPDX-License-Identifier: MPL-2.0 */
// Contract and lifecycle checks; smoke_radial.py separately drives genuine
// Gecko mouse events, native menu commands, and cross-origin frames on Windows.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const views = new WeakMap();
const registrations = [];
class View {
  constructor(win) { this.win = win; views.set(win, this); }
  show(model) { this.model = model; this.hit = null; }
  refresh(value) { Object.assign(this.model, value); }
  updatePointer(x, y) { this.pointer = [x, y]; }
  hitTest() { return this.hit; }
  setPassthrough(value) { this.model.passthrough = value; }
  hide(reason) { const model = this.model; this.model = null; model?.onDismiss(reason); }
  destroy() { this.model = null; this.destroyed = true; }
}
const modules = { OrbitRadialView: View };
globalThis.ChromeUtils = {
  defineESModuleGetters(target, getters) {
    for (const name of Object.keys(getters)) Object.defineProperty(target, name, { get: () => modules[name] });
  },
  registerWindowActor(name, options) { registrations.push({ name, options }); },
};
globalThis.JSWindowActorChild = class {};
globalThis.JSWindowActorParent = class {};
const load = async name => import(`data:text/javascript;base64,${Buffer.from(await readFile(
  new URL(`../overlay/browser/components/orbit/${name}.sys.mjs`, import.meta.url), "utf8")).toString("base64")}`);
const { OrbitRadial, buildTabTree, snapshotNativeMenu, executeNativeCommand } = await load("OrbitRadial");
modules.OrbitRadial = OrbitRadial;
const { OrbitRadialParent } = await load("OrbitRadialParent");
const { OrbitRadialChild } = await load("OrbitRadialChild");

class NativeNode extends EventTarget {
  constructor(tag, id = "", label = "") {
    super(); this.localName = tag; this.id = id; this.children = []; this.style = {};
    this.attributes = { label }; this.commands = 0;
  }
  getAttribute(name) { return this.attributes[name] || ""; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  doCommand() { this.commands++; this.action?.(); }
}

function fixture() {
  const win = new EventTarget();
  const popup = new NativeNode("menupopup", "contentAreaContextMenu");
  const copy = new NativeNode("menuitem", "context-copylink", "Copy link");
  const selectAll = new NativeNode("menuitem", "context-selectall", "Select All");
  const container = new NativeNode("menu", "context-openlinkinusercontext-menu", "Open in container");
  const submenu = new NativeNode("menupopup", "context-openlinkinusercontext-popup");
  container.append(submenu); popup.append(copy, selectAll, container);
  const nodes = [popup, copy, selectAll, container, submenu];
  win.document = {
    getElementById: id => nodes.find(node => node.id === id),
    l10n: { translateFragment: async () => {} },
    createEvent: type => {
      assert.equal(type, "XULCommandEvent");
      const event = new Event("command", { bubbles: true, cancelable: true });
      event.initCommandEvent = (...args) => { event.arguments = args; };
      return event;
    },
  };
  win.MutationObserver = class { observe() {} disconnect() {} };
  win.Event = Event; win.devicePixelRatio = 2;
  win.queueMicrotask = queueMicrotask;
  const timers = new Map(); let timerSerial = 0;
  win.setTimeout = fn => { timers.set(++timerSerial, fn); return timerSerial; };
  win.clearTimeout = id => timers.delete(id);
  const browser = { currentURI: { spec: "https://example.test/" }, focus() { win.contentFocused = true; } };
  const first = { label: "First", linkedBrowser: browser };
  const second = { label: "Settings", linkedBrowser: { currentURI: { spec: "about:preferences" } } };
  let selected = first;
  win.gBrowser = {
    openTabs: [first, second], tabContainer: new EventTarget(),
    get selectedTab() { return selected; },
    set selectedTab(value) { selected = value; this.tabContainer.dispatchEvent(new Event("TabSelect")); },
    get selectedBrowser() { return selected.linkedBrowser; },
    getTabForBrowser(value) { return this.openTabs.find(tab => tab.linkedBrowser === value); },
    duplicateTab(value) {
      const copyTab = { ...value }; this.openTabs.push(copyTab); return copyTab;
    },
  };
  browser.ownerDocument = { defaultView: win };
  let hidden = 0, extensionHidden = 0;
  popup.addEventListener("popuphidden", () => extensionHidden++);
  const nativeContext = (source = browser, overrides = {}) => {
    const context = {
      shouldDisplay: true, browser: source, onLink: false, onImage: false,
      frameBrowsingContext: { id: 41 },
      contentData: { context: { screenXDevPx: 200, screenYDevPx: 200 } },
      hiding() { hidden++; },
      ...overrides,
    };
    win.gContextMenu = context;
    const event = new Event("popupshowing", { cancelable: true });
    popup.dispatchEvent(event);
    return { context, event };
  };
  OrbitRadial.init(win);
  return { win, popup, copy, selectAll, container, submenu, browser, first, second, timers, nativeContext,
    get hidden() { return hidden; }, get extensionHidden() { return extensionHidden; },
    get view() { return views.get(win); } };
}

const down = (f, extras = {}) => OrbitRadial.handleContentGesture(f.win, f.browser, 41,
  { kind: "down", screenX: 100, screenY: 100, buttons: 2, ...extras });
const up = (f, x = 100, y = 100) => OrbitRadial.handleContentGesture(f.win, f.browser, 41,
  { kind: "up", screenX: x, screenY: y, buttons: 0 });

test("wheel includes native pinned, collapsed/hidden groups and non-web tabs without changing groups", () => {
  const group = { id: "native-group", label: "Research", collapsed: true, color: "blue" };
  const make = (label, url, extra) => ({ label, linkedBrowser: { currentURI: { spec: url } }, ...extra });
  const pinned = make("Pinned", "about:blank", { pinned: true });
  const grouped = make("Hidden file", "file:///C:/report.html", { group, hidden: true });
  const settings = make("Settings", "about:preferences", { group });
  const closing = make("Closed", "https://closed.test", { closing: true });
  const tree = buildTabTree({ openTabs: [pinned, grouped, settings, closing], selectedTab: settings },
    tab => tab.label, value => value.id);
  assert.deepEqual(tree.map(node => node.id), ["orbit-radial-pinned", "native-group"]);
  assert.deepEqual(tree[1].children.map(node => node.description), ["file:///C:/report.html", "about:preferences"]);
  assert.equal(tree[1].children[1].checked, true);
  assert.equal(group.collapsed, true);
  assert.equal(pinned.pinned, true);
});

test("menu snapshot preserves original IDs, flattened native groups and lazy children", () => {
  const popup = new NativeNode("menupopup");
  const toolbar = new NativeNode("menugroup");
  const command = new NativeNode("menuitem", "context-back", "Back");
  const hidden = new NativeNode("menuitem", "hidden", "Hidden"); hidden.hidden = true;
  const menu = new NativeNode("menu", "extension-menu", "Extension");
  const child = new NativeNode("menupopup");
  const extension = new NativeNode("menuitem", "extension-native-leaf", "Do extension action");
  child.append(extension); menu.append(child); toolbar.append(command); popup.append(toolbar, hidden, menu);
  const elements = new Map(), populated = new Set();
  const snapshot = () => snapshotNativeMenu(popup, { identify: () => "fallback", elements, populated });
  assert.deepEqual(snapshot().map(node => node.id), ["context-back", "extension-menu"]);
  assert.equal(snapshot()[1].children[0].kind, "placeholder");
  populated.add(child);
  assert.equal(snapshot()[1].children[0].id, extension.id);
  assert.equal(elements.get(extension.id), extension);
  assert.equal(extension.commands, 0);
});

test("native command revalidates disabled and mimics checkbox/radio autocheck", () => {
  const f = fixture();
  const node = f.copy;
  node.setAttribute("type", "checkbox");
  assert.equal(executeNativeCommand(f.win, node), true);
  assert.equal(node.getAttribute("checked"), "true");
  executeNativeCommand(f.win, node);
  assert.equal(node.getAttribute("checked"), "false");
  node.disabled = true;
  assert.equal(executeNativeCommand(f.win, node), false);
  assert.equal(node.commands, 2);
  node.disabled = false; node.setAttribute("type", "radio");
  executeNativeCommand(f.win, node);
  assert.equal(node.getAttribute("checked"), "true");
  node.setAttribute("type", "checkbox");
  node.setAttribute("checked", "");
  const snapshot = snapshotNativeMenu(f.popup, { identify: () => "generated", elements: new Map(), populated: new Set() });
  assert.equal(snapshot.find(item => item.id === node.id).checked, true);
  executeNativeCommand(f.win, node);
  assert.equal(node.getAttribute("checked"), "false");
  OrbitRadial.uninit(f.win);
});

test("modified activation dispatches XUL command on original item with original event", () => {
  const f = fixture();
  const original = { ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, button: 1, mozInputSource: 2 };
  let dispatched;
  f.copy.addEventListener("command", event => { dispatched = event; assert.equal(event.target, f.copy); });
  executeNativeCommand(f.win, f.copy, original);
  assert.deepEqual(dispatched.arguments.slice(5, 10), [true, false, true, false, 1]);
  assert.equal(dispatched.arguments[10], original);
  assert.equal(f.copy.commands, 0);
  OrbitRadial.uninit(f.win);
});

test("held hover never selects; native TabSelect and late context suppression complete together", () => {
  const f = fixture(); down(f);
  assert.equal(f.view.model.mode, "tabs"); assert.equal(f.view.model.passthrough, true);
  const target = f.view.model.items.find(node => node.label === "Settings");
  f.view.hit = target;
  OrbitRadial.handleContentGesture(f.win, f.browser, 41, { kind: "move", screenX: 220, screenY: 100, buttons: 2 });
  assert.equal(f.win.gBrowser.selectedTab, f.first);
  up(f, 220, 100);
  assert.equal(f.win.gBrowser.selectedTab, f.second);
  const late = f.nativeContext(f.browser);
  assert.equal(late.event.defaultPrevented, true);
  assert.equal(f.win.gContextMenu, null);
  assert.equal(f.hidden, 1); assert.equal(f.extensionHidden, 1);
  assert.equal(f.view.model, null);
  OrbitRadial.uninit(f.win);
});

test("quick release waits for native descriptor, then command restores content focus and native lifecycle", () => {
  const f = fixture(); down(f); up(f);
  const native = f.nativeContext();
  assert.equal(native.event.defaultPrevented, true);
  assert.equal(f.view.model.mode, "context");
  f.selectAll.action = () => {
    assert.equal(f.win.contentFocused, true);
    assert.equal(f.win.gContextMenu, native.context);
    assert.equal(f.hidden, 0);
  };
  f.view.model.onActivate(f.view.model.items.find(item => item.id === "context-selectall"));
  assert.equal(f.selectAll.commands, 1);
  assert.equal(f.win.gContextMenu, null);
  assert.equal(f.hidden, 1); assert.equal(f.extensionHidden, 1);
  OrbitRadial.uninit(f.win);
});

test("Open in new tab appears only in the center and forwards the original link command", () => {
  const f = fixture();
  const original = new NativeNode("menuitem", "context-openlinkintab", "Open Link in New Tab");
  f.popup.append(original);
  f.win.document.getElementById = id => id === original.id ? original : id === f.popup.id ? f.popup : undefined;
  f.nativeContext(f.browser, {onLink: true});
  assert.equal(f.view.model.items.some(item => item.id === original.id), false);
  assert.equal(f.view.model.centerItem.label, "Open in new tab");
  f.view.model.onActivate(f.view.model.centerItem);
  assert.equal(original.commands, 1);
  assert.equal(f.win.gContextMenu, null);
  OrbitRadial.uninit(f.win);
});

test("Escape returns focus to the original content browser after native menu cleanup", () => {
  const f = fixture();
  f.nativeContext();
  f.view.model.onDismiss("escape");
  assert.equal(f.win.contentFocused, true);
  assert.equal(f.win.gContextMenu, null);
  OrbitRadial.uninit(f.win);
});

test("late background-browser context is cancelled and cleaned without a suppression token", () => {
  const f = fixture();
  f.win.gBrowser.selectedTab = f.second;
  const late = f.nativeContext(f.browser);
  assert.equal(late.event.defaultPrevented, true);
  assert.equal(f.win.gContextMenu, null);
  assert.equal(f.hidden, 1);
  assert.equal(f.extensionHidden, 1);
  assert.equal(f.view.model, null);
  OrbitRadial.uninit(f.win);
});

test("a late old-browser popup preserves a newer held wheel and its release selection", () => {
  const f = fixture();
  f.win.gBrowser.selectedTab = f.second;
  const source = f.second.linkedBrowser;
  OrbitRadial.handleContentGesture(f.win, source, 52,
    { kind: "down", screenX: 100, screenY: 100, buttons: 2 });
  const model = f.view.model;
  const target = model.items.find(item => item.label === "First");
  const late = f.nativeContext(f.browser);
  assert.equal(late.event.defaultPrevented, true);
  assert.equal(f.win.gContextMenu, null);
  assert.equal(f.hidden, 1);
  assert.equal(f.extensionHidden, 1);
  assert.equal(f.view.model, model);
  assert.equal(f.view.model.mode, "tabs");
  assert.equal(f.view.model.passthrough, true);
  f.view.hit = target;
  OrbitRadial.handleContentGesture(f.win, source, 52,
    { kind: "up", screenX: 220, screenY: 100, buttons: 0 });
  assert.equal(f.win.gBrowser.selectedTab, f.first);
  assert.equal(f.view.model, null);
  const released = f.nativeContext(source);
  assert.equal(released.event.defaultPrevented, true);
  assert.equal(f.win.gContextMenu, null);
  assert.equal(f.hidden, 2);
  OrbitRadial.uninit(f.win);
});

test("suppressed native popup cleanup preserves a released interactive tabs wheel", () => {
  const f = fixture(); down(f);
  f.view.hit = { id: "native-group", kind: "group", children: [f.view.model.items[1]] };
  up(f, 220, 100);
  const model = f.view.model;
  assert.equal(model.passthrough, false);
  const native = f.nativeContext();
  assert.equal(native.event.defaultPrevented, true);
  assert.equal(f.win.gContextMenu, null);
  assert.equal(f.hidden, 1);
  assert.equal(f.view.model, model);
  model.onActivate(model.items.find(item => item.label === "Settings"));
  assert.equal(f.win.gBrowser.selectedTab, f.second);
  assert.equal(f.view.model, null);
  OrbitRadial.uninit(f.win);
});

test("Linux down-context stays held, release switches to actions, native lazy submenu builds once", () => {
  const f = fixture(); down(f); f.nativeContext();
  assert.equal(f.view.model.mode, "tabs");
  let built = 0;
  f.submenu.addEventListener("popupshowing", () => {
    built++;
    f.submenu.append(new NativeNode("menuitem", "native-container-2", "Work container"));
  });
  up(f);
  const branch = f.view.model.items.find(item => item.id === f.container.id);
  f.view.model.onHover(branch);
  f.view.model.onHover(branch);
  assert.equal(built, 1);
  assert.equal(f.view.model.items.find(item => item.id === branch.id).children[0].id, "native-container-2");
  assert.equal(f.win.gBrowser.selectedTab, f.first);
  OrbitRadial.uninit(f.win);
});

test("Shift-RMB leaves original native popup visible without relying on popup modifier fields", () => {
  const f = fixture(); down(f, { shiftKey: true });
  const native = f.nativeContext();
  assert.equal(native.event.shiftKey, undefined);
  assert.equal(native.event.defaultPrevented, false);
  assert.equal(f.view.model, null);
  assert.equal(f.win.gContextMenu, native.context);
  // Native popuphiding owns this context; it was not retained by Orbit.
  assert.equal(f.hidden, 0);
  OrbitRadial.uninit(f.win);
});

test("source-frame navigation clears retained native context even after neutral gesture ended", () => {
  const f = fixture(); down(f); up(f); f.nativeContext();
  OrbitRadial.cancelContentGesture(f.win, f.browser, 999);
  assert.equal(f.view.model.mode, "context");
  OrbitRadial.cancelContentGesture(f.win, f.browser, 41);
  assert.equal(f.view.model, null);
  assert.equal(f.win.gContextMenu, null);
  assert.equal(f.hidden, 1);
  OrbitRadial.uninit(f.win);
});

test("child ignores synthetic input and reports trusted subframe up in physical screen coordinates", () => {
  const child = new OrbitRadialChild();
  child.contentWindow = { devicePixelRatio: 1.5, cancelAnimationFrame() {} };
  const sent = []; child.sendAsyncMessage = (name, data) => sent.push({ name, data });
  const event = { type: "mouseup", button: 2, buttons: 0, screenX: 40, screenY: 80 };
  child.handleEvent({ ...event, isTrusted: false });
  assert.equal(sent.length, 0);
  child.handleEvent({ ...event, isTrusted: true });
  assert.equal(sent[0].data.kind, "up");
  assert.equal(sent[0].data.screenXDevPx, 60);
  assert.equal(sent[0].data.screenYDevPx, 120);
  assert.equal(event.defaultPrevented, undefined);
});

test("parent refuses wrong owner, non-current ancestors and invalid coordinates; converts chrome DPR", () => {
  const f = fixture();
  const parent = new OrbitRadialParent();
  parent.manager = { isCurrentGlobal: true, rootFrameLoader: { ownerElement: f.browser } };
  parent.browsingContext = { id: 41, ancestorsAreCurrent: true, isInBFCache: false, isDiscarded: false };
  parent.actorCreated();
  const pointer = { name: "OrbitRadial:Pointer", data: { kind: "down", screenXDevPx: 200, screenYDevPx: 300, buttons: 2 } };
  parent.manager.isCurrentGlobal = false; parent.receiveMessage(pointer); assert.equal(f.view.model, undefined);
  parent.manager.isCurrentGlobal = true; parent.browsingContext.ancestorsAreCurrent = false;
  parent.receiveMessage(pointer); assert.equal(f.view.model, undefined);
  parent.browsingContext.ancestorsAreCurrent = true;
  parent.receiveMessage({ ...pointer, data: { ...pointer.data, screenXDevPx: NaN } });
  assert.equal(f.view.model, undefined);
  parent.manager.rootFrameLoader.ownerElement = { ownerDocument: { defaultView: f.win } };
  parent.receiveMessage(pointer); assert.equal(f.view.model, undefined);
  parent.manager.rootFrameLoader.ownerElement = f.browser;
  parent.receiveMessage(pointer);
  assert.deepEqual(f.view.model.center, { screenX: 100, screenY: 150 });
  parent.manager.isCurrentGlobal = false;
  parent.receiveMessage({ name: "OrbitRadial:Pointer", data: { kind: "cancel" } });
  assert.equal(f.view.model, null);
  OrbitRadial.uninit(f.win);
});

test("uninit removes native hooks and registration uses trusted actor options only once", () => {
  const f = fixture(); down(f); f.nativeContext();
  const view = f.view;
  OrbitRadial.uninit(f.win);
  assert.equal(view.destroyed, true);
  assert.equal(f.hidden, 1);
  assert.equal(f.timers.size, 0);
  const native = f.nativeContext();
  assert.equal(native.event.defaultPrevented, false);
  assert.equal(registrations.length, 1);
  const options = registrations[0].options;
  assert.equal(options.allFrames, true);
  assert.equal(options.includeChrome, false);
  assert.equal(options.child.events.mousedown.wantUntrusted, false);
});
