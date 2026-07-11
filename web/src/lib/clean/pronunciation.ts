import type { PronunciationEntry } from './types'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function leadingBoundary(pattern: string): string {
  return /^\w/.test(pattern) ? `\\b${pattern}` : pattern
}

function trailingBoundary(pattern: string): string {
  return /\w$/.test(pattern) ? `${pattern}\\b` : pattern
}

export function applyPronunciation(text: string, entries: PronunciationEntry[]): string {
  const valid = entries.filter((e) => e.find.length > 0)
  if (valid.length === 0) return text
  const byKey = new Map(valid.map((e) => [e.find.toLowerCase(), e.replace]))
  const sorted = [...valid].sort((a, b) => b.find.length - a.find.length)
  const alternation = sorted
    .map((e) => trailingBoundary(leadingBoundary(escapeRegex(e.find))))
    .join('|')
  const re = new RegExp(alternation, 'gi')
  return text.replace(re, (match) => byKey.get(match.toLowerCase()) ?? match)
}
