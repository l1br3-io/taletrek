#!/usr/bin/env node
// Mirrors WASM runtime artifacts into web/public/wasm/ so TaleTrek never
// depends on a CDN (cdnjs / jsdelivr) for inference — only for the one-time
// voice-MODEL download (HuggingFace), which is cached in OPFS afterward.
//
// Two sources:
//   1. ORT wasm  — copied from node_modules/onnxruntime-web/dist (pinned 1.18.0)
//   2. Piper phonemize wasm + espeak data — downloaded from the CORRECT
//      @diffusionstudio/piper-wasm@1.0.0 package (note: no hyphen — the
//      @mintplex-labs/piper-tts-web package misreferences the hyphenated
//      "@diffusion-studio/piper-wasm" which 404s; we override wasmPaths).
//
// Idempotent: skips files that already exist with a matching size.
// Run via `pnpm mirror-wasm` or automatically on postinstall.

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(__dirname, '..')
const ORT_DIST = resolve(WEB_DIR, 'node_modules/onnxruntime-web/dist')
const OUT_DIR = resolve(WEB_DIR, 'public/wasm')
const OUT_ORT = resolve(OUT_DIR, 'ort')
const OUT_PIPER = resolve(OUT_DIR, 'piper')

// ORT 1.18.0 non-jsep CPU path (dist/esm/ort.min.js loader). SIMD variants
// cover both single-threaded (no COOP/COEP — our default) and threaded
// (cross-origin isolated) browsers.
const ORT_WASM_FILES = ['ort-wasm-simd.wasm', 'ort-wasm-simd-threaded.wasm']

// Correct piper-wasm package (the mintplex package's default URL is wrong).
const PIPER_BASE =
  'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build'
const PIPER_FILES = ['piper_phonemize.wasm', 'piper_phonemize.data']

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

async function copyOrt(src, dest, label) {
  if (!existsSync(src)) {
    throw new Error(`ORT wasm source missing: ${src}`)
  }
  const srcSize = (await stat(src)).size
  if (existsSync(dest)) {
    const destSize = (await stat(dest)).size
    if (destSize === srcSize) {
      console.log(`  ✓ ${label} (cached, ${mb(srcSize)})`)
      return
    }
  }
  await copyFile(src, dest)
  console.log(`  ✓ ${label} (${mb(srcSize)})`)
}

async function download(url, dest, label) {
  // Skip if already present (size check deferred — jsdelivr sends content-length).
  if (existsSync(dest)) {
    const size = (await stat(dest)).size
    console.log(`  ✓ ${label} (cached, ${mb(size)})`)
    return true
  }
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    console.warn(
      `  ✗ ${label} — HTTP ${res.status} from ${url}\n` +
        `    Run \`pnpm mirror-wasm\` again when online. TTS will 404 until then.`,
    )
    return false
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  await ensureDir(dirname(dest))
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  console.log(`  ✓ ${label} (${mb(total || (await stat(dest)).size)})`)
  return true
}

async function main() {
  console.log('Mirroring WASM runtime artifacts → public/wasm/')

  await ensureDir(OUT_ORT)
  console.log('\n[1/2] ORT wasm (from node_modules/onnxruntime-web, pinned 1.18.0):')
  for (const file of ORT_WASM_FILES) {
    await copyOrt(
      resolve(ORT_DIST, file),
      resolve(OUT_ORT, file),
      `ort/${file}`,
    )
  }

  console.log('\n[2/2] Piper phonemize wasm + espeak data (from @diffusionstudio/piper-wasm):')
  await ensureDir(OUT_PIPER)
  let piperOk = true
  for (const file of PIPER_FILES) {
    const ok = await download(
      `${PIPER_BASE}/${file}`,
      resolve(OUT_PIPER, file),
      `piper/${file}`,
    )
    piperOk = piperOk && ok
  }

  if (!piperOk) {
    console.warn(
      '\n⚠  Piper artifacts incomplete. Re-run `pnpm mirror-wasm` when online.',
    )
  } else {
    console.log('\nDone. WASM runtime is fully mirrored.')
  }
}

main().catch((err) => {
  console.error('mirror-wasm failed:', err)
  process.exit(1)
})
