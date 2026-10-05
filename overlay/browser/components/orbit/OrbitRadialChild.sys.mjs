/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pointer observation only. Firefox's ContextMenu actor remains responsible
 * for hit testing, principals, and the native context-menu descriptor. */
export class OrbitRadialChild extends JSWindowActorChild {
  handleEvent(event) {
    if (!event.isTrusted) return;
    if (event.type === "pagehide") {
      this._send("cancel");
      return;
    }
    if (event.type === "keydown") {
      if (event.key === "Escape") this._send("cancel");
      return;
    }
    if (event.type === "mousedown" && event.button === 2) {
      this._send("down", event);
    } else if (event.type === "mouseup" && event.button === 2) {
      this._send("up", event);
    } else if (event.type === "mousemove" && (event.buttons & 2)) {
      // Each frame may see a different part of the gesture. In particular a
      // subframe must report its up even if the down was in its parent frame.
      this._pendingMove = event;
      if (!this._moveFrame) {
        this._moveFrame = this.contentWindow.requestAnimationFrame(() => {
          this._moveFrame = null;
          const last = this._pendingMove;
          this._pendingMove = null;
          if (last) this._send("move", last);
        });
      }
    }
    // Never cancel contextmenu or mouseup: the native actor needs the real
    // target and event, including cross-origin frames and editable controls.
  }

  _send(kind, event = null) {
    if (kind === "up" || kind === "cancel") this._cancelMove();
    const dpr = this.contentWindow.devicePixelRatio;
    const data = { kind };
    if (event) {
      // Match ContextMenuChild's screenXDevPx contract (including page zoom).
      data.screenXDevPx = event.screenX * dpr;
      data.screenYDevPx = event.screenY * dpr;
      data.buttons = event.buttons;
      data.shiftKey = event.shiftKey;
      data.ctrlKey = event.ctrlKey;
      data.altKey = event.altKey;
      data.metaKey = event.metaKey;
    }
    this.sendAsyncMessage("OrbitRadial:Pointer", data);
  }

  _cancelMove() {
    if (this._moveFrame) this.contentWindow.cancelAnimationFrame(this._moveFrame);
    this._moveFrame = null;
    this._pendingMove = null;
  }

  didDestroy() {
    // The parent actor also cancels a gesture whose originating frame dies.
    // Do not access contentWindow here: its global may already be torn down.
    this._moveFrame = null;
    this._pendingMove = null;
  }
}
