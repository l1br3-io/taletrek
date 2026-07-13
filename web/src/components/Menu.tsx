import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  type Placement,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { type ReactNode, useState } from 'react'

/** Props spread onto the trigger element by `<Menu>` (ref + toggle + a11y). */
export type MenuTriggerProps = {
  ref: (node: HTMLElement | null) => void
  onClick: (e: React.MouseEvent<HTMLElement>) => void
  'aria-haspopup': 'menu' | undefined
  'aria-expanded': boolean
}

interface MenuProps {
  /** Where the panel should appear relative to the trigger. */
  placement?: Placement
  /** Gap between trigger and panel (px). */
  gap?: number
  /** Classes applied to the floating panel wrapper. */
  panelClassName?: string
  /**
   * Renders the trigger button. Receives props to spread onto it (ref, toggle
   * onClick, aria). The caller keeps ownership of styling + icon + aria-label.
   */
  trigger: (props: MenuTriggerProps) => ReactNode
  /**
   * Renders the panel content. Receives a `close` callback so menu items can
   * dismiss the menu after acting.
   */
  children: (close: () => void) => ReactNode
}

/**
 * Reusable anchored dropdown menu built on Floating UI. The panel renders in a
 * `FloatingPortal` (document body) so it always layers above siblings — no
 * `z-index` stacking battles. `flip` + `shift` keep it on screen near viewport
 * edges; `useDismiss` handles outside-click + Escape.
 *
 * Presentational — the caller owns item markup, styling, and actions.
 */
export function Menu({
  placement = 'bottom-end',
  gap = 4,
  panelClassName,
  trigger,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false)

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(gap), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  const dismiss = useDismiss(context, { escapeKey: true, outsidePress: true })
  const role = useRole(context, { role: 'menu' })
  const click = useClick(context)
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role, click])

  const close = (): void => setOpen(false)

  const triggerProps = {
    ref: refs.setReference,
    ...getReferenceProps(),
  } as MenuTriggerProps

  return (
    <>
      {trigger(triggerProps)}
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={['z-50', panelClassName].filter(Boolean).join(' ')}
            {...getFloatingProps()}
          >
            {children(close)}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
