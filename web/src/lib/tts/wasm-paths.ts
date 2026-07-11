/**
 * Local WASM runtime paths — overrides the package defaults so TaleTrek never
 * depends on a CDN (cdnjs / jsdelivr) for inference.
 *
 * Background: `@mintplex-labs/piper-tts-web` defaults its `wasmPaths` to
 *  - ONNX wasm  → cdnjs.cloudflare.com/.../onnxruntime-web/1.18.0/
 *  - Piper wasm → cdn.jsdelivr.net/.../@diffusion-studio/piper-wasm@1.0.0/...
 * The piper URL is a broken reference (the real package is
 * `@diffusionstudio/piper-wasm`, no hyphen) and we want neither at runtime.
 * `pnpm mirror-wasm` copies ORT wasm from node_modules and downloads the piper
 * artifacts into `public/wasm/`; these paths point the engine there.
 *
 * See docs/prds/M2-speak.md (T1) + AGENTS.md gotcha #1 (ORT 1.18.0 pin).
 */
export interface PiperWasmPaths {
  /** Directory prefix serving the ORT 1.18.0 `.wasm` files. */
  onnxWasm: string
  /** Full URL to the piper-phonemize `.wasm` binary. */
  piperWasm: string
  /** Full URL to the piper-phonemize `.data` (espeak-ng-data). */
  piperData: string
}

const BASE = '/wasm'

export const WASM_PATHS: PiperWasmPaths = {
  onnxWasm: `${BASE}/ort/`,
  piperWasm: `${BASE}/piper/piper_phonemize.wasm`,
  piperData: `${BASE}/piper/piper_phonemize.data`,
}
