export interface CleaningFilters {
  urls: boolean
  images: boolean
  footnotes: boolean
  pageNumbers: boolean
}

export interface PronunciationEntry {
  id: string
  find: string
  replace: string
}

export interface CleaningConfig {
  enabled: boolean
  filters: CleaningFilters
  pronunciation: PronunciationEntry[]
}

/** The out-of-the-box cleaning config (M4): enabled, all filters on. */
export const DEFAULT_CLEANING: CleaningConfig = {
  enabled: true,
  filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
  pronunciation: [],
}
