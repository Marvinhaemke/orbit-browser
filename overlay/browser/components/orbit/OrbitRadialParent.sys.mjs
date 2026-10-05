/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  OrbitRadial: "moz-src:///browser/components/orbit/OrbitRadial.sys.mjs",
});

export class OrbitRadialParent extends JSWindowActorParent {
  actorCreated() {
    const browser = this.manager.rootFrameLoader?.ownerElement;
    const win = browser?.ownerDocument?.defaultView;
    if (win?.gBrowser) this._owner = { win, browser, frameId: this.browsingContext.id };
  }

  receiveMessage(message) {
    if (message.name !== "OrbitRadial:Pointer") return;
    // pagehide can race the replacement WindowGlobal. Cancellation of this
    // actor's own existing UI remains valid after its document stops current.
    if (message.data?.kind === "cancel" && this._owner) {
      const { win, browser, frameId } = this._owner;
      lazy.OrbitRadial.cancelContentGesture(win, browser, frameId);
      return;
    }
    if (!this.manager.isCurrentGlobal ||
        !this.browsingContext.ancestorsAreCurrent || this.browsingContext.isInBFCache ||
        this.browsingContext.isDiscarded) return;
    const browser = this.manager.rootFrameLoader?.ownerElement;
    const win = browser?.ownerDocument?.defaultView;
    // A web process may only affect the selected native browser that actually
    // owns this actor. No browser identifiers, tab IDs, or commands cross IPC.
    if (!win?.gBrowser || win.gBrowser.selectedBrowser !== browser ||
        !win.gBrowser.getTabForBrowser(browser)) return;
    const data = message.data;
    if (!data || !["down", "move", "up", "cancel"].includes(data.kind)) return;
    if (data.kind !== "cancel" &&
        (![data.screenXDevPx, data.screenYDevPx].every(value =>
          Number.isFinite(value) && Math.abs(value) <= 1e7) ||
          !Number.isInteger(data.buttons) || data.buttons < 0 || data.buttons > 31)) return;
    const dpr = win.devicePixelRatio;
    if (!Number.isFinite(dpr) || dpr <= 0) return;
    this._owner = { win, browser, frameId: this.browsingContext.id };
    lazy.OrbitRadial.handleContentGesture(win, browser, this.browsingContext.id, {
      kind: data.kind,
      screenX: data.screenXDevPx / dpr,
      screenY: data.screenYDevPx / dpr,
      buttons: data.buttons,
      shiftKey: data.shiftKey === true,
      ctrlKey: data.ctrlKey === true,
      altKey: data.altKey === true,
      metaKey: data.metaKey === true,
    });
  }

  didDestroy() {
    if (this._owner) {
      const { win, browser, frameId } = this._owner;
      lazy.OrbitRadial.cancelContentGesture(win, browser, frameId);
      this._owner = null;
    }
  }
}
