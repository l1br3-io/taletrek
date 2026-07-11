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
