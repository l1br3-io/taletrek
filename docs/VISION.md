# Vision

> **Status:** Living document — the "why" behind TaleTrek.
> **Owner:** TaleTrek Team — **l1br3** *(pronounced "libre")*
> **Tagline:** *"Every story is a journey."*

TaleTrek is a free, open-source **reading companion** — a product of the **l1br3** organization (pronounced "libre") — that turns any ebook into an audiobook you can listen to anywhere. Upload a PDF, EPUB, MOBI, or TXT file and TaleTrek reads it aloud using text-to-speech that runs entirely on your device — no cloud, no API keys, no subscriptions. It strips out links, images, footnotes, and other noise so only the story flows, then plays it as background audio that survives screen lock, app switching, and phone closure. You go for a run; your book comes with you.

TaleTrek ships as a **Progressive Web App (PWA)**: no app store, no install friction, no $99/year developer fee. Open a URL on iOS or Android, pick a book, and start listening. Add it to your home screen and it behaves like a native app — offline, full-screen, with lock-screen playback controls. The entire pipeline — file parsing, text cleaning, speech synthesis, and audio playback — runs in the browser. Nothing leaves your device.

The app is free. The TTS engine is free. The books are yours. That's the disruption: competitors charge $15+ for a one-time purchase or lock you into cloud-based subscription TTS; TaleTrek charges nothing and lets your phone do all the work. Open-source, offline-first, and yours to fork.

**Product positioning:** *"Your books, read aloud — anywhere, hands-free. Free, by l1br3."*

---

## The problem

People want to consume books while doing other things — jogging, commuting, cooking, walking. Audiobooks solve this but cost money and are limited to titles someone has narrated. Text-to-speech (TTS) can read any digital book aloud, but existing solutions all impose friction, cost, or platform lock-in:

- **Apple Books + Spoken Content** — Free and built into iOS, but the TTS experience is an afterthought: no link or image skipping, no voice choice, clunky controls, and no continuous "read me a chapter while I run" flow.
- **Voice Dream Reader** — The gold standard for iOS TTS reading with excellent link/image/footnote skipping and voice selection, but it's **paid (~$15–20)** and **closed-source**.
- **KOReader / Librera Reader** — Open-source and free with solid TTS, but **Android and Linux only** — no iOS app exists.
- **Web-based TTS readers** (TTSReader, NaturalReader web) — Work in a browser but use the live Web Speech API, which **iOS kills the moment the screen locks**. Audio dies mid-sentence. Unusable for jogging.
- **Cloud TTS APIs** (Google, AWS, OpenAI) — High-quality voices, but **cost money per character**, require internet, and send your book text to a third-party server.

The core pains:

1. **No free + open-source option on iOS** — the best open-source readers don't exist on iOS, and the best iOS readers aren't free or open.
2. **Background TTS is broken on iOS web** — the Web Speech API dies when the screen locks, making browser-based readers useless for active use.
3. **Junk in the audio stream** — links get read as "h-t-t-p-s-colon-slash-slash," image alt-text interrupts the narrative, and footnotes derail the flow. Most readers don't filter these.
4. **No voice choice without paying** — free TTS readers offer one or two generic voices; good neural voices are locked behind paid apps or cloud subscriptions.
5. **Privacy concerns** — cloud-based TTS sends your personal reading material to third-party servers.
6. **Cost** — recurring subscriptions or one-time purchases for features that should be free and open.

TaleTrek solves this by running a neural TTS engine (Piper) entirely in the browser via WebAssembly, pre-rendering text into audio chunks, and playing them through the standard `<audio>` element — which iOS and Android **both guarantee** will keep playing in the background. No cloud, no cost, no compromise.

---

## Goals

| Goal | Target |
|------|--------|
| Listen to any ebook hands-free, phone locked | Audio survives screen lock, background, and app closure on iOS and Android |
| Read every common ebook format | PDF, EPUB, MOBI, and TXT supported at launch |
| Clean audio — only the story | Links, images, footnotes, page numbers, and headers automatically skipped |
| Choose your voice | Multiple Piper TTS voices available, switchable at runtime |
| Works fully offline | After first load, no internet connection required — books, TTS, and playback all run on-device |
| Zero cost to the user | $0 — no app purchase, no subscription, no cloud fees |
| No app store needed | Installable PWA — works from a URL on iOS and Android |
| Read comfortably on any screen | Responsive from phone to desktop — reader controls, chapter outline, and navigation adapt to a small screen |
| Refine any paragraph on the fly | Per-paragraph transforms (AI or deterministic) fix OCR noise, change casing, or translate just the line you're on |
| Fast from upload to audio | First audio plays within seconds of selecting a book |
| Open source | MIT-licensed, forkable, community-driven |

### Non-goals (explicitly out of scope)

**At launch — NOT shipping:**

- Cloud-based TTS voices — all synthesis runs on-device via Piper WASM; no audio is sent to or processed by a server.
- Cloud storage or syncing — books live in the browser's IndexedDB; no account, no cloud sync.
- Online ebook store or library integration — users bring their own files.
- Real-time speech recognition / voice commands.
- Multi-user or social features (sharing notes, ratings, reading groups).
- Native app store distribution — the product is a PWA; a native wrapper (Capacitor) is a possible future direction, not a launch goal.

**Across all phases — NOT building:**

- Paid tiers or subscriptions — the app is always free; sustainability comes from community contributions and the open-source model, never paywalls.
- Cloud dependency for core functionality — the entire read-aloud pipeline works offline; the internet is only needed for the initial page load and optional voice model downloads.
- Server-side processing of user content — no user book text or audio ever leaves their device.
- DRM circumvention — TaleTrek reads files the user already has; it does not strip or bypass copy protection.

---

## Who it's for

| Persona | Description | Key need |
|---------|-------------|----------|
| **The Jogger / Runner** *(primary)* | Wants to listen to books while exercising; phone is locked, earbuds in, hands free | Background playback that survives screen lock; lock-screen controls; skip junk so the story flows uninterrupted |
| **The Commuter** | Walks, cycles, or takes transit; wants hands-free reading | Upload once, listen on the go; resume where they left off |
| **The iOS User** | Wants a free, open-source TTS reader on iPhone — a category that barely exists | Works on iOS without an app store, without paying, without background playback dying |
| **The Privacy-Conscious Reader** | Doesn't want their reading material sent to cloud TTS servers | Entirely on-device processing; nothing leaves the phone |
| **The Budget Reader** | Can't justify $15–20 for Voice Dream Reader or a cloud TTS subscription | Free, forever — no purchase, no trial, no upsell |
| **The Open-Source Advocate** | Values FOSS; may want to fork, contribute, or self-host | MIT-licensed, hackable, community-driven |

---

## Where this fits

This vision is the top of the planning hierarchy. Direction and milestones live in [`ROADMAP.md`](./ROADMAP.md).

```text
VISION   "What problem does this project solve?"     VISION.md  (this)
  │
ROADMAP  "What directions / milestones?"              ROADMAP.md
  │
PRDs     "Detailed requirements per area"            docs/prds/   (forthcoming)
  │
EPICS    "Trackable feature groups"
  │
ISSUES   "Specific, actionable work items"
  │
PRs      "Implementation against issues"
  │
RELEASES "Ship it, tag it, communicate it"
```
