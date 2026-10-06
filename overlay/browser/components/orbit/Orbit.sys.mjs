/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orbit's native browser chrome integration. This module is registered in
 * BrowserComponents.manifest, not installed through the extension APIs.
 * Web documents always live in a type="content" Firefox browser. The board is
 * a packaged chrome document; it never renders downloaded HTML or scripts.
 */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  OrbitInteractions: "moz-src:///browser/components/orbit/OrbitInteractions.sys.mjs",
  OrbitRadial: "moz-src:///browser/components/orbit/OrbitRadial.sys.mjs",
  OrbitTheme: "moz-src:///browser/components/orbit/OrbitTheme.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

const BOARD_URI = "chrome://browser/content/orbit/orbit.html";
const BOARD_KEY = "orbit-board-v1";
const TAB_KEY = "orbit-tab-id-v1";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function identifier(value, label = "id") {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`Invalid Orbit ${label}`);
  }
  return value;
}

function finite(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`Invalid Orbit ${label}`);
  }
  return value;
}

function text(value, max, label) {
  if (typeof value !== "string" || value.length > max) {
    throw new TypeError(`Invalid Orbit ${label}`);
  }
  return value;
}

function color(value) {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    throw new TypeError("Invalid Orbit color");
  }
  return value;
}

function webURL(value) {
  text(value, 8192, "URL");
  const uri = Services.io.newURI(value);
  if (
    !(uri.schemeIs("https") || uri.schemeIs("http")) ||
    !uri.host ||
    uri.userPass
  ) {
    throw new TypeError("Orbit cards require an HTTP or HTTPS URL without credentials");
  }
  return uri.spec;
}

function isWebURL(value) {
  try {
    webURL(value);
    return true;
  } catch {
    return false;
  }
}

function containerID(value = 0) {
  finite(value, 0, 0x7fffffff, "container");
  if (!Number.isInteger(value)) {
    throw new TypeError("Invalid Orbit container");
  }
  return value;
}

/** Copy only the documented board schema. No HTML, principals, browser objects,
 * arbitrary properties, or privileged URLs may pass through persistence.
 */
