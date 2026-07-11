import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'
import type { BookFormat } from '../../types'
import type { ParsedChapter, Parser } from './types'
import { ParseError } from './types'
import { titleFromFilename } from './util'

const DC_TITLE_TAGS = new Set(['title', 'dc:title'])
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li'])

const structParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  isArray: (name) => name === 'item' || name === 'itemref' || name === 'navPoint',
})
const contentParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  preserveOrder: true,
})

interface ManifestItem {
  path: string
  mediaType: string
  properties: string[]
}

export const epubParser: Parser = {
  format: 'epub' satisfies BookFormat,
  matches(file) {
    return file.name.toLowerCase().endsWith('.epub') || file.type === 'application/epub+zip'
  },
  async parse(file) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    const opf = await loadOpf(zip)
    const title = readTitle(opf.doc) ?? titleFromFilename(file.name)
    const manifest = readManifest(opf.doc, opf.dir)
    const spine = readSpine(opf.doc)
    const tocTitles = await readToc(zip, manifest)

    const chapters: ParsedChapter[] = []
    let chapterNo = 0
    for (const idref of spine) {
      const item = manifest.get(idref)
      if (!item || !isXhtml(item.mediaType)) continue
      const html = await readTextFile(zip, item.path)
      const paragraphs = extractParagraphs(html)
      if (paragraphs.length === 0) continue
      chapterNo += 1
      const chapterTitle = tocTitles.get(item.path) ?? `Chapter ${chapterNo}`
      chapters.push({ title: chapterTitle, paragraphs })
    }

    if (chapters.length === 0) {
      throw new ParseError(`No readable text found in EPUB: ${file.name}`, 'epub')
    }
    return { title, chapters }
  },
}

async function loadOpf(zip: JSZip): Promise<{ doc: unknown; dir: string }> {
  const containerXml = await readTextFile(zip, 'META-INF/container.xml')
  const container = structParser.parse(containerXml) as Record<string, unknown>
  const rootfile = findOne(container, 'rootfile') as Record<string, unknown> | undefined
  const fullPath = rootfile?.['@_full-path']
  if (typeof fullPath !== 'string') {
    throw new ParseError('Invalid EPUB: missing OPF rootfile', 'epub')
  }
  const opfText = await readTextFile(zip, fullPath)
  return { doc: structParser.parse(opfText), dir: dirOf(fullPath) }
}

function readTitle(doc: unknown): string | undefined {
  const metadata = (doc as Record<string, unknown>)?.package as Record<string, unknown> | undefined
  const meta = metadata?.metadata as Record<string, unknown> | undefined
  if (!meta) return undefined
  for (const key of Object.keys(meta)) {
    if (DC_TITLE_TAGS.has(key)) {
      const text = textOf(meta[key])
      if (text) return text
    }
  }
  return undefined
}

function readManifest(doc: unknown, opfDir: string): Map<string, ManifestItem> {
  const map = new Map<string, ManifestItem>()
  const items = findAll(doc, 'item')
  for (const item of items) {
    const node = item as Record<string, unknown>
    const id = node['@_id']
    const href = node['@_href']
    if (typeof id !== 'string' || typeof href !== 'string') continue
    const mediaType = typeof node['@_media-type'] === 'string' ? node['@_media-type'] : ''
    const properties =
      typeof node['@_properties'] === 'string'
        ? (node['@_properties'] as string).split(/\s+/).filter(Boolean)
        : []
    map.set(id, { path: resolvePath(opfDir, href), mediaType, properties })
  }
  return map
}

function readSpine(doc: unknown): string[] {
  const refs = findAll(doc, 'itemref')
  const out: string[] = []
  for (const ref of refs) {
    const idref = (ref as Record<string, unknown>)['@_idref']
    if (typeof idref === 'string') out.push(idref)
  }
  return out
}

async function readToc(
  zip: JSZip,
  manifest: Map<string, ManifestItem>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const items = [...manifest.values()]

  const nav = items.find((it) => it.properties.includes('nav'))
  if (nav) {
    try {
      await mergeNavTitles(zip, nav.path, titles)
    } catch {
      /* fall back to NCX or defaults */
    }
  }

  const ncx = items.find((it) => it.mediaType === 'application/x-dtbncx+xml')
  if (ncx) {
    try {
      await mergeNcxTitles(zip, ncx.path, titles)
    } catch {
      /* defaults are fine */
    }
  }
  return titles
}

