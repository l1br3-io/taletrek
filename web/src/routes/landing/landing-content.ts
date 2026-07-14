import {
  AudioLines,
  Bookmark,
  BookOpen,
  ChefHat,
  CloudOff,
  Dumbbell,
  Eraser,
  Footprints,
  Headphones,
  Lock,
  Moon,
  PawPrint,
  Train,
  Upload,
} from 'lucide-react'

export const heroBadges = ['Free', 'MIT', 'Offline', 'by l1br3']

export const steps = [
  {
    n: '01',
    icon: Upload,
    label: 'Upload',
    desc: 'Bring a PDF, EPUB, MOBI, TXT, or Markdown file. It never leaves your device.',
  },
  {
    n: '02',
    icon: Eraser,
    label: 'Clean',
    desc: 'Links, images, footnotes, and page numbers are stripped — only prose remains.',
  },
  {
    n: '03',
    icon: AudioLines,
    label: 'Synthesize',
    desc: 'Piper neural speech renders each paragraph to audio, in your browser.',
  },
  {
    n: '04',
    icon: Headphones,
    label: 'Listen',
    desc: 'Pre-rendered chunks play through the audio element and survive screen lock.',
  },
]

export const moments = [
  { icon: Footprints, label: 'Jogging' },
  { icon: Train, label: 'Commuting' },
  { icon: ChefHat, label: 'Cooking' },
  { icon: Dumbbell, label: 'Working out' },
  { icon: PawPrint, label: 'Walking the dog' },
  { icon: Moon, label: 'Falling asleep' },
]

export const features = [
  {
    icon: BookOpen,
    title: 'Every common format',
    desc: 'PDF, EPUB, MOBI, TXT, and Markdown — bring what you have.',
  },
  {
    icon: AudioLines,
    title: 'Neural voices',
    desc: 'Multiple Piper voices, switchable at any time.',
  },
  {
    icon: Lock,
    title: 'Survives screen lock',
    desc: 'Audio keeps playing after you lock your phone.',
  },
  {
    icon: Eraser,
    title: 'Clean audio',
    desc: 'Links, images, and footnotes skipped automatically.',
  },
  {
    icon: Bookmark,
    title: 'Resume anywhere',
    desc: 'A personal library remembers where you stopped.',
  },
  {
    icon: CloudOff,
    title: 'Offline once loaded',
    desc: 'After your voice downloads, no internet needed.',
  },
]

export const comparison = {
  cols: ['TaleTrek', 'Voice Dream', 'Apple Books', 'Web readers', 'Cloud TTS'],
  rows: [
    { label: 'Price', cells: ['$0', '~$20', 'Free', 'Free', 'Pay / min'] },
    { label: 'Works offline', cells: [true, true, true, false, false] },
    { label: 'Plays after screen lock', cells: [true, true, 'Limited', false, false] },
    { label: 'Strips links & footnotes', cells: [true, true, false, false, 'Varies'] },
    { label: 'Voice choice, free', cells: ['Many', 'Paid', '1–2', '1–2', 'Paid'] },
    { label: 'Open source (MIT)', cells: [true, false, false, false, false] },
  ],
}

export const faqs = [
  {
    q: 'Is it really free?',
    a: 'Yes. MIT-licensed, no ads, no subscription, no upsell. The speech engine (Piper) is open source too.',
  },
  {
    q: 'Will it keep playing when I lock my phone?',
    a: 'Yes. Audio is pre-rendered and played through the standard audio element, which iOS and Android keep alive in the background. Browser readers that use the Web Speech API stop the moment the screen locks — TaleTrek does not.',
  },
  {
    q: 'Where are my books stored?',
    a: 'On your device, in the browser. Your book text and audio never leave your phone.',
  },
  {
    q: 'Which devices work?',
    a: 'Any modern browser. Install TaleTrek as a PWA on iOS or Android for full-screen, offline playback with lock-screen controls.',
  },
  {
    q: 'Can I help?',
    a: 'It’s MIT on GitHub. Issues and pull requests are welcome.',
  },
]
