// Generates simple tray icons as PNGs (no external tooling). Run: npm run icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, shader) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges
      let cov = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) cov += shader((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size) ? 1 : 0;
      const [r, g, b] = shader.color;
      raw.set([r, g, b, Math.round((cov / 16) * 255)], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dot = (color) => Object.assign((x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 < 0.3 ** 2, { color });
const ring = (color) => Object.assign((x, y) => {
  const d = Math.hypot(x - 0.5, y - 0.5);
  const bars = y > 0.32 && y < 0.68 && ((x > 0.37 && x < 0.46) || (x > 0.54 && x < 0.63));
  return (d < 0.34 && d > 0.25) || bars;
}, { color });

const out = 'resources';
for (const [name, shader] of [
  ['trayRecordingTemplate', dot([0, 0, 0])],
  ['trayPausedTemplate', ring([0, 0, 0])],
  ['tray-recording', dot([220, 38, 38])],
  ['tray-paused', ring([120, 120, 120])],
]) {
  writeFileSync(`${out}/${name}.png`, png(16, shader));
  writeFileSync(`${out}/${name}@2x.png`, png(32, shader));
}
console.log('icons written to resources/');
