/* Orbit's canvas is privileged Firefox chrome. All page loads and persistence
 * go through the parent bridge; cards only display native tab metadata. */
"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const viewport = $("viewport");
  const world = $("world");
  const bridge = parent.OrbitChrome;
  const SVG = "http://www.w3.org/2000/svg";
  const palette = ["#9782ca", "#7baba0", "#d39a75", "#869bc8", "#bf8dad"];
  const noteColors = ["#fff1ad", "#f5dce9", "#dceee4", "#e3def9"];
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = () => crypto.randomUUID();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, title, callback, className = "") => {
    const node = el("button", className, text);
    node.type = "button";
    node.title = title;
    node.addEventListener("click", callback);
    return node;
  };
  const webURL = raw => {
    const trimmed = String(raw || "").trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error("Enter an HTTP or HTTPS website address without embedded credentials.");
    }
    return url.href;
  };
  const domain = raw => {
    try { return new URL(raw).hostname.replace(/^www\./, ""); }
    catch { return "Website"; }
  };
  const tabTitle = tab => String(tab.title || domain(tab.url)).slice(0, 2048);
  const isTyping = node => !!node?.closest("input,textarea,select,[contenteditable=true]");
  let board = {version: 1, camera: {x: 68, y: 78, zoom: 1}, items: [], frames: [], connections: [], strokes: []};
  let nativeTabs = [];
  let tool = "select";
  let selected = null;
  let connectFrom = null;
  let drag = null;
  let spaceHeld = false;
  let radialPoint = null;
  let pendingAddPoint = null;
  let saveTimer;
  let toastTimer;
  let unsubscribe;
  const history = [];

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.add("visible");
    toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 2600);
  }

  function report(error) {
    console.error("Orbit canvas:", error);
    toast(error?.message || "The browser action could not be completed.");
  }

  function checkpoint() {
    history.push(clone(board));
    if (history.length > 40) history.shift();
    $("undo").disabled = false;
  }

  function persist() {
    clearTimeout(saveTimer);
    try {
      bridge.saveBoard({...board, strokes: board.strokes.filter(stroke => stroke.points.length >= 2)});
      $("save-status").textContent = "◌ Workspace saved";
    } catch (error) {
      $("save-status").textContent = "Workspace could not be saved";
      report(error);
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 350);
  }

  function undo() {
    if (!history.length) return;
    board = history.pop();
    selected = null;
    connectFrom = null;
    render();
    persist();
    toast("Board change undone");
  }

  function point(event) {
    const rect = viewport.getBoundingClientRect();
    return {x: clamp((event.clientX - rect.left - board.camera.x) / board.camera.zoom, -100000, 100000),
      y: clamp((event.clientY - rect.top - board.camera.y) / board.camera.zoom, -100000, 100000)};
  }

  function centerPoint() {
    return {x: clamp((viewport.clientWidth / 2 - board.camera.x) / board.camera.zoom, -100000, 100000),
      y: clamp((viewport.clientHeight / 2 - board.camera.y) / board.camera.zoom, -100000, 100000)};
  }

  function applyCamera() {
    const {x, y, zoom} = board.camera;
    world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    viewport.style.backgroundSize = `${20 * zoom}px ${20 * zoom}px`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    $("zoom-value").textContent = `${Math.round(zoom * 100)}%`;
  }

  function zoomAt(factor, clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    const px = clientX === undefined ? viewport.clientWidth / 2 : clientX - rect.left;
    const py = clientY === undefined ? viewport.clientHeight / 2 : clientY - rect.top;
    const before = board.camera.zoom;
    const after = clamp(before * factor, .2, 2);
    board.camera.x = clamp(px - (px - board.camera.x) * after / before, -100000, 100000);
    board.camera.y = clamp(py - (py - board.camera.y) * after / before, -100000, 100000);
    board.camera.zoom = after;
    applyCamera();
    scheduleSave();
  }

  function fit(rect) {
    const shapes = rect ? [rect] : [...board.items, ...board.frames];
    const points = rect ? [] : board.strokes.flatMap(stroke => stroke.points);
    if (!shapes.length && !points.length) {
      board.camera = {x: 68, y: 78, zoom: 1};
    } else {
      const bounds = shapes.map(s => ({x: s.x, y: s.y - (s.title && !s.type ? 40 : 0), right: s.x + s.w, bottom: s.y + s.h}));
      const extent = [...bounds, ...points.map(p => ({x: p.x, y: p.y, right: p.x, bottom: p.y}))]
        .reduce((box, p) => ({minX: Math.min(box.minX, p.x), minY: Math.min(box.minY, p.y),
          maxX: Math.max(box.maxX, p.right), maxY: Math.max(box.maxY, p.bottom)}),
        {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity});
      const {minX, minY, maxX, maxY} = extent;
      const zoom = clamp(Math.min((viewport.clientWidth - 112) / Math.max(100, maxX - minX),
        (viewport.clientHeight - 180) / Math.max(100, maxY - minY)), .2, 1.3);
      board.camera = {x: (viewport.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom,
        y: Math.max(50, (viewport.clientHeight - 85 - (maxY - minY) * zoom) / 2) - minY * zoom, zoom};
    }
    board.camera.x = clamp(board.camera.x, -100000, 100000);
    board.camera.y = clamp(board.camera.y, -100000, 100000);
    applyCamera();
    scheduleSave();
  }

  function setTool(next) {
    tool = next;
    connectFrom = null;
    viewport.className = `canvas-viewport tool-${next}`;
    document.querySelectorAll("[data-tool]").forEach(node => {
      node.setAttribute("aria-pressed", String(node.dataset.tool === next));
    });
    $("canvas-hint").textContent = {
      select: "Drag to arrange · Right-click to explore · Scroll to pan",
      hand: "Drag anywhere to pan · Ctrl + scroll to zoom",
      note: "Click the canvas to place a note",
      frame: "Drag on the canvas to draw a frame",
      connect: "Choose two cards or notes to connect them",
      draw: "Drag to draw · Double-click a drawing to remove it",
    }[next];
    renderSelection();
  }

  function record(item) {
    return {url: webURL(item.url), ...(item.tabId ? {tabId: item.tabId} : {}),
      userContextId: item.userContextId || 0};
  }

  function retainNativeBinding(itemId, tabId) {
    // Native tab identities are metadata, so undoing a layout change should
    // preserve a tab restored after that history snapshot was created.
    for (const snapshot of history) {
      const item = snapshot.items.find(candidate => candidate.id === itemId);
      if (item?.type === "tab") item.tabId = tabId;
    }
  }

  async function tabAction(item, action) {
    try {
      persist();
      if (action === "open") {
        const tab = await bridge.openTab(record(item));
        item.tabId = tab.id;
        retainNativeBinding(item.id, tab.id);
        await bridge.selectTab(tab.id);
        bridge.hideCanvas();
        persist();
      } else if (action === "peek") {
        await bridge.peek(record(item));
      } else {
        await bridge.split(record(item));
      }
    } catch (error) { report(error); }
  }

  function positionNode(node, shape) {
    node.style.left = `${shape.x}px`;
    node.style.top = `${shape.y}px`;
    node.style.width = `${shape.w}px`;
    node.style.height = `${shape.h}px`;
  }

  function renderSelection() {
    document.querySelectorAll("[data-id]").forEach(node => {
      node.classList.toggle("selected", node.dataset.id === selected);
      node.classList.toggle("connection-source", node.dataset.id === connectFrom);
    });
  }

  function select(itemId) {
    selected = itemId;
    renderSelection();
  }

  function connectTo(item) {
    select(item.id);
    if (!connectFrom) {
      connectFrom = item.id;
      renderSelection();
      toast("Choose a second card or note");
    } else if (connectFrom !== item.id) {
      const exists = board.connections.some(c => c.from === connectFrom && c.to === item.id);
      if (!exists) {
        if (board.connections.length >= 1000) { toast("This workspace has reached its connection limit."); return; }
        checkpoint();
        board.connections.push({id: id(), from: connectFrom, to: item.id});
        renderLines();
        persist();
      }
      connectFrom = null;
      renderSelection();
    }
  }

  function renderCard(item) {
    const tab = nativeTabs.find(t => t.id === item.tabId);
    const node = el("article", `item card${tab ? " live" : ""}${tab?.active ? " active" : ""}`);
    node.dataset.id = item.id;
    node.tabIndex = 0;
    node.setAttribute("aria-label", `${item.title || domain(item.url)}. Enter opens this tab.`);
    node.addEventListener("focus", () => select(item.id));
    positionNode(node, item);
    const color = palette[board.items.indexOf(item) % palette.length];
    node.style.setProperty("--accent", color);
    node.style.setProperty("--wash", `${color}22`);
    const top = el("div", "card-top");
    top.append(el("div", "site-mark", domain(item.url).slice(0, 1).toUpperCase()));
    const site = el("div", "card-site");
    site.append(el("div", "card-domain", domain(item.url)),
      el("div", "tab-status", tab ? (tab.active ? "Active browser tab" : "Open in Firefox") : "Saved website"));
    top.append(site);
    node.append(top, el("div", "card-title", item.title || domain(item.url)));
    const actions = el("div", "card-actions");
    actions.append(button("Open ↗", "Open this real Firefox tab", () => tabAction(item, "open")),
      button("Peek", "Preview the live website beside the canvas", () => tabAction(item, "peek")),
      button("Compare", "Open beside your active page", () => tabAction(item, "split")));
    node.append(actions);
    node.addEventListener("dblclick", event => {
      if (!event.target.closest("button") && tool === "select") tabAction(item, "open");
    });
    node.addEventListener("keydown", event => {
      if (event.key === "Enter" && event.target === node) {
        event.preventDefault();
        tool === "connect" ? connectTo(item) : tabAction(item, "open");
      }
    });
    return node;
  }

  function renderNote(item) {
    const node = el("article", "item note");
    node.dataset.id = item.id;
    node.tabIndex = 0;
    node.setAttribute("aria-label", "Sticky note. Drag its heading to move it.");
    node.addEventListener("focus", () => select(item.id));
    node.style.setProperty("--note-color", item.color || noteColors[0]);
    positionNode(node, item);
    const grip = el("div", "note-grip");
    grip.append(el("span", "", "⋮⋮ NOTE"), button("◐", "Change note color", () => {
      checkpoint();
      item.color = noteColors[(noteColors.indexOf(item.color) + 1) % noteColors.length];
      node.style.setProperty("--note-color", item.color);
      persist();
    }));
    const textarea = el("textarea");
    textarea.value = item.text || "";
    textarea.placeholder = "Put a thought here…";
    textarea.maxLength = 8000;
    textarea.setAttribute("aria-label", "Note text");
    let editingStarted = false;
    textarea.addEventListener("focus", () => { editingStarted = false; select(item.id); });
    textarea.addEventListener("input", () => {
      if (!editingStarted) { checkpoint(); editingStarted = true; }
      item.text = textarea.value;
      scheduleSave();
    });
    textarea.addEventListener("blur", persist);
    node.append(grip, textarea);
    return node;
  }

  function renderFrames() {
    $("frames").replaceChildren();
    $("frame-list").replaceChildren();
    for (const frame of board.frames) {
      const node = el("section", "frame");
      node.dataset.id = frame.id;
      node.style.setProperty("--accent", frame.color);
      node.style.setProperty("--wash", `${frame.color}0a`);
      positionNode(node, frame);
      const header = el("div", "frame-header");
      header.dataset.frameMove = frame.id;
      header.tabIndex = 0;
      header.setAttribute("aria-label", `Move frame ${frame.title}`);
      header.addEventListener("focus", () => select(frame.id));
      const name = el("label", "frame-name");
      name.append(el("span", "", "▣"));
      const input = el("input");
      input.value = frame.title;
      input.maxLength = 120;
      input.setAttribute("aria-label", "Frame name");
      input.addEventListener("change", () => {
        checkpoint();
        frame.title = input.value.trim() || "Untitled frame";
        input.value = frame.title;
        persist();
        renderFrames();
      });
      name.append(input);
      const count = board.items.filter(item => item.type === "tab" && item.frameId === frame.id).length;
      const open = button(`Open ${count} ${count === 1 ? "tab" : "tabs"} ↗`, "Open every real tab in this frame", async () => {
        try {
          persist();
          await bridge.openFrame(frame.id);
          board = await bridge.getBoard();
          for (const item of board.items.filter(candidate => candidate.type === "tab" && candidate.tabId)) {
            retainNativeBinding(item.id, item.tabId);
          }
          await refreshTabs();
        }
        catch (error) { report(error); }
      }, "open-frame");
      open.disabled = count === 0;
      header.append(name, open);
      const resize = button("⌟", "Drag to resize this frame", () => {}, "frame-resize");
      resize.dataset.frameResize = frame.id;
      resize.setAttribute("aria-label", "Resize frame. Arrow keys change size.");
      resize.addEventListener("keydown", event => {
        if (!event.key.startsWith("Arrow")) return;
        event.preventDefault();
        event.stopPropagation();
        checkpoint();
        const amount = event.shiftKey ? 64 : 16;
        frame.w = Math.max(200, frame.w + (event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0));
        frame.h = Math.max(160, frame.h + (event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0));
        positionNode(node, frame);
        updateMembership();
        persist();
      });
      node.append(header, resize);
      $("frames").append(node);
      const nav = button("", `Focus frame ${frame.title}`, () => fit(frame), "frame-nav");
      nav.style.setProperty("--accent", frame.color);
      nav.append(el("span", "frame-swatch"), el("strong", "", frame.title), el("small", "", count));
      $("frame-list").append(nav);
    }
  }

  function curve(from, to) {
    const x1 = from.x + from.w / 2;
    const y1 = from.y + from.h / 2;
    const x2 = to.x + to.w / 2;
    const y2 = to.y + to.h / 2;
    const bend = Math.max(50, Math.abs(x2 - x1) * .45);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  }

  function renderLines() {
    $("lines").replaceChildren();
    for (const link of board.connections) {
      const from = board.items.find(item => item.id === link.from);
      const to = board.items.find(item => item.id === link.to);
      if (!from || !to) continue;
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", curve(from, to));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#9286bc");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("marker-end", "url(#arrow)");
      path.dataset.connection = link.id;
      path.addEventListener("dblclick", () => {
        checkpoint();
        board.connections = board.connections.filter(c => c.id !== link.id);
        renderLines();
        persist();
      });
      $("lines").append(path);
    }
  }

  function strokePath(stroke) {
    return stroke.points.map((p, index) => `${index ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  }

  function renderStrokes() {
    $("strokes").replaceChildren();
    for (const stroke of board.strokes) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", strokePath(stroke));
      path.setAttribute("stroke", stroke.color);
      path.setAttribute("stroke-width", stroke.width);
      path.dataset.stroke = stroke.id;
      path.addEventListener("dblclick", () => {
        checkpoint();
        board.strokes = board.strokes.filter(s => s.id !== stroke.id);
        renderStrokes();
        persist();
      });
      $("strokes").append(path);
    }
  }

  function render() {
    $("items").replaceChildren(...board.items.map(item => item.type === "tab" ? renderCard(item) : renderNote(item)));
    renderFrames();
    renderLines();
    renderStrokes();
    renderSelection();
    applyCamera();
    $("empty-state").hidden = !!(board.items.length || board.frames.length || board.strokes.length);
    $("tab-count").textContent = board.items.filter(item => item.type === "tab").length;
    $("undo").disabled = !history.length;
  }

  function updateMembership() {
    for (const item of board.items) {
      const cx = item.x + item.w / 2;
      const cy = item.y + item.h / 2;
      const frames = board.frames.filter(frame => cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h);
      frames.sort((a, b) => a.w * a.h - b.w * b.h);
      if (frames.length) item.frameId = frames[0].id;
      else delete item.frameId;
    }
  }

  function addNote(p) {
    if (board.items.length >= 500) { toast("This workspace has reached its 500 card limit."); return; }
    checkpoint();
    const note = {id: id(), type: "note", x: p.x, y: p.y, w: 216, h: 180, text: "", color: noteColors[0]};
    board.items.push(note);
    updateMembership();
    select(note.id);
    setTool("select");
    render();
    persist();
    document.querySelector(`[data-id="${note.id}"] textarea`).focus();
  }

  function addFrame(p, w = 560, h = 340) {
    if (board.frames.length >= 100) { toast("This workspace has reached its 100 frame limit."); return null; }
    const frame = {id: id(), x: p.x, y: p.y, w: Math.min(10000, w), h: Math.min(10000, h), title: `Frame ${board.frames.length + 1}`,
      color: palette[board.frames.length % palette.length]};
    board.frames.push(frame);
    updateMembership();
    select(frame.id);
    setTool("select");
    render();
    persist();
    return frame;
  }

  function removeSelection() {
    if (!selected) return;
    checkpoint();
    if (board.frames.some(f => f.id === selected)) {
      board.frames = board.frames.filter(f => f.id !== selected);
      updateMembership();
    } else {
      board.items = board.items.filter(item => item.id !== selected);
      board.connections = board.connections.filter(link => link.from !== selected && link.to !== selected);
    }
    selected = null;
    connectFrom = null;
    render();
    persist();
    toast("Removed from canvas · Undo with Ctrl + Z");
  }

  function showAdd(p = centerPoint()) {
    pendingAddPoint = p;
    $("frame-select").replaceChildren(el("option", "", "Loose on canvas"));
    $("frame-select").firstChild.value = "";
    for (const frame of board.frames) {
      const option = el("option", "", frame.title);
      option.value = frame.id;
      $("frame-select").append(option);
    }
    $("url-error").hidden = true;
    $("tab-dialog").showModal();
    $("tab-form").elements.url.focus();
  }

  async function refreshTabs(importNew = false) {
    nativeTabs = await bridge.listTabs();
    let changed = false;
    for (const item of board.items.filter(i => i.type === "tab")) {
      const tab = nativeTabs.find(t => t.id === item.tabId);
      if (tab && (tab.url !== item.url || tab.title !== item.title)) {
        item.url = webURL(tab.url);
        item.title = tabTitle(tab);
        item.userContextId = tab.userContextId || 0;
        changed = true;
      }
    }
    if (importNew) {
      const tabs = nativeTabs.filter(tab => !board.items.some(item => item.type === "tab" && item.tabId === tab.id)).slice(0, Math.max(0, 500 - board.items.length));
      if (tabs.length) {
        checkpoint();
        const p = centerPoint();
        const offset = Math.max(0, ...board.items.map(item => item.y + item.h)) + 46;
        const baseY = board.items.length ? offset : 30;
        tabs.forEach((tab, index) => {
          board.items.push({id: id(), type: "tab", x: clamp(Math.max(20, p.x - 370) + index % 3 * 276, -100000, 100000),
            y: clamp(baseY + Math.floor(index / 3) * 188, -100000, 100000),
            w: 248, h: 160, title: tabTitle(tab), url: webURL(tab.url),
            tabId: tab.id, userContextId: tab.userContextId || 0});
        });
        changed = true;
      }
      toast(tabs.length ? `Imported ${tabs.length} open ${tabs.length === 1 ? "tab" : "tabs"}` : "All open websites are already on this canvas");
    }
    if (!isTyping(document.activeElement) && !drag) render();
    if (changed) persist();
  }

  function hideRadial() { $("radial").hidden = true; }

  function showRadial(event) {
    event.preventDefault();
    const target = event.target.closest("[data-id]");
    if (target) select(target.dataset.id);
    else select(null);
    radialPoint = point(event);
    const radial = $("radial");
    radial.style.left = `${clamp(event.clientX - 116, 8, Math.max(8, innerWidth - 240))}px`;
    radial.style.top = `${clamp(event.clientY - 116, 8, Math.max(8, innerHeight - 240))}px`;
    radial.hidden = false;
    radial.querySelector('[data-action="peek"]').disabled = !board.items.some(item => item.id === selected && item.type === "tab");
    radial.querySelector('[data-action="delete"]').disabled = !selected;
    radial.querySelector("button").focus();
  }

  function pointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    const resizeNode = event.target.closest("[data-frame-resize]");
    if (!resizeNode && event.target.closest("button,input,textarea,select,.toolbar,.zoom-controls,#empty-state")) return;
    hideRadial();
    const p = point(event);
    const itemNode = event.target.closest(".item");
    const frameNode = event.target.closest("[data-frame-move]");
    if (spaceHeld || tool === "hand" || event.button === 1) {
      drag = {type: "pan", startX: event.clientX, startY: event.clientY, x: board.camera.x, y: board.camera.y};
      viewport.classList.add("panning");
    } else if (tool === "connect" && itemNode) {
      connectTo(board.items.find(item => item.id === itemNode.dataset.id));
      event.preventDefault();
      return;
    } else if (tool === "select" && (itemNode || frameNode || resizeNode)) {
      const shapeId = itemNode?.dataset.id || frameNode?.dataset.frameMove || resizeNode?.dataset.frameResize;
      const shape = board.items.find(item => item.id === shapeId) || board.frames.find(frame => frame.id === shapeId);
      select(shapeId);
      drag = {type: resizeNode ? "resize" : "move", start: p, shape, x: shape.x, y: shape.y, w: shape.w, h: shape.h,
        members: board.items.filter(item => item.frameId === shapeId).map(item => ({item, x: item.x, y: item.y})), saved: false};
    } else if (tool === "note") {
      addNote(p);
      return;
    } else if (tool === "frame") {
      drag = {type: "frame", start: p};
      $("draft").hidden = false;
      positionNode($("draft"), {x: p.x, y: p.y, w: 1, h: 1});
    } else if (tool === "draw") {
      if (board.strokes.length >= 300 || board.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) >= 19998) {
        toast("This workspace has reached its drawing limit."); return;
      }
      checkpoint();
      const stroke = {id: id(), color: "#9782ca", width: 3, points: [p]};
      board.strokes.push(stroke);
      drag = {type: "draw", stroke,
        pointBudget: Math.min(3000, 20000 - board.strokes.filter(s => s !== stroke).reduce((sum, s) => sum + s.points.length, 0))};
      renderStrokes();
    } else {
      if (!event.target.closest("[data-connection],[data-stroke]")) select(null);
      viewport.focus({preventScroll: true});
      return;
    }
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
  }

  function pointerMove(event) {
    if (!drag) return;
    const p = point(event);
    if (drag.type === "pan") {
      board.camera.x = clamp(drag.x + event.clientX - drag.startX, -100000, 100000);
      board.camera.y = clamp(drag.y + event.clientY - drag.startY, -100000, 100000);
      applyCamera();
    } else if (drag.type === "move" || drag.type === "resize") {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (!drag.saved && Math.abs(dx) + Math.abs(dy) > 2) {
        checkpoint();
        drag.saved = true;
      }
      if (!drag.saved) return;
      if (drag.type === "move") {
        drag.shape.x = clamp(drag.x + dx, -100000, 100000);
        drag.shape.y = clamp(drag.y + dy, -100000, 100000);
        for (const member of drag.members) {
          member.item.x = clamp(member.x + drag.shape.x - drag.x, -100000, 100000);
          member.item.y = clamp(member.y + drag.shape.y - drag.y, -100000, 100000);
          positionNode(document.querySelector(`[data-id="${member.item.id}"]`), member.item);
        }
      } else {
        drag.shape.w = clamp(drag.w + dx, 200, 10000);
        drag.shape.h = clamp(drag.h + dy, 160, 10000);
      }
      positionNode(document.querySelector(`[data-id="${drag.shape.id}"]`), drag.shape);
      renderLines();
    } else if (drag.type === "frame") {
      positionNode($("draft"), {x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y),
        w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y)});
    } else if (drag.type === "draw") {
      const last = drag.stroke.points.at(-1);
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2 / board.camera.zoom && drag.stroke.points.length < drag.pointBudget) {
        drag.stroke.points.push(p);
        $("strokes").querySelector(`[data-stroke="${drag.stroke.id}"]`).setAttribute("d", strokePath(drag.stroke));
      }
    }
  }

  function pointerUp(event) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    viewport.classList.remove("panning");
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (previous.type === "frame") {
      const p = point(event);
      const w = Math.abs(p.x - previous.start.x);
      const h = Math.abs(p.y - previous.start.y);
      $("draft").hidden = true;
      checkpoint();
      if (w > 30 && h > 30) addFrame({x: Math.min(p.x, previous.start.x), y: Math.min(p.y, previous.start.y)}, Math.max(200, w), Math.max(160, h));
      else addFrame(previous.start);
    } else if (previous.type === "move" || previous.type === "resize") {
      if (previous.saved) {
        updateMembership();
        renderFrames();
        renderSelection();
        persist();
      }
      // Click selection leaves card focus available for Enter and arrow keys.
      if (previous.shape.type) document.querySelector(`[data-id="${previous.shape.id}"]`)?.focus({preventScroll: true});
    } else if (previous.type === "draw") {
      if (previous.stroke.points.length < 2) board.strokes = board.strokes.filter(s => s.id !== previous.stroke.id);
      render();
      persist();
    } else scheduleSave();
  }

  function moveSelected(key, amount) {
    const shape = board.items.find(item => item.id === selected) || board.frames.find(frame => frame.id === selected);
    if (!shape) return false;
    const dx = key === "ArrowRight" ? amount : key === "ArrowLeft" ? -amount : 0;
    const dy = key === "ArrowDown" ? amount : key === "ArrowUp" ? -amount : 0;
    checkpoint();
    shape.x = clamp(shape.x + dx, -100000, 100000);
    shape.y = clamp(shape.y + dy, -100000, 100000);
    for (const item of board.items.filter(item => item.frameId === shape.id)) {
      item.x = clamp(item.x + dx, -100000, 100000); item.y = clamp(item.y + dy, -100000, 100000);
    }
    updateMembership();
    render();
    const selectedNode = document.querySelector(`[data-id="${shape.id}"]`);
    (shape.type ? selectedNode : selectedNode?.querySelector(".frame-header"))?.focus({preventScroll: true});
    persist();
    return true;
  }

  function keyboard(event) {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "o") {
      event.preventDefault(); persist(); bridge.hideCanvas(); return;
    }
    if (isTyping(event.target) || document.querySelector("dialog[open]")) return;
    if (!$("radial").hidden) {
      if (event.key === "Escape") { hideRadial(); viewport.focus(); event.preventDefault(); }
      if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
        const buttons = [...$("radial").querySelectorAll("button:not(:disabled)")];
        const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
        buttons[(buttons.indexOf(document.activeElement) + step + buttons.length) % buttons.length].focus();
        event.preventDefault();
      }
      return;
    }
    if (event.key === "Escape") {
      bridge.closePeek();
      setTool("select");
      select(null);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault(); undo(); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === " ") { event.preventDefault(); spaceHeld = true; viewport.classList.add("panning"); return; }
    if (["Delete", "Backspace"].includes(event.key) && selected) { event.preventDefault(); removeSelection(); return; }
    if (event.key.startsWith("Arrow") && moveSelected(event.key, event.shiftKey ? 64 : 16)) { event.preventDefault(); return; }
    const next = {v: "select", h: "hand", n: "note", f: "frame", c: "connect", d: "draw"}[event.key.toLowerCase()];
    if (next) { event.preventDefault(); setTool(next); }
    if (event.key === "0") fit();
    if (["+", "="].includes(event.key)) zoomAt(1.15);
    if (event.key === "-") zoomAt(1 / 1.15);
  }

  async function start() {
    if (!bridge) {
      $("save-status").textContent = "Native browser bridge unavailable";
      toast("Open Orbit Canvas using this browser’s canvas button.");
      document.querySelectorAll("button").forEach(node => { node.disabled = true; });
      return;
    }
    try {
      const saved = await bridge.getBoard();
      if (saved) board = saved;
      nativeTabs = await bridge.listTabs();
      if (!saved && nativeTabs.length) {
        nativeTabs.slice(0, 500).forEach((tab, index) => board.items.push({id: id(), type: "tab", x: index % 3 * 276,
          y: Math.floor(index / 3) * 188, w: 248, h: 160, title: tabTitle(tab),
          url: webURL(tab.url), tabId: tab.id, userContextId: tab.userContextId || 0}));
      }
      render();
      if (!saved && board.items.length) fit();
      persist();
      unsubscribe = bridge.subscribe(() => refreshTabs().catch(report));
    } catch (error) { report(error); }
  }

  document.querySelectorAll("[data-tool]").forEach(node => node.addEventListener("click", () => setTool(node.dataset.tool)));
  $("add-tab").addEventListener("click", () => showAdd());
  $("empty-add").addEventListener("click", () => showAdd());
  $("return-browser").addEventListener("click", () => { persist(); bridge.hideCanvas(); });
  $("guide-button").addEventListener("click", () => $("guide").showModal());
  $("import-tabs").addEventListener("click", async () => {
    try { await refreshTabs(true); updateMembership(); render(); fit(); persist(); }
    catch (error) { report(error); }
  });
  $("sidebar-frame").addEventListener("click", () => { setTool("frame"); viewport.focus(); });
  $("undo").addEventListener("click", undo);
  for (const key of ["fit", "zoom-value", "fit-nav"]) $(key).addEventListener("click", () => fit());
  $("zoom-in").addEventListener("click", () => zoomAt(1.15));
  $("zoom-out").addEventListener("click", () => zoomAt(1 / 1.15));
  document.querySelectorAll(".close-dialog").forEach(node => node.addEventListener("click", () => node.closest("dialog").close()));
  $("tab-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    try {
      if (board.items.length >= 500) throw new Error("This workspace has reached its 500 card limit.");
      const url = webURL(form.elements.url.value);
      submit.disabled = true;
      const tab = await bridge.openTab({url, background: true});
      const frame = board.frames.find(f => f.id === form.elements.frame.value);
      const frameItems = frame ? board.items.filter(item => item.frameId === frame.id) : [];
      const p = frame ? {x: frame.x + 20 + frameItems.length % 2 * 268, y: frame.y + 20 + Math.floor(frameItems.length / 2) * 180} : pendingAddPoint;
      checkpoint();
      const item = {id: id(), type: "tab", x: clamp(p.x, -100000, 100000), y: clamp(p.y, -100000, 100000), w: 248, h: 160,
        url, title: tabTitle(tab), tabId: tab.id, userContextId: tab.userContextId || 0};
      board.items.push(item);
      if (frame) {
        frame.w = Math.max(frame.w, item.x + item.w - frame.x + 20);
        frame.h = Math.max(frame.h, item.y + item.h - frame.y + 20);
      }
      updateMembership();
      select(item.id);
      $("tab-dialog").close();
      form.reset();
      render();
      persist();
      toast("Real Firefox tab added to canvas");
    } catch (error) {
      $("url-error").textContent = error.message || "This website could not be opened.";
      $("url-error").hidden = false;
    } finally { submit.disabled = false; }
  });
  $("radial").addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    hideRadial();
    if (action === "note") addNote(radialPoint);
    if (action === "tab") showAdd(radialPoint);
    if (action === "frame") { checkpoint(); addFrame(radialPoint); }
    if (action === "connect") {
      const item = board.items.find(i => i.id === selected);
      setTool("connect");
      if (item) connectTo(item);
    }
    if (action === "peek") {
      const item = board.items.find(i => i.id === selected && i.type === "tab");
      if (item) tabAction(item, "peek");
    }
    if (action === "delete") removeSelection();
  });
  viewport.addEventListener("contextmenu", showRadial);
  viewport.addEventListener("pointerdown", pointerDown);
  viewport.addEventListener("pointermove", pointerMove);
  viewport.addEventListener("pointerup", pointerUp);
  viewport.addEventListener("pointercancel", pointerUp);
  viewport.addEventListener("wheel", event => {
    if (event.target.closest("textarea")) return;
    event.preventDefault();
    hideRadial();
    if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * .006), event.clientX, event.clientY);
    else {
      const factor = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      board.camera.x = clamp(board.camera.x - (event.shiftKey ? event.deltaY : event.deltaX) * factor, -100000, 100000);
      board.camera.y = clamp(board.camera.y - (event.shiftKey ? 0 : event.deltaY) * factor, -100000, 100000);
      applyCamera();
      scheduleSave();
    }
  }, {passive: false});
  document.addEventListener("keydown", keyboard);
  document.addEventListener("keyup", event => {
    if (event.key === " ") { spaceHeld = false; if (!drag) viewport.classList.remove("panning"); }
  });
  document.addEventListener("pointerdown", event => { if (!event.target.closest("#radial") && !viewport.contains(event.target)) hideRadial(); });
  window.addEventListener("blur", () => { spaceHeld = false; viewport.classList.remove("panning"); });
  window.addEventListener("pagehide", () => { if (bridge) persist(); unsubscribe?.(); });
  start();
})();
