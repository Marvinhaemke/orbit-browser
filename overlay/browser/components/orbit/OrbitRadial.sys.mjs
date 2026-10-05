/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  OrbitRadialView: "moz-src:///browser/components/orbit/OrbitRadialView.sys.mjs",
});
const windows = new WeakMap();
let actorRegistered = false;
const TAB_EVENTS = [
  "TabOpen", "TabClose", "TabSelect", "TabAttrModified", "SSTabRestored",
  "TabMove", "TabGrouped", "TabUngrouped", "TabGroupCreate", "TabGroupRemoved",
  "TabGroupUpdate", "TabGroupCollapse", "TabGroupExpand", "TabShow", "TabHide",
];

export function nativeMenuVisible(node) {
  return !node.hidden && !node.collapsed && node.getAttribute("hidden") !== "true" &&
    node.getAttribute("collapsed") !== "true" && node.style?.display !== "none";
}

function nativeMenuChecked(node) {
  // Native context initialization also uses toggleAttribute, whose true
  // state is an empty attribute rather than the literal string "true".
  return node.hasAttribute("checked") && node.getAttribute("checked") !== "false";
}

/** Snapshot the original native menu, never a parallel list of page actions.
 * Native submenu construction is lazy, so unvisited menus have a placeholder
 * until their actual popupshowing handlers have run. */
export function snapshotNativeMenu(popup, { identify, elements, populated }) {
  const result = [];
  for (const node of popup.children) {
    if (!nativeMenuVisible(node)) continue;
    const tag = node.localName;
    if (tag === "menugroup" || tag === "hbox" || tag === "vbox") {
      result.push(...snapshotNativeMenu(node, { identify, elements, populated }));
      continue;
    }
    if (tag !== "menu" && tag !== "menuitem") continue;
    const id = node.id || identify(node);
    elements.set(id, node);
    const item = {
      id,
      label: node.getAttribute("label") || node.label || node.getAttribute("aria-label") ||
        node.getAttribute("tooltiptext") || id.replace(/^context-/, "").replaceAll("-", " "),
      disabled: node.disabled || node.getAttribute("disabled") === "true",
      checked: nativeMenuChecked(node),
      kind: tag === "menu" ? "submenu" : "native-command",
      icon: node.getAttribute("image") || "",
    };
    if (tag === "menu") {
      const child = Array.from(node.children).find(candidate => candidate.localName === "menupopup");
      item.children = child && populated.has(child)
        ? snapshotNativeMenu(child, { identify, elements, populated })
        : [{ id: `${id}-pending`, label: "Loading…", disabled: true, kind: "placeholder" }];
      // Empty native menus remain visible but cannot activate a command.
      if (!item.children.length) item.disabled = true;
    }
    result.push(item);
  }
  return result;
}

/** Groups come from Firefox, including hidden/collapsed and non-HTTP tabs.
 * The pinned bucket is presentation only; this never mutates native groups. */
export function buildTabTree(gBrowser, identifyTab, identifyGroup) {
  const tabs = Array.from(gBrowser.openTabs || gBrowser.tabs).filter(tab => !tab.closing);
  const leaf = tab => ({
    id: identifyTab(tab), label: tab.label || "New tab", kind: "tab",
    description: tab.linkedBrowser.currentURI?.spec || "",
    favicon: tab.getAttribute?.("image") || "", tabIndex: tabs.indexOf(tab),
    checked: tab === gBrowser.selectedTab,
  });
  const pinned = tabs.filter(tab => tab.pinned);
  const result = pinned.length ? [{
    id: "orbit-radial-pinned", label: "Pinned tabs", kind: "group", icon: "⌖",
    children: pinned.map(leaf),
  }] : [];
  const groups = new Map();
  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (!tab.group) { result.push(leaf(tab)); continue; }
    const group = tab.group;
    let item = groups.get(group);
    if (!item) {
      item = {
        id: identifyGroup(group), label: group.label || group.defaultGroupName || "Unnamed group",
        kind: "group", nativeGroupId: group.id, color: group.color, collapsed: group.collapsed,
        icon: "▦", children: [],
      };
      groups.set(group, item);
      result.push(item);
    }
    item.children.push(leaf(tab));
  }
  return result;
}

