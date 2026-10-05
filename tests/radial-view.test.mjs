import assert from "node:assert/strict";
import test from "node:test";
import {pageRadialItems, layoutRadialRings, radialSectorPath, hitRadialGeometry}
  from "../overlay/browser/components/orbit/OrbitRadialView.sys.mjs";

test("pagination keeps every original action reachable through bounded rings", () => {
  const source = Array.from({length: 133}, (_, index) => ({id: `native-${index}`, label: `Tab ${index}`}));
  const visited = [];
  let page = source;
  let depth = 0;
  while (page.length) {
    const visible = pageRadialItems(page, depth++);
    assert.ok(visible.length <= 8);
    visited.push(...visible.filter(item => !item.orbitSynthetic));
    page = visible.find(item => item.orbitSynthetic)?.children || [];
  }
  assert.deepEqual(visited, source);
});

test("all ring sectors hit their corresponding original index including angular wrap", () => {
  for (let count = 1; count <= 8; count++) {
    const geometry = layoutRadialRings({width: 1440, height: 960, center: {x: 600, y: 440}, counts: [count, 8, 3]});
    for (const ring of geometry.rings) {
      const radius = (ring.inner + ring.outer) / 2;
      for (let index = 0; index < ring.count; index++) {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / ring.count;
        const hit = hitRadialGeometry(geometry, geometry.center.x + Math.cos(angle) * radius,
          geometry.center.y + Math.sin(angle) * radius);
        assert.deepEqual(hit, {depth: ring.depth, index});
      }
    }
    assert.deepEqual(hitRadialGeometry(geometry, geometry.center.x, geometry.center.y), {center: true});
  }
});

test("submenu fans open around the selected parent, including angles crossing zero", () => {
  for (let parentIndex = 0; parentIndex < 8; parentIndex++) {
    for (let count = 1; count <= 8; count++) {
      const geometry = layoutRadialRings({width: 1440, height: 960, center: {x: 600, y: 440},
        counts: [8, count], parentIndices: [parentIndex]});
      const [root, fan] = geometry.rings;
      assert.equal(root.fan, false);
      assert.equal(fan.fan, true);
      assert.equal(fan.anchor, root.sectors[parentIndex].angle);
      assert.ok(fan.span <= Math.PI * 8 / 9);
      assert.ok(fan.span < Math.PI * 2);
      assert.ok(Math.abs(fan.start + fan.span / 2 - fan.anchor) < 1e-12);
      const radius = (fan.inner + fan.outer) / 2;
      for (const sector of fan.sectors) {
        assert.ok(Math.abs(sector.angle - fan.anchor) < Math.PI / 2);
        assert.deepEqual(hitRadialGeometry(geometry,
          geometry.center.x + Math.cos(sector.angle) * radius,
          geometry.center.y + Math.sin(sector.angle) * radius), {depth: 1, index: sector.index});
      }
    }
  }
});

test("unused outer fan arcs and painted angular separators cannot activate commands", () => {
  const geometry = layoutRadialRings({width: 1280, height: 800, center: {x: 640, y: 400},
    counts: [8, 8, 3], parentIndices: [7, 0]});
  for (const ring of geometry.rings) {
    const radius = (ring.inner + ring.outer) / 2;
    const hitAt = angle => hitRadialGeometry(geometry,
      geometry.center.x + Math.cos(angle) * radius,
      geometry.center.y + Math.sin(angle) * radius);
    assert.equal(hitAt(ring.start), null);
    for (let index = 1; index < ring.count; index++) {
      assert.equal(hitAt((ring.sectors[index - 1].end + ring.sectors[index].start) / 2), null);
    }
    if (ring.fan) {
      assert.equal(hitAt(ring.anchor + Math.PI), null);
      assert.equal(hitAt(ring.start - .1), null);
      assert.equal(hitAt(ring.end + .1), null);
    }
  }
});