function validateBoard(value) {
  if (!value || value.version !== 1) {
    throw new TypeError("Unsupported Orbit board version");
  }
  const array = (name, limit) => {
    if (!Array.isArray(value[name]) || value[name].length > limit) {
      throw new TypeError(`Invalid Orbit ${name}`);
    }
    return value[name];
  };
  const ids = new Set();
  const uniqueID = id => {
    identifier(id);
    if (ids.has(id)) {
      throw new TypeError("Duplicate Orbit board id");
    }
    ids.add(id);
    return id;
  };
  const geometry = item => ({
    x: finite(item.x, -100000, 100000, "x"),
    y: finite(item.y, -100000, 100000, "y"),
    w: finite(item.w, 32, 50000, "width"),
    h: finite(item.h, 32, 50000, "height"),
  });
  const frames = array("frames", 100).map(frame => ({
    id: uniqueID(frame.id),
    ...geometry(frame),
    title: text(frame.title, 512, "frame title"),
    color: color(frame.color),
  }));
  const frameIDs = new Set(frames.map(frame => frame.id));
  const items = array("items", 500).map(item => {
    const result = { id: uniqueID(item.id), type: item.type, ...geometry(item) };
    if (item.frameId !== undefined && item.frameId !== null) {
      result.frameId = identifier(item.frameId, "frame id");
      if (!frameIDs.has(result.frameId)) {
        throw new TypeError("Unknown Orbit frame");
      }
    }
    if (item.type === "tab") {
      result.url = webURL(item.url);
      result.title = text(item.title, 2048, "tab title");
      result.userContextId = containerID(item.userContextId);
      if (item.tabId) {
        result.tabId = identifier(item.tabId, "tab id");
      }
    } else if (item.type === "note") {
      result.text = text(item.text, 20000, "note");
      result.color = color(item.color);
    } else {
      throw new TypeError("Unknown Orbit item type");
    }
    return result;
  });
  const endpoints = new Set([...frameIDs, ...items.map(item => item.id)]);
  const connections = array("connections", 1000).map(connection => {
    const result = {
      id: uniqueID(connection.id),
      from: identifier(connection.from),
      to: identifier(connection.to),
    };
    if (
      result.from === result.to ||
      !endpoints.has(result.from) ||
      !endpoints.has(result.to)
    ) {
      throw new TypeError("Invalid Orbit connection endpoint");
    }
    return result;
  });
  let pointCount = 0;
  const strokes = array("strokes", 300).map(stroke => {
    if (!Array.isArray(stroke.points) || stroke.points.length < 2) {
      throw new TypeError("Invalid Orbit stroke");
    }
    pointCount += stroke.points.length;
    if (pointCount > 20000) {
      throw new TypeError("Orbit board has too many drawing points");
    }
    return {
      id: uniqueID(stroke.id),
      color: color(stroke.color),
      width: finite(stroke.width, 1, 32, "stroke width"),
      points: stroke.points.map(point => ({
        x: finite(point.x, -100000, 100000, "point x"),
        y: finite(point.y, -100000, 100000, "point y"),
      })),
    };
  });
  const board = {
    version: 1,
    camera: {
      x: finite(value.camera?.x, -100000, 100000, "camera x"),
      y: finite(value.camera?.y, -100000, 100000, "camera y"),
      zoom: finite(value.camera?.zoom, 0.2, 2, "zoom"),
    },
    items,
    frames,
    connections,
    strokes,
  };
  if (JSON.stringify(board).length > MAX_BYTES) {
    throw new TypeError("Orbit board is too large");
  }
  return board;
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

class OrbitWindow {
  constructor(win) {
    this.win = win;
    this.isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    this.board = null;
    this.privateTabIDs = new WeakMap();
    this.claimedTabIDs = new Map();
    this.listeners = new Set();
    this.canvasBridges = new WeakMap();
    this.cleanups = [];
    this.disposed = false;
    this.overlay = null;
    this.frame = null;
    this.peekPanel = null;
    this.peekBrowser = null;
    this.peekProgress = null;
    this.captureToast = null;
    this.captureToastTimer = null;
    this.oldBrowserPosition = null;

    // The browser-window bridge keeps the toolbar canvas contract. Native new
    // tabs receive separate bridges bound to their exact document and browser.
    Object.defineProperty(win, "OrbitChrome", {
      value: this.createBridge(),
      configurable: true,
    });

    const tabsChanged = event => {
      if (event.type === "TabSelect") {
        this.hide();
      }
      this.notify();
    };
    for (const name of ["TabOpen", "TabClose", "TabSelect", "TabAttrModified", "SSTabRestored"]) {
      this.listen(win.gBrowser.tabContainer, name, tabsChanged);
    }
    this.listen(win, "keydown", event => {
      if (
        event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey &&
        event.code === "KeyO" && !event.repeat
      ) {
        event.preventDefault();
        this.toggle();
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        if (this.peekPanel) {
          event.preventDefault();
          this.closePeek();
        } else if (this.overlay && !this.overlay.hidden) {
          event.preventDefault();
          this.hide();
        }
      }
    }, true);
    this.listen(win, "unload", () => this.destroy(), { once: true });
  }

  createBridge(document = null, browser = null) {
    const bridge = {};
    const expose = (name, callback) => {
      bridge[name] = (...args) => {
        this.assertBoard(document, browser);
        return callback(...args);
      };
    };
    expose("getBoard", () => this.getBoard());
    expose("saveBoard", board => this.saveBoard(board, document || this.frame?.contentDocument));
    expose("listTabs", () => this.listTabs());
    expose("openTab", record => this.openTab(record));
    expose("openFrame", frameID => this.openFrame(frameID));
    expose("selectTab", tabID => this.selectTab(tabID));
    expose("closeTab", tabID => this.closeTab(tabID));
    expose("peek", record => this.peek(record));
    expose("closePeek", () => this.closePeek());
    expose("split", record => this.split(record));
    expose("hideCanvas", () => browser ? this.returnToBrowser(browser) : this.hide());
    expose("subscribe", callback => {
      if (typeof callback !== "function") {
        throw new TypeError("Orbit subscription requires a function");
      }
      const source = document || this.frame?.contentDocument;
      const listener = (tabs, change) => {
        try {
          this.assertBoard(source, browser);
        } catch {
          this.listeners.delete(listener);
          return;
        }
        callback(tabs, change);
      };
      listener.document = source;
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    });
    return Object.freeze(bridge);
  }

  listen(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    this.cleanups.push(() => target.removeEventListener(name, callback, options));
  }

  assertBoard(document = null, browser = null) {
    const doc = document || this.frame?.contentDocument;
    if (
      this.disposed || !doc || doc.documentURI !== BOARD_URI ||
      !doc.nodePrincipal?.isSystemPrincipal
    ) {
      throw new Error("Orbit bridge is available only to the packaged canvas");
    }
    if (browser) {
      const tab = this.win.gBrowser.getTabForBrowser(browser);
      const global = browser.browsingContext?.currentWindowGlobal;
      if (
        browser.ownerDocument?.defaultView !== this.win ||
        browser.contentDocument !== doc || browser.currentURI?.spec !== BOARD_URI ||
        !tab || tab.closing || !this.win.gBrowser.tabs.includes(tab) ||
        global?.isCurrentGlobal === false || global?.isInBFCache || global?.isDiscarded
      ) {
        throw new Error("Orbit bridge is available only to a current native canvas tab");
      }
    } else if (document && this.frame?.contentDocument !== doc) {
      throw new Error("Orbit bridge is available only to the current packaged canvas");
    }
  }

  connectCanvas(document, browser) {
    this.assertBoard(document, browser);
    let bridge = this.canvasBridges.get(document);
    if (!bridge) {
      bridge = this.createBridge(document, browser);
      this.canvasBridges.set(document, bridge);
    }
    return bridge;
  }

  getBoard() {
    if (this.board === null && !this.isPrivate) {
      const stored = lazy.SessionStore.getCustomWindowValue(this.win, BOARD_KEY);
      if (stored && stored.length <= MAX_BYTES) {
        try {
          this.board = validateBoard(JSON.parse(stored));
        } catch (error) {
          console.error("Orbit ignored an invalid saved board", error);
        }
      }
    }
    return clone(this.board);
  }

  saveBoard(value, source = null) {
    const board = validateBoard(value);
    if (!this.isPrivate) {
      lazy.SessionStore.setCustomWindowValue(this.win, BOARD_KEY, JSON.stringify(board));
    }
    this.board = board;
    this.notify({ type: "board-changed", board }, source);
    return clone(board);
  }

  getFrames() {
    const board = this.getBoard();
    return (board?.frames || []).map(frame => ({
      id: frame.id,
      title: frame.title,
      tabCount: board.items.filter(item => item.type === "tab" && item.frameId === frame.id).length,
    }));
  }

  captureContext(context, kind) {
    const browser = context?.browser;
    const tab = browser && this.win.gBrowser.getTabForBrowser(browser);
    const actor = context?.actor;
    // A selected subframe can provide the context, but its live WindowGlobal
    // must still belong to this selected browser when the command executes.
    // These are the same actor lifecycle/owner checks as OrbitRadialParent.
    if (this.disposed || context !== this.win.gContextMenu ||
        browser !== this.win.gBrowser.selectedBrowser ||
        browser?.ownerDocument?.defaultView !== this.win ||
        !tab || tab.closing || !this.win.gBrowser.tabs.includes(tab) ||
        !actor?.manager?.isCurrentGlobal || !actor.browsingContext?.ancestorsAreCurrent ||
        actor.browsingContext.isInBFCache || actor.browsingContext.isDiscarded ||
        actor.manager.rootFrameLoader?.ownerElement !== browser) {
      throw new Error("Orbit requires a current native webpage context");
    }
    const board = this.getBoard() || {
      version: 1, camera: { x: 68, y: 78, zoom: 1 },
      frames: [], items: [], connections: [], strokes: [],
    };
    const userContextId = containerID(Number(tab.userContextId || 0));
    let item, existing = false;
    if (kind === "selection") {
      const selected = context.selectionInfo?.fullText;
      if (!context.isTextSelected || context.onPassword || context.passwordRevealed ||
          typeof selected !== "string" || !selected.trim()) {
        throw new TypeError("Orbit requires selected text outside a password field");
      }
      const source = webURL(context.contentData?.docLocation || browser.currentURI.spec);
      const annotation = `\n\nSource: ${source}`;
      const note = selected.slice(0, 20000 - annotation.length) + annotation;
      item = board.items.find(candidate => candidate.type === "note" && candidate.text === note);
      existing = !!item;
      if (!item) item = { type: "note", text: note, color: "#70ded3", w: 256, h: 208 };
    } else if (kind === "page" || kind === "link") {
      if (kind === "link" && !context.onLink) throw new TypeError("Orbit requires a native link context");
      const url = webURL(kind === "link" ? context.linkURL : browser.currentURI.spec);
      const live = kind === "page" ? tab : this.win.gBrowser.tabs.find(candidate =>
        !candidate.closing && candidate.linkedBrowser?.currentURI?.spec === url &&
        Number(candidate.userContextId || 0) === userContextId
      );
      item = board.items.find(candidate => candidate.type === "tab" &&
        candidate.url === url && candidate.userContextId === userContextId);
      existing = !!item;
      if (!item) item = {
        type: "tab", url, userContextId, w: 248, h: 160,
        title: String(kind === "page" ? tab.label || url : context.linkTextStr || url).slice(0, 2048),
      };
      if (live) item.tabId = this.tabID(live);
    } else {
      throw new TypeError("Unknown Orbit canvas capture action");
    }
    if (!existing) {
      if (board.items.length >= 500) throw new Error("This workspace has reached its 500 card limit");
      const index = board.items.filter(candidate => !candidate.frameId).length;
      Object.assign(item, {
        id: `orbit-${Services.uuid.generateUUID().toString().replace(/[{}]/g, "")}`,
        x: Math.min(100000, index % 3 * 276),
        y: Math.min(100000, Math.floor(index / 3) * 228),
      });
      board.items.push(item);
    }
    this.saveBoard(board);
    this.showCaptureToast(existing ? "Already on your canvas" :
      kind === "selection" ? "Text saved to your canvas" : "Card added to your canvas");
    return { id: item.id, type: item.type, existing };
  }

  showCaptureToast(message) {
    const doc = this.win.document;
    if (!this.captureToast) {
      const toast = doc.createElementNS(HTML_NS, "div");
      toast.id = "orbit-capture-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      toast.style.cssText = "position:fixed;z-index:2147483646;bottom:28px;left:50%;transform:translateX(-50%);padding:14px 22px;border-radius:24px;border:1px solid var(--orbit-chrome-highlight,#ffffffb0);background:var(--orbit-chrome-raised,#f5f8fc);color:var(--orbit-chrome-ink,#253247);box-shadow:9px 9px 24px var(--orbit-chrome-shadow,#99acc14a),-5px -5px 18px var(--orbit-chrome-highlight,#ffffffc9),inset 0 1px 0 #fff4;font:600 13px system-ui;pointer-events:none;max-width:80vw;";
      doc.getElementById("browser").append(toast);
      this.captureToast = toast;
    }
    this.captureToast.textContent = `◉  ${message}`;
    if (!this.win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.captureToast.animate?.([
        { opacity: 0, transform: "translate(-50%,10px) scale(.96)" },
        { opacity: 1, transform: "translate(-50%,0) scale(1)" },
      ], { duration: 260, easing: "cubic-bezier(.22,1,.36,1)" });
    }
    this.win.clearTimeout(this.captureToastTimer);
    this.captureToastTimer = this.win.setTimeout(() => {
      this.captureToast?.remove();
      this.captureToast = null;
      this.captureToastTimer = null;
    }, 2400);
  }

  tabID(tab) {
    let id = this.isPrivate
      ? this.privateTabIDs.get(tab)
      : lazy.SessionStore.getCustomTabValue(tab, TAB_KEY);
    const claimed = id ? this.claimedTabIDs.get(id)?.deref() : null;
    // Firefox's Duplicate Tab copies SessionStore custom values. Give that
    // duplicate its own identity while preserving the original card binding.
    if (!id || !ID_PATTERN.test(id) ||
        (claimed && claimed !== tab && this.win.gBrowser.tabs.includes(claimed))) {
      id = `orbit-${Services.uuid.generateUUID().toString().replace(/[{}]/g, "")}`;
      if (this.isPrivate) {
        this.privateTabIDs.set(tab, id);
      } else {
        lazy.SessionStore.setCustomTabValue(tab, TAB_KEY, id);
      }
    }
    this.claimedTabIDs.set(id, new WeakRef(tab));
    return id;
  }

  describeTab(tab) {
    return {
      id: this.tabID(tab),
      title: (tab.label || tab.linkedBrowser.currentURI.spec).slice(0, 2048),
      url: tab.linkedBrowser.currentURI.spec,
      userContextId: Number(tab.userContextId || 0),
      selected: tab === this.win.gBrowser.selectedTab,
      active: tab === this.win.gBrowser.selectedTab,
      pinned: !!tab.pinned,
    };
  }

  listTabs() {
    return this.win.gBrowser.tabs
      .filter(tab => !tab.closing && isWebURL(tab.linkedBrowser?.currentURI?.spec))
      .map(tab => this.describeTab(tab));
  }

  findTab(id) {
    identifier(id, "tab id");
    return this.win.gBrowser.tabs.find(tab => !tab.closing && this.tabID(tab) === id);
  }

  record(value) {
    if (!value || typeof value !== "object") {
      throw new TypeError("Orbit requires a tab record");
    }
    const url = webURL(value.url);
    const tabId = value.tabId ? identifier(value.tabId, "tab id") : null;
    const existing = tabId ? this.findTab(tabId) : null;
    let userContextId = existing
      ? Number(existing.userContextId || 0)
      : containerID(value.userContextId);
    if (this.isPrivate && userContextId) {
      throw new TypeError("Containers are not available in private windows");
    }
    if (userContextId && !lazy.ContextualIdentityService.getPublicIdentityFromId(userContextId)) {
      throw new TypeError("This Firefox container no longer exists");
    }
    return { url, tabId, userContextId, existing };
  }

  navigationOptions(record) {
    // A live tab's actual principal and referrer remain inside chrome. Saved
    // cards receive a fresh null principal; the board never supplies one.
    const source = record.sourceBrowser || record.existing?.linkedBrowser;
    const attrs = {
      userContextId: record.userContextId,
      privateBrowsingId: this.isPrivate ? 1 : 0,
    };
    const triggeringPrincipal = source?.contentPrincipal && !source.contentPrincipal.isSystemPrincipal
      ? source.contentPrincipal
      : Services.scriptSecurityManager.createNullPrincipal(attrs);
    const options = {
      userContextId: record.userContextId,
      triggeringPrincipal,
      allowInheritPrincipal: false,
    };
    if (source) {
      if (source.referrerInfo) {
        options.referrerInfo = source.referrerInfo;
      } else {
        const referrer = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
        referrer.init(Ci.nsIReferrerInfo.EMPTY, true, source.currentURI);
        options.referrerInfo = referrer;
      }
      if (source.policyContainer) {
        options.policyContainer = source.policyContainer;
      }
    }
    return options;
  }

  ensureTab(record) {
    if (record.existing) {
      return record.existing;
    }
    return this.win.gBrowser.addTab(record.url, {
      ...this.navigationOptions(record),
      inBackground: true,
      relatedToCurrent: false,
    });
  }

  openTab(value) {
    return this.openNativeRecord(this.record(value), value.background === true);
  }

  openNativeRecord(record, background = false) {
    const tab = this.ensureTab(record);
    if (!background) {
      this.win.gBrowser.selectedTab = tab;
      this.hide();
    }
    const result = this.describeTab(tab);
    // Navigation is asynchronous: a just-created native browser may still
    // expose about:blank until its first location change arrives.
    if (!record.existing) {
      result.url = record.url;
      result.title = record.url;
    }
    return result;
  }

  selectTab(id) {
    const tab = this.findTab(id);
    if (!tab) {
      throw new Error("The tab has closed; open its saved card to restore it");
    }
    this.win.gBrowser.selectedTab = tab;
    this.hide();
    return this.describeTab(tab);
  }

  returnToBrowser(browser) {
    this.hide();
    const candidates = this.win.gBrowser.tabs.filter(tab =>
      !tab.closing && !tab.hidden && tab.linkedBrowser !== browser &&
      tab.linkedBrowser?.currentURI?.spec !== BOARD_URI
    );
    candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (candidates.length) {
      this.win.gBrowser.selectedTab = candidates[0];
      candidates[0].linkedBrowser.focus();
    } else {
      // A fresh window may contain only canvases. Keep its real native new tab
      // and offer the address bar rather than opening an extra empty document.
      this.win.gURLBar?.select();
    }
  }

  closeTab(id) {
    const tab = this.findTab(id);
    if (tab) {
      this.win.gBrowser.removeTab(tab, { animate: true });
    }
    return !!tab;
  }

  openFrame(id) {
    identifier(id, "frame id");
    const board = this.getBoard();
    if (!board?.frames.some(frame => frame.id === id)) {
      throw new TypeError("Unknown Orbit frame");
    }
    const items = board.items.filter(item => item.type === "tab" && item.frameId === id);
    // Validate the entire group before creating anything, including containers.
    const records = items.map(item => this.record(item));
    const tabs = records.map(record => this.ensureTab(record));
    for (let index = 0; index < tabs.length; ++index) {
      items[index].tabId = this.tabID(tabs[index]);
    }
    this.saveBoard(board);
    if (tabs.length) {
      this.win.gBrowser.selectedTab = tabs[0];
      this.hide();
    }
    return { opened: tabs.length, selected: tabs.length ? this.tabID(tabs[0]) : null };
  }

  split(value) {
    return this.splitRecord(this.record(value));
  }

  splitRecord(record) {
    const browser = this.win.gBrowser;
    if (!Services.prefs.getBoolPref("browser.tabs.splitView.enabled", false) ||
        typeof browser.addTabSplitView !== "function") {
      throw new Error("Native split views are disabled in this Firefox build");
    }
    const left = browser.selectedTab;
    if (left.pinned || left.hidden || left.splitview) {
      throw new Error("Choose a visible, unpinned tab outside a split view first");
    }
    if (record.existing === left) {
      record.sourceBrowser = left.linkedBrowser;
      record.existing = null;
    } else if (record.existing?.pinned || record.existing?.hidden || record.existing?.splitview) {
      throw new Error("The comparison tab must be visible, unpinned, and outside a split view");
    }
    const right = this.ensureTab(record);
    const split = browser.addTabSplitView([left, right], { insertBefore: left });
    if (!split) {
      throw new Error("Firefox could not create this split view");
    }
    browser.selectedTab = right;
    this.hide();
    return { left: this.tabID(left), right: this.tabID(right) };
  }

  ensureOverlay() {
    if (this.overlay) {
      return;
    }
    const doc = this.win.document;
    const parent = doc.getElementById("browser");
    if (!parent) {
      throw new Error("Orbit requires a normal Firefox browser window");
    }
    this.oldBrowserPosition = parent.style.position;
    parent.style.position = "relative";
    const overlay = doc.createElementNS(HTML_NS, "div");
    overlay.id = "orbit-canvas-overlay";
    overlay.hidden = true;
    overlay.style.cssText = "position:absolute;inset:0;z-index:20;background:#e9eef5;";
    const frame = doc.createElementNS(HTML_NS, "iframe");
    frame.id = "orbit-canvas-frame";
    frame.title = "Orbit spatial tab canvas";
    frame.style.cssText = "width:100%;height:100%;border:0;display:block;";
    this.overlay = overlay;
    this.frame = frame;
    overlay.append(frame);
    parent.append(overlay);
    frame.src = BOARD_URI;
  }

  show() {
    this.ensureOverlay();
    this.overlay.hidden = false;
    const button = this.win.document.getElementById("orbit-canvas-button");
    button?.setAttribute("aria-pressed", "true");
    this.frame.focus();
    this.notify();
  }

  hide() {
    this.closePeek();
    if (this.overlay) {
      this.overlay.hidden = true;
    }
    this.win.document.getElementById("orbit-canvas-button")?.setAttribute("aria-pressed", "false");
  }

  toggle() {
    if (this.overlay && !this.overlay.hidden) {
      this.hide();
      this.win.gBrowser.selectedBrowser.focus();
    } else {
      this.show();
    }
  }

  peek(value) {
    const record = this.record(value);
    const options = this.navigationOptions(record);
    this.closePeek();
    const doc = this.win.document;
    const panel = doc.createElementNS(HTML_NS, "section");
    panel.id = "orbit-peek-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Live page preview");
    panel.style.cssText = "position:absolute;z-index:30;inset:7% 9%;display:flex;flex-direction:column;background:white;border:1px solid #d5d2cd;border-radius:18px;box-shadow:0 22px 80px #0004;overflow:hidden;";
    const bar = doc.createElementNS(HTML_NS, "div");
    bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f3f2ef;font:13px system-ui;";
    const address = doc.createElementNS(HTML_NS, "span");
    address.textContent = record.url;
    address.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    bar.append(address);
    const button = (label, action) => {
      const node = doc.createElementNS(HTML_NS, "button");
      node.textContent = label;
      node.style.cssText = "border:1px solid #d1cec8;border-radius:8px;padding:7px 11px;background:white;color:#25282c;font:inherit;cursor:pointer;";
      node.addEventListener("click", () => {
        try {
          action();
        } catch (error) {
          this.win.alert(error.message);
        }
      });
      bar.append(node);
    };
    // Snapshot native navigation metadata before selection disposes the peek.
    // No principal or source browser is accepted through the public bridge.
    const currentRecord = () => {
      const result = this.record({
        url: browser.currentURI.spec,
        userContextId: record.userContextId,
      });
      result.sourceBrowser = browser;
      return result;
    };
    button("Open tab", () => this.openNativeRecord(currentRecord()));
    button("Split", () => this.splitRecord(currentRecord()));
    button("Close", () => this.closePeek());
    const remoteType = ChromeUtils.predictRemoteTypeForURI(record.url, {
      window: this.win,
      userContextId: record.userContextId,
    });
    const browser = this.win.gBrowser.createBrowser({
      remoteType,
      userContextId: record.userContextId,
      uriIsAboutBlank: false,
    });
    browser.id = "orbit-peek-browser";
    browser.setAttribute("disablehistory", "true");
    browser.setAttribute("disablefullscreen", "true");
    // This browser is a temporary preview, not a gBrowser tab. Avoid letting
    // tab-specific context commands act upon the unrelated selected tab.
    browser.removeAttribute("contextmenu");
    browser.style.cssText = "display:flex;flex:1;min-height:0;width:100%;";
    panel.append(bar, browser);
    this.win.document.getElementById("browser").append(panel);
    this.peekPanel = panel;
    this.peekBrowser = browser;
    browser.docShellIsActive = true;
    try {
      this.peekProgress = {
        QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
        onLocationChange(progress, request, location) {
          if (progress.isTopLevel && location) {
            // Show the effective address after redirects or in-preview links.
            address.textContent = location.spec;
          }
        },
        onStateChange() {},
        onProgressChange() {},
        onStatusChange() {},
        onSecurityChange() {},
        onContentBlockingEvent() {},
      };
      browser.addProgressListener(this.peekProgress, Ci.nsIWebProgress.NOTIFY_LOCATION);
      browser.loadURI(Services.io.newURI(record.url), options);
    } catch (error) {
      this.closePeek();
      throw error;
    }
    return { url: record.url, userContextId: record.userContextId };
  }

  closePeek() {
    if (this.peekBrowser) {
      try {
        if (this.peekProgress) {
          this.peekBrowser.removeProgressListener(this.peekProgress);
        }
        this.peekBrowser.stop();
        this.peekBrowser.docShellIsActive = false;
      } catch {}
      this.peekBrowser.destroy();
      this.peekBrowser = null;
    }
    this.peekProgress = null;
    this.peekPanel?.remove();
    this.peekPanel = null;
  }

  notify(change = null, source = null) {
    for (const [id, reference] of this.claimedTabIDs) {
      const tab = reference.deref();
      if (!tab || tab.closing || !this.win.gBrowser.tabs.includes(tab)) {
        this.claimedTabIDs.delete(id);
      }
    }
    if (!this.listeners.size) {
      return;
    }
    const tabs = this.listTabs();
    for (const callback of this.listeners) {
      if (source && callback.document === source) {
        continue;
      }
      try {
        callback(clone(tabs), clone(change));
      } catch (error) {
        console.error("Orbit tab subscription failed", error);
      }
    }
  }

  destroy() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    this.closePeek();
    this.win.clearTimeout(this.captureToastTimer);
    this.captureToast?.remove();
    this.captureToast = null;
    this.listeners.clear();
    this.claimedTabIDs.clear();
    this.overlay?.remove();
    if (this.oldBrowserPosition !== null) {
      const parent = this.win.document.getElementById("browser");
      if (parent) {
        parent.style.position = this.oldBrowserPosition;
      }
    }
    delete this.win.OrbitChrome;
    this.board = null;
    this.frame = null;
    this.overlay = null;
  }
}

