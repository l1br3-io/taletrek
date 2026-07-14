import { Upload } from 'lucide-react'
import { useRef } from 'react'

interface UploadButtonProps {
  onSelect: (file: File) => void
  disabled?: boolean
  label?: string
}

export function UploadButton({ onSelect, disabled, label = 'Upload a book' }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onSelect(file)
    event.target.value = ''
  }

  const handleClick = (): void => {
    if (disabled) return
    inputRef.current?.click()
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.epub,.txt,.md"
        className="hidden"
        onChange={handleChange}
        disabled={disabled}
        aria-label="Upload a book"
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="inline-flex items-center gap-2 border border-accent bg-accent-soft px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Upload className="h-4 w-4" /> {label}
      </button>
    </>
  )
}
