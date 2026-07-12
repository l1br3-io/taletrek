/**
 * WebGPU feature-detection (M6 spike finding #4 / gotcha #9).
 *
 * `!!navigator.gpu` is NOT a valid check — the API object is present even when
 * no adapter is available (e.g. the Flatpak Chrome under bwrap with Vulkan
 * disabled, or older iOS Safari). The only reliable test is to request an
 * adapter and treat `null` as unsupported. Shared by `WebLlmEngine.isReady`,
 * `client.ts`, and the Settings UI (T4) so they all agree.
 */
export async function hasWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.gpu?.requestAdapter) return false
  try {
    const adapter = await navigator.gpu.requestAdapter()
    return adapter !== null
  } catch {
    return false
  }
}
