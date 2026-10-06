/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  Orbit: "moz-src:///browser/components/orbit/Orbit.sys.mjs",
  OrbitRadial: "moz-src:///browser/components/orbit/OrbitRadial.sys.mjs",
  OrbitFocusTools: "moz-src:///browser/components/orbit/OrbitFocusTools.sys.mjs",
});
const HTML_NS = "http://www.w3.org/1999/xhtml";
const windows = new WeakMap();
let widgetCreated = false;

/** Search is local to this window. Text never becomes a navigation command. */
export function searchCommands(commands, query, limit = 40) {
  const words = String(query).normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return commands.filter(command => {
    const text = `${command.label} ${command.detail} ${command.keywords || ""}`.normalize("NFKC").toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }).slice(0, limit);
}

export class InteractionWindow {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.root = this.doc.documentElement;
    this.cleanups = [];
    this.tabIDs = new WeakMap();
    this.serial = 0;
    this.focusMode = false;
    this.revealed = false;
    this.timer = null;
    this.islands = Object.fromEntries(["address", "tools", "window"].map(name => [name, {
      visible: false, hovered: false, dwell: null, conceal: null, popups: new Set(),
    }]));
    this.focusMarkers = new Map();
    this.windowControlListeners = new WeakSet();
    this.focusTools = null;
    this.results = [];
    this.selection = 0;
    this.disposed = false;
    this.build();
    this.listen(win, "keydown", event => this.keydown(event), true);
    this.listen(win, "fullscreen", () => this.setFocusMode(false));
    this.listen(win, "DOMFullscreen:Entered", () => this.setFocusMode(false));
    this.listen(win, "beforecustomization", () => this.setFocusMode(false));
    this.listen(win, "blur", () => this.onWindowBlur());
    this.listen(win, "focus", () => this.onWindowFocus());
    this.listen(win, "resize", () => this.updateFocusLayout());
    // Firefox can move the native window buttons to the navigation row when
    // switching to vertical tabs. Preserve whichever row actually owns them.
    this.layoutObserver = new win.MutationObserver(records => {
      if (records.some(record => record.attributeName && !record.attributeName.startsWith("data-orbit-"))) this.updateFocusLayout();
    });
    this.layoutObserver.observe(this.root, { attributes: true });
    const toolbox = this.doc.getElementById("navigator-toolbox");
    if (toolbox) {
      // Vertical-tab layout changes native titlebar ownership on the toolbox
      // and toolbar nodes, without necessarily changing a root attribute.
      this.layoutObserver.observe(toolbox, {
        attributes: true, subtree: true,
        attributeFilter: ["tabs-hidden", "collapsed", "autohide", "inactive", "class"],
      });
      this.listen(toolbox, "focusin", event => {
        if (this.searchFallback?.contains(event.target)) this.showIsland("address", true);
      });
      this.listen(toolbox, "focusout", () => {
        if (this.searchFallback) this.scheduleConceal("address");
      });
    }
    const address = this.addressNode();
    if (address) {
      this.listen(address, "mouseenter", event => {
        if (!event.isTrusted) return;
        this.islands.address.hovered = true;
        this.showIsland("address");
      });
      this.listen(address, "mouseleave", event => {
        if (!event.isTrusted) return;
        this.islands.address.hovered = false;
        this.scheduleConceal("address");
      });
      this.listen(address, "mousedown", event => { if (event.isTrusted) this.showIsland("address", true); });
      this.listen(address, "focusin", () => {
        this.searchFallback = null;
        this.root.removeAttribute("data-orbit-focus-reveal");
        this.showIsland("address", true);
      });
      this.listen(address, "focusout", () => this.scheduleConceal("address"));
    }
    this.listen(win, "mousedown", event => {
      if (event.isTrusted && this.focusMode && !this.addressNode()?.contains(event.target) &&
          !this.palette.contains(event.target) && !this.chip.contains(event.target) &&
          !this.focusTools?.contains(event.target) && !this.windowControls?.contains(event.target)) {
        for (const island of Object.keys(this.islands)) this.scheduleConceal(island);
      }
    }, true);
    this.listen(win, "popupshowing", event => this.popupChanged(event.target, true));
    this.listen(win, "popuphidden", event => this.popupChanged(event.target, false));
    this.listen(win, "mousemove", event => {
      if (!event.isTrusted || !this.focusMode || !this.palette.hidden || !this.focusTools?.visible) return;
      // The tools wheel begins away from the physical corner. A geometric,
      // pointer-transparent corridor lets a slow approach cross the empty
      // space without placing another hit target over the website.
      const inside = this.focusTools.ownsPointer?.(event.clientX, event.clientY) || false;
      if (inside) {
        this.islands.tools.hovered = true;
        this.cancelIslandTimer("tools", "conceal");
      } else if (this.islands.tools.hovered) {
        this.islands.tools.hovered = false;
        this.scheduleConceal("tools");
      }
    }, true);
    const refresh = () => { if (!this.palette.hidden) this.update(); };
    for (const type of ["TabOpen", "TabClose", "TabSelect", "TabAttrModified", "TabGroupCollapse", "TabGroupExpand"]) {
      this.listen(win.gBrowser.tabContainer, type, refresh);
    }
  }

  node(tag, id, className, text) {
    const element = this.doc.createElementNS(HTML_NS, tag);
    if (id) element.id = id;
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  listen(target, type, callback, capture = false) {
    target.addEventListener(type, callback, capture);
    this.cleanups.push(() => target.removeEventListener(type, callback, capture));
  }

  build() {
    this.sheet = this.node("link", "orbit-interactions-styles");
    this.sheet.rel = "stylesheet";
    this.sheet.href = "chrome://browser/content/orbit/orbit-interactions.css";
    this.root.append(this.sheet);
    this.palette = this.node("section", "orbit-command-palette");
    this.palette.hidden = true;
    this.palette.setAttribute("role", "dialog");
    this.palette.setAttribute("aria-modal", "true");
    this.palette.setAttribute("aria-labelledby", "orbit-command-title");
    const panel = this.node("div", "orbit-command-panel");
    const header = this.node("div", null, "orbit-command-header");
    const mark = this.node("img", null, "orbit-command-mark");
    mark.src = "chrome://browser/content/orbit/orbit.svg";
    mark.alt = "";
    const heading = this.node("h2", "orbit-command-title", null, "Orbit commands");
    const close = this.node("button", "orbit-command-close", null, "Esc");
    close.type = "button";
    close.setAttribute("aria-label", "Close Orbit commands");
    this.listen(close, "click", event => { if (event.isTrusted) this.close(); });
    header.append(mark, heading, close);
    this.input = this.node("input", "orbit-command-input");
    this.input.type = "search";
    this.input.placeholder = "Search tabs, frames, and commands…";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "Search tabs, canvas frames, and Orbit commands");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-controls", "orbit-command-results");
    this.input.setAttribute("aria-expanded", "true");
    this.listen(this.input, "input", event => { if (event.isTrusted) { this.selection = 0; this.update(); } });
    this.list = this.node("div", "orbit-command-results");
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Matching tabs, frames, and commands");
    this.empty = this.node("p", "orbit-command-empty", null, "No matches. Try a tab title, a frame name, or “focus”.");
    this.empty.hidden = true;
    const hint = this.node("p", null, "orbit-command-hint", "↑ ↓ to choose · Enter to open · Esc to return");
    panel.append(header, this.input, this.list, this.empty, hint);
    this.palette.append(panel);
    this.listen(this.palette, "mousedown", event => {
      if (event.isTrusted && event.target === this.palette) this.close();
    });
    this.chip = this.node("div", "orbit-focus-chip");
    this.chip.hidden = true;
    this.chip.setAttribute("role", "group");
    this.chip.setAttribute("aria-label", "Focus mode controls");
    const reveal = this.node("button", "orbit-focus-reveal", null, "Address bar");
    reveal.type = "button";
    reveal.title = `Show the address bar (${Services.appinfo.OS === "Darwin" ? "⌘" : "Ctrl+"}L)`;
    const exit = this.node("button", "orbit-focus-exit", null, "Exit focus");
    exit.type = "button";
    exit.title = "Exit focus mode (Escape or Alt+Shift+F)";
    this.listen(reveal, "click", event => {
      if (!event.isTrusted) return;
      this.reveal(true, true);
      this.win.gURLBar?.select();
    });
    this.listen(exit, "click", event => { if (event.isTrusted) this.setFocusMode(false); });
    this.chip.append(reveal, exit);
    this.root.append(this.palette, this.chip);
    for (const island of Object.keys(this.islands)) {
      const zone = this.node("div", `orbit-focus-${island}-hotzone`, "orbit-focus-hotzone");
      zone.hidden = true;
      zone.setAttribute("aria-hidden", "true");
      this[`${island}Hotzone`] = zone;
      this.listen(zone, "mouseenter", event => { if (event.isTrusted) this.enterHotzone(island); });
      this.listen(zone, "mouseleave", event => { if (event.isTrusted) this.leaveHotzone(island); });
      this.root.append(zone);
    }
  }

  commands() {
    const commands = [
      { id: "action:canvas", kind: "command", label: "Open canvas", detail: "Your spatial tabs, frames, and notes", keywords: "board workspace", run: () => lazy.Orbit.openBoard(this.win) },
      { id: "action:focus", kind: "command", label: this.focusMode ? "Exit focus mode" : "Enter focus mode", detail: "Let browser controls recede · Alt+Shift+F", keywords: "restore toolbar distraction", run: () => this.setFocusMode(!this.focusMode) },
      { id: "action:new-tab", kind: "command", label: "New tab", detail: "Open a fresh canvas tab · Ctrl+T", run: () => {
        if (this.focusMode) {
          this.searchFallback = null;
          this.root.removeAttribute("data-orbit-focus-reveal");
          this.reveal(true, true);
          this.scheduleConceal("address");
        }
        this.win.BrowserCommands.openTab();
      } },
    ];
    for (const tab of this.win.gBrowser.openTabs || this.win.gBrowser.tabs) {
      if (tab.closing || !this.win.gBrowser.getTabForBrowser(tab.linkedBrowser)) continue;
      if (!this.tabIDs.has(tab)) this.tabIDs.set(tab, ++this.serial);
      const url = tab.linkedBrowser.currentURI?.spec || "";
      const group = tab.group?.label || tab.group?.name || "";
      commands.push({
        id: `tab:${this.tabIDs.get(tab)}`, kind: "tab", label: String(tab.label || "Untitled tab").slice(0, 512),
        detail: `${group ? group + " · " : ""}${url}`.slice(0, 2048), keywords: "tab " + group,
        run: () => {
          if (tab.closing || this.win.gBrowser.getTabForBrowser(tab.linkedBrowser) !== tab) return;
          if (tab.hidden) this.win.gBrowser.showTab(tab);
          if (tab.group?.collapsed) tab.group.collapsed = false;
          this.win.gBrowser.selectedTab = tab;
          tab.linkedBrowser.focus();
        },
      });
    }
    for (const frame of lazy.Orbit.getFrames(this.win)) {
      commands.push({ id: `frame:${frame.id}`, kind: "frame", label: frame.title || "Untitled frame",
        detail: `${frame.tabCount} ${frame.tabCount === 1 ? "tab" : "tabs"} · Canvas frame`, keywords: "frame group workspace",
        run: () => lazy.Orbit.openFrame(this.win, frame.id) });
    }
    return commands;
  }

  open() {
    if (this.disposed || !this.palette.hidden) return;
    lazy.OrbitRadial.dismiss(this.win, "command-palette");
    this.focusTools?.close("command-palette");
    this.previousFocus = this.doc.activeElement;
    if (this.doc.getElementById("orbit-radial-root")?.contains(this.previousFocus)) {
      this.previousFocus = this.win.gBrowser.selectedBrowser;
    }
    this.palette.hidden = false;
    this.input.value = "";
    this.selection = 0;
    this.update();
    this.input.focus();
  }

  close(restore = true) {
    if (this.palette.hidden) return;
    this.palette.hidden = true;
    if (restore) {
      if (this.focusMode && this.nativeSearchNode()?.contains(this.previousFocus)) {
        this.showSearchFallback();
        this.reveal(true, true);
      }
      if (this.addressNode()?.contains(this.previousFocus)) this.reveal(true, true);
      const concealedNative = this.focusMode && this.doc.getElementById("navigator-toolbox")?.contains(this.previousFocus) &&
        !this.addressNode()?.contains(this.previousFocus) && !this.searchFallback?.contains(this.previousFocus) &&
        !this.windowControls?.contains(this.previousFocus);
      if (this.previousFocus?.isConnected && !concealedNative && !this.palette.contains(this.previousFocus) &&
          !(this.chip.hidden && this.chip.contains(this.previousFocus))) this.previousFocus.focus();
      else this.win.gBrowser.selectedBrowser.focus();
    }
    this.previousFocus = null;
    this.scheduleConceal();
  }

  update() {
    this.results = searchCommands(this.commands(), this.input.value);
    this.selection = Math.max(0, Math.min(this.selection, this.results.length - 1));
    this.list.replaceChildren();
    this.empty.hidden = !!this.results.length;
    this.results.forEach((command, index) => {
      const row = this.node("button", `orbit-command-option-${index}`, "orbit-command-result");
      row.type = "button";
      row.tabIndex = -1;
      row.setAttribute("role", "option");
      row.setAttribute("data-orbit-command-id", command.id);
      const kind = this.node("span", null, "orbit-command-kind", command.kind === "command" ? "◈" : command.kind === "tab" ? "↗" : "▣");
      kind.setAttribute("aria-hidden", "true");
      const copy = this.node("span", null, "orbit-command-copy");
      copy.append(this.node("span", null, "orbit-command-label", command.label), this.node("span", null, "orbit-command-detail", command.detail));
      row.append(kind, copy);
      // Rows are replaced on every query and native tab change. Their listeners
      // belong to the transient nodes, rather than the window cleanup list.
      row.addEventListener("click", event => { if (event.isTrusted) this.activate(index); });
      this.list.append(row);
    });
    this.select(this.selection);
  }

  select(index) {
    this.selection = this.results.length ? (index + this.results.length) % this.results.length : 0;
    for (let i = 0; i < this.list.children.length; i++) this.list.children[i].setAttribute("aria-selected", String(i === this.selection));
    const row = this.list.children[this.selection];
    if (row) {
      this.input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else this.input.removeAttribute("aria-activedescendant");
  }

  activate(index = this.selection) {
    const command = this.results[index];
    if (!command) return;
    this.close(false);
    // Default focus is the real selected browser. Native new-tab/canvas
    // commands may subsequently focus their own address field or document.
    this.win.gBrowser.selectedBrowser.focus();
    command.run();
  }

  keydown(event) {
    if (!event.isTrusted || event.defaultPrevented || event.isComposing) return;
    const accel = Services.appinfo.OS === "Darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (accel && event.shiftKey && !event.altKey && (event.code === "Space" || event.key === " ")) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) this.palette.hidden ? this.open() : this.close();
      return;
    }
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) this.setFocusMode(!this.focusMode);
      return;
    }
    const nativeAddressShortcut = accel && !event.altKey && ["l", "k", "e", "t"].includes(event.key.toLowerCase()) ||
      event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "d" ||
      !event.altKey && !event.ctrlKey && !event.metaKey && event.key === "F6";
    if (this.focusMode && nativeAddressShortcut) {
      // Reveal before Firefox receives its original shortcut; a hidden native
      // field cannot be focused. Firefox still owns search, new-tab and cycle
      // semantics, including installations with a separate search widget.
      // An optional customized search widget keeps its native shortcut and
      // popup behavior. Its original toolbar unfolds only for that edit.
      if (accel && !event.altKey && ["k", "e"].includes(event.key.toLowerCase())) this.showSearchFallback();
      else if (this.searchFallback) {
        this.searchFallback = null;
        this.root.removeAttribute("data-orbit-focus-reveal");
      }
      this.reveal(true, true);
      this.scheduleConceal("address");
    }
    if (!this.palette.hidden) {
      // Native navigation shortcuts keep their Firefox behavior and focus.
      // Close our modal before the original shortcut handler runs.
      if (nativeAddressShortcut || accel && !event.altKey && event.key.toLowerCase() === "w") {
        this.close(false);
        return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape", "Tab"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape") this.close();
        else if (event.key === "Enter") {
          if (this.doc.activeElement === this.doc.getElementById("orbit-command-close")) this.close();
          else this.activate();
        }
        else if (event.key === "ArrowDown") this.select(this.selection + 1);
        else if (event.key === "ArrowUp") this.select(this.selection - 1);
        else if (event.key === "Home") this.select(0);
        else if (event.key === "End") this.select(this.results.length - 1);
        else if (event.key === "Tab") {
          if (this.doc.activeElement === this.input) this.doc.getElementById("orbit-command-close").focus();
          else this.input.focus();
        }
      }
    } else if (this.focusMode && event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey &&
               !this.doc.getElementById("orbit-radial-root")?.classList.contains("orbit-radial-visible")) {
      // Native autocomplete, identity and extension panels own their first Esc.
      if (this.win.gURLBar?.view?.isOpen || Object.values(this.islands).some(island => island.popups.size)) return;
      if (this.focusTools?.visible) {
        event.preventDefault(); event.stopPropagation(); this.hideIsland("tools", true);
      } else if (this.addressNode()?.contains(this.doc.activeElement) || this.searchFallback?.contains(this.doc.activeElement)) {
        // Let Firefox revert the edit before returning focus to the page.
        this.cancelIslandTimer("address", "conceal");
        this.islands.address.conceal = this.win.setTimeout(() => {
          this.islands.address.conceal = null;
          if (!this.focusMode || this.win.gURLBar?.view?.isOpen) return;
          this.win.gBrowser.selectedBrowser.focus();
          this.hideIsland("address", true);
        }, 0);
      } else {
        event.preventDefault(); event.stopPropagation(); this.setFocusMode(false);
      }
    }
  }

  addressNode() {
    return this.doc.getElementById("urlbar-container") || this.win.gURLBar?.inputField || this.doc.getElementById("urlbar-input");
  }

  nativeSearchNode() {
    const search = this.doc.getElementById("search-container") || this.doc.getElementById("searchbar");
    return search?.isConnected && this.doc.getElementById("nav-bar")?.contains(search) ? search : null;
  }

  showSearchFallback() {
    const search = this.nativeSearchNode();
    if (!this.focusMode || !search) return;
    this.searchFallback = this.doc.getElementById("search-container") || search;
    this.root.setAttribute("data-orbit-focus-reveal", "true");
  }

  markFocusNode(node, name, value = "true") {
    if (!node) return;
    if (!this.focusMarkers.has(node)) this.focusMarkers.set(node, new Map());
    const attributes = this.focusMarkers.get(node);
    if (!attributes.has(name)) attributes.set(name, node.getAttribute(name));
    node.setAttribute(name, value);
  }

  restoreFocusMarkers() {
    for (const [node, attributes] of this.focusMarkers) {
      for (const [name, value] of attributes) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
    }
    this.focusMarkers.clear();
    this.windowControls = null;
  }

  ensureFocusTools() {
    if (this.focusTools) return;
    this.focusTools = new lazy.OrbitFocusTools(this.win, {
      onVisibilityChange: visible => {
        this.islands.tools.visible = this.focusMode && !!visible;
        this.root.toggleAttribute("data-orbit-focus-tools-visible", this.islands.tools.visible);
        if (this.islands.tools.visible) this.root.setAttribute("data-orbit-focus-tools-visible", "true");
        else this.islands.tools.hovered = false;
      },
      onAddress: () => { this.reveal(true, true); this.win.gURLBar?.select(); },
      onAddressReveal: () => this.reveal(true, true),
      onExit: () => this.setFocusMode(false),
      onCommands: () => this.open(),
      onPointerEnter: () => {
        this.islands.tools.hovered = true;
        this.cancelIslandTimer("tools", "conceal");
      },
      onPointerLeave: () => {
        this.islands.tools.hovered = false;
        this.scheduleConceal("tools");
      },
      onNativePopup: (popup, opened = true) => {
        if (opened && this.focusMode) {
          this.islands.tools.popups.add(popup);
          this.cancelIslandTimer("tools", "conceal");
        } else {
          this.islands.tools.popups.delete(popup);
          this.scheduleConceal("tools");
        }
      },
    });
  }

  setFocusMode(enabled) {
    if (this.disposed || (enabled && (this.win.fullScreen || this.root.getAttribute("customizing") === "true"))) return;
    enabled = !!enabled;
    if (enabled === this.focusMode) return;
    if (enabled) this.ensureFocusTools();
    const toolbox = this.doc.getElementById("navigator-toolbox");
    if (this.palette.hidden && (toolbox?.contains(this.doc.activeElement) || this.chip.contains(this.doc.activeElement))) {
      this.win.gBrowser.selectedBrowser.focus();
    }
    this.focusMode = enabled;
    this.root.toggleAttribute("data-orbit-focus", enabled);
    if (enabled) this.root.setAttribute("data-orbit-focus", "true");
    this.focusTools?.setEnabled?.(enabled);
    this.chip.hidden = !enabled;
    for (const island of Object.keys(this.islands)) {
      this[`${island}Hotzone`].hidden = !enabled;
      this.islands[island].hovered = false;
      this.cancelIslandTimer(island, "dwell");
      this.cancelIslandTimer(island, "conceal");
      this.hideIsland(island, true);
      if (!enabled) this.islands[island].popups.clear();
    }
    if (enabled) this.updateFocusLayout();
    else {
      this.restoreFocusMarkers();
      for (const attr of ["data-orbit-focus-reveal", "data-orbit-focus-nav-titlebar", "data-orbit-focus-native-titlebar", "data-orbit-focus-measuring"]) {
        this.root.removeAttribute(attr);
      }
    }
    if (!this.palette.hidden) this.update();
  }

  updateFocusLayout() {
    if (!this.focusMode || this.disposed) return;
    this.root.setAttribute("data-orbit-focus-measuring", "true");
    try {
      const address = this.addressNode();
      this.markFocusNode(address, "data-orbit-focus-address");
      for (let node = address?.parentElement; node && node !== this.root; node = node.parentElement) {
        this.markFocusNode(node, "data-orbit-focus-island-parent");
      }
      const navigation = this.doc.getElementById("nav-bar");
      const boxes = this.doc.querySelectorAll?.(".titlebar-buttonbox-container") || navigation?.querySelectorAll(".titlebar-buttonbox-container") || [];
      let controls = null;
      for (const box of boxes) {
        const rect = box.getBoundingClientRect();
        const style = this.win.getComputedStyle(box);
        if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") {
          controls = box;
          break;
        }
      }
      if (this.windowControls !== controls) {
        if (this.windowControls) {
          const previous = this.focusMarkers.get(this.windowControls)?.get("data-orbit-focus-window-controls");
          if (previous === null || previous === undefined) this.windowControls.removeAttribute("data-orbit-focus-window-controls");
          else this.windowControls.setAttribute("data-orbit-focus-window-controls", previous);
        }
        this.windowControls = controls;
        if (controls) {
          this.markFocusNode(controls, "data-orbit-focus-window-controls");
          if (!this.windowControlListeners.has(controls)) {
            // Native widgets stay in place; only our attributes alter layout.
            // Track listener ownership here so a titlebar owner change is safe.
            const enter = event => {
              if (!event.isTrusted || controls !== this.windowControls) return;
              this.islands.window.hovered = true;
              this.showIsland("window");
            };
            const leave = event => {
              if (!event.isTrusted || controls !== this.windowControls) return;
              this.islands.window.hovered = false;
              this.scheduleConceal("window");
            };
            this.listen(controls, "mouseenter", enter);
            this.listen(controls, "mouseleave", leave);
            this.windowControlListeners.add(controls);
          }
        }
      }
      const navigationTitlebar = !!controls && !!navigation?.contains(controls);
      this.root.toggleAttribute("data-orbit-focus-nav-titlebar", navigationTitlebar);
      if (navigationTitlebar) this.root.setAttribute("data-orbit-focus-nav-titlebar", "true");
      // macOS traffic lights and system titlebars retain their OS ownership.
      const nativeTitlebar = Services.appinfo.OS === "Darwin" || !controls;
      this.root.toggleAttribute("data-orbit-focus-native-titlebar", nativeTitlebar);
      if (nativeTitlebar) this.root.setAttribute("data-orbit-focus-native-titlebar", "true");
    } finally {
      this.root.removeAttribute("data-orbit-focus-measuring");
    }
  }

  cancelIslandTimer(island, kind) {
    const state = this.islands[island];
    if (state[kind] !== null) this.win.clearTimeout(state[kind]);
    state[kind] = null;
    if (island === "address" && kind === "conceal") this.timer = null;
  }

  enterHotzone(island) {
    if (!this.focusMode || !this.palette.hidden || this.disposed) return;
    const state = this.islands[island];
    state.hovered = true;
    this.cancelIslandTimer(island, "conceal");
    this.cancelIslandTimer(island, "dwell");
    if (island === "address" || state.visible) {
      this.showIsland(island);
      return;
    }
    state.dwell = this.win.setTimeout(() => {
      state.dwell = null;
      if (this.focusMode && state.hovered && this.palette.hidden) this.showIsland(island);
    }, 140);
  }

  leaveHotzone(island) {
    this.islands[island].hovered = false;
    this.cancelIslandTimer(island, "dwell");
    this.scheduleConceal(island);
  }

  showIsland(island, expanded = false) {
    if (!this.focusMode || this.disposed) return;
    this.cancelIslandTimer(island, "conceal");
    const state = this.islands[island];
    if (island === "tools") {
      this.ensureFocusTools();
      this.focusTools.open();
      state.visible = this.focusTools.visible;
    } else state.visible = true;
    this.root.toggleAttribute(`data-orbit-focus-${island}-visible`, state.visible);
    if (state.visible) this.root.setAttribute(`data-orbit-focus-${island}-visible`, "true");
    if (island === "address") {
      this.revealed = true;
      if (expanded || this.addressNode()?.contains(this.doc.activeElement)) this.root.setAttribute("data-orbit-focus-address-expanded", "true");
    }
  }

  hideIsland(island, force = false) {
    if (!force && this.islandPinned(island)) return;
    this.cancelIslandTimer(island, "conceal");
    const state = this.islands[island];
    state.visible = false;
    if (island === "tools") this.focusTools?.close("conceal");
    this.root.removeAttribute(`data-orbit-focus-${island}-visible`);
    if (island === "address") {
      this.revealed = false;
      this.root.removeAttribute("data-orbit-focus-address-expanded");
      this.searchFallback = null;
      this.root.removeAttribute("data-orbit-focus-reveal");
    }
  }

  dismissTools(reason = "page-radial") {
    this.islands.tools.hovered = false;
    this.cancelIslandTimer("tools", "dwell");
    this.cancelIslandTimer("tools", "conceal");
    this.focusTools?.close(reason);
    this.hideIsland("tools", true);
  }

  islandPinned(island) {
    const state = this.islands[island];
    if (state.hovered || state.popups.size) return true;
    if (island === "address") return !!this.addressNode()?.contains(this.doc.activeElement) ||
      !!this.searchFallback?.contains(this.doc.activeElement) || !!this.win.gURLBar?.view?.isOpen;
    if (island === "window") return !!this.windowControls?.contains(this.doc.activeElement);
    return !!this.focusTools?.contains(this.doc.activeElement);
  }

  reveal(shown, expanded = false) {
    if (shown) this.showIsland("address", expanded);
    else this.hideIsland("address", true);
  }

  scheduleConceal(island = "address") {
    if (!this.focusMode || this.disposed) return;
    this.cancelIslandTimer(island, "conceal");
    this.islands[island].conceal = this.win.setTimeout(() => {
      this.islands[island].conceal = null;
      if (island === "address") this.timer = null;
      this.hideIsland(island);
    }, 350);
    if (island === "address") this.timer = this.islands[island].conceal;
  }

  popupChanged(popup, opened) {
    if (!popup) return;
    if (!opened) {
      for (const [name, state] of Object.entries(this.islands)) {
        if (state.popups.delete(popup)) this.scheduleConceal(name);
      }
      return;
    }
    if (!this.focusMode) return;
    const anchor = popup.anchorNode || popup.triggerNode;
    let island = null;
    if (this.addressNode()?.contains(anchor) || this.addressNode()?.contains(popup) ||
        this.searchFallback?.contains(anchor) || this.searchFallback?.contains(popup)) island = "address";
    else if (this.windowControls?.contains(anchor)) island = "window";
    else if (this.focusTools?.contains(anchor) || this.doc.getElementById("nav-bar")?.contains(anchor)) island = "tools";
    if (island) {
      this.islands[island].popups.add(popup);
      // A native extension/app panel replaces the radial tools surface. Keep
      // its original native anchor alive without reopening the tools wheel.
      if (island === "tools") this.cancelIslandTimer(island, "conceal");
      else this.showIsland(island, island === "address");
    }
  }

  onWindowBlur() {
    this.close(false);
    for (const [name, state] of Object.entries(this.islands)) {
      state.hovered = false;
      this.cancelIslandTimer(name, "dwell");
      this.cancelIslandTimer(name, "conceal");
      if (!state.popups.size && !(name === "address" && this.win.gURLBar?.view?.isOpen)) this.hideIsland(name, true);
    }
  }

  onWindowFocus() {
    if (!this.focusMode || this.disposed) return;
    if (this.nativeSearchNode()?.contains(this.doc.activeElement)) this.showSearchFallback();
    if (this.addressNode()?.contains(this.doc.activeElement) || this.searchFallback?.contains(this.doc.activeElement)) {
      this.showIsland("address", true);
    }
  }

  destroy() {
    if (this.disposed) return;
    this.close(false);
    this.setFocusMode(false);
    this.disposed = true;
    this.layoutObserver.disconnect();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.focusTools?.destroy();
    for (const island of Object.keys(this.islands)) {
      this.cancelIslandTimer(island, "dwell");
      this.cancelIslandTimer(island, "conceal");
      this[`${island}Hotzone`].remove();
    }
    this.palette.remove(); this.chip.remove(); this.sheet.remove();
    this.results = [];
  }
}

export const OrbitInteractions = {
  dismissTools(win, reason = "page-radial") { windows.get(win)?.dismissTools(reason); },
  init(win) {
    if (!win.gBrowser || windows.has(win)) return;
    windows.set(win, new InteractionWindow(win));
    if (widgetCreated) return;
    lazy.CustomizableUI.createWidget({
      id: "orbit-command-button", defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
      label: "Orbit commands", tooltiptext: `Orbit commands (${Services.appinfo.OS === "Darwin" ? "⌘" : "Ctrl+"}Shift+Space)`, showInPrivateBrowsing: true,
      onCreated(node) { node.setAttribute("image", "chrome://browser/content/orbit/orbit-commands.svg"); },
      onCommand(event) {
        if (!event.isTrusted) return;
        const win = (event.currentTarget || event.target).ownerDocument.defaultView;
        const state = windows.get(win);
        if (state) state.palette.hidden ? state.open() : state.close();
      },
    });
    widgetCreated = true;
  },
  uninit(win) { windows.get(win)?.destroy(); windows.delete(win); },
};
