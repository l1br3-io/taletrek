// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** UI surface the datasource seam governs (ADR-0014). `players/` is scanned when present. */
const GATED_DIRS = ['routes', 'components', 'players', 'hooks', 'context'] as const

/**
 * Locked exceptions (spec): settings + the secure keyring stay on client-side
 * IndexedDB in both modes. `lib/ai/secure-keyring.ts` itself lives under
 * `lib/` — behind the seam, ungated — so only the settings context is exempt.
 */
const ALLOWLIST = new Set(['context/settings.tsx'])

/** Static `from '…/lib/db…'`, dynamic `import('…')`, and `require('…')` forms. */
const DB_IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"][^'"]*lib\/db(?:\/[^'"]*)?['"]/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

describe('datasource boundary — UI must not import lib/db directly', () => {
  it('no non-allowlisted file under routes/components/players/hooks/context imports lib/db', () => {
    const offenders: string[] = []
    for (const dir of GATED_DIRS) {
      const root = join(srcRoot, dir)
      if (!existsSync(root)) continue
      for (const file of walk(root)) {
        // Tests seed/reset the real DB via `_clearDBForTests` etc. — test infra, not shipping code.
        if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
        const rel = relative(srcRoot, file).replaceAll('\\', '/')
        if (ALLOWLIST.has(rel)) continue
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (DB_IMPORT_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(
      offenders,
      `UI files importing lib/db (route through lib/datasource):\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
