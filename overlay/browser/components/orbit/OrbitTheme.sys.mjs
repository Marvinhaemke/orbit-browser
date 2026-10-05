/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const DEFAULT_THEME_ID = "default-theme@mozilla.org";
const windows = new WeakMap();

/** Orbit's appearance lives entirely in browser chrome. Firefox still owns
 * theme selection and color-scheme handling; an explicitly selected theme
 * retains its colors and the native private-browsing indicator stays intact.
 */
export const OrbitTheme = {
  init(win) {
    if (windows.has(win)) return;
    const doc = win.document;
    const root = doc.documentElement;
    let sheet = doc.getElementById("orbit-chrome-styles");
    const ownsSheet = !sheet;
    if (!sheet) {
      sheet = doc.createElementNS(HTML_NS, "link");
      sheet.id = "orbit-chrome-styles";
      sheet.rel = "stylesheet";
      sheet.href = "chrome://browser/content/orbit/orbit-chrome.css";
      root.append(sheet);
    }
    const update = () => {
      // This attribute and event are set by LightweightThemeConsumer after
      // it has resolved the user's theme, private-window variant, and OS mode.
      const themeID = root.getAttribute("theme-effective-id");
      root.setAttribute("data-orbit-theme",
        !themeID || themeID === DEFAULT_THEME_ID ? "default" : "custom");
    };
    root.classList.add("orbit-browser-chrome");
    win.addEventListener("windowlwthemeupdate", update);
    windows.set(win, {root, sheet, ownsSheet, update});
    update();
  },

  uninit(win) {
    const state = windows.get(win);
    if (!state) return;
    win.removeEventListener("windowlwthemeupdate", state.update);
    state.root.classList.remove("orbit-browser-chrome");
    state.root.removeAttribute("data-orbit-theme");
    if (state.ownsSheet) state.sheet.remove();
    windows.delete(win);
  },
};