export const Orbit = {
  _windows: new WeakMap(),
  _widgetCreated: false,
  _newTabConfigured: false,

  init(win) {
    if (!win.gBrowser || this._windows.has(win)) {
      return;
    }
    if (!this._newTabConfigured) {
      // Firefox's native commands and initial-page URL bar handling already
      // consume this service. Use a real packaged tab, not a blank-tab overlay.
      lazy.AboutNewTab.newTabURL = BOARD_URI;
      this._newTabConfigured = true;
    }
    this._windows.set(win, new OrbitWindow(win));
    lazy.OrbitTheme.init(win);
    lazy.OrbitRadial.init(win);
    lazy.OrbitInteractions.init(win);
    if (!this._widgetCreated) {
      lazy.CustomizableUI.createWidget({
        id: "orbit-canvas-button",
        defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
        label: "Orbit canvas",
        tooltiptext: "Orbit canvas (Alt+Shift+O)",
        showInPrivateBrowsing: true,
        onCreated(node) {
          // MozToolbarbutton maps image to its native icon's src attribute.
          // Gecko blocks SVG context paint in data: images; chrome: preserves
          // the themed icon in the toolbar, overflow menu, and customization.
          node.setAttribute("image", "chrome://browser/content/orbit/orbit.svg");
          node.setAttribute("aria-pressed", "false");
        },
        onCommand(event) {
          // ownerGlobal was removed from Gecko's Node WebIDL. Resolve the
          // actual command's window through the standard DOM document instead.
          const node = event.currentTarget || event.target;
          Orbit.toggleBoard(node.ownerDocument.defaultView);
        },
      });
      this._widgetCreated = true;
    }
  },

  openBoard(win) {
    this.init(win);
    this._windows.get(win)?.show();
  },

  getFrames(win) {
    this.init(win);
    return this._windows.get(win)?.getFrames() || [];
  },

  openFrame(win, id) {
    this.init(win);
    return this._windows.get(win)?.openFrame(id);
  },

  captureContext(win, context, kind) {
    this.init(win);
    return this._windows.get(win)?.captureContext(context, kind);
  },

  connectCanvas(canvasWindow) {
    const document = canvasWindow?.document;
    if (document?.documentURI !== BOARD_URI || !document.nodePrincipal?.isSystemPrincipal) {
      throw new Error("Orbit can connect only the packaged canvas document");
    }
    const browser = canvasWindow.docShell?.chromeEventHandler;
    const win = browser?.ownerDocument?.defaultView;
    if (!win?.gBrowser || browser.contentDocument !== document ||
        !win.gBrowser.getTabForBrowser(browser)) {
      throw new Error("Orbit requires a canvas in a native browser tab");
    }
    this.init(win);
    return this._windows.get(win).connectCanvas(document, browser);
  },

  closeBoard(win) {
    this._windows.get(win)?.hide();
  },

  toggleBoard(win) {
    this.init(win);
    this._windows.get(win)?.toggle();
  },

  uninit(win) {
    lazy.OrbitInteractions.uninit(win);
    lazy.OrbitRadial.uninit(win);
    lazy.OrbitTheme.uninit(win);
    this._windows.get(win)?.destroy();
    this._windows.delete(win);
  },
};
