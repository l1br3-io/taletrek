import type { TransformTemplate } from './types'

/**
 * Seed templates shown in the "New transform" gallery. Each template pre-fills
 * the {@link TransformDefinition} editor with sensible defaults. The user can
 * edit freely before saving.
 */
export const TRANSFORM_TEMPLATES: TransformTemplate[] = [
  {
    label: 'Clean up OCR',
    hint: 'Fix scanned-book artifacts',
    desc: 'Repairs OCR noise: strips page numbers, running headers, Chapter-N labels, stray markup, and broken hyphenation. Keeps paragraph boundaries intact.',
    systemPrompt:
      'You repair scanned-book text for text-to-speech. Fix OCR errors. Remove inline artifacts: page numbers, running headers/footers, "Chapter N" labels, "|" separators, and stray markup. Repair words broken across a line-end hyphen (join "glimmer-\\ning" into "glimmering"). Return exactly ONE cleaned paragraph per input paragraph, in order, with paragraphs separated by a blank line. Do not add commentary, headings, or markdown. Do not merge or split paragraphs.',
    params: [],
  },
  {
    label: 'Translate',
    hint: 'Translate into another language',
    desc: 'Renders the entire book in a target language. Preserves paragraph order, count, meaning, and tone. Use a BCP-47 language code (e.g. es, fr, de, ja).',
    systemPrompt:
      'You are a literary translator. Translate every input paragraph into language "{{target}}". Preserve paragraph order and count, and the meaning and tone. Return exactly ONE translated paragraph per input paragraph, with paragraphs separated by a blank line. No commentary.',
    params: [
      {
        key: 'target',
        type: 'text',
        label: 'Target language',
        default: 'es',
      },
    ],
  },
  {
    label: 'Summarize',
    hint: 'Condense to a shorter listen',
    desc: 'Condenses the narrative to a fraction of its length while keeping the main beats and original order. Great for previewing or shorter sessions.',
    systemPrompt:
      'Summarize the input to about {{percent}}% of its length, keeping the key narrative beats and original order. Return the summary as paragraphs separated by blank lines. No commentary.',
    params: [
      {
        key: 'percent',
        type: 'range',
        label: 'Summarize to',
        default: 50,
        min: 20,
        max: 80,
        step: 10,
      },
    ],
  },
  {
    label: 'Simplify',
    hint: 'Rewrite at a simpler reading level',
    desc: 'Rewrites each paragraph at a chosen reading level (1 simplest, 5 hardest) for easier listening. Simple words, short sentences.',
    systemPrompt:
      'Rewrite each input paragraph at a Grade {{level}} reading level: simple words, short sentences. Preserve meaning and paragraph order. Return exactly ONE rewritten paragraph per input paragraph, with paragraphs separated by a blank line. No commentary.',
    params: [
      {
        key: 'level',
        type: 'range',
        label: 'Reading level',
        default: 2,
        min: 1,
        max: 5,
        step: 1,
      },
    ],
  },
]
