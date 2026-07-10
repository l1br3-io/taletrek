// Generate TaleTrek PWA icons with no external deps (pure Node + zlib).
// Brand mark: a green play triangle on the dark ink background.
//   - pwa-192.png            (192x192, purpose: any)
//   - pwa-512.png            (512x512, purpose: any)
//   - pwa-512-maskable.png   (512x512, purpose: maskable, content in safe zone)
//
// Run: node scripts/gen-icons.mjs
import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../public/icons')
mkdirSync(outDir, { recursive: true })

// Brand colors (RGBA)
const BG = [0x0b, 0x11, 0x20, 0xff] // ink-950
const FG = [0x22, 0xc5, 0x5e, 0xff] // sage-500

/** Render a right-pointing play triangle centered in a size×size canvas. */
function renderTriangle(size, scale = 1) {
  const buf = Buffer.alloc(size * size * 4)
  // Triangle vertices, centered, scaled by `scale` (maskable uses smaller scale
  // so the mark sits inside the 80% safe zone).
  const cx = size / 2
  const cy = size / 2
  const r = (size * 0.32 * scale)
  // left edge top/bottom, right point
  const ax = cx - r * 0.65
  const ay = cy - r
  const bx = cx - r * 0.65
  const by = cy + r
  const px = cx + r * 1.0
  const py = cy

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // Point-in-triangle via barycentric sign test.
      const w0 = (px - ax) * (y - ay) - (py - ay) * (x - ax)
      const w1 = (ax - bx) * (y - by) - (ay - by) * (x - bx)
      const w2 = (bx - px) * (y - py) - (by - py) * (x - px)
      const inside =
        (w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)
      buf.set(inside ? FG : BG, i)
    }
  }
  return buf
}

/** Encode an RGBA buffer to a PNG file (8-bit, color type 6). */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // Raw image data: each scanline prefixed with filter byte 0 (None).
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9 })

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const typeData = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeData) >>> 0, 0)
  return Buffer.concat([len, typeData, crc])
}

function writeIcon(name, size, scale = 1) {
  const png = encodePng(size, size, renderTriangle(size, scale))
  writeFileSync(resolve(outDir, name), png)
  console.log(`wrote ${name} (${size}×${size}, scale=${scale}, ${png.length} bytes)`)
}

writeIcon('pwa-192.png', 192, 1)
writeIcon('pwa-512.png', 512, 1)
// Maskable: shrink the mark so it stays inside the ~80% safe zone.
writeIcon('pwa-512-maskable.png', 512, 0.8)
