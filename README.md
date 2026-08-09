# DOTDNA

DOTDNA is a local-first DNA and plasmid workspace. It opens SnapGene, GenBank,
FASTA, DOTDNA project, and raw DNA files; visualizes maps and annotations; and
supports sequence editing, ORF and restriction-site analysis, primers, PCR,
translation, assembly, alignment, and export.

Sequence data is processed on the device. The standalone Mac app runs its own
loopback-only web server and does not require the hosted DOTDNA site or an
internet connection.

## Web development

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run build
node --test tests/*.test.mjs
npm run lint
```

## Standalone Mac app

Install the desktop packaging dependencies once:

```bash
npm install
npm install --prefix desktop
```

Build a universal DMG that contains both Apple silicon and Intel code:

```bash
npm run desktop:dmg
```

The installer is written to `release/`. The desktop build first creates a
Next.js standalone bundle, copies its static assets into that bundle, and then
packages it with Electron. At runtime Electron starts the bundle on a random
loopback port and opens it in the native application window.

For a faster architecture-specific local build:

```bash
npm run build:desktop-web
npm --prefix desktop run dist:arm64
npm --prefix desktop run dist:x64
```

## Signing and notarization

Unsigned development DMGs can be opened with Finder's **Open** command, but a
frictionless download-and-install experience requires an Apple Developer ID
Application certificate and Apple notarization.

The GitHub Actions workflow supports these repository secrets:

- `CSC_LINK`: base64-encoded Developer ID Application certificate (`.p12`)
- `CSC_KEY_PASSWORD`: password for that certificate
- `APPLE_ID`: Apple account used for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for that account
- `APPLE_TEAM_ID`: Apple Developer team identifier

With those secrets configured, tagged builds are signed and notarized. Without
them, the workflow still produces an unsigned universal DMG artifact for
testing.

## Releases

`.github/workflows/macos-dmg.yml` can be run manually. Tags matching `v*`
also build the DMG and attach it to a GitHub release.

## Privacy

The desktop server binds only to `127.0.0.1`. DOTDNA does not upload sequence
files unless a future feature explicitly asks the user to do so.
