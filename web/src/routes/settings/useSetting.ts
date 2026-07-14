import { type Settings, useSettings } from '../../context/settings'

export type { Theme } from '../../context/settings'

/**
 * Read/write a single setting. Convenience around `useSettings` for components
 * that only touch one field.
 *
 *   const [theme, setTheme] = useSetting('theme')
 */
export function useSetting<K extends keyof Settings>(
  key: K,
): readonly [Settings[K], (value: Settings[K]) => Promise<void>] {
  const { settings, update } = useSettings()
  return [
    settings[key],
    (value: Settings[K]) => update({ [key]: value } satisfies Partial<Settings>),
  ] as const
}
