import type { ParseResult } from './types'

export interface ParseRequest {
  id: number
  buffer: ArrayBuffer
  name: string
  type: string
}

export type ParseResponse =
  | { id: number; type: 'success'; result: ParseResult }
  | { id: number; type: 'error'; message: string }
