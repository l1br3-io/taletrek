# TaleTrek for iOS

The SwiftUI app over the Rust kernel (`crates/ffi` via UniFFI Swift bindings,
`TaleTrek/FFI/`). Hand-rolled checked-in Xcode project — no cargo-mobile2,
no xcodegen; Xcode never invokes Cargo (`just ios-kernel` / `just ios-bindings`
build the kernel and bindings, mirroring the Android doctrine).

## Status (task 003 — the link spike)

**Verified via the e2e CI path** (run `34978225901` on a `macos-15` arm64
runner): `just ios-kernel` cross-builds both Apple-target static libs +
vendors the sherpa xcframework, `just ios` builds the app for the
simulator, `just ios-test` runs `KernelSmokeTest` (2/2) on an iPhone 16
simulator — the app-hosted test boots the app. The local Mac loop
(`git pull && just ios && just ios-test`) is equivalent and remains the
comfortable dev path; the linking traps live in the ledger below and in
the `ios-kernel` recipe's comments.

## Environment

- Runner/CI: `macos-15` (arm64), Xcode **16.4** (`Xcode_16.4.app`), iPhoneSimulator **18.5** SDK, destination `platform=iOS Simulator,name=iPhone 16` (the justfile default)
- Simulator OS: iOS 18.5 (project min iOS 17)
- Signing: simulator runs unsigned; for `just ios-install` set
  `DEVELOPMENT_TEAM` in the project or pass
  `DEVELOPMENT_TEAM=<team> IOS_DEVICE_ID=<udid>` (device signing needs a
  paid Apple Developer team — `xcrun devicectl list devices` for the udid).
- Prereqs: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`,
  `cmake` (libopus cross-build), `just` (NOT preinstalled on macOS —
  `brew install just`), `cargo install uniffi --features cli --version
  0.32.0 --locked` (bindings regen).

## The pbxproj trap ledger (paid on CI, 2026-09-15)

1. **Group-relative paths**: a fileRef's `path` resolves against its parent
   group — `TaleTrek/Vendor/...` inside the `TaleTrek` group doubled into
   `TaleTrek/TaleTrek/Vendor`. Keep refs group-relative (`Vendor/...`).
2. **`module.modulemap`**: clang auto-discovers only that exact name in
   `SWIFT_INCLUDE_PATHS` dirs; uniffi emits `<module>FFI.modulemap`. The
   `ios-bindings` recipe owns the rename — never check in the generated
   name.
3. **Simulator slices**: the generic-sim destination builds x86_64 too on
   Xcode 16; the kernel ships arm64-only
   (`EXCLUDED_ARCHS[sdk=iphonesimulator*] = x86_64` in all four configs).
4. **SOURCE_ROOT is `ios/`**: repo-tree references need exactly one `..`
   (`../crates/...`); two hops leave the checkout.
5. **`@testable import`** requires `ENABLE_TESTABILITY = YES` on the app's
   Debug config (Xcode templates set it; hand-rolled projects forget).

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