async function mergeNavTitles(
  zip: JSZip,
  navPath: string,
  titles: Map<string, string>,
): Promise<void> {
  const html = await readTextFile(zip, navPath)
  const doc = structParser.parse(html)
  const base = dirOf(navPath)
  for (const node of findAll(doc, 'a')) {
    const href = (node as Record<string, unknown>)['@_href']
    const label = textOf(node)
    if (typeof href !== 'string' || !label) continue
    const path = resolvePath(base, href)
    if (!titles.has(path)) titles.set(path, label)
  }
}

async function mergeNcxTitles(
  zip: JSZip,
  ncxPath: string,
  titles: Map<string, string>,
): Promise<void> {
  const xml = await readTextFile(zip, ncxPath)
  const doc = structParser.parse(xml)
  const base = dirOf(ncxPath)
  const points = findAll(doc, 'navPoint')
  for (const point of points) {
    const labelEl = (point as Record<string, unknown>).navLabel as
      | Record<string, unknown>
      | undefined
    const label = textOf(labelEl?.text)
    const contentEl = (point as Record<string, unknown>).content as
      | Record<string, unknown>
      | undefined
    const src = contentEl?.['@_src']
    if (!label || typeof src !== 'string') continue
    const path = resolvePath(base, src)
    if (!titles.has(path)) titles.set(path, label)
  }
}

function extractParagraphs(html: string): string[] {
  const doc = contentParser.parse(html) as unknown[]
  const paragraphs: string[] = []
  walkOrdered(doc, paragraphs)
  return paragraphs
}

function walkOrdered(nodes: unknown[], into: string[]): void {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    for (const [tag, val] of Object.entries(node as Record<string, unknown>)) {
      if (tag.startsWith('@_') || tag === '#text') continue
      const children = Array.isArray(val) ? val : [val]
      if (BLOCK_TAGS.has(tag)) {
        if (containsBlockChild(children)) walkOrdered(children, into)
        else {
          const text = extractOrderedText(children)
          if (text) into.push(text)
        }
      } else {
        walkOrdered(children, into)
      }
    }
  }
}

function containsBlockChild(nodes: unknown[]): boolean {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (key.startsWith('@_') || key === '#text') continue
      if (BLOCK_TAGS.has(key)) return true
    }
  }
  return false
}

function extractOrderedText(nodes: unknown[]): string {
  const parts: string[] = []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    for (const [tag, val] of Object.entries(node as Record<string, unknown>)) {
      if (tag.startsWith('@_')) continue
      if (tag === '#text') {
        if (typeof val === 'string') parts.push(val)
        continue
      }
      const children = Array.isArray(val) ? val : [val]
      parts.push(extractOrderedText(children))
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}

function isXhtml(mediaType: string): boolean {
  const m = mediaType.toLowerCase()
  return m === 'application/xhtml+xml' || m === 'text/html'
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : ''
}

function resolvePath(base: string, rel: string): string {
  const relClean = stripFragment(rel).replace(/^\/+/, '')
  const parts = base.split('/').filter(Boolean)
  for (const part of relClean.split('/')) {
    if (part === '..') parts.pop()
    else if (part === '.' || part === '') continue
    else parts.push(part)
  }
  return parts.join('/')
}

function stripFragment(s: string): string {
  return s.split('#')[0] ?? ''
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value]
}

function textOf(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return textOf(value[0])
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v['#text'] === 'string') return (v['#text'] as string).trim()
    const first = Object.values(v).find((x) => x !== undefined)
    return textOf(first)
  }
  return ''
}

function findAll(node: unknown, tagName: string): unknown[] {
  const out: unknown[] = []
  visit(node, tagName, out)
  return out
}

function visit(node: unknown, tagName: string, out: unknown[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) visit(n, tagName, out)
    return
  }
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('@_') || key === '#text') continue
    if (key === tagName) for (const item of asArray(val)) out.push(item)
    visit(val, tagName, out)
  }
}

function findOne(node: unknown, tagName: string): unknown {
  const all = findAll(node, tagName)
  return all[0]
}

async function readTextFile(zip: JSZip, path: string): Promise<string> {
  const entry = findEntry(zip, path)
  if (!entry) throw new ParseError(`Missing EPUB file: ${path}`, 'epub')
  return entry.async('text')
}

function findEntry(zip: JSZip, path: string): JSZip.JSZipObject | undefined {
  const normalized = path.replace(/^\/+/, '')
  return zip.file(normalized) ?? zip.file(decodeURIComponent(normalized)) ?? undefined
}
