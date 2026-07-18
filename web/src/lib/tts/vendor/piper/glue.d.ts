/**
 * Type shim for the vendored Emscripten glue (`glue.js`). The glue itself is
 * untouched upstream output — this declaration gives the rest of the codebase
 * a typed entry point.
 */

export interface PiperPhonemizeModule {
  callMain(args: string[]): number
}

export interface CreatePiperPhonemizeOptions {
  print?: (data: string) => void
  printErr?: (message: string) => void
  locateFile?: (url: string) => string
}

export declare function createPiperPhonemize(
  options: CreatePiperPhonemizeOptions,
): Promise<PiperPhonemizeModule>