/** doCommand does native command forwarding, but unlike native menu activation
 * it does not perform checkbox/radio autocheck. Preserve that behavior here. */
export function executeNativeCommand(win, node, event = null) {
  if (!nativeMenuVisible(node) || node.disabled || node.getAttribute("disabled") === "true") return false;
  const type = node.getAttribute("type");
  if (node.getAttribute("autocheck") !== "false") {
    if (type === "checkbox") node.setAttribute("checked", String(!nativeMenuChecked(node)));
    else if (type === "radio") node.setAttribute("checked", "true");
  }
  if (event && (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.button > 0)) {
    // XULCommandEvent has no constructor. Dispatch on the ORIGINAL item so
    // extensions, command= forwarding, and data-usercontextid remain intact.
    const command = win.document.createEvent("XULCommandEvent");
    command.initCommandEvent("command", true, true, win, 0, !!event.ctrlKey, !!event.altKey,
      !!event.shiftKey, !!event.metaKey, event.button || 0, event, event.mozInputSource || 0);
    node.dispatchEvent(command);
  } else node.doCommand();
  return true;
}

class RadialWindow {
  constructor(win) {
    this.win = win;
    this.popup = win.document.getElementById("contentAreaContextMenu");
    this.view = new lazy.OrbitRadialView(win);
    this.context = null;
    this.contextBrowser = null;
    this.gesture = null;
    this.mode = null;
    this.elements = new Map();
    this.tabElements = new Map();
    this.populated = new Set();
    this.identities = new WeakMap();
    this.identitySerial = 0;
    this.cleanups = [];
    this.suppressed = null;
    this.executing = false;
    this.dismissed = false;
    this._listen(this.popup, "popupshowing", event => this._onContextShowing(event));
    for (const event of TAB_EVENTS) this._listen(win.gBrowser.tabContainer, event, value => {
      if (value.type === "TabSelect" && !this.executing) this.dismiss("tab-selected");
      else this._queueRefresh();
    });
    this._listen(win, "mousemove", event => {
      if (event.isTrusted && this.gesture?.down && (event.buttons & 2)) this._move(event);
    }, true);
    this._listen(win, "mouseup", event => {
      if (event.isTrusted && event.button === 2 && this.gesture?.down) this._up(event);
    }, true);
    this._listen(win, "keydown", event => {
      if (event.isTrusted && event.key === "Escape" && this.gesture?.down) this.dismiss("escape");
    }, true);
    this._listen(win, "blur", () => this.dismiss("blur"));
    this.observer = new win.MutationObserver(() => this._queueRefresh());
    this.observer.observe(this.popup, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["label", "aria-label", "hidden", "collapsed", "disabled", "checked", "image", "style"],
    });
  }

  _listen(node, type, callback, options) {
    node.addEventListener(type, callback, options);
    this.cleanups.push(() => node.removeEventListener(type, callback, options));
  }

  _identify(node, type) {
    if (!this.identities.has(node)) this.identities.set(node, `orbit-radial-${type}-${++this.identitySerial}`);
    return this.identities.get(node);
  }

  _tabItems() {
    this.tabElements.clear();
    return buildTabTree(this.win.gBrowser, tab => {
      const id = this._identify(tab, "tab");
      this.tabElements.set(id, tab);
      return id;
    }, group => this._identify(group, "group"));
  }

  _contextItems() {
    this.elements.clear();
    const items = snapshotNativeMenu(this.popup, {
      identify: node => this._identify(node, "command"),
      elements: this.elements, populated: this.populated,
    });
    const centerId = this.context?.onLink ? "context-openlinkintab" :
      this.context?.onImage ? "context-viewimage" : null;
    return items.filter(item => item.id !== centerId);
  }

  _centerItem() {
    if (this.mode === "tabs") return {
      id: "orbit-radial-current-tab", label: "Current tab", kind: "info", disabled: true,
      description: this.win.gBrowser.selectedTab.label,
    };
    const id = this.context.onLink ? "context-openlinkintab" : this.context.onImage ? "context-viewimage" : null;
    const node = id && this.win.document.getElementById(id);
    if (node) this.elements.set("orbit-radial-new-tab", node);
    return {
      id: "orbit-radial-new-tab", label: "Open in new tab", kind: "native-center", icon: "+",
      disabled: id ? !node || !nativeMenuVisible(node) || node.disabled : false,
    };
  }

  _show(mode, center, passthrough = false) {
    this.mode = mode;
    this.view.show({
      mode, center, passthrough,
      items: mode === "tabs" ? this._tabItems() : this._contextItems(),
      centerItem: this._centerItem(),
      onActivate: (item, event) => this._activate(item, event),
      onHover: item => this._hover(item),
      onDismiss: reason => this.dismiss(reason),
    });
  }

  _queueRefresh() {
    if (this.refreshQueued || !this.mode) return;
    this.refreshQueued = true;
    this.win.queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.mode === "context" && this.context === this.win.gContextMenu) {
        this.view.refresh({ items: this._contextItems(), centerItem: this._centerItem() });
      } else if (this.mode === "tabs") this.view.refresh({ items: this._tabItems(), centerItem: this._centerItem() });
    });
  }

  _hover(item) {
    if (this.mode !== "context" || item?.kind !== "submenu" || this.context !== this.win.gContextMenu) return;
    const node = this.elements.get(item.id);
    const popup = node && Array.from(node.children).find(child => child.localName === "menupopup");
    if (!popup || this.populated.has(popup)) return;
    this.populated.add(popup);
    // Run Firefox/extension lazy submenu handlers against their native DOM.
    popup.dispatchEvent(new this.win.Event("popupshowing", { bubbles: true, cancelable: true }));
    this.view.refresh({ items: this._contextItems(), centerItem: this._centerItem() });
  }

  _onContextShowing(event) {
    if (event.target !== this.popup) return;
    // This listener is installed at delayed startup, AFTER browser-context.js
    // has created gContextMenu and run native visibility/extension hooks.
    const context = this.win.gContextMenu;
    if (!context?.shouldDisplay) return;
    const browser = context.browser;
    // The native descriptor can arrive after TabSelect (or after the short
    // gesture suppression window). Never display a background browser's
    // popup. Its initialization already ran, so finish that lifecycle too.
    if (browser !== this.win.gBrowser.selectedBrowser) {
      const preserveTabs = this.mode === "tabs" &&
        this.gesture?.browser === this.win.gBrowser.selectedBrowser;
      event.preventDefault();
      this.context = context;
      this.contextBrowser = browser;
      this._cleanupContext();
      // A late release descriptor from the preceding tab must not cancel a
      // newer selected-browser gesture. The tab model uses native tabs, not
      // this obsolete popup's command DOM, and remains safe to interact with.
      if (!preserveTabs) this.dismiss("stale-browser-context");
      return;
    }
    if (event.shiftKey) return;
    if (this.nativeFallback?.browser === browser && Date.now() < this.nativeFallback.until) {
      this.nativeFallback = null;
      return;
    }
    if (this.suppressed?.browser === browser && Date.now() < this.suppressed.until) {
      event.preventDefault();
      this.context = context;
      this.contextBrowser = browser;
      this._cleanupContext();
      this.suppressed = null;
      return;
    }
    event.preventDefault();
    this.context = context;
    this.contextBrowser = browser;
    this.contextFrameId = context.frameBrowsingContext?.id ||
      context.contentData?.context?.frameBrowsingContextID || context.actor?.browsingContext?.id;
    this.populated.clear();
    const native = context.contentData?.context;
    const dpr = this.win.devicePixelRatio;
    this.contextPoint = Number.isFinite(native?.screenXDevPx) ? {
      screenX: native.screenXDevPx / dpr, screenY: native.screenYDevPx / dpr,
    } : this.gesture?.center || { screenX: event.screenX, screenY: event.screenY };
    this.win.clearTimeout(this.contextTimer);
    if (!this.gesture?.down) this._show("context", this.contextPoint);
    // Native localization can be deferred until popup appearance. Translate
    // its original items, including Fluent labels, then refresh our snapshot.
    const translated = this.win.document.l10n?.translateFragment(this.popup);
    translated?.then(() => this._queueRefresh()).catch(error => console.error("Orbit menu localization:", error));
  }

  contentGesture(browser, frameId, data) {
    if (data.kind === "cancel") {
      if ((this.gesture?.browser === browser && this.gesture.frameId === frameId) ||
          (this.contextBrowser === browser && this.contextFrameId === frameId)) this.dismiss("frame-hidden");
      return;
    }
    if (data.kind === "down") {
      // Shift retains Firefox's native context menu as a fallback.
      this.dismiss("new-gesture");
      if (data.shiftKey) {
        this.nativeFallback = { browser, until: Date.now() + 750 };
        return;
      }
      this.nativeFallback = null;
      this.suppressed = null;
      this.gesture = { browser, frameId, center: { screenX: data.screenX, screenY: data.screenY }, down: true };
      this._show("tabs", this.gesture.center, true);
      return;
    }
    if (!this.gesture?.down || this.gesture.browser !== browser) return;
    if (data.kind === "move") this._move(data);
    if (data.kind === "up") this._up(data);
  }

  _move(point) { this.view.updatePointer(point.screenX, point.screenY); }

  _up(point) {
    const gesture = this.gesture;
    if (!gesture?.down) return;
    gesture.down = false;
    this.view.updatePointer(point.screenX, point.screenY);
    const hit = this.view.hitTest(point.screenX, point.screenY);
    const moved = Math.hypot(point.screenX - gesture.center.screenX, point.screenY - gesture.center.screenY) > 10;
    if (moved && hit?.kind === "tab" && this.tabElements.has(hit.id)) {
      this._suppressContext(gesture.browser);
      this._activate(hit);
    } else if (moved && hit?.children?.length) {
      // Keep the currently expanded rings when a group is released. A later
      // ordinary click chooses a tab without accidentally running page actions.
      this._suppressContext(gesture.browser);
      this._cleanupContext();
      this.view.setPassthrough(false);
    } else if (this.context) {
      this._show("context", this.contextPoint);
    } else {
      this.view.hide("awaiting-context");
      // A site may suppress Firefox's native context menu. We do not fabricate
      // a descriptor; hide quietly if the native actor does not supply one.
      this.contextTimer = this.win.setTimeout(() => this.dismiss("no-native-context"), 500);
    }
  }

  _suppressContext(browser) {
    // This survives TabSelect. The up-triggered native context actor message
    // can arrive after the tab has already changed in this chrome process.
    this.suppressed = { browser, until: Date.now() + 750 };
  }

  _activate(item, event = null) {
    if (!item || item.disabled || item.children?.length) return;
    if (item.kind === "tab") {
      const tab = this.tabElements.get(item.id);
      if (!tab || !this.win.gBrowser.openTabs.includes(tab) || tab.closing) return;
      this.win.gBrowser.selectedTab = tab;
      this.dismiss("tab-activated");
      return;
    }
    if (!this.context || this.context !== this.win.gContextMenu ||
        this.contextBrowser !== this.win.gBrowser.selectedBrowser) return;
    const actor = this.context.actor;
    if (actor && (!actor.manager.isCurrentGlobal || !actor.browsingContext.ancestorsAreCurrent)) {
      this.dismiss("stale-context");
      return;
    }
    const node = this.elements.get(item.id);
    // Native actions retain their own principals/referrers/container and
    // original DOM target. No URL or command payload comes from web content.
    if (node && (!this.popup.contains(node) || !this._ancestorsVisible(node))) return;
    this.executing = true;
    try {
      // HTML keyboard focus belongs to the radial panel while browsing its
      // rings. Native edit commands use commandDispatcher's focused window,
      // so restore the source browser BEFORE dispatching the original item.
      this.contextBrowser.focus();
      if (node) executeNativeCommand(this.win, node, event);
      else if (item.id === "orbit-radial-new-tab" && !this.context.onLink && !this.context.onImage) {
        const tab = this.win.gBrowser.getTabForBrowser(this.contextBrowser);
        if (tab) this.win.gBrowser.selectedTab = this.win.gBrowser.duplicateTab(tab);
      }
    } finally {
      this.executing = false;
      this.dismiss("command");
    }
  }

  _ancestorsVisible(node) {
    for (let current = node; current && current !== this.popup; current = current.parentNode) {
      if (!nativeMenuVisible(current)) return false;
    }
    return true;
  }

  _cleanupContext() {
    const context = this.context;
    this.context = null;
    this.contextBrowser = null;
    this.contextFrameId = null;
    this.elements.clear();
    this.populated.clear();
    if (!context) return;
    if (this.win.gContextMenu === context) {
      try { context.hiding(this.popup); }
      finally {
        if (this.win.gContextMenu === context) this.win.gContextMenu = null;
        this.win.updateEditUIVisibility?.();
        this.win.gSync?._resetSendTabExposureTracking();
        // ext-menus listens for popuphidden, not popuphiding, to remove native
        // extension items and release its context references. A cancelled
        // popup never emits it naturally, so finish that lifecycle explicitly.
        this.popup.dispatchEvent(new this.win.Event("popuphidden", { bubbles: true }));
      }
    }
  }

  dismiss(reason = "dismiss") {
    if (this.dismissed) return;
    this.dismissed = true;
    const browser = this.contextBrowser || this.gesture?.browser;
    try {
      if (this.gesture?.down && reason !== "new-gesture") this._suppressContext(this.gesture.browser);
      this.win.clearTimeout(this.contextTimer);
      this.gesture = null;
      this.mode = null;
      this.view.hide(reason);
      if (!this.executing) this._cleanupContext();
      if (reason === "escape" && browser === this.win.gBrowser.selectedBrowser &&
          this.win.document.hasFocus?.() !== false) browser.focus();
    } finally {
      this.dismissed = false;
    }
  }

  destroy() {
    this.dismiss("window-unload");
    this.observer.disconnect();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.view.destroy();
  }
}

