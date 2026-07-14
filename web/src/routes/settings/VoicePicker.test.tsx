import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CURATED_VOICES } from '../../lib/tts/voices'
import { voiceId } from '../../types'
import { VoicePicker } from './VoicePicker'

const ACTIVE = voiceId('en_US-hfc_female-medium')

function renderPicker(overrides?: Partial<React.ComponentProps<typeof VoicePicker>>) {
  const handlers = { onSelect: vi.fn(), onDownload: vi.fn(), onRemove: vi.fn() }
  const props = {
    voices: CURATED_VOICES,
    activeVoiceId: ACTIVE,
    storedIds: new Set<string>(),
    downloading: null,
    ...handlers,
    ...overrides,
  }
  return { ...render(<VoicePicker {...props} />), ...handlers }
}

describe('VoicePicker', () => {
  it('renders every curated voice', () => {
    renderPicker()
    expect(screen.getByText(/HFC Female/)).toBeInTheDocument()
    expect(screen.getByText(/Ryan/)).toBeInTheDocument()
    expect(screen.getByText(/Cori/)).toBeInTheDocument()
  })

  it('shows a download button for un-stored voices', () => {
    renderPicker()
    expect(screen.getAllByRole('button', { name: 'download' })).toHaveLength(8)
  })

  it('shows a downloaded badge for stored voices', () => {
    renderPicker({ storedIds: new Set([ACTIVE]) })
    // one fewer download button (the stored one shows a badge instead)
    expect(screen.getAllByRole('button', { name: 'download' })).toHaveLength(7)
    expect(screen.getAllByText('downloaded')).toHaveLength(1)
  })

  it('shows progress percent while a voice downloads', () => {
    renderPicker({ downloading: { id: ACTIVE, progress: 0.5 } })
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('calls onSelect with the voice id when a voice row is clicked', () => {
    const { onSelect } = renderPicker()
    fireEvent.click(screen.getByText(/Ryan/))
    expect(onSelect).toHaveBeenCalledWith(voiceId('en_US-ryan-medium'))
  })

  it('calls onDownload when the download button is clicked', () => {
    const { onDownload } = renderPicker()
    const buttons = screen.getAllByRole('button', { name: 'download' })
    const first = buttons[0]
    if (!first) throw new Error('expected a download button')
    fireEvent.click(first)
    expect(onDownload).toHaveBeenCalledWith(ACTIVE)
  })

  it('calls onRemove when a stored voice remove button is clicked', () => {
    const { onRemove } = renderPicker({ storedIds: new Set([ACTIVE]) })
    fireEvent.click(screen.getByRole('button', { name: /remove HFC Female/i }))
    expect(onRemove).toHaveBeenCalledWith(ACTIVE)
  })
})
