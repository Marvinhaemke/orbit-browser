/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Keep every command reachable without putting more than eight sectors in a
 * ring. A More branch is a real submenu, so this works at every nesting level. */
export function pageRadialItems(items, depth = 0) {
  const nodes = items.filter(item => item && typeof item.id === "string");
  if (nodes.length <= 8) return nodes;
  return [...nodes.slice(0, 7), {
    id: `orbit-more-${depth}-${nodes.length - 7}`,
    label: `More (${nodes.length - 7})`,
    icon: "•••",
    children: nodes.slice(7),
    orbitSynthetic: true,
  }];
}

/** Pure geometry, also used by the actor's release hit test. All units are
 * viewport CSS pixels. parentIndices identifies each opening sector in the
 * preceding ring; its midpoint anchors a partial fan. Omitted parents retain
 * standalone full rings. Small windows shrink ring widths instead of clipping. */
export function layoutRadialRings({width, height, center, counts, parentIndices = []}) {
  const available = Math.max(1, Math.min(width, height) / 2 - 10);
  const count = Math.max(1, counts.length);
  const gap = Math.min(5, available / (count * 6));
  const centerRadius = Math.min(53, Math.max(8, available * .29));
  const contentSpace = Math.max(.25, available - centerRadius - gap * count);
  const olderCount = count > 4 && contentSpace / count < 60 ? count - 3 : 0;
  const olderWidth = olderCount ? Math.min(24, contentSpace * .25 / olderCount) : 0;
  const ringWidth = Math.max(.25, Math.min(78, (contentSpace - olderCount * olderWidth) / (count - olderCount)));
  const widths = counts.map((_, depth) => depth < olderCount ? olderWidth : ringWidth);
  const radius = Math.min(available, centerRadius + widths.reduce((sum, width) => sum + width + gap, 0));
  // Reserve space for the next ring on the initial view, reducing movement
  // when a submenu opens near a viewport edge.
  const placementRadius = Math.max(radius, Math.min(214, available));
  const insetX = Math.min(placementRadius + 8, width / 2);
  const insetY = Math.min(placementRadius + 8, height / 2);
  const x = clamp(center.x, insetX, Math.max(insetX, width - insetX));
  const y = clamp(center.y, insetY, Math.max(insetY, height - insetY));
  const rings = [];
  for (const [depth, sectors] of counts.entries()) {
    const inner = centerRadius + gap + widths.slice(0, depth).reduce((sum, width) => sum + width + gap, 0);
    const outer = Math.min(radius, inner + widths[depth]);
    const parent = rings[depth - 1]?.sectors[parentIndices[depth - 1]];
    const fan = !!parent;
    const anchor = parent?.angle ?? -Math.PI / 2;
    // An outer menu opens immediately beyond its parent. About 76 px of arc
    // per option keeps labels readable, with a 160-degree cap so no command
    // requires travelling around the opposite side of the menu.
    const span = fan ? Math.min(TAU * 4 / 9,
      Math.max(1, sectors) * clamp(76 / ((inner + outer) / 2), Math.PI / 18, Math.PI / 4)) : TAU;
    const sectorAngle = span / Math.max(1, sectors);
    const start = fan ? anchor - span / 2 : anchor - sectorAngle / 2;
    const insetAngle = Math.min(.028, sectorAngle / 12);
    const orbitRadius = (inner + outer) / 2;
    const neighborDistance = sectors > 1 ? 2 * orbitRadius * Math.sin(sectorAngle / 2) : Infinity;
    // Separate sculpted buttons share the canvas menu's circular shape. The
    // Euclidean chord, rather than arc length, prevents adjacent fan buttons
    // overlapping. Radial insets also keep different generations separate.
    const targetRadius = Math.max(.125, Math.min(33, (outer - inner) / 2 - 5, neighborDistance / 2 - 4));
    rings.push({depth, count: sectors, inner, outer, fan, anchor, span, start, end: start + span,
      sectorAngle, insetAngle, orbitRadius, targetRadius,
      sectors: Array.from({length: sectors}, (_, index) => {
        const angle = start + (index + .5) * sectorAngle;
        return {index, angle, targetRadius,
          x: x + Math.cos(angle) * orbitRadius, y: y + Math.sin(angle) * orbitRadius,
          start: start + index * sectorAngle + insetAngle,
          end: start + (index + 1) * sectorAngle - insetAngle,
        };
      }),
    });
  }
  return {center: {x, y}, radius, centerRadius, ringWidth, gap, rings};
}

