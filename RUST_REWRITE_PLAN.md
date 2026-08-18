# DOTDNA Tauri + Rust rewrite

## Current milestone status

The installed `0.1.0` milestone completes the native foundation, Rust document
and file-format engine, coordinate-safe sequence editing, actionable primer
validation, nearest-neighbor scoring, standard/inverse/overlap-extension PCR,
deterministic products, conflict-aware New/Open/Save/Save As workflows, bounded
undo/redo, native macOS menus, and the initial
Map/Sequence/Features/Primers/History workbench. Controls for folder projects,
feature and primer authoring, digest, assembly, alignment, translation, split
views, and crash recovery remain visibly disabled and are later parity phases;
this milestone is not represented as a pixel-for-pixel or full-feature SnapGene
replacement.

## Product decisions

- Implementation: Tauri 2 desktop shell with React + TypeScript for the workbench, PixiJS for interactive graphical views, and Rust for file I/O and scientific logic. Electron is not used.
- Platform: macOS on Apple Silicon.
- Migration: clean rewrite alongside the current application until feature and data parity are verified.
- Appearance: always-dark, near-black, compact laboratory workspace. The layout and interaction density should closely follow the familiar macOS SnapGene workspace while retaining the DOTDNA name and original assets.
- Typography: SF Mono when available, followed by Menlo, Monaco, and a system monospace fallback.
- Documents: real filesystem folders, multiple remembered document tabs, preview and permanent tabs, drag-and-drop, native shortcuts, direct sequence editing, continuous crash recovery, and explicit saved/unsaved state.
- Views: Map, Sequence, Features, Primers, and History. Map and Sequence selections are synchronized and can be shown in a split view.
- Actions: PCR, assembly, digest, alignment, and translation open as guided temporary workflow tabs.
- History: preserve ancestral documents and deterministic products, not only text descriptions.
- Performance: virtualized sequence rendering with smooth interaction through at least 10 Mb.
- Distribution: signed and notarized Apple Silicon application.

## Architecture

The desktop implementation lives under `native/`:

- `dotdna-core`: document model, coordinate system, editing, annotations, analysis, primers, thermodynamics, PCR, cloning, translation, alignment, and history records. It has no GUI dependency.
- `dotdna-io`: SnapGene, GenBank, FASTA, plain DNA, DOTDNA project, recovery, and filesystem project handling.
- `src/`: React workbench, document state, views, inspectors, workflows, accessibility, and PixiJS canvases.
- `src-tauri`: Apple Silicon application entry point, typed Rust commands, native dialogs, filesystem access, packaging metadata, signing, and notarization.

The current TypeScript implementation remains the behavioral reference until the final acceptance gate. New Rust tests will use the same deterministic fixtures and expected sequences.

## Coordinate rules

- Internal coordinates are zero-based and half-open: `[start, end)`.
- File formats and visible UI coordinates are converted at the boundary to one-based inclusive coordinates.
- Circular origin-spanning annotations are represented as ordered segments rather than an invalid reversed interval.
- Editing operations return a new document state and an explicit coordinate remapping result.

## Implementation steps and gates

### 1. Foundation

1. Pin the stable Rust toolchain and Apple Silicon target.
2. Create the three-crate Rust workspace plus the React/Pixi frontend.
3. Establish formatting, Clippy, unit-test, and release-build commands.
4. Build a launchable always-dark application shell.

Gate: `cargo fmt --check`, `cargo clippy --workspace --all-targets`, `cargo test --workspace`, and a release build all pass.

### 2. Document model and file compatibility

1. Port sequence normalization, topology, strands, features, segments, qualifiers, primers, notes, packets, and document statistics.
2. Port FASTA, plain DNA, GenBank, DOTDNA project, and SnapGene parsing.
3. Port GenBank, FASTA, and DOTDNA export.
4. Add fixtures shared with the TypeScript reference tests.
5. Define explicit errors for corrupt, unsupported, and partially recoverable documents.

Gate: Rust imports and exports match the reference fixtures, including topology, coordinates, primers, notes, and feature metadata.

### 3. Biological operations

1. Port reverse complement, insert/delete/replace, topology changes, and annotation remapping.
2. Port restriction-site discovery, circular-origin sites, digest products, ORFs, motif search, and translation.
3. Port primer binding, nearest-neighbor thermodynamics, tails, mismatches, structural warnings, and primer design.
4. Port standard PCR, inverse PCR, and overlap-extension PCR with deterministic annotated products.
5. Port exact-overlap, directional restriction, and Golden Gate assembly.
6. Port pairwise alignment and formatted verification output.

Gate: every deterministic TypeScript test has an equivalent Rust test with identical biological results.

### 4. Workspace state and migration

1. Implement multiple documents, preview/permanent tabs, dirty state, undo/redo, and generated-product tabs.
2. Implement immutable operation history with recoverable ancestors.
3. Implement atomic recovery writes and corrupt-recovery isolation.
4. Import the Electron recovery payload once, preserve a backup, and record migration completion.
5. Implement real-folder projects, recent files, search, and restored tabs/panel geometry.

Gate: forced termination and relaunch restore all open documents and history without modifying the source files.

### 5. Native workspace shell

1. Implement the top macOS menu and compact command toolbar.
2. Implement the collapsible project sidebar.
3. Implement draggable document tabs and temporary previews.
4. Implement the automatic right inspector.
5. Implement bottom view tabs and the persistent information/status bar.
6. Persist all panel sizes, visibility, split ratios, and last active views.

Gate: the shell matches approved reference screenshots at fixed window sizes and remains usable at the minimum supported size.

### 6. Map and Sequence views

1. Build a PixiJS interactive circular/linear plasmid painter.
2. Add feature, primer, enzyme, ORF, translation, label, and selection layers.
3. Build a virtualized monospaced sequence renderer with direct editing and drag selection.
4. Add complement, fixed/wrapped widths, zoom, minimap, focus-on-region, and visibility controls.
5. Synchronize selection, scrolling, and inspector state between Map and Sequence.
6. Add split Map/Sequence and Sequence/Alignment layouts.

Gate: smooth pan, zoom, selection, and editing through 10 Mb without rendering the full sequence into widgets each frame.

### 7. Supporting views and workflows

1. Implement sortable/editable Features and Primers views.
2. Implement visual History with reopenable ancestors and products.
3. Implement guided PCR, assembly, digest, alignment, and translation tabs.
4. Keep invalid designs visible with blocking and advisory remediation messages.
5. Open deterministic products as new documents with propagated features and history links.

Gate: all current DOTDNA workflows are available without navigating a vertically scrolling page.

### 8. macOS completion

1. Add native shortcuts, context menus, file associations, drag-and-drop, and Finder open events.
2. Add accessibility labels, keyboard focus order, reduced-motion behavior, and adjustable font sizes.
3. Add visual regression snapshots and performance benchmarks.
4. Create the `.app`, sign with Developer ID, notarize, staple, and build the installer.
5. Install alongside a recoverable backup and run migration/rollback acceptance tests.

Gate: signed release launches without Gatekeeper warnings, imports the current workspace, passes all parity tests, and leaves the TypeScript build available for rollback.

### 9. Cutover and publication

1. Run the complete Rust and reference test suites.
2. Record any intentional compatibility differences.
3. Publish the rewrite branch and a draft pull request.
4. Remove the Electron application only after explicit acceptance of the native build.
