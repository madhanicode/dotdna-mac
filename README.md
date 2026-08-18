# DOTDNA

DOTDNA is a local-first DNA and plasmid workbench for Apple-silicon Macs. The
native Tauri shell and molecular-biology engine are written in Rust; React owns
the document workbench and PixiJS accelerates circular and linear maps.

The native rewrite opens SnapGene, GenBank, FASTA, DOTDNA project, and raw DNA
files; visualizes maps, features, primers, history, and restriction sites; edits
sequences while remapping annotation coordinates; and simulates standard,
inverse, and overlap-extension PCR. Primer tails and intentional mismatches are
included in products while only the explicit 3′ binding region is validated and
thermodynamically scored. It also creates new DNA documents and provides native
New, Open, Save, and Save As workflows with unsaved-change protection and
conflict-aware atomic project writes. Controls that are not implemented yet are
visibly disabled rather than showing synthetic scientific results.

The project sidebar can scan real folders for supported DNA documents without
following symlinks or indexing dependency/build caches. The command palette
(`⌘K`) exposes the implemented file, view, annotation, search, and PCR actions
with the same safety guards as the toolbar and native macOS menus.

Sequence data is processed entirely on the device. The Tauri application does
not start a local server and does not require the hosted DOTDNA site.

## Native development

Requirements: Apple-silicon macOS 13+, Rust stable, Node.js 22.13+, and pnpm 10.

```bash
pnpm install
pnpm --dir native tauri:dev
```

Useful checks:

```bash
pnpm --dir native test
pnpm --dir native build
cd native && cargo fmt --all --check
cd native && cargo clippy --workspace --all-targets -- -D warnings
cd native && cargo test --workspace
```

## Standalone Mac app

The current native rewrite builds an Apple-silicon app and a deterministic
drag-to-Applications DMG without depending on Finder automation:

```bash
pnpm --dir native tauri:build
```

The app bundle and installer are written below
`native/target/aarch64-apple-darwin/release/bundle/`.

## Signing and notarization

Local builds are ad-hoc signed for development. A frictionless downloadable
installer requires an Apple Developer ID Application certificate and Apple
notarization.

Tagged GitHub Actions releases require these repository secrets:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application certificate (`.p12`)
- `APPLE_CERTIFICATE_PASSWORD`: password for that certificate
- `APPLE_SIGNING_IDENTITY`: full Developer ID Application identity
- `APPLE_ID`: Apple account used for notarization
- `APPLE_PASSWORD`: app-specific password for that account
- `APPLE_TEAM_ID`: Apple Developer team identifier

The workflow fails closed when any signing or notarization secret is missing;
it never uploads or publishes an unsigned release DMG. Local builds remain
available for internal testing.

## Releases

`.github/workflows/macos-dmg.yml` can be run manually. Tags matching `v*`
also build the DMG and attach it to a GitHub release.

## Privacy

DOTDNA does not upload sequence files unless a future feature explicitly asks
the user to do so.
