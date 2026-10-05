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
        const geometry = layoutRadialRings({width,height,center,counts:Array(depth).fill(8)});
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
