# DOTDNA for macOS

This directory contains DOTDNA's Apple Silicon desktop application. Tauri provides the macOS shell, Rust owns the molecular-biology and file-format engine, React owns the workbench UI, and PixiJS renders interactive plasmid graphics.

## Development

```sh
pnpm install
pnpm tauri:dev
pnpm test
cargo fmt --all --check
cargo clippy --workspace --all-targets
cargo test --workspace
```

The application is scoped to Apple Silicon macOS. The current workspace contains only the production Tauri shell, shared Rust biology engine, and format I/O crate; the superseded egui prototype has been removed.