export function radialSectorPath(cx, cy, inner, outer, start, end) {
  const at = (radius, angle) => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
  const a = at(outer, start), b = at(outer, end), c = at(inner, end), d = at(inner, start);
  const large = end - start > Math.PI ? 1 : 0;
  // Avoid the coincident start/end points of a full-circle SVG arc.
  if (end - start >= TAU - .0001) {
    const middle = at(outer, start + Math.PI), imiddle = at(inner, start + Math.PI);
    return `M ${a} A ${outer} ${outer} 0 1 1 ${middle} A ${outer} ${outer} 0 1 1 ${b} L ${c} A ${inner} ${inner} 0 1 0 ${imiddle} A ${inner} ${inner} 0 1 0 ${d} Z`;
  }
  return `M ${a} A ${outer} ${outer} 0 ${large} 1 ${b} L ${c} A ${inner} ${inner} 0 ${large} 0 ${d} Z`;
}

/** Returns {depth,index} or {center:true}. Only the painted circular buttons
 * accept release; the soft disc/fan backing and every gap return null. */
export function hitRadialGeometry(geometry, x, y) {
  const dx = x - geometry.center.x, dy = y - geometry.center.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= geometry.centerRadius) return {center: true};
  const ring = geometry.rings.find(candidate => distance >= candidate.inner && distance <= candidate.outer);
  if (!ring || !ring.count) return null;
  const sector = ring.sectors.find(candidate => Math.hypot(x - candidate.x, y - candidate.y) <= candidate.targetRadius);
  return sector ? {depth: ring.depth, index: sector.index} : null;
}

function visualLabel(node) {
  // Compact visual wording leaves room for the circular surface. The full
  // native Fluent label remains in the accessible name and SVG title.
  const labels = {
    "context-openlink": "New window",
    "context-openlinkprivate": "Private window",
    "context-openlinkinusercontext-menu": "Container tab",
    "context-openlinkinsplitview": "Split view",
    "context-savelink": "Save link",
    "context-copylink": "Copy link",
    "context-copyimage": "Image link",
    "context-saveimage": "Save image",
    "context-viewimage": "View image",
    "context-viewimageinfo": "Image info",
    "context-selectall": "Select all",
    "context-viewsource": "Page source",
    "context-inspect": "Inspect",
  };
  return labels[node.id] || node.label;
}

function safeImage(icon) {
  if (typeof icon !== "string" || icon.length > 65536) return null;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(icon)) return icon;
  if (/^chrome:\/\/(?:browser|global)\/skin\/[a-z\d/_.,@-]+(?:\.svg|\.png)$/i.test(icon)) return icon;
  return null;
}

function iconText(node) {
  const icon = typeof node.icon === "string" ? node.icon : "";
  if (icon && !/[:/<>]/.test(icon) && icon.length <= 12) return icon;
  if (node.checked) return "✓";
  if (node.children?.length) return "▦";
  return String(node.label || "•").trim().slice(0, 1).toUpperCase();
}

function glyphPath(node) {
  const paths = {
    "＋": "M12 5v14M5 12h14", "+": "M12 5v14M5 12h14",
    "←": "M19 12H5m6-6-6 6 6 6", "→": "M5 12h14m-6-6 6 6-6 6",
    "↻": "M19 8a8 8 0 1 0 1 7M19 3v5h-5",
    "☆": "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z",
    "↓": "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
    "↗": "M8 5H4v15h15v-4M10 14 20 4m-7 0h7v7",
    "▤": "M4 4h16v16H4ZM8 8h8M8 12h8M8 16h5",
    "▣": "M4 4h16v16H4ZM8 8h8v8H8Z",
    "▦": "M4 4h16v16H4ZM12 4v16M4 12h16",
    "◉": "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
    "✧": "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
    "✓": "m5 12 4 4L19 6",
    "⌖": "M12 3v4M12 17v4M3 12h4M17 12h4M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z",
    "•••": "M5 11v2M12 11v2M19 11v2",
  };
  const explicit = paths[iconText(node)];
  if (explicit) return explicit;
  const nativeID = String(node.id || "");
  const key = /(?:^|-)back$/.test(nativeID) ? "←" : /forward$/.test(nativeID) ? "→" :
    /reload$/.test(nativeID) ? "↻" : /bookmark/.test(nativeID) ? "☆" :
      /new-tab|openlinkintab/.test(nativeID) ? "＋" : /save/.test(nativeID) ? "↓" :
        /send|openlink/.test(nativeID) ? "↗" : node.children?.length ? "▦" : null;
  return paths[key] || null;
}

