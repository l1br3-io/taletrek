import type { BookId, VoiceId } from '../types'
import { getDB } from './db/connection'

export interface BookAudio {
  bookId: BookId
  blob: Blob
  duration: number
  paragraphOffsets: number[]
  durations: number[]
  voiceId: VoiceId
  createdAt: number
}

export async function getBookAudio(bookId: BookId): Promise<BookAudio | undefined> {
  const db = await getDB()
  return db.get('bookAudio', bookId)
}

export async function putBookAudio(audio: BookAudio): Promise<void> {
  const db = await getDB()
  await db.put('bookAudio', audio)
}

export async function deleteBookAudio(bookId: BookId): Promise<void> {
  const db = await getDB()
  await db.delete('bookAudio', bookId)
}
