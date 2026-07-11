import { parseFile } from '../lib/parse/dispatcher'
import type { ParseRequest, ParseResponse } from '../lib/parse/protocol'

const ctx = self as unknown as Worker

ctx.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, buffer, name, type } = event.data
  const file = new File([buffer], name, { type })
  let response: ParseResponse
  try {
    const result = await parseFile(file)
    response = { id, type: 'success', result }
  } catch (error) {
    response = {
      id,
      type: 'error',
      message: error instanceof Error ? error.message : 'unknown error',
    }
  }
  ctx.postMessage(response)
}
