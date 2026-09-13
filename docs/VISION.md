# Vision

> **Status:** Living document — the "why" behind TaleTrek.
> **Owner:** TaleTrek Team — **l1br3** *(pronounced "libre")*
> **Tagline:** *"Every story is a journey."*

TaleTrek is a free, open-source **reading companion** — a product of the **l1br3** organization (pronounced "libre") — that turns any ebook or document into an audiobook you can listen to anywhere. Feed it an EPUB, PDF, DOCX, HTML, Markdown, or plain-text file and TaleTrek reads it aloud using text-to-speech that runs entirely on your device — no cloud, no API keys, no subscriptions. It strips out links, images, footnotes, and other noise so only the story flows, then plays it as background audio that survives screen lock, app switching, and phone closure. You go for a run; your book comes with you.

TaleTrek is a **Rust kernel with platform-native apps**: one shared core (parsing, synthesis, encoding) exposed to SwiftUI on iOS, Jetpack Compose on Android, and a native desktop UI — each app speaking its platform's own idiom. Synthesis runs in-process via the OSS [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) engine (Piper and Kokoro voices), and native audio sessions make background playback, lock-screen controls, and car integration first-class. Books travel between surfaces as portable `.taletrek` files — the sole interchange format. The desktop processor is the workhorse (file in → synth → `.taletrek` out); the phone apps are players; the **web is a landing page plus a `.taletrek` reader** — file-open only, no upload, no synthesis, no accounts. Apps ship to the stores as free downloads. Nothing leaves your device.

The app is free. The TTS engine is free. The books are yours. That's the disruption: competitors charge $15+ for a one-time purchase or lock you into cloud-based subscription TTS; TaleTrek charges nothing and lets your device do all the work. Open-source, offline-first, and yours to fork.

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

TaleTrek solves this with one Rust kernel doing parsing, cleaning, and synthesis in-process via sherpa-onnx — pre-rendering text into audio and playing it through native audio sessions that iOS and Android **both guarantee** keep running in the background. The story arrives on your phone as a `.taletrek` bundle; native apps (and, in demo class, the web reader) play it hands-free. No cloud, no cost, no compromise. This is the native pivot of [ADR-0015](./adrs/0015-native-pivot-rust-kernel-and-native-apps.md): the product problem was never hard — the browser platform was, so the pipeline moved into a kernel.

---

## Goals

The read-aloud core — parse any document, clean the audio stream, speak it on-device, play it background-safe, fully offline, for free — is the product. The kernel re-foundations it off the web platform's constraints. Ship history lives in [`CHANGELOG.md`](../CHANGELOG.md); the current phase and forward direction live in [`ROADMAP.md`](./ROADMAP.md). This vision does not track feature checkboxes — it states the *why* that the rest of the planning hierarchy decomposes.

### Non-goals (explicitly out of scope)

**Not shipping in the native launch:**

- Cloud-based TTS voices — all synthesis runs in-process via sherpa-onnx; no audio or text is sent to or processed by a server.
- A hosted cloud library or sync — books live on the device (or travel as `.taletrek` files the user manages); no account, no TaleTrek-operated cloud. (The former self-hosted personal-server track was deleted by [ADR-0015](./adrs/0015-native-pivot-rust-kernel-and-native-apps.md); any sync/cloud return requires a new ADR.)
- Online ebook store or library integration — users bring their own files.
- Real-time speech recognition / voice commands.
- Multi-user or social features (sharing notes, ratings, reading groups).
- On-device mobile synthesis — *deferred here to "later, once the kernel is proven"; the deferral is now spent: on-device conversion shipped on Android via [ADR-0016](./adrs/0016-on-device-pipeline-android.md).* AI transforms remain later desktop-processor features — they require re-synth, so they belong where synthesis's UI lives.

**Across all phases — NOT building:**

- Paid tiers or subscriptions — the apps are always free downloads; sustainability comes from community contributions and the open-source model, never paywalls.
- Cloud dependency for the *default* experience — the entire read-aloud pipeline works offline; the internet is only needed to download the apps and optional voice models.
- A TaleTrek-operated hosted cloud or multi-tenant SaaS — there is no TaleTrek-run backend, and the web reader is deliberately file-open-only.
- DRM circumvention — TaleTrek reads files the user already has; it does not strip or bypass copy protection.

---

## Who it's for

| Persona | Description | Key need |
|---------|-------------|----------|
| **The Jogger / Runner** *(primary)* | Wants to listen to books while exercising; phone is locked, earbuds in, hands free | Native background playback that survives screen lock; lock-screen controls; skip junk so the story flows uninterrupted |
| **The Commuter** | Walks, cycles, or takes transit; wants hands-free reading | Synth on the desktop once, listen on the go anywhere; resume where they left off |
| **The iOS User** | Wants a free, open-source TTS reader on iPhone — a category that barely exists | A native App Store app, free, with background playback that actually works |
| **The Privacy-Conscious Reader** | Doesn't want their reading material sent to cloud TTS servers | Entirely on-device processing; nothing leaves the phone |
| **The Budget Reader** | Can't justify $15–20 for Voice Dream Reader or a cloud TTS subscription | Free, forever — no purchase, no trial, no upsell |
| **The Open-Source Advocate** | Values FOSS; may want to fork or contribute | MIT-licensed, hackable, community-driven |

---

## Where this fits

This vision is the top of the planning hierarchy — the *why*. Direction,
milestones, and the delivery lifecycle (DEFINE → PLAN → BUILD → VERIFY →
REVIEW → SHIP) live in [`ROADMAP.md`](./ROADMAP.md).
