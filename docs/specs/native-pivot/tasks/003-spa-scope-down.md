# T3 — SPA scope-down

**Description:** Cut `web/` down to a `.taletrek` reader + landing surface. Delete the upload/parse/synth/AI pipeline and the server datasource seam; keep everything the reader needs to open and play bundles. Delete in dependency order, typechecking between steps (R1 mitigation).

**Delete (with co-located tests):**
- [ ] Workers: `workers/parse.worker.ts`, `workers/tts.worker.ts`, `workers/concat.worker.ts` (+ parser libs usage)
- [ ] Upload stack: `lib/upload/*` (manager, useUpload, boot-sweep), `lib/wake-lock.ts`, `lib/ingest.ts`, `lib/pre-synth.ts`, `routes/library/UploadBookModal*`, `components/GlobalUploadBanner*`, `components/UploadButton` (if separate), `routes/library/SynthVoiceSheet*`
- [ ] AI stack: `lib/ai/*`, `routes/library/useAiTransform*`, `useOutline*`, `OutlineSheet*`, `usePronunciationHints*`, `PronunciationReview*`, `AiStatusChip*`, `routes/settings/ai-settings/*`, `routes/settings/PronunciationEditor*`, `KeySaveWarningDialog*`
- [ ] Crypto keyring: `lib/crypto/*` (aes, prf — existed only to encrypt AI keys)
- [ ] Server seam: `lib/datasource/{server,remote-playback,resolve}*` (keep `types.ts` + `local.ts` behind the `LibraryDatasource` facade — callers unchanged where possible), `hooks/useServerVoices*`, `hooks/useOnline*` (revisit if reader uses it)
- [ ] Dead deps from `web/package.json` (pdfjs-dist, fast-xml-parser, ort/onnxruntime-web/piper-wasm glue, ai sdk bits — whatever the deletion leaves unused); `pnpm install` to relock

**Keep (fence — existing tests stay green):** reader route, playback engines (Web Audio + FFmpeg fallback), `lib/bundle/*`, `lib/db/*`, `lib/book-audio.ts`, `lib/media-session.ts`, `lib/backup.ts`, imported-bundle library UI, settings subset (playback/voice prefs), install-prompt, landing route (rebuilt in T6).

- [ ] Reader still opens a v1 full `.taletrek` (existing import tests green)
- [ ] `pnpm verify` green (lint + typecheck + test + build)

**Files:** ~40 deletions + call-site fixes + `web/package.json`
**Verify:** `pnpm verify`; manual `pnpm dev` smoke: import fixture bundle → play
