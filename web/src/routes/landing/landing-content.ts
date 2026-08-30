import {
  Apple,
  AudioLines,
  Bookmark,
  BookOpen,
  ChefHat,
  CloudOff,
  Dumbbell,
  Eraser,
  FileUp,
  Footprints,
  Headphones,
  Lock,
  Monitor,
  Moon,
  PawPrint,
  Smartphone,
  Train,
} from 'lucide-react'

export const heroBadges = ['Free', 'MIT', 'Offline', 'by l1br3']

export const steps = [
  {
    n: '01',
    icon: FileUp,
    label: 'Bring',
    desc: 'Drop an EPUB, PDF, MOBI, TXT, or Markdown file into the desktop processor. It never leaves your machine.',
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
    desc: 'Piper and Kokoro neural voices render each paragraph in the Rust kernel, on your hardware.',
  },
  {
    n: '04',
    icon: Headphones,
    label: 'Listen',
    desc: 'The result — a single .taletrek file — plays in the phone apps with background audio that survives screen lock.',
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

export const apps = [
  {
    icon: Monitor,
    name: 'Desktop',
    role: 'The processor',
    status: 'First ship — in development',
    desc: 'File in, audiobook out. Turn any ebook into a .taletrek with on-device synthesis.',
    badge: 'Download — at first release',
  },
  {
    icon: Smartphone,
    name: 'Android',
    role: 'The player',
    status: 'Coming soon',
    desc: 'Lock-screen controls, background audio, your whole library in your pocket.',
    badge: 'Google Play',
  },
  {
    icon: Apple,
    name: 'iOS',
    role: 'The player',
    status: 'Coming soon',
    desc: 'A free, open-source read-aloud app for iPhone — a category that barely exists.',
    badge: 'App Store',
  },
]

export const today = {
  reader: {
    title: 'Open a .taletrek',
    desc: 'Already have a bundle? The web reader plays it right here — file-open only, nothing uploaded. Export any book back out as a .taletrek whenever you like.',
    cta: 'Open your library',
  },
  cli: {
    title: 'Build from source',
    desc: 'Until the apps land, the Rust CLI does the heavy lifting: clone the repo, seed a voice, synth a text-only bundle into a voiced one.',
    lines: [
      'git clone https://github.com/l1br3-io/taletrek',
      'cd taletrek && just setup',
      'just synth book.taletrek book.synth.taletrek',
    ],
  },
}

export const features = [
  {
    icon: BookOpen,
    title: 'Every common format',
    desc: 'PDF, EPUB, MOBI, TXT, and Markdown — bring what you have.',
  },
  {
    icon: AudioLines,
    title: 'Neural voices',
    desc: 'Piper and Kokoro voices via sherpa-onnx, switchable any time.',
  },
  {
    icon: Lock,
    title: 'Survives screen lock',
    desc: 'Native audio sessions keep the story going after you lock your phone.',
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
    title: 'Offline by default',
    desc: 'Once voices are downloaded, no internet is ever needed.',
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
    a: 'Yes. MIT-licensed, no ads, no subscription, no upsell. The speech engine — sherpa-onnx with Piper and Kokoro voices — is open source too.',
  },
  {
    q: 'Will it keep playing when I lock my phone?',
    a: 'In the native apps, yes — audio runs through the platform’s background audio session with lock-screen controls. The web reader is a demo-class player: on iOS it pauses when the screen locks.',
  },
  {
    q: 'What’s a .taletrek file?',
    a: 'A single portable file carrying your book’s clean text and synthesized audio — the sole interchange format. Write it on the desktop, play it on any surface.',
  },
  {
    q: 'Where are my books stored?',
    a: 'On your devices. Books travel as .taletrek files you own; the web reader keeps imports in local storage on your device. Nothing is uploaded anywhere.',
  },
  {
    q: 'Which devices work?',
    a: 'The desktop processor ships first; Android and iOS follow as free store downloads. Today, any modern browser can open a .taletrek in the web reader.',
  },
  {
    q: 'Can I help?',
    a: 'It’s MIT on GitHub. Issues and pull requests are welcome.',
  },
]
