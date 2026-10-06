/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};
const HTML_NS = "http://www.w3.org/1999/xhtml";
ChromeUtils.defineESModuleGetters(lazy, {
  Orbit: "moz-src:///browser/components/orbit/Orbit.sys.mjs",
  OrbitRadial: "moz-src:///browser/components/orbit/OrbitRadial.sys.mjs",
  OrbitRadialView: "moz-src:///browser/components/orbit/OrbitRadialView.sys.mjs",
});

/** These are Firefox's existing action delegates and window-local policy
 * filters. Discovering a button never invokes an extension or grants access. */
export function focusExtensionItems(win) {
  const controller = win.gUnifiedExtensions;
  const tab = win.gBrowser.selectedTab;
  if (!controller?.getActivePolicies || !tab || tab.closing) return [];
  const items = [];
  for (const policy of controller.getActivePolicies()) {
    try {
      if (!policy?.id || !policy.canAccessWindow(win)) continue;
      const delegate = controller.browserActionFor(policy);
      const widget = delegate?.widget?.forWindow(win);
      const actionButton = widget?.node?.querySelector(".unified-extensions-item-action-button");
      if (!actionButton || !widget.node.isConnected) continue;
      const enabled = !actionButton.disabled && delegate.action.isShownForTab(tab);
      items.push({
        id: `orbit-focus-extension:${policy.id}`,
        label: String(delegate.action.getProperty(tab, "title") || policy.extension?.name || policy.id).slice(0, 512),
        icon: "✧", disabled: !enabled,
        policy, delegate, widget, actionButton,
      });
    } catch (error) {
      console.error("Orbit extension action discovery:", error);
    }
  }
  return items;
}

