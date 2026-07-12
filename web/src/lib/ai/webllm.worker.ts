/**
 * WebLLM dedicated Web Worker — the documented `WebWorkerMLCEngineHandler`
 * pattern confirmed in `docs/spikes/webllm.md`. The handler implements the
 * worker side of WebLLM's own protocol; the main thread creates a
 * `WebWorkerMLCEngine` (via `CreateWebWorkerMLCEngine`) that proxies
 * `chat.completions.create` calls here. There is no TaleTrek-specific message
 * protocol on top — WebLLM's covers it (spike finding, supersedes the PRD's
 * planned `protocol.ts`).
 */
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg)
}
