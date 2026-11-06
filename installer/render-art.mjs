// SPDX-License-Identifier: MPL-2.0
// Regenerates the installer artwork from its SVG sources:
//   orbit-icon.svg -> orbit.ico (16-256 px) and orbit-icon-256.png
//   wizard.svg     -> wizard.bmp (welcome and finish page side image)
// Needs Node and Playwright with Chromium: node installer/render-art.mjs
// Small icon sizes are 32-bit BMP entries, 256 px is PNG, as Windows expects.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// require() also finds a globally installed Playwright, which import does not.
const { chromium } = createRequire(import.meta.url)("playwright");

const here = fileURLToPath(new URL(".", import.meta.url));
const svg = readFileSync(here + "orbit-icon.svg", "utf8");
const wizardSvg = readFileSync(here + "wizard.svg", "utf8");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR bitmap plus AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4; // bottom-up rows
      const to = (y * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const stride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rgba[((size - 1 - y) * size + x) * 4 + 3] === 0) mask[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

// A 24-bit bottom-up BMP, the format NSIS expects for wizard bitmaps.
function bmpFile(width, height, rgba) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((height - 1 - y) * width + x) * 4;
      const to = y * stride + x * 3;
      data[to] = rgba[from + 2];
      data[to + 1] = rgba[from + 1];
      data[to + 2] = rgba[from];
    }
  }
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(data.length, 34);
  header.writeInt32LE(5669, 38); // 144 DPI
  header.writeInt32LE(5669, 42);
  return Buffer.concat([header, data]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  const images = await page.evaluate(async ({ svg, sizes }) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const out = [];
    for (const size of sizes) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, size, size);
      const rgba = Array.from(ctx.getImageData(0, 0, size, size).data);
      const png = canvas.toDataURL("image/png").split(",")[1];
      out.push({ size, rgba, png });
    }
    return out;
  }, { svg, sizes: SIZES });
  const entries = images.map(({ size, rgba, png }) =>
    size >= 256 ? Buffer.from(png, "base64") : bmpEntry(size, Uint8Array.from(rgba)));
  const directory = Buffer.alloc(6 + 16 * entries.length);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  entries.forEach((data, index) => {
    const size = images[index].size;
    const at = 6 + index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  writeFileSync(here + "orbit.ico", Buffer.concat([directory, ...entries]));
  writeFileSync(here + "orbit-icon-256.png", Buffer.from(images.at(-1).png, "base64"));
  const wizard = await page.evaluate(async ({ svg, width, height }) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    return Array.from(ctx.getImageData(0, 0, width, height).data);
  }, { svg: wizardSvg, width: 328, height: 628 });
  writeFileSync(here + "wizard.bmp", bmpFile(328, 628, Uint8Array.from(wizard)));
  console.log(`Wrote orbit.ico (${SIZES.join(", ")} px), orbit-icon-256.png and wizard.bmp`);
} finally {
  await browser.close();
}