function trustedActivation(event) {
  if (!event?.isTrusted || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.type === "pointerup" && event.button === 0 ||
    event.type === "keydown" && (event.key === "Enter" || event.key === " ");
}

/** A focus-mode entry point into original Firefox controls. Native extension
 * permissions, activeTab grants, panel contents, and toolbar placements remain
 * owned by Firefox. Only a real trusted activation invokes an action. */
export class OrbitFocusTools {
  constructor(win, callbacks = {}) {
    this.win = win;
    this.doc = win.document;
    this.callbacks = callbacks;
    this.view = new lazy.OrbitRadialView(win, {idPrefix: "orbit-focus-tools", caption: "BROWSER TOOLS"});
    this.visible = false;
    this.disposed = false;
    this.enabled = false;
    this.cleanups = [];
    this.anchor = null;
    this.popups = new Set();
    this.anchorTimer = null;
    this.pendingNative = false;
    this.trigger = this.doc.createElementNS(HTML_NS, "button");
    this.trigger.id = "orbit-focus-tools-trigger";
    this.trigger.type = "button";
    this.trigger.hidden = true;
    this.trigger.setAttribute("aria-label", "Open browser tools");
    this.trigger.setAttribute("aria-haspopup", "menu");
    this.trigger.setAttribute("aria-controls", "orbit-focus-tools-menu");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.title = "Browser tools, extensions, and settings";
    const mark = this.doc.createElementNS(HTML_NS, "img");
    mark.src = "chrome://browser/content/orbit/orbit.svg";
    mark.alt = "";
    mark.width = 24;
    mark.height = 24;
    this.trigger.append(mark);
    this.doc.documentElement.append(this.trigger);
    this.listen(this.trigger, "pointerenter", event => {
      if (!event.isTrusted || !this.enabled) return;
      this.callbacks.onPointerEnter?.();
      this.open();
    });
    this.listen(this.trigger, "pointerleave", event => {
      if (event.isTrusted) this.callbacks.onPointerLeave?.();
    });
    this.listen(this.trigger, "click", event => {
      if (!event.isTrusted || event.button !== 0 || !this.enabled) return;
      this.open({focus: true});
      this.view.panel?.focus({preventScroll: true});
    });
    this.listen(this.trigger, "keydown", event => {
      if (!event.isTrusted || event.repeat || event.isComposing || !this.enabled ||
          !["Enter", " "].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      this.open({focus: true});
      this.view.panel?.focus({preventScroll: true});
    });
    this.listen(win, "popupshowing", event => this.popupShowing(event), true);
    this.listen(win, "popuphidden", event => this.popupHidden(event), true);
    this.listen(win, "blur", () => this.close("blur"));
    this.listen(win.gBrowser.tabContainer, "TabSelect", () => this.refresh());
    this.listen(win.gBrowser.tabContainer, "TabAttrModified", () => this.refresh());
    this.listen(win, "popupshowing", event => {
      if (event.target?.id === "contentAreaContextMenu") this.close("page-menu");
    }, true);
  }

  listen(target, type, callback, capture = false) {
    target.addEventListener(type, callback, capture);
    this.cleanups.push(() => target.removeEventListener(type, callback, capture));
  }

  setEnabled(enabled) {
    this.enabled = enabled === true && !this.disposed;
    this.trigger.hidden = !this.enabled;
    if (this.enabled) return;
    this.close("focus-exit");
    for (const popup of this.popups) popup.hidePopup?.();
    for (const popup of this.popups) this.callbacks.onNativePopup?.(popup, false);
    this.popups.clear();
    this.releaseAnchor();
  }

  contains(node) {
    return !!node && (this.trigger.contains(node) || !!this.view.root?.contains(node) || !!this.anchor?.contains(node));
  }

  /** Non-interactive pointer corridor from the physical corner into the menu.
   * It keeps a slow diagonal approach alive without stealing page events. */
  ownsPointer(x, y) {
    const geometry = this.view.geometry;
    if (!this.visible || !geometry || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const {center, radius} = geometry;
    const menu = x >= center.x - radius - 24 && x <= center.x + radius + 24 &&
      y >= center.y - radius - 24 && y <= center.y + radius + 24;
    const corridor = x >= 0 && y >= 0 && x <= center.x && y <= center.y;
    return menu || corridor;
  }

  items() {
    const extensions = focusExtensionItems(this.win).map(item => ({
      id: item.id, label: item.label, icon: item.icon, disabled: item.disabled,
    }));
    return [
      {id: "orbit-focus-extensions", label: "Extensions", icon: "✧", children: [
        ...extensions,
        {id: "orbit-focus-extensions-panel", label: "Extension controls", icon: "✧"},
        {id: "orbit-focus-manage-extensions", label: "Manage extensions", icon: "▦"},
      ]},
      {id: "orbit-focus-bookmarks", label: "Bookmarks", icon: "☆", children: [
        {id: "orbit-focus-bookmarks-panel", label: "Browse bookmarks", icon: "☆"},
        {id: "orbit-focus-bookmark-page", label: "Bookmark this page", icon: "＋"},
        {id: "orbit-focus-bookmarks-library", label: "Bookmark library", icon: "▤"},
      ]},
      {id: "orbit-focus-history", label: "History", icon: "↻", children: [
        {id: "orbit-focus-history-panel", label: "Recent history", icon: "↻"},
        {id: "orbit-focus-history-library", label: "History library", icon: "▤"},
      ]},
      {id: "orbit-focus-downloads", label: "Downloads", icon: "↓"},
      {id: "orbit-focus-settings", label: "Settings", icon: "◉", children: [
        {id: "orbit-focus-preferences", label: "Browser settings", icon: "◉"},
        {id: "orbit-focus-privacy", label: "Privacy settings", icon: "⌖"},
        {id: "orbit-focus-more-tools", label: "More browser tools", icon: "▦"},
        {id: "orbit-focus-customize", label: "Customize controls", icon: "▣"},
      ]},
      {id: "orbit-focus-canvas", label: "Canvas", icon: "▦"},
      {id: "orbit-focus-browser-menu", label: "Browser menu", icon: "•••"},
      {id: "orbit-focus-exit", label: "Exit focus", icon: "↗"},
    ];
  }

  open({focus = false} = {}) {
    if (this.disposed || !this.enabled || this.visible || this.pendingNative || this.popups.size) return;
    lazy.OrbitRadial.dismiss(this.win, "focus-tools");
    this.previousFocus = this.doc.activeElement;
    if (this.doc.getElementById("orbit-radial-root")?.contains(this.previousFocus)) {
      this.previousFocus = this.win.gBrowser.selectedBrowser;
    }
    this.visible = true;
    this.trigger.setAttribute("aria-expanded", "true");
    this.callbacks.onVisibilityChange?.(true);
    this.view.show({
      mode: "focus-tools", center: {x: 220, y: 220}, items: this.items(), focus,
      centerItem: {id: "orbit-focus-commands", label: "Orbit commands", icon: "⌖"},
      onActivate: (node, event) => this.activate(node, event),
      onDismiss: reason => this.dismissed(reason),
    });
    // Keep the same pointer grace as the corner trigger and the other islands.
    // The backing remains decorative and never intercepts a webpage click.
    const root = this.view.root;
    if (this.listenedRoot !== root) {
      this.listenedRoot = root;
      root.addEventListener("pointerdown", event => {
        if (event.isTrusted && event.button === 0 && root.contains(event.target)) this.view.panel?.focus({preventScroll: true});
      });
      root.addEventListener("pointerenter", () => this.callbacks.onPointerEnter?.());
      root.addEventListener("pointerleave", () => this.callbacks.onPointerLeave?.());
    }
  }

  refresh() {
    if (this.visible) this.view.refresh({items: this.items()});
  }

  dismissed(reason) {
    if (!this.visible) return;
    this.visible = false;
    this.trigger.setAttribute("aria-expanded", "false");
    this.callbacks.onVisibilityChange?.(false);
    // A hover menu never owns focus. Closing it must not interrupt an address
    // edit or a text field on the webpage underneath it.
    const ownedFocus = this.view.root?.contains(this.doc.activeElement) || this.trigger.contains(this.doc.activeElement);
    if (ownedFocus && (reason === "escape" || reason === "dismiss" || reason === "conceal")) {
      const previous = this.previousFocus;
      const address = this.doc.getElementById("urlbar-container");
      if (previous?.isConnected && address?.contains(previous)) {
        this.callbacks.onAddressReveal?.();
        previous.focus();
      } else if (previous?.isConnected && !this.view.root?.contains(previous) &&
          !this.doc.getElementById("navigator-toolbox")?.contains(previous)) previous.focus();
      else this.win.gBrowser.selectedBrowser?.focus();
    }
    this.previousFocus = null;
  }

  close(reason = "dismiss") {
    if (this.visible) this.view.hide(reason);
    if (!this.popups.size && !this.pendingNative) this.releaseAnchor();
  }

  /** Float the real existing anchor in place; never clone or reparent widgets.
   * It stays available until native popuphidden, including extension panels. */
  holdAnchor(anchor, node) {
    if (!anchor?.isConnected) return null;
    this.releaseAnchor();
    this.anchor = anchor;
    const option = node && [...(this.view.panel?.querySelectorAll(".orbit-radial-sector") || [])]
      .find(element => element.getAttribute("data-orbit-id") === node.id);
    const x = option ? Number(option.getAttribute("data-orbit-x")) : NaN;
    const y = option ? Number(option.getAttribute("data-orbit-y")) : NaN;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    this.anchorStyle = ["--orbit-focus-anchor-left", "--orbit-focus-anchor-top"].map(name =>
      [name, anchor.style.getPropertyValue(name), anchor.style.getPropertyPriority(name)]);
    anchor.style.setProperty("--orbit-focus-anchor-left", `${clamp(Number.isFinite(x) ? x - 20 : 32, 12, Math.max(12, this.win.innerWidth - 52))}px`);
    anchor.style.setProperty("--orbit-focus-anchor-top", `${clamp(Number.isFinite(y) ? y - 20 : 16, 12, Math.max(12, this.win.innerHeight - 52))}px`);
    this.anchorHadClass = anchor.classList.contains("orbit-focus-native-anchor");
    anchor.classList.add("orbit-focus-native-anchor");
    this.pendingNative = true;
    this.anchorTimer = this.win.setTimeout(() => {
      this.pendingNative = false;
      if (!this.popups.size) this.releaseAnchor();
    }, 2500);
    return anchor;
  }

  releaseAnchor() {
    this.win.clearTimeout(this.anchorTimer);
    this.anchorTimer = null;
    if (this.anchor) {
      if (this.enabled && this.anchor.contains(this.doc.activeElement) &&
          this.doc.documentElement.getAttribute("data-orbit-focus-reveal") !== "true") {
        this.win.gBrowser.selectedBrowser?.focus();
      }
      if (!this.anchorHadClass) this.anchor.classList.remove("orbit-focus-native-anchor");
      for (const [name, value, priority] of this.anchorStyle || []) {
        if (value) this.anchor.style.setProperty(name, value, priority);
        else this.anchor.style.removeProperty(name);
      }
    }
    this.anchor = null;
    this.anchorStyle = null;
    this.pendingNative = false;
  }

  popupShowing(event) {
    const popup = event.target;
    if (!this.anchor || !popup?.id || popup.id === "contentAreaContextMenu") return;
    const nativeAnchor = popup.anchorNode || popup.triggerNode;
    const owned = nativeAnchor && (nativeAnchor === this.anchor || this.anchor.contains(nativeAnchor) ||
      [...this.popups].some(parent => parent.contains(nativeAnchor)));
    if (!owned && !(this.pendingNative && ["downloadsPanel", "unified-extensions-panel", "appMenu-popup", "customizationui-widget-panel"].includes(popup.id))) return;
    this.popups.add(popup);
    this.pendingNative = false;
    this.win.clearTimeout(this.anchorTimer);
    this.anchorTimer = null;
    this.callbacks.onNativePopup?.(popup, true);
  }

  popupHidden(event) {
    const popup = event.target;
    if (!this.popups.delete(popup)) return;
    this.callbacks.onNativePopup?.(popup, false);
    // During extension panel -> action popup transitions, the old panel hides
    // just before the new one opens. Preserve the anchor for the next tick.
    if (!this.popups.size) this.anchorTimer = this.win.setTimeout(() => {
      if (!this.popups.size && !this.pendingNative) this.releaseAnchor();
    }, 0);
  }

  activate(node, event) {
    if (this.disposed || !this.visible || !trustedActivation(event)) return;
    const id = node?.id;
    const current = this.items().flatMap(item => item.children || [item]).find(item => item.id === id);
    if (id !== "orbit-focus-commands" && (!current || current.disabled || current.children)) return;
    const win = this.win;
    let anchor = null;
    let run;
    if (id?.startsWith("orbit-focus-extension:")) {
      const item = focusExtensionItems(win).find(extension => extension.id === id && !extension.disabled);
      if (!item) { this.refresh(); return; }
      // BrowserAction.triggerAction is Firefox's existing keyboard-action
      // delegate. It performs enabled/activeTab/script/popup handling itself.
      // The live policy and original widget are checked again immediately
      // before a trusted click or key invokes it.
      if (!item.policy.canAccessWindow(win) || !item.delegate.action.isShownForTab(win.gBrowser.selectedTab)) return;
      const popupURL = item.delegate.action.getPopupUrl(win.gBrowser.selectedTab);
      if (popupURL) anchor = this.holdAnchor(item.widget.anchor || item.actionButton, current);
      run = () => item.delegate.triggerAction(win);
    } else {
      const action = {
        "orbit-focus-commands": () => this.callbacks.onCommands?.(),
        "orbit-focus-canvas": () => lazy.Orbit.openBoard(win),
        "orbit-focus-exit": () => this.callbacks.onExit?.(),
        "orbit-focus-preferences": () => win.openPreferences(),
        "orbit-focus-privacy": () => win.openPreferences("privacy"),
        "orbit-focus-manage-extensions": () => win.BrowserAddonUI.openAddonsMgr("addons://list/extension"),
        "orbit-focus-bookmark-page": () => {
          this.callbacks.onAddressReveal?.();
          return win.PlacesCommandHook.bookmarkPage();
        },
        "orbit-focus-bookmarks-library": () => win.PlacesCommandHook.showPlacesOrganizer("AllBookmarks"),
        "orbit-focus-history-library": () => win.PlacesCommandHook.showPlacesOrganizer("History"),
        "orbit-focus-customize": () => win.gCustomizeMode.enter(),
      }[id];
      if (action) run = action;
      else {
        const anchorID = id === "orbit-focus-downloads" ? "downloads-button" :
          id === "orbit-focus-extensions-panel" ? "unified-extensions-button" : "PanelUI-menu-button";
        anchor = this.holdAnchor(this.doc.getElementById(anchorID), current);
        if (!anchor) return;
        if (id === "orbit-focus-downloads") run = () => win.DownloadsPanel.showPanel(true, event.type === "keydown");
        else if (id === "orbit-focus-extensions-panel") run = () => win.gUnifiedExtensions.openPanel(null, "extensions_panel_showing");
        else if (id === "orbit-focus-bookmarks-panel") run = () => win.PanelUI.showSubView("PanelUI-bookmarks", anchor, event);
        else if (id === "orbit-focus-history-panel") run = () => win.PanelUI.showSubView("PanelUI-history", anchor, event);
        else if (id === "orbit-focus-more-tools") run = () => win.PanelUI.showMoreToolsPanel(anchor);
        else if (id === "orbit-focus-browser-menu") run = () => win.PanelUI.show(event);
        else { this.pendingNative = false; this.releaseAnchor(); return; }
      }
    }
    this.close("activate");
    try {
      const result = run();
      if (result?.catch) result.catch(error => { console.error("Orbit focus tool:", error); this.failedNative(); });
    } catch (error) {
      console.error("Orbit focus tool:", error);
      this.failedNative();
    }
  }

  failedNative() {
    this.pendingNative = false;
    if (!this.popups.size) this.releaseAnchor();
    this.win.gBrowser.selectedBrowser?.focus();
  }

  destroy() {
    this.setEnabled(false);
    this.disposed = true;
    this.visible = false;
    for (const popup of this.popups) this.callbacks.onNativePopup?.(popup, false);
    this.popups.clear();
    this.pendingNative = false;
    this.releaseAnchor();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.view.destroy();
    this.trigger.remove();
  }
}
