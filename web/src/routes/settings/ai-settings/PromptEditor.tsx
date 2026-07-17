import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useMemo } from 'react'
import type { ParamSpec } from '../../../lib/ai/types'

const inert = 'pointer-events-none opacity-50'

/**
 * Simple HTML-to-plain-text conversion for prompt templates. Strips tags,
 * normalises newlines, and unescapes HTML entities.
 */
export function promptHtmlToPlain(html: string): string {
  return html
    .replace(/<p>/gi, '\n')
    .replace(/<\/p>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

interface PromptEditorProps {
  value: string
  onChange: (html: string) => void
  params: ParamSpec[]
  disabled?: boolean
}

/**
 * TipTap-rich editor for a transform's system-prompt template. The toolbar
 * offers headings (H1), bold, italic, and a code-block toggle. Variable-
 * inserter buttons let the user inject `{{key}}` placeholder references to
 * the definition's declared parameters.
 *
 * On save, the caller converts the HTML to plain text via
 * {@link promptHtmlToPlain} before storing it in the definition.
 */
export function PromptEditor({ value, onChange, params, disabled }: PromptEditorProps) {
  const extensions = useMemo(
    () => [StarterKit, Placeholder.configure({ placeholder: 'System prompt…' })],
    [],
  )

  const editor = useEditor({
    extensions,
    content: value,
    editable: !disabled,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  })

  if (!editor) return null

  return (
    <div className="space-y-1">
      <div className={['flex gap-1', disabled ? inert : ''].join(' ')}>
        <div className="flex gap-0.5">
          <EditorButton
            active={editor.isActive('heading', { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            label="H1"
          />
          <EditorButton
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
            label="B"
          />
          <EditorButton
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            label="I"
          />
          <EditorButton
            active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            label="Code"
          />
        </div>
        {params.length > 0 && <span className="mx-1 border-l border-line" />}
        {params.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => editor.chain().focus().insertContent(`{{${p.key}}}`).run()}
            disabled={disabled}
            className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {`{{${p.key}}}`}
          </button>
        ))}
      </div>
      <EditorContent
        editor={editor}
        className={[
          'prose prose-sm max-w-none rounded-md border border-line bg-surface px-3 py-2 [&_.ProseMirror]:min-h-[120px] [&_.ProseMirror]:outline-none',
          disabled ? inert : '',
        ].join(' ')}
      />
    </div>
  )
}

function EditorButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
        active ? 'bg-accent text-surface' : 'border border-line text-muted hover:border-accent',
      ].join(' ')}
    >
      {label}
    </button>
  )
}
