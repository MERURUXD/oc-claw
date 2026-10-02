# Patched tao 0.34.8

Unmodified crates.io `tao 0.34.8` source except:

- `src/platform_impl/windows/event_loop/runner.rs`: `EventLoopRunnerShared` is `Arc` instead of `Rc`.
- `src/platform_impl/windows/event_loop.rs`: the runner is created with `Arc::new`.
- `Cargo.toml`: example targets removed because `examples/` is not vendored.

Why: `tauri-runtime-wry` keeps tao's `EventLoopWindowTarget` inside a context that is
`Clone + Send + Sync`, so every `AppHandle`/window/webview clone or drop off the main
thread also clones or drops the runner handle. With a non-atomic `Rc` those updates race
with the main thread, the count reaches zero while the event loop still runs, and the
process crashes with heap corruption (`0xc0000374`), access violations (`0xc0000005`) or
`ud2` (`0xc000001d`). Upstream: tauri-apps/tauri#15408, tauri-apps/tao#1290.

Remove this directory and the `[patch.crates-io]` entry once a tauri release fixes it.