export const OrbitRadial = {
  init(win) {
    if (windows.has(win) || !win.gBrowser || !win.document.getElementById("contentAreaContextMenu")) return;
    if (!actorRegistered) {
      ChromeUtils.registerWindowActor("OrbitRadial", {
        allFrames: true, includeChrome: false, safeForUntrustedWebProcess: true,
        messageManagerGroups: ["browsers"],
        parent: { esModuleURI: "moz-src:///browser/components/orbit/OrbitRadialParent.sys.mjs" },
        child: {
          esModuleURI: "moz-src:///browser/components/orbit/OrbitRadialChild.sys.mjs",
          events: {
            mousedown: { capture: true, mozSystemGroup: true, wantUntrusted: false },
            mouseup: { capture: true, mozSystemGroup: true, wantUntrusted: false },
            mousemove: { capture: true, mozSystemGroup: true, wantUntrusted: false },
            keydown: { capture: true, mozSystemGroup: true, wantUntrusted: false },
            pagehide: { capture: true, mozSystemGroup: true, wantUntrusted: false },
          },
        },
      });
      actorRegistered = true;
    }
    windows.set(win, new RadialWindow(win));
  },

  uninit(win) {
    windows.get(win)?.destroy();
    windows.delete(win);
  },

  handleContentGesture(win, browser, frameId, data) {
    windows.get(win)?.contentGesture(browser, frameId, data);
  },

  cancelContentGesture(win, browser, frameId) {
    windows.get(win)?.contentGesture(browser, frameId, { kind: "cancel" });
  },
};
