# DOTDNA → full molecular-biology workspace

Updated: 2026-08-07

This roadmap inventories SnapGene’s publicly documented capability surface and turns it into an independent implementation plan for DOTDNA. “Parity” means users can complete the same scientific workflows with comparable correctness and interoperability; it does not mean copying SnapGene’s interface, code, proprietary datasets, or branding.

## Sources used for the inventory

- [Official SnapGene features](https://www.snapgene.com/features)
- [SnapGene User Guide index](https://support.snapgene.com/hc/en-us/categories/10304176221716-SnapGene-User-Guide)
- [ORF and translation behavior](https://support.snapgene.com/hc/en-us/articles/10383962342804-Show-or-Hide-Translations-and-ORFs)
- [Restriction-site overview behavior](https://support.snapgene.com/hc/en-us/articles/10383861256084-Display-a-Restriction-Site-Overview)
- [Alignment and assembly tools](https://support.snapgene.com/hc/en-us/articles/10527865093524-What-Alignment-and-Assembly-tools-are-Available-in-SnapGene)
- [Restriction digest and gel simulation](https://support.snapgene.com/hc/en-us/articles/10384200576660-Simulate-a-Restriction-Digest)

## What DOTDNA supports now

| Area | Current capability | Next fidelity target |
|---|---|---|
| SnapGene reading | Reads native `.dna` packets, sequence, topology, and simple feature segments | Parse primers, notes, metadata, feature qualifiers/segments, enzyme state, alignments, and history |
| Sequence view | Full sequence, coordinates, motif search, copy, FASTA export | Inline overlays, selection, zoom, editing, translations, primers, and cut markers |
| Features | Displays a scaled annotation map; adds/removes session annotations | Multi-segment features, directionality, qualifiers, CDS translation, introns, point features, persistence, import/export |
| ORFs | Six-frame prediction, forward/reverse colors, minimum length and start-codon controls | Alternate genetic codes, no-start/incomplete ORFs, circular edge-case validation, convert ORF to CDS |
| Restriction sites | Searchable Type II/Type IIS catalog, cutter filters, coordinate overview, circular-origin matching | Full curated enzyme database, cut offsets/overhangs, methylation sensitivity, enzyme sets, noncutters, digest fragments |

## Complete capability inventory

### 1. Projects, files, and document metadata

- Project interface, tabs, folders, side panel, collections, collection areas, multi-file information tables, recent files, drag/drop, search, and batch operations.
- Descriptions, references, accession data, comments, embedded files, dates, authors, custom fields, and searchable metadata.
- Autosave, recovery, duplicate/rename/move, file comparison, sharing, and stable document identifiers.
- DNA, RNA, protein, alignment, trace, contig, and agarose-gel document types.

### 2. DNA/RNA/protein visualization

- Circular and linear maps; circular sequences displayed horizontally when desired.
- Sequence view, map view, split view, minimap, pan/zoom/focus-on-region, selection coordinates, ruler, and large chromosome-scale sequence support.
- Configurable feature labels, primers, enzyme sites, coordinates, translations, line width, blocks of 3/10, compact text, font size, dark mode, and print/export layouts.
- DNA/RNA and amino-acid coloring schemes, GC-content plot, protein-region maps, intramolecular bonds, and single-stranded nucleic-acid secondary structure.
- Sanger trace viewing/editing and accessibility-friendly trace colors.

### 3. Features and annotations

- Create/edit/delete simple, translated, point, and multi-segment features.
- Directionality, feature types, colors, labels, qualifiers, notes, references, cleavage arrows, display priority, and visibility.
- CDS translation, alternate genetic codes, non-ATG starts, ribosomal slippage/frameshifts, translation numbering, and gene-fusion frame checks.
- Introns, splicing, cDNA-to-genome feature creation, and exon-aware translations.
- Standard and custom feature types; import/export/share feature types and feature lists.
- Detect common/custom features and annotate CDS features from exact protein matches.
- Import/export GFF3, GTF, BED, GenBank feature tables, and delimited annotation data.

### 4. Translations and ORFs

- Six reading frames, predicted ORFs, whole-sequence translation, translated feature editing, and one-/three-letter amino-acid display.
- Configurable minimum ORF length, required/allowed start codons, incomplete ORFs at sequence ends, genetic code, and selected reading frames.
- Hover details, protein properties, make protein from DNA, reverse translation, and ORF-to-CDS conversion.
- Gene-fusion reading-frame checks and translated feature numbering across segments.

### 5. Restriction enzymes

- Full enzyme catalog with recognition sequence, top/bottom cut offsets, overhang, prototype/isoshizomers, supplier data, temperature, buffer notes, methylation sensitivity, and star-activity warnings where data is licensed or independently available.
- Predefined supplier/cutter sets, custom sets, import/export, choose/search/sort, show/hide, highlight, and noncutter view.
- Number and line overviews, coordinates, unique/two/multiple-cutter filters, sites inside/outside a selection, and fragment-size reporting.
- Add or remove restriction sites without changing a coding translation.
- Restriction digest fragment calculation for linear/circular molecules, partial digest options, and selected-enzyme actions.

### 6. Primers and oligonucleotides

- Create/edit/delete/show/hide primers on either strand; primer list and map/sequence overlays.
- Hybridization parameters, Tm and secondary-structure calculations, mismatches, tails, phosphorylation, and primer notes.
- Automatic primer design for sequencing, PCR, mutagenesis, cloning, assembly, and feature insertion.
- Anneal oligo pairs into double-stranded products and export/order oligos.

### 7. Sequence editing and synthetic design

- Insert, delete, replace, copy, paste, reverse-complement, translate, circularize, linearize, and edit DNA ends/overhangs.
- Undo/redo with selection preservation and scientific validation.
- Insert feature, codons, restriction site, or back-translated protein; synonymous codon changes; synthetic-construct design and order-ready export.
- Single- versus double-stranded conversion and DNA↔RNA conversion.
- Codon-usage tables, frequency display, reverse translation, and codon optimization/change tools.

### 8. PCR and mutagenesis

- Standard PCR, inverse PCR, overlap-extension PCR, primer-directed mutagenesis, and NEB Q5-style site-directed mutagenesis workflows.
- Primer design/selection, amplicon prediction, product features, end chemistry, polymerase settings, warnings, and product creation.
- Simulated PCR product on agarose gels and procedure documentation in history.

### 9. Molecular cloning and assembly

- Restriction cloning, linear ligation, insert/delete restriction fragments, phosphorylation/dephosphorylation, end compatibility, and orientation checks.
- Gateway cloning with one or multiple inserts.
- Gibson Assembly, NEBuilder HiFi, and In-Fusion with one/multiple inserts and circularization.
- Golden Gate with Type IIS or non-Type-IIS enzymes, multi-fragment assembly, overhang compatibility, and fidelity prediction.
- TA/GC cloning and blunt, TA, and directional TOPO cloning.
- Reaction schematics, input-fragment selection, design warnings, product preview, feature propagation, and automatically recorded procedure history.

### 10. Agarose gels

- Gel documents, configurable agarose percentage, voltage/running time, lanes, labels, dyes, and molecular-weight markers.
- Uncut/supercoiled/nicked/linear DNA behavior, PCR products, restriction digests, partial digests, predicted fragments, and migration estimates.
- Band/fragment selection, details, exports, images, and saved gel layouts.

### 11. Alignment, assembly, traces, and BLAST

- Align Sanger/whole-plasmid reads to a DNA reference; strand/region constraints, repeat placement controls, mismatch/indel/coverage views, and consensus validation.
- Pairwise local/global/semi-global DNA, RNA, and protein alignment.
- Multiple alignment using Clustal Omega, MAFFT, MUSCLE, and T-Coffee-compatible engines; conservation, consensus, sequence logos, reorder/rename, and DNA↔protein alignment conversion.
- De novo Sanger contig assembly compatible with CAP3 behavior; quality trimming, chromatograms, consensus editing, and contig export.
- NCBI BLAST submission/results workflow and similar-sequence search.

### 12. Import, export, and interoperability

- Read/write FASTA, GenBank/DDBJ, EMBL/ENA, Swiss-Prot, GFF3/GTF/BED, common alignment formats, trace formats, and SnapGene documents.
- Import/export or conversion for ApE, CLC Bio, Clone Manager, DNA Strider, DNADynamo, DNASIS, DNAssist, DNASTAR Lasergene, DS Gene, EnzymeX, Gene Construction Kit, Geneious, GeneTool, Genome Compiler, Jellyfish, MacVector, pDRAW32, Serial Cloner, Vector NTI, and Visual Cloning when format specifications and test corpora permit.
- NCBI, Ensembl, Addgene, and published-plasmid import; multi-sequence import; batch conversion; map image/PDF export; command-line conversion and map generation.
- Round-trip preservation tests for sequences, topology, features, primers, references, and history.

### 13. History and provenance

- Immutable operation graph for every edit, cloning step, PCR, assembly, import, and conversion.
- Graphical history view, colored provenance on maps/sequences, rich step metadata, undo/redo, branch/restore, history text/PDF export, and history trimming.
- Reproducible resurrection of intermediate products and comparison of revisions.

### 14. Search and navigation

- Exact and similar nucleotide search, translated protein search across six frames, enzyme/feature/primer search, qualifier/metadata search, and project-wide search.
- Previous/next result navigation, highlights across map/sequence/minimap, reverse-complement matching, IUPAC ambiguity, and circular-origin matches.

### 15. Data management, integrations, and administration

- Collections, project folders, sharing, batch operations, local/network/cloud-drive compatibility, and external file-change handling.
- Dotmatics Bioregister authentication/search/register/similarity workflows and LabArchives exchange.
- Preferences, keyboard/gesture shortcuts, localization, update management, licensing/SSO administration, and cross-platform packaging.

## Recommended architecture

1. **Canonical document model** — versioned schema for DNA/RNA/protein sequences, topology, ends, features/segments/qualifiers, primers, enzyme settings, alignments, traces, history, notes, and attachments.
2. **Format adapters** — independent import/export modules with golden round-trip fixtures; keep SnapGene binary interoperability isolated from the scientific model.
3. **Analysis workers** — Web Workers/WASM for translations, enzyme scanning, primer thermodynamics, alignments, assembly, secondary structure, and gel simulation so large sequences never freeze the interface.
4. **Scientific engine contracts** — every algorithm exposes inputs, assumptions, version, warnings, and deterministic results; UI does not contain scientific logic.
5. **History-first command system** — all mutations are commands with inverse operations and provenance records. This enables undo, graphical history, and reproducibility from day one.
6. **Local-first storage** — browser IndexedDB for projects and preferences, explicit import/export backups, optional encrypted sync later. Never upload sequence data without a clear user action.
7. **Composable views** — shared coordinate/selection model powers circular map, linear map, sequence, minimap, enzyme, feature, primer, translation, alignment, and gel views.

## Phased implementation plan

Estimates are rough single-team engineering ranges and should be refined after technical spikes and acceptance-test design.

### Phase 0 — analysis foundation (complete for this milestone)

- Native `.dna` sequence/topology/basic-feature read.
- Sequence/statistics/motif view and FASTA export.
- Annotation display and session additions.
- Six-frame ORF scan with minimum-length/start controls.
- Common restriction-site catalog with search, cutter filters, circular-origin matching, map, and coordinates.

### Phase 1 — high-fidelity viewer (3–5 weeks)

- Parse every known `.dna` packet used by a representative corpus: feature qualifiers/segments/direction, primers, notes, references, metadata, display settings, alignments, and history.
- Circular/linear plasmid map, minimap, inline sequence overlays, synchronized selection, pan/zoom, labels, and export.
- Snapshot/golden tests against a licensed reference corpus without embedding proprietary data.
- Deliverable: reliable browser replacement for SnapGene Viewer workflows.

### Phase 2 — complete translations and enzymes (3–5 weeks)

- Genetic-code selector, incomplete/no-start ORFs, translated features, introns, frameshifts, alternative starts, protein export, and ORF→CDS.
- Independent full enzyme dataset, cut geometry, overhangs, methylation, enzyme sets, noncutters, fragment sizes, and digest engine.
- Deliverable: analysis parity for translations, ORFs, restriction sites, and digests.

### Phase 3 — editor, annotations, and formats (5–8 weeks)

- Transactional sequence editing, ends/topology, multi-segment features, qualifiers, primers, custom feature types, and undo/redo command bus.
- GenBank/EMBL/GFF/BED/FASTA/protein import/export plus map/PDF/image exports.
- History model begins recording all edits and imports.
- Deliverable: day-to-day sequence editing and annotation parity.

### Phase 4 — primers, PCR, and mutagenesis (5–8 weeks)

- Primer thermodynamics/design, overlays, ordering exports, PCR/inverse PCR/overlap PCR, mutagenesis, amplicon products, and warnings.
- Validate calculations with published standards and independently generated fixtures.
- Deliverable: routine primer and amplification design workflows.

### Phase 5 — cloning and assembly (8–12 weeks)

- Restriction/ligation, Gibson, NEBuilder, In-Fusion, Golden Gate, Gateway, TA/GC, and TOPO workflows.
- Fragment-end chemistry, compatibility engine, feature propagation, reaction schematics, warnings, and history records.
- Deliverable: major in-silico cloning workflows with reproducible products.

### Phase 6 — gels, alignments, and sequencing verification (8–12 weeks)

- Agarose gel/digest simulation and configurable markers.
- Pairwise/multiple alignment engines, Sanger trace-to-reference, coverage/mismatch UI, consensus, and CAP3-compatible contig assembly.
- BLAST handoff and results import.
- Deliverable: construct verification and gel-planning workflows.

### Phase 7 — projects, history, batch work, and collaboration (6–10 weeks)

- Collections/projects, multi-file tables/search, local-first persistence, backups, batch conversion, graphical history, restoration, and comparison.
- Optional encrypted synchronization and controlled sharing.
- Deliverable: complete daily workspace and provenance workflows.

### Phase 8 — advanced sequence design and integrations (6–10 weeks)

- RNA/protein documents, protein properties, secondary structure, codon tables/optimization, synthetic design/order export, and remaining specialist formats.
- Bioregister/LabArchives-style integration adapters, CLI, localization, accessibility, enterprise controls, and packaging.
- Deliverable: remaining long-tail capability and administration parity.

## Quality gates for every phase

- Scientific results have deterministic unit tests, edge cases for circular and ambiguous sequences, and documented assumptions.
- Format work has round-trip tests and corruption/fuzz testing; original input files are never overwritten by default.
- Large-sequence performance is measured; heavy computation is cancellable and leaves the UI responsive.
- Accessibility includes keyboard operation, high-contrast/color-independent cues, readable tables, and reduced motion.
- Privacy is explicit: local processing by default, clear consent for every network operation, and no hidden analytics on sequence contents.
- Parity claims require workflow-level acceptance tests against current official documentation and a legally obtained reference installation.

## Immediate next sprint after this milestone

1. Complete the `.dna` packet inventory and add multi-segment/directional feature parsing.
2. Build synchronized circular map + sequence overlays for features, ORFs, and enzyme cut positions.
3. Add cut offsets/overhangs and restriction-fragment calculations to the enzyme engine.
4. Convert predicted ORFs into editable CDS annotations with translated protein export.
5. Establish the history command model before sequence editing begins.