test("each deeper fan inherits its actual parent midpoint rather than the root orientation", () => {
  const parents = [6, 0, 7, 2];
  const geometry = layoutRadialRings({width: 1600, height: 1000, center: {x: 800, y: 500},
    counts: [8, 8, 8, 8, 4], parentIndices: parents});
  for (let depth = 1; depth < geometry.rings.length; depth++) {
    const ring = geometry.rings[depth];
    const parent = geometry.rings[depth - 1].sectors[parents[depth - 1]];
    assert.equal(ring.anchor, parent.angle);
    assert.notEqual(ring.anchor, -Math.PI / 2);
    const radius = (ring.inner + ring.outer) / 2;
    for (const sector of ring.sectors) {
      assert.deepEqual(hitRadialGeometry(geometry,
        geometry.center.x + Math.cos(sector.angle) * radius,
        geometry.center.y + Math.sin(sector.angle) * radius), {depth, index: sector.index});
    }
  }
});

test("recursive More pages retain their opening points and every final leaf remains hittable", () => {
  const source = Array.from({length: 133}, (_, index) => ({id: `tab-${index}`}));
  const pages = [];
  const parents = [];
  let nodes = source;
  while (nodes.length) {
    const page = pageRadialItems(nodes, pages.length);
    pages.push(page);
    const moreIndex = page.findIndex(node => node.orbitSynthetic);
    if (moreIndex < 0) break;
    parents.push(moreIndex);
    nodes = page[moreIndex].children;
  }
  const geometry = layoutRadialRings({width: 1440, height: 960, center: {x: 720, y: 480},
    counts: pages.map(page => page.length), parentIndices: parents});
  for (const ring of geometry.rings) {
    const radius = (ring.inner + ring.outer) / 2;
    for (const sector of ring.sectors) {
      const hit = hitRadialGeometry(geometry,
        geometry.center.x + Math.cos(sector.angle) * radius,
        geometry.center.y + Math.sin(sector.angle) * radius);
      assert.deepEqual(hit, {depth: ring.depth, index: sector.index});
      assert.equal(pages[hit.depth][hit.index], pages[ring.depth][sector.index]);
    }
    if (ring.depth) assert.equal(ring.anchor, geometry.rings[ring.depth - 1].sectors[parents[ring.depth - 1]].angle);
  }
});

test("separator gaps preserve submenu hysteresis by yielding no target", () => {
  const geometry = layoutRadialRings({width: 1280, height: 800, center: {x: 640, y: 400}, counts: [8, 5]});
  const between = (geometry.rings[0].outer + geometry.rings[1].inner) / 2;
  assert.equal(hitRadialGeometry(geometry, geometry.center.x + between, geometry.center.y), null);
  assert.equal(hitRadialGeometry(geometry, -100, -100), null);
});

test("edge placement and arbitrary depth remain inside the viewport", () => {
  for (const [width, height] of [[1440,960],[800,600],[320,240],[160,120]]) {
    for (const depth of [1,3,4,8,20,60]) {
      for (const center of [{x: 0,y: 0}, {x: width,y: height}]) {
        const geometry = layoutRadialRings({width,height,center,counts:Array(depth).fill(8),
          parentIndices:Array(Math.max(0, depth - 1)).fill(7)});
        assert.ok(geometry.center.x - geometry.radius >= 0);
        assert.ok(geometry.center.y - geometry.radius >= 0);
        assert.ok(geometry.center.x + geometry.radius <= width);
        assert.ok(geometry.center.y + geometry.radius <= height);
        assert.ok(geometry.rings.every(ring => ring.outer > ring.inner));
      }
    }
  }
});

test("deep menus retain readable outer rings by compressing older history", () => {
  const geometry = layoutRadialRings({width:1280,height:800,center:{x:640,y:400},counts:Array(20).fill(8)});
  assert.ok(geometry.rings.at(-1).outer - geometry.rings.at(-1).inner > 50);
  assert.ok(geometry.rings[0].outer - geometry.rings[0].inner < 10);
});

test("single-sector SVG uses two arcs for each circle and never emits NaN", () => {
  const path = radialSectorPath(100,100,30,80,0,Math.PI * 2);
  assert.equal((path.match(/ A /g) || []).length, 4);
  assert.ok(!path.includes("NaN"));
});