function shortLines(value, limit) {
  const words = String(value || "").trim().split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const index = lines.length - 1;
    if (lines[index] && (lines[index] + " " + word).length > limit && lines.length < 2) lines.push(word);
    else lines[index] += `${lines[index] ? " " : ""}${word}`;
  }
  return lines.slice(0, 2).map(line => line.length > limit ? `${line.slice(0, Math.max(1, limit - 1))}…` : line);
}

export class OrbitRadialView {
  constructor(win, {idPrefix = "orbit-radial", caption = null} = {}) {
    if (!/^[a-z][a-z\d-]*$/i.test(idPrefix)) throw new TypeError("Invalid radial view ID prefix");
    this.win = win;
    this.doc = win.document;
    this.idPrefix = idPrefix;
    this.gradientPrefix = idPrefix === "orbit-radial" ? "orbit" : idPrefix;
    this.menuCaption = caption;
    this.root = null;
    this.panel = null;
    this.caption = null;
    this.model = null;
    this.path = [];
    this.rings = [];
    this.geometry = null;
    this.active = null;
    this.hoverTimer = null;
    this.hideTimer = null;
    this.cleanups = [];
    this.ringSignatures = [];
  }

  _html(tag, className, text) {
    const node = this.doc.createElementNS(HTML_NS, tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  _svg(tag, attributes = {}) {
    const node = this.doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  _icon(node, x, y, size = 18) {
    const path = glyphPath(node);
    if (!path) return null;
    const svg = this._svg("svg", {x: x - size / 2, y: y - size / 2, width: size, height: size,
      viewBox: "0 0 24 24", class: "orbit-radial-vector-icon", "aria-hidden": "true"});
    svg.append(this._svg("path", {d: path, fill: "none", "stroke-width": "1.6",
      "stroke-linecap": "round", "stroke-linejoin": "round"}));
    return svg;
  }

  _listen(node, event, callback, options) {
    node.addEventListener(event, callback, options);
    this.cleanups.push(() => node.removeEventListener(event, callback, options));
  }

  _emit(name, ...args) {
    try { this.model?.[name]?.(...args); }
    catch (error) { console.error(`Orbit radial ${name}:`, error); }
  }

  _toViewport(point) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
    return {x: point.screenX - (this.win.mozInnerScreenX ?? this.win.screenX ?? 0),
      y: point.screenY - (this.win.mozInnerScreenY ?? this.win.screenY ?? 0)};
  }

  _mount() {
    if (this.root) return;
    let sheet = this.doc.getElementById("orbit-radial-styles");
    if (!sheet) {
      sheet = this._html("link");
      sheet.id = "orbit-radial-styles";
      sheet.rel = "stylesheet";
      sheet.href = "chrome://browser/content/orbit/orbit-radial.css";
      this.doc.documentElement.append(sheet);
    }
    this.root = this._html("div", "orbit-radial-root");
    this.root.id = `${this.idPrefix}-root`;
    for (const name of ["surface", "base", "active"]) {
      this.root.style.setProperty(`--orbit-gradient-${name}`, `url(#${this.gradientPrefix}-gradient-${name})`);
    }
    this.panel = this._html("div", "orbit-radial-menu");
    this.panel.id = `${this.idPrefix}-menu`;
    this.panel.tabIndex = 0;
    this.panel.setAttribute("role", "menu");
    this.panel.setAttribute("aria-label", "Orbit radial menu");
    this.caption = this._html("div", "orbit-radial-command-label");
    this.caption.id = `${this.idPrefix}-command-label`;
    this.caption.setAttribute("aria-hidden", "true");
    this.caption.hidden = true;
    this.root.append(this.panel, this.caption);
    this.doc.documentElement.append(this.root);
    this._listen(this.panel, "pointermove", event => this.updatePointer(event.screenX, event.screenY));
    this._listen(this.panel, "pointerleave", () => {
      if (!this.model?.passthrough) this.win.clearTimeout(this.hoverTimer);
    });
    this._listen(this.panel, "pointerup", event => {
      if (this.model?.passthrough || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.activateAt(event.screenX, event.screenY, event);
    });
    this._listen(this.panel, "contextmenu", event => event.preventDefault());
    this._listen(this.win, "pointerdown", event => {
      if (!this.model?.passthrough && !this.root?.contains(event.target)) this.hide("outside");
    }, true);
    this._listen(this.win, "blur", () => this.hide("blur"));
    this._listen(this.win, "resize", () => this._render());
    this._listen(this.win, "keydown", event => this._keyboard(event), true);
  }

  show(model) {
    if (!model || !Array.isArray(model.items)) throw new TypeError("Orbit radial menu requires items");
    const hadMenu = !!this.root;
    this.win.clearTimeout(this.hideTimer);
    this.win.clearTimeout(this.hoverTimer);
    this.model = {...model};
    this.path = [];
    this.active = null;
    this.ringSignatures = [];
    this._mount();
    this.root.classList.remove("orbit-radial-leaving");
    this.root.classList.toggle("orbit-radial-held", model.passthrough === true);
    this.root.dataset.mode = model.mode || "context";
    this.root.classList.toggle("orbit-radial-morph", hadMenu);
    this._render();
    if (!model.passthrough && model.focus !== false) this.panel.focus({preventScroll: true});
    this.win.requestAnimationFrame(() => this.root?.classList.add("orbit-radial-visible"));
    if (hadMenu) this.win.setTimeout(() => this.root?.classList.remove("orbit-radial-morph"), 180);
    return this;
  }

  setMode(mode) {
    if (!this.model) return;
    this.model.mode = mode;
    this.root.dataset.mode = mode;
  }

  setPassthrough(value) {
    if (!this.model || !this.root) return;
    this.model.passthrough = value === true;
    this.root.classList.toggle("orbit-radial-held", this.model.passthrough);
    if (!this.model.passthrough) this.panel.focus({preventScroll: true});
  }

  refresh(update = {}) {
    if (!this.model) return;
    if (update.items !== undefined) {
      if (!Array.isArray(update.items)) throw new TypeError("Orbit radial refresh requires an item array");
      this.model.items = update.items;
    }
    if (update.centerItem !== undefined) this.model.centerItem = update.centerItem;
    let nodes = this.model.items;
    const path = [];
    for (const [depth, previous] of this.path.entries()) {
      const current = pageRadialItems(nodes, depth).find(node => node.id === previous.id);
      if (!current?.children?.length) break;
      path.push(current);
      nodes = current.children;
    }
    this.path = path;
    this._render();
    if (this.active?.depth >= 0) {
      const nodes = this.rings[this.active.depth] || [];
      const index = nodes.findIndex(node => node.id === this.active.node.id);
      this.active = index >= 0 ? {node: nodes[index], depth: this.active.depth, index} : null;
      this._paintActive();
    }
  }

  _render() {
    if (!this.model || !this.panel) return;
    this.rings = [pageRadialItems(this.model.items, 0)];
    for (const [depth, parent] of this.path.entries()) {
      this.rings.push(pageRadialItems(parent.children || [], depth + 1));
    }
    const requested = this._toViewport(this.model.center || {x: this.win.innerWidth / 2, y: this.win.innerHeight / 2});
    this.geometry = layoutRadialRings({width: this.win.innerWidth, height: this.win.innerHeight,
      center: requested, counts: this.rings.map(ring => ring.length),
      parentIndices: this.path.map((parent, depth) => this.rings[depth].findIndex(node => node.id === parent.id))});
    const geometry = this.geometry;
    const size = Math.ceil(geometry.radius * 2 + 8);
    const localCenter = size / 2;
    this.panel.style.left = `${geometry.center.x - localCenter}px`;
    this.panel.style.top = `${geometry.center.y - localCenter}px`;
    this.panel.style.width = `${size}px`;
    this.panel.style.height = `${size}px`;
    this.panel.dataset.orbitCenterX = geometry.center.x;
    this.panel.dataset.orbitCenterY = geometry.center.y;
    this.root.style.setProperty("--orbit-menu-left", `${geometry.center.x - localCenter}px`);
    this.root.style.setProperty("--orbit-menu-top", `${geometry.center.y - localCenter}px`);
    this.root.style.setProperty("--orbit-menu-size", `${size}px`);
    this.panel.style.setProperty("--orbit-center-size", `${geometry.centerRadius * 2}px`);
    this.panel.style.setProperty("--orbit-ring-count", this.rings.length);
    const svg = this._svg("svg", {viewBox: `0 0 ${size} ${size}`, width: size, height: size,
      class: "orbit-radial-svg", "aria-hidden": "true"});
    // Children carry the accessible command labels; the SVG is decorative
    // when keyboard focus remains on the menu container.
    svg.removeAttribute("aria-hidden");
    const defs = this._svg("defs");
    for (const [name, first, second] of [["surface", "--orbit-surface-a", "--orbit-surface-b"],
      ["base", "--orbit-sector-a", "--orbit-sector-b"],
      ["active", "--orbit-active-a", "--orbit-active-b"]]) {
      const gradient = this._svg("linearGradient", {id: `${this.gradientPrefix}-gradient-${name}`, x1: "0", y1: "0", x2: "1", y2: "1"});
      const start = this._svg("stop", {offset: "0%"});
      start.style.setProperty("stop-color", `var(${first})`);
      const end = this._svg("stop", {offset: "100%"});
      end.style.setProperty("stop-color", `var(${second})`);
      gradient.append(start, end); defs.append(gradient);
    }
    svg.append(defs);
    // One soft canvas material supports the root and its outward fans. This
    // entire backing is decorative: even its visible blank space passes input
    // through to the real page underneath.
    const backing = this._svg("g", {class: "orbit-radial-backing", "pointer-events": "none", "aria-hidden": "true"});
    backing.append(this._svg("circle", {cx: localCenter, cy: localCenter,
      r: (geometry.rings[0]?.outer || geometry.centerRadius) + 7,
      class: "orbit-radial-disc", "pointer-events": "none"}));
    svg.append(backing);
    const signatures = [];
    for (const [depth, nodes] of this.rings.entries()) {
      const ring = geometry.rings[depth];
      const signature = `${ring.start}:${ring.span}\n${nodes.map(node => node.id).join("\n")}`;
      signatures.push(signature);
      const stable = this.ringSignatures[depth] === signature;
      const ringGroup = this._svg("g", {class: `orbit-radial-ring${ring.fan ? " orbit-radial-fan" : ""}${stable ? " orbit-radial-stable" : ""}`,
        "data-orbit-depth": depth, "data-orbit-anchor": ring.anchor, "data-orbit-span": ring.span,
        "data-orbit-start": ring.start, "data-orbit-end": ring.end, "data-orbit-inner": ring.inner,
        "data-orbit-outer": ring.outer});
      if (ring.fan) {
        ringGroup.style.setProperty("--orbit-fan-angle", `${ring.anchor * 180 / Math.PI}deg`);
        ringGroup.style.setProperty("--orbit-fan-span", `${ring.span * 180 / Math.PI}deg`);
        ringGroup.style.transformOrigin = `${localCenter + Math.cos(ring.anchor) * ring.inner}px ${localCenter + Math.sin(ring.anchor) * ring.inner}px`;
        const surface = this._svg("g", {class: `orbit-radial-backing-fan${stable ? " orbit-radial-stable" : ""}`,
          "pointer-events": "none", "aria-hidden": "true"});
        surface.style.transformOrigin = ringGroup.style.transformOrigin;
        const first = ring.sectors[0], last = ring.sectors.at(-1);
        if (first && last) {
          if (nodes.length === 1) {
            surface.append(this._svg("circle", {cx: localCenter + Math.cos(first.angle) * ring.orbitRadius,
              cy: localCenter + Math.sin(first.angle) * ring.orbitRadius, r: (ring.outer - ring.inner) / 2 + 7,
              class: "orbit-radial-disc", "pointer-events": "none"}));
          } else {
            const sx = localCenter + Math.cos(first.angle) * ring.orbitRadius;
            const sy = localCenter + Math.sin(first.angle) * ring.orbitRadius;
            const ex = localCenter + Math.cos(last.angle) * ring.orbitRadius;
            const ey = localCenter + Math.sin(last.angle) * ring.orbitRadius;
            surface.append(this._svg("path", {d: `M ${sx} ${sy} A ${ring.orbitRadius} ${ring.orbitRadius} 0 0 1 ${ex} ${ey}`,
              "stroke-width": ring.outer - ring.inner + 14, "stroke-linecap": "round",
              class: "orbit-radial-fan-surface", "pointer-events": "none"}));
          }
        }
        backing.append(surface);
      }
      nodes.forEach((node, index) => {
        const sector = ring.sectors[index];
        const angle = sector.angle;
        const g = this._svg("g", {class: "orbit-radial-sector", role: "menuitem", tabindex: "-1",
          id: `${this.idPrefix}-option-${depth}-${index}`,
          "aria-label": String(node.label || node.id), "aria-disabled": String(!!node.disabled),
          "data-orbit-id": node.id, "data-orbit-depth": depth, "data-orbit-index": index});
        g.setAttribute("data-orbit-angle", angle);
        g.setAttribute("data-orbit-start", sector.start);
        g.setAttribute("data-orbit-end", sector.end);
        g.style.setProperty("--orbit-stagger", `${Math.min(8, depth * 2 + index) * 12}ms`);
        if (node.disabled) g.classList.add("orbit-radial-disabled");
        if (node.checked) g.classList.add("orbit-radial-checked");
        if (this.path[depth]?.id === node.id) g.classList.add("orbit-radial-parent");
        const r = ring.orbitRadius;
        const x = localCenter + Math.cos(angle) * r;
        const y = localCenter + Math.sin(angle) * r;
        const border = Math.min(1, sector.targetRadius);
        const shape = this._svg("circle", {cx: x, cy: y, r: sector.targetRadius - border / 2,
          class: "orbit-radial-sector-shape orbit-radial-option-surface"});
        shape.style.setProperty("stroke-width", border);
        g.append(shape);
        g.setAttribute("data-orbit-x", sector.x);
        g.setAttribute("data-orbit-y", sector.y);
        g.setAttribute("data-orbit-radius", sector.targetRadius);
        g.setAttribute("data-orbit-inner", ring.inner);
        g.setAttribute("data-orbit-outer", ring.outer);
        const compact = sector.targetRadius < 20;
        const imageURL = safeImage(node.favicon || node.icon);
        if (imageURL && !compact) {
          g.append(this._svg("image", {href: imageURL, x: x - 9, y: y - 23, width: 18, height: 18, class: "orbit-radial-icon-image"}));
        } else if (sector.targetRadius > 6) {
          const vector = this._icon(node, x, compact ? y : y - 15);
          if (vector) g.append(vector);
          else {
            const icon = this._svg("text", {x, y: compact ? y + 4 : y - 7, class: "orbit-radial-icon", "text-anchor": "middle"});
            icon.textContent = iconText(node); g.append(icon);
          }
        }
        if (!compact) {
          const limit = clamp(Math.floor((sector.targetRadius * 2 - 12) / 5.7), 4, 10);
          shortLines(visualLabel(node), limit).forEach((line, lineIndex) => {
            const label = this._svg("text", {x, y: y + 9 + lineIndex * 12, class: "orbit-radial-label", "text-anchor": "middle"});
            label.textContent = line; g.append(label);
          });
        }
        if (node.children?.length) {
          const arrow = this._svg("text", {x: x + Math.cos(angle) * (sector.targetRadius - 5),
            y: y + Math.sin(angle) * (sector.targetRadius - 5) + 3,
            class: "orbit-radial-submenu-mark", "text-anchor": "middle"});
          arrow.textContent = "·"; g.append(arrow);
          g.setAttribute("aria-haspopup", "menu");
          g.setAttribute("aria-expanded", String(this.path[depth]?.id === node.id));
        }
        const title = this._svg("title"); title.textContent = String(node.label || node.id); g.append(title);
        ringGroup.append(g);
      });
      svg.append(ringGroup);
    }
    this.ringSignatures = signatures;
    const center = this._html("button", "orbit-radial-center");
    center.id = `${this.idPrefix}-center`;
    center.type = "button";
    center.tabIndex = -1;
    center.disabled = !!this.model.centerItem?.disabled;
    center.dataset.orbitId = this.model.centerItem?.id || "orbit-center";
    center.dataset.orbitX = geometry.center.x;
    center.dataset.orbitY = geometry.center.y;
    center.setAttribute("aria-label", this.model.centerItem?.label || "Orbit");
    const centerIcon = this._icon(this.model.centerItem || {icon: "◉"}, 13, 13, 26) ||
      this._html("span", "orbit-radial-center-icon", this.model.centerItem ? iconText(this.model.centerItem) : "◉");
    centerIcon.classList.add("orbit-radial-center-icon");
    center.append(centerIcon, this._html("span", "orbit-radial-center-label", this.model.centerItem?.label || "Orbit"));
    const caption = this._html("div", "orbit-radial-caption", this.path.length > 3 ? `DEPTH ${this.path.length + 1}` : this.menuCaption || (this.model.mode === "tabs" ? "YOUR OPEN TABS" : "PAGE ACTIONS"));
    caption.setAttribute("aria-hidden", "true");
    this.panel.replaceChildren(svg, center, caption);
    this._positionCaption();
    this._paintActive();
  }

  _positionCaption() {
    if (!this.caption || !this.geometry) return;
    const {width, height} = {width: this.win.innerWidth, height: this.win.innerHeight};
    const {center, radius, centerRadius, rings} = this.geometry;
    const labelWidth = Math.min(360, Math.max(1, width - 32));
    const reserveHeight = Math.min(112, Math.max(1, height - 32));
    const rootRadius = rings[0]?.outer || centerRadius;
    const circles = [{x: center.x, y: center.y, targetRadius: centerRadius}, ...rings.flatMap(ring => ring.sectors)];
    const locations = [
      [center.x - labelWidth / 2, center.y + rootRadius + 20],
      [center.x - labelWidth / 2, center.y - rootRadius - 20 - reserveHeight],
      [center.x - labelWidth / 2, center.y + radius + 20],
      [center.x - labelWidth / 2, center.y - radius - 20 - reserveHeight],
      [16, 16], [width - labelWidth - 16, 16],
      [16, height - reserveHeight - 16], [width - labelWidth - 16, height - reserveHeight - 16],
    ];
    // A fixed caption box lets long native command names and tab titles stay
    // legible without remounting or moving command circles on every hover.
    // Prefer the root's edge, then a clear viewport corner for deeper fans.
    let best = null;
    for (const [left, top] of locations) {
      const x = clamp(left, 16, Math.max(16, width - labelWidth - 16));
      const y = clamp(top, 16, Math.max(16, height - reserveHeight - 16));
      const overlaps = circles.filter(circle => {
        const dx = Math.max(x - circle.x, 0, circle.x - (x + labelWidth));
        const dy = Math.max(y - circle.y, 0, circle.y - (y + reserveHeight));
        return Math.hypot(dx, dy) < circle.targetRadius + 8;
      }).length;
      if (!best || overlaps < best.overlaps) best = {x, y, overlaps};
      if (!overlaps) break;
    }
    this.caption.style.left = `${best.x}px`;
    this.caption.style.top = `${best.y}px`;
    this.caption.style.width = `${labelWidth}px`;
    this.caption.style.maxHeight = `${Math.max(1, height - best.y - 16)}px`;
  }

  hitTest(screenX, screenY) {
    if (!this.geometry || !this.model) return null;
    const position = this._toViewport(typeof screenX === "object" ? screenX : {screenX, screenY});
    const hit = hitRadialGeometry(this.geometry, position.x, position.y);
    return hit?.center ? (this.model.centerItem || null) : hit ? (this.rings[hit.depth]?.[hit.index] || null) : null;
  }

  updatePointer(screenX, screenY) {
    if (!this.model || !this.geometry) return null;
    const position = this._toViewport(typeof screenX === "object" ? screenX : {screenX, screenY});
    const hit = hitRadialGeometry(this.geometry, position.x, position.y);
    if (!hit) { this.win.clearTimeout(this.hoverTimer); return null; }
    const node = hit.center ? this.model.centerItem : this.rings[hit.depth]?.[hit.index];
    if (!node) return null;
    if (this.active?.node.id !== node.id || this.active?.depth !== hit.depth) {
      this.active = {node, depth: hit.center ? -1 : hit.depth, index: hit.index ?? -1};
      this._paintActive();
      this._emit("onHover", node);
      this.win.clearTimeout(this.hoverTimer);
      if (!node.disabled && !hit.center) {
        const depth = hit.depth;
        const sameParent = this.path[depth]?.id === node.id;
        if (!sameParent) {
          this.hoverTimer = this.win.setTimeout(() => {
            if (this.active?.node.id !== node.id) return;
            const current = this.active.node;
            this.path = this.path.slice(0, depth);
            if (current.children?.length) this.path.push(current);
            this._render();
          }, node.children?.length ? 90 : 145);
        }
      }
    }
    return node;
  }

  _paintActive() {
    if (!this.panel) return;
    for (const sector of this.panel.querySelectorAll(".orbit-radial-sector")) {
      sector.classList.toggle("orbit-radial-active", sector.dataset.orbitId === this.active?.node?.id &&
        Number(sector.dataset.orbitDepth) === this.active?.depth);
    }
    this.panel.querySelector(".orbit-radial-center")?.classList.toggle("orbit-radial-active", this.active?.depth === -1);
    if (this.caption) {
      this.caption.textContent = this.active?.node?.label || "";
      this.caption.hidden = !this.active?.node?.label;
    }
    this.panel.setAttribute("aria-label", this.active?.node?.label ? `Orbit menu: ${this.active.node.label}` : "Orbit radial menu");
    if (this.active?.node) {
      this.panel.setAttribute("aria-activedescendant", this.active.depth === -1 ? `${this.idPrefix}-center` :
        `${this.idPrefix}-option-${this.active.depth}-${this.active.index}`);
    } else this.panel.removeAttribute("aria-activedescendant");
  }

  activateAt(screenX, screenY, event = null) {
    const node = this.updatePointer(screenX, screenY);
    if (node) this._activate(node, event);
    return node;
  }

  _activate(node, event = null) {
    if (node.disabled) return;
    this.win.clearTimeout(this.hoverTimer);
    if (node.children?.length && this.active?.depth >= 0) {
      this.path = this.path.slice(0, this.active.depth);
      this.path.push(node);
      this._render();
      return;
    }
    this._emit("onActivate", node, event);
  }

  _keyboard(event) {
    if (!this.model || !this.root || this.root.classList.contains("orbit-radial-leaving")) return;
    if (this.model.focus === false && !this.root.contains(this.doc.activeElement)) return;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (this.path.length) {
        const parent = this.path.pop();
        this._render();
        const depth = this.rings.length - 1;
        this.active = {node: parent, depth, index: this.rings[depth].findIndex(node => node.id === parent.id)};
        this._paintActive();
      } else this.hide("escape");
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " ", "Home", "Tab"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Enter" || event.key === " ") {
      const target = this.active?.node || this.model.centerItem;
      if (target) this._activate(target, event);
      return;
    }
    if (event.key === "Home") { this.active = this.model.centerItem ? {node: this.model.centerItem, depth: -1, index: -1} : null; this._paintActive(); return; }
    if (event.key === "ArrowUp" && this.path.length) {
      const parent = this.path.pop(); this._render();
      const depth = this.rings.length - 1;
      this.active = {node: parent, depth, index: this.rings[depth].findIndex(node => node.id === parent.id)};
      this._paintActive(); return;
    }
    if (event.key === "ArrowDown" && this.active?.node.children?.length) {
      this._activate(this.active.node);
      const depth = this.rings.length - 1;
      const index = this.rings[depth].findIndex(node => !node.disabled);
      if (index >= 0) this.active = {node: this.rings[depth][index], depth, index};
      this._paintActive(); return;
    }
    const depth = this.active?.depth >= 0 ? this.active.depth : this.rings.length - 1;
    const nodes = this.rings[depth];
    const step = event.key === "ArrowLeft" || event.key === "Tab" && event.shiftKey ? -1 : 1;
    let index = this.active?.depth === depth ? this.active.index : -1;
    for (let attempts = 0; attempts < nodes.length; attempts++) {
      index = (index + step + nodes.length) % nodes.length;
      if (!nodes[index].disabled) break;
    }
    if (nodes[index]) this.active = {node: nodes[index], depth, index};
    this._paintActive();
    this._emit("onHover", this.active?.node);
  }

  hide(reason = "dismiss") {
    if (!this.root || this.root.classList.contains("orbit-radial-leaving")) return;
    this.win.clearTimeout(this.hoverTimer);
    this.root.classList.remove("orbit-radial-visible");
    this.root.classList.add("orbit-radial-leaving", "orbit-radial-held");
    this._emit("onDismiss", reason);
    this.hideTimer = this.win.setTimeout(() => this._remove(), this.win.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  }

  _remove() {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.root?.remove();
    this.root = null; this.panel = null; this.caption = null; this.model = null; this.geometry = null;
    this.path = []; this.rings = []; this.active = null;
    this.ringSignatures = [];
  }

  destroy() {
    this.win.clearTimeout(this.hoverTimer); this.win.clearTimeout(this.hideTimer);
    this._remove();
  }
}
