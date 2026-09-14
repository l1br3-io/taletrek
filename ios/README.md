# TaleTrek for iOS

The SwiftUI app over the Rust kernel (`crates/ffi` via UniFFI Swift bindings,
`TaleTrek/FFI/`). Hand-rolled checked-in Xcode project — no cargo-mobile2,
no xcodegen; Xcode never invokes Cargo (`just ios-kernel` / `just ios-bindings`
build the kernel and bindings, mirroring the Android doctrine).

## Status (task 003 — the link spike)

**Linux-authored, Mac-unverified.** This skeleton was committed from the
Linux box (research + authoring); the acceptance criteria — `just ios`
build, simulator smoke, hardware install — verify on the Mac:

```
git pull && just ios && just ios-test
```

Fill this README's *Environment* section with the exact versions when the
first Mac run lands, and record every linking trap beside the `ios-kernel`
recipe in the root `justfile` (android-T1 precedent).

## Environment (fill in on first Mac run)

- Xcode: __ (15+ assumed; project format 56 / "Xcode 14.0" compatible)
- Simulator OS: __ (iOS 17+)
- Signing: simulator runs unsigned; for `just ios-install` set
  `DEVELOPMENT_TEAM` in the project or pass
  `DEVELOPMENT_TEAM=<team> IOS_DEVICE_ID=<udid>` (device signing needs a
  paid Apple Developer team — `xcrun devicectl list devices` for the udid).
- Prereqs: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`,
  `cmake` (libopus cross-build), `cargo install uniffi --features cli
  --version 0.32.0 --locked` (bindings regen).

## Layout

```
TaleTrek.xcodeproj/          checked-in project (app + unit-test targets)
TaleTrek/                    app sources; FFI/ = generated Swift (never hand-edited)
TaleTrek/Vendor/             GITIGNORED — `just ios-kernel` populates:
                             libtaletrek_ffi.a per PLATFORM_NAME + SherpaOnnxC.xcframework
TaleTrekTests/               app-hosted XCTest (kernel smoke over book-playable.taletrek)
.swiftlint.yml               style gate; FFI/ excluded
```

## The linking story (how the kernel crosses)

1. `just ios-kernel` runs `cargo rustc -p taletrek-ffi --lib --crate-type
   staticlib` for `aarch64-apple-ios` + `aarch64-apple-ios-sim`; sherpa-onnx-sys
   (forced shared on iOS) auto-downloads
   `sherpa-onnx-v<ver>-ios-shared-onnxruntime-static.xcframework.zip` —
   onnxruntime is statically **inside** the SherpaOnnxC dylib — and the
   recipe copies the xcframework + both `.a`s into `TaleTrek/Vendor/`.
2. The app links the static lib via `OTHER_LDFLAGS = -ltaletrek_ffi -lc++`
   and `LIBRARY_SEARCH_PATHS = …/Vendor/$(PLATFORM_NAME)` (settings switch
   device/simulator; staticlibs drop rustc link directives, so the app
   supplies them). The generated Swift finds its C half via
   `SWIFT_INCLUDE_PATHS = $(SRCROOT)/TaleTrek/FFI` (modulemap).
3. `SherpaOnnxC.xcframework` links + embeds (CodeSignOnCopy) — the jniLibs
   analogue; Xcode auto-selects the slice.
