# TaleTrek FFI — generated Swift bindings

**Generated code — never hand-edit.** These files are produced by UniFFI
0.32 from the proc-macro surface in [`crates/ffi`](../../../crates/ffi)
and checked in (Xcode never invokes Cargo — the Gradle-never-invokes-Cargo
doctrine, transposed). Regenerate after any `crates/ffi` surface change:

```
just ios-bindings
```

(Host-built cdylib → `uniffi-bindgen generate --language swift`; runs on
Linux or macOS. The bindgen version must match the crate's `uniffi`
dependency — API checksums are verified at load.)

| File | Role |
| --- | --- |
| `taletrek_ffi.swift` | The Swift API: `openBook`, `readSegment`, `decodeSegment`, `TrekPlayer`, `PipelineHandle`, voices/espeak |
| `taletrek_ffiFFI.h` | The C header for the static lib's extern surface |
| `taletrek_ffiFFI.modulemap` | Clang module for the header (linked against `libtaletrek_ffi.a` from `just ios-kernel`) |

Compile validation is the Xcode project's (task 003); this directory only
claims generation is stable and committed.
