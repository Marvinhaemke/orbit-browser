/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  Orbit: "moz-src:///browser/components/orbit/Orbit.sys.mjs",
  OrbitRadial: "moz-src:///browser/components/orbit/OrbitRadial.sys.mjs",
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
    this.results = [];
    this.selection = 0;
    this.disposed = false;
    this.build();
    this.listen(win, "keydown", event => this.keydown(event), true);
    this.listen(win, "fullscreen", () => this.setFocusMode(false));
    this.listen(win, "DOMFullscreen:Entered", () => this.setFocusMode(false));
    this.listen(win, "beforecustomization", () => this.setFocusMode(false));
    this.listen(win, "blur", () => this.close(false));
    this.listen(win, "resize", () => this.updateFocusLayout());
    // Firefox can move the native window buttons to the navigation row when
    // switching to vertical tabs. Preserve whichever row actually owns them.
    this.layoutObserver = new win.MutationObserver(records => {
      if (records.some(record => !record.attributeName.startsWith("data-orbit-"))) this.updateFocusLayout();
    });
    this.layoutObserver.observe(this.root, { attributes: true });
    const toolbox = this.doc.getElementById("navigator-toolbox");
    if (toolbox) {
      this.listen(toolbox, "mouseenter", () => this.reveal(true));
      this.listen(toolbox, "mouseleave", () => this.scheduleConceal());
      this.listen(toolbox, "focusin", () => this.reveal(true));
      this.listen(toolbox, "focusout", () => this.scheduleConceal());
    }
    this.listen(win, "mousedown", event => {
      if (event.isTrusted && this.focusMode && !toolbox?.contains(event.target) && !this.palette.contains(event.target) && !this.chip.contains(event.target)) {
        this.scheduleConceal();
      }
    }, true);
    this.listen(win, "popupshowing", () => this.reveal(true));
    this.listen(win, "popuphidden", () => this.scheduleConceal());
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
    const reveal = this.node("button", "orbit-focus-reveal", null, "Show controls");
    reveal.type = "button";
    reveal.title = `Reveal browser controls (${Services.appinfo.OS === "Darwin" ? "⌘" : "Ctrl+"}L)`;
    const exit = this.node("button", "orbit-focus-exit", null, "Exit focus");
    exit.type = "button";
    exit.title = "Exit focus mode (Escape or Alt+Shift+F)";
    this.listen(reveal, "click", event => {
      if (!event.isTrusted) return;
      this.reveal(true);
      this.win.gURLBar?.select();
    });
    this.listen(exit, "click", event => { if (event.isTrusted) this.setFocusMode(false); });
    this.listen(this.chip, "mouseenter", () => this.reveal(true));
    this.listen(this.chip, "mouseleave", () => this.scheduleConceal());
    this.chip.append(reveal, exit);
    this.root.append(this.palette, this.chip);
  }

  commands() {
    const commands = [
      { id: "action:canvas", kind: "command", label: "Open canvas", detail: "Your spatial tabs, frames, and notes", keywords: "board workspace", run: () => lazy.Orbit.openBoard(this.win) },
      { id: "action:focus", kind: "command", label: this.focusMode ? "Exit focus mode" : "Enter focus mode", detail: "Let browser controls recede · Alt+Shift+F", keywords: "restore toolbar distraction", run: () => this.setFocusMode(!this.focusMode) },
      { id: "action:new-tab", kind: "command", label: "New tab", detail: "Open a fresh canvas tab · Ctrl+T", run: () => this.win.BrowserCommands.openTab() },
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
    this.previousFocus = this.doc.activeElement;
    if (this.doc.getElementById("orbit-radial-root")?.contains(this.previousFocus)) {
      this.previousFocus = this.win.gBrowser.selectedBrowser;
    }
    this.palette.hidden = false;
    this.input.value = "";
    this.selection = 0;
    this.update();
    this.reveal(true);
    this.input.focus();
  }

  close(restore = true) {
    if (this.palette.hidden) return;
    this.palette.hidden = true;
    if (restore) {
      const toolbox = this.doc.getElementById("navigator-toolbox");
      if (toolbox?.contains(this.previousFocus)) this.reveal(true);
      if (this.previousFocus?.isConnected && !this.palette.contains(this.previousFocus) &&
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
    if (this.focusMode && accel && !event.altKey && event.key.toLowerCase() === "l") this.reveal(true);
    if (!this.palette.hidden) {
      // Native navigation shortcuts keep their Firefox behavior and focus.
      // Close our modal before the original shortcut handler runs.
      if (accel && !event.altKey && ["l", "t", "w"].includes(event.key.toLowerCase())) {
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
    } else if (this.focusMode && event.key === "Escape" && !this.doc.getElementById("orbit-radial-root")?.classList.contains("orbit-radial-visible")) {
      event.preventDefault(); event.stopPropagation(); this.setFocusMode(false);
    }
  }

  setFocusMode(enabled) {
    if (this.disposed || (enabled && (this.win.fullScreen || this.root.getAttribute("customizing") === "true"))) return;
    this.focusMode = !!enabled;
    const toolbox = this.doc.getElementById("navigator-toolbox");
    if (this.palette.hidden && (toolbox?.contains(this.doc.activeElement) || this.chip.contains(this.doc.activeElement))) {
      this.win.gBrowser.selectedBrowser.focus();
    }
    this.root.toggleAttribute("data-orbit-focus", this.focusMode);
    if (this.focusMode) this.root.setAttribute("data-orbit-focus", "true");
    this.chip.hidden = !this.focusMode;
    this.updateFocusLayout();
    this.reveal(false);
    if (!this.palette.hidden) this.update();
  }

  updateFocusLayout() {
    let navigationTitlebar = false;
    if (this.focusMode) {
      const navigation = this.doc.getElementById("nav-bar");
      // Measure while revealed: the focus rule itself must not make a native
      // titlebar appear absent on a subsequent layout update.
      if (navigation) {
        const wasRevealed = this.root.hasAttribute("data-orbit-focus-reveal");
        if (!wasRevealed) this.root.setAttribute("data-orbit-focus-reveal", "true");
        for (const box of navigation.querySelectorAll(".titlebar-buttonbox-container")) {
          const rect = box.getBoundingClientRect();
          const style = this.win.getComputedStyle(box);
          if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") navigationTitlebar = true;
        }
        if (!wasRevealed) this.root.removeAttribute("data-orbit-focus-reveal");
      }
    }
    if (navigationTitlebar !== this.root.hasAttribute("data-orbit-focus-nav-titlebar")) {
      this.root.toggleAttribute("data-orbit-focus-nav-titlebar", navigationTitlebar);
    }
  }

  reveal(shown) {
    if (this.timer !== null) { this.win.clearTimeout(this.timer); this.timer = null; }
    this.revealed = this.focusMode && !!shown;
    if (this.revealed) this.root.setAttribute("data-orbit-focus-reveal", "true");
    else this.root.removeAttribute("data-orbit-focus-reveal");
  }

  scheduleConceal() {
    if (!this.focusMode || !this.palette.hidden) return;
    if (this.timer !== null) this.win.clearTimeout(this.timer);
    this.timer = this.win.setTimeout(() => {
      this.timer = null;
      const toolbox = this.doc.getElementById("navigator-toolbox");
      if (!toolbox?.contains(this.doc.activeElement) && !this.chip.contains(this.doc.activeElement) && !this.doc.querySelector("panel[open], menupopup[open]")) this.reveal(false);
    }, 250);
  }

  destroy() {
    if (this.disposed) return;
    this.close(false);
    this.setFocusMode(false);
    this.disposed = true;
    this.layoutObserver.disconnect();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.palette.remove(); this.chip.remove(); this.sheet.remove();
    this.results = [];
  }
}

export const OrbitInteractions = {
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
