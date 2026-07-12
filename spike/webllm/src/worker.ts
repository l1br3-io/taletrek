import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

// Dedicated Web Worker — documented WebLLM pattern.
// Source: https://github.com/mlc-ai/web-llm#dedicated-web-worker
// The handler implements the worker side of the engine protocol; the main
// thread creates a WebWorkerMLCEngine that proxies chat.completions calls here.
const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg)
}
