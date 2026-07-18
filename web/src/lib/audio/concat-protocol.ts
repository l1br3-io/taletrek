export type ConcatRequest =
  | { id: number; type: 'load' }
  | { id: number; type: 'concat'; keys: string[] }

export type ConcatResponse =
  | { id: number; type: 'loadProgress'; fraction: number }
  | { id: number; type: 'loaded' }
  | {
      id: number
      type: 'success'
      m4a: ArrayBuffer
      paragraphOffsets: number[]
      durations: number[]
      duration: number
    }
  | { id: number; type: 'error'; message: string; name?: string; code?: number }
