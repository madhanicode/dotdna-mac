use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_HISTORY_ENTRIES: usize = 128;
const MAX_EMBEDDED_PARENT_BASES: usize = 2_000_000;

/// Zero-based, half-open coordinates: `[start, end)`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SequenceSpan {
    pub start: usize,
    pub end: usize,
}

impl SequenceSpan {
    #[must_use]
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    #[must_use]
    pub const fn len(self) -> usize {
        self.end.saturating_sub(self.start)
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start >= self.end
    }

    #[must_use]
    pub const fn is_valid_for(self, sequence_length: usize) -> bool {
        self.start < self.end && self.end <= sequence_length
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Topology {
    #[default]
    Linear,
    Circular,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Strand {
    Forward,
    Reverse,
    Both,
    None,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Qualifier {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FeatureSegment {
    pub span: SequenceSpan,
    pub color: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Feature {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub color: Option<String>,
    pub strand: Strand,
    pub segments: Vec<FeatureSegment>,
    pub qualifiers: Vec<Qualifier>,
    pub reading_frame: Option<i8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PrimerBindingSite {
    pub span: SequenceSpan,
    pub strand: Strand,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Primer {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub sequence: String,
    pub binding_length: Option<usize>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub phosphorylated: bool,
    pub binding_sites: Vec<PrimerBindingSite>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentNotes {
    pub uuid: Option<String>,
    pub sequence_type: Option<String>,
    pub created: Option<String>,
    pub created_utc: Option<String>,
    pub last_modified: Option<String>,
    pub last_modified_utc: Option<String>,
    pub created_by: Option<String>,
    pub accession_number: Option<String>,
    pub description: Option<String>,
    pub comments: Option<String>,
    pub sequence_class: Option<String>,
    pub transformed_into: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SequenceProperties {
    pub upstream_stickiness: Option<i32>,
    pub downstream_stickiness: Option<i32>,
    pub upstream_modification: Option<String>,
    pub downstream_modification: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SnapGeneHeader {
    pub sequence_type: Option<u16>,
    pub export_version: Option<u16>,
    pub import_version: Option<u16>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PacketFormat {
    Sequence,
    Xml,
    Binary,
    Cookie,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SnapGenePacket {
    pub index: usize,
    pub packet_type: u8,
    pub name: String,
    pub byte_length: usize,
    pub format: PacketFormat,
    pub decoded: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentMetadata {
    pub primer_settings: BTreeMap<String, String>,
    pub sequence_properties: SequenceProperties,
    pub enzyme_visibilities: Vec<String>,
    pub custom_enzyme_set_count: usize,
    pub alignable_sequence_count: usize,
    pub snapgene_header: SnapGeneHeader,
    pub snapgene_packets: Vec<SnapGenePacket>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryOperation {
    Import,
    Edit,
    Annotation,
    Primer,
    Pcr,
    Assembly,
    Digest,
    Alignment,
    Translation,
    Topology,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub operation: HistoryOperation,
    pub description: String,
    pub recorded_at: String,
    #[serde(default)]
    pub parent_document: Option<Box<SequenceDocument>>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SequenceDocument {
    pub name: String,
    pub sequence: String,
    pub topology: Topology,
    pub double_stranded: bool,
    pub features: Vec<Feature>,
    pub primers: Vec<Primer>,
    pub notes: DocumentNotes,
    pub metadata: DocumentMetadata,
    pub history: Vec<HistoryEntry>,
}

impl SequenceDocument {
    /// Creates a normalized DNA document.
    ///
    /// # Errors
    ///
    /// Returns an error when no DNA bases remain after normalization.
    pub fn new(name: impl Into<String>, sequence: &str) -> Result<Self, SequenceError> {
        let sequence = normalize_dna(sequence);
        if sequence.is_empty() {
            return Err(SequenceError::Empty);
        }
        if let Some(base) = sequence.chars().find(|base| !is_supported_base(*base)) {
            return Err(SequenceError::InvalidBase(base));
        }
        Ok(Self {
            name: name.into(),
            sequence,
            topology: Topology::Linear,
            double_stranded: true,
            features: Vec::new(),
            primers: Vec::new(),
            notes: DocumentNotes::default(),
            metadata: DocumentMetadata {
                snapgene_header: SnapGeneHeader {
                    sequence_type: Some(1),
                    ..SnapGeneHeader::default()
                },
                ..DocumentMetadata::default()
            },
            history: Vec::new(),
        })
    }

    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn stats(&self) -> DocumentStats {
        let length = self.sequence.len();
        let gc_count = self
            .sequence
            .bytes()
            .filter(|base| matches!(base, b'G' | b'C'))
            .count();
        let canonical_bases = self
            .sequence
            .bytes()
            .filter(|base| matches!(base, b'A' | b'C' | b'G' | b'T'))
            .count();
        let unknown_bases = self
            .sequence
            .bytes()
            .filter(|base| !matches!(base, b'A' | b'C' | b'G' | b'T'))
            .count();
        let gc_percent = if canonical_bases == 0 {
            0.0
        } else {
            gc_count as f64 / canonical_bases as f64 * 100.0
        };
        DocumentStats {
            length,
            gc_percent,
            unknown_bases,
        }
    }

    /// Replaces a single edited sequence region and shifts annotations that follow it.
    ///
    /// The smallest changed interval is inferred from the common prefix and suffix. Features and
    /// recorded primer sites that cross the edit are resized; downstream coordinates are shifted.
    ///
    /// # Errors
    ///
    /// Returns an error when the replacement is empty or contains an unsupported DNA symbol.
    pub fn replace_sequence(&mut self, value: &str) -> Result<SequenceEdit, SequenceError> {
        let replacement = normalize_dna(value);
        if replacement.is_empty() {
            return Err(SequenceError::Empty);
        }
        if let Some(base) = replacement.chars().find(|base| !is_supported_base(*base)) {
            return Err(SequenceError::InvalidBase(base));
        }
        let prefix_length = self
            .sequence
            .bytes()
            .zip(replacement.bytes())
            .take_while(|(left, right)| left == right)
            .count();
        let maximum_suffix = self.sequence.len().min(replacement.len()) - prefix_length;
        let suffix_length = self.sequence.as_bytes()[prefix_length..]
            .iter()
            .rev()
            .zip(replacement.as_bytes()[prefix_length..].iter().rev())
            .take(maximum_suffix)
            .take_while(|(left, right)| left == right)
            .count();
        let old_end = self.sequence.len() - suffix_length;
        let new_end = replacement.len() - suffix_length;
        let edit = SequenceEdit {
            old_span: SequenceSpan::new(prefix_length, old_end),
            replacement_length: new_end - prefix_length,
        };
        if edit.old_span.is_empty() && edit.replacement_length == 0 {
            return Ok(edit);
        }
        let parent_document = self.history_parent();
        for feature in &mut self.features {
            feature.segments.retain_mut(|segment| {
                segment.span = remap_span(segment.span, edit);
                !segment.span.is_empty()
            });
        }
        let topology = self.topology;
        let sequence_length = self.sequence.len();
        for primer in &mut self.primers {
            if primer
                .binding_sites
                .iter()
                .any(|site| edit_affects_span(site.span, edit))
                || edit_breaks_circular_site(&primer.binding_sites, edit, topology, sequence_length)
            {
                primer.binding_sites.clear();
            } else {
                primer.binding_sites.retain_mut(|site| {
                    site.span = remap_span(site.span, edit);
                    !site.span.is_empty()
                });
            }
        }
        self.sequence = replacement;
        self.record_history(
            HistoryOperation::Edit,
            format!(
                "Replaced {} bp with {} bp at position {}",
                edit.old_span.len(),
                edit.replacement_length,
                edit.old_span.start + 1
            ),
            parent_document,
        );
        Ok(edit)
    }

    /// Adds or replaces a validated feature annotation and records an undoable history parent.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid names, colors, reading frames, locations, or indexes.
    pub fn upsert_feature(
        &mut self,
        index: Option<usize>,
        mut feature: Feature,
    ) -> Result<usize, AnnotationError> {
        feature.name = validate_label(&feature.name, "feature name", 255)?;
        feature.kind = validate_label(&feature.kind, "feature type", 64)?;
        validate_color(feature.color.as_deref())?;
        if feature.segments.is_empty() {
            return Err(AnnotationError::FeatureLocationRequired);
        }
        if feature.segments.len() > 128 {
            return Err(AnnotationError::TooManyFeatureSegments);
        }
        for segment in &mut feature.segments {
            if !segment.span.is_valid_for(self.sequence.len()) {
                return Err(AnnotationError::InvalidFeatureSpan {
                    start: segment.span.start,
                    end: segment.span.end,
                    sequence_length: self.sequence.len(),
                });
            }
            validate_color(segment.color.as_deref())?;
        }
        if feature
            .reading_frame
            .is_some_and(|frame| !(0..=2).contains(&frame))
        {
            return Err(AnnotationError::InvalidReadingFrame);
        }
        for qualifier in &mut feature.qualifiers {
            qualifier.name = validate_label(&qualifier.name, "qualifier name", 64)?;
            qualifier.value = qualifier.value.trim().to_owned();
        }

        let parent_document = self.history_parent();
        let target = if let Some(index) = index {
            let Some(existing) = self.features.get_mut(index) else {
                return Err(AnnotationError::FeatureIndexOutOfRange(index));
            };
            if *existing == feature {
                return Ok(index);
            }
            *existing = feature;
            index
        } else {
            self.features.push(feature);
            self.features.len() - 1
        };
        let description = if index.is_some() {
            format!("Updated feature '{}'", self.features[target].name)
        } else {
            format!("Added feature '{}'", self.features[target].name)
        };
        self.record_history(HistoryOperation::Annotation, description, parent_document);
        Ok(target)
    }

    /// Removes a feature annotation and records an undoable history parent.
    ///
    /// # Errors
    ///
    /// Returns an error when the feature index does not exist.
    pub fn remove_feature(&mut self, index: usize) -> Result<(), AnnotationError> {
        if index >= self.features.len() {
            return Err(AnnotationError::FeatureIndexOutOfRange(index));
        }
        let parent_document = self.history_parent();
        let feature = self.features.remove(index);
        self.record_history(
            HistoryOperation::Annotation,
            format!("Removed feature '{}'", feature.name),
            parent_document,
        );
        Ok(())
    }

    /// Adds or replaces a validated primer and records an undoable history parent.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid names, sequences, binding lengths, sites, or indexes.
    pub fn upsert_primer(
        &mut self,
        index: Option<usize>,
        mut primer: Primer,
    ) -> Result<usize, AnnotationError> {
        primer.name = validate_label(&primer.name, "primer name", 255)?;
        primer.sequence = primer
            .sequence
            .chars()
            .filter(|character| !character.is_whitespace())
            .map(|character| character.to_ascii_uppercase())
            .collect();
        if primer.sequence.is_empty()
            || !primer
                .sequence
                .bytes()
                .all(|base| matches!(base, b'A' | b'C' | b'G' | b'T'))
        {
            return Err(AnnotationError::InvalidPrimerSequence);
        }
        if primer.sequence.len() > 500 {
            return Err(AnnotationError::PrimerTooLong(primer.sequence.len()));
        }
        let binding_length = primer
            .binding_length
            .ok_or(AnnotationError::PrimerBindingLengthRequired)?;
        if binding_length == 0 || binding_length > primer.sequence.len() {
            return Err(AnnotationError::InvalidPrimerBindingLength {
                binding_length,
                primer_length: primer.sequence.len(),
            });
        }
        validate_color(primer.color.as_deref())?;
        primer.description = primer
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        for site in &primer.binding_sites {
            if !site.span.is_valid_for(self.sequence.len())
                || !matches!(site.strand, Strand::Forward | Strand::Reverse)
            {
                return Err(AnnotationError::InvalidPrimerBindingSite);
            }
        }
        let stored_site_bases = primer
            .binding_sites
            .iter()
            .map(|site| site.span.len())
            .sum::<usize>();
        if primer
            .binding_sites
            .iter()
            .any(|site| site.span.len() > binding_length)
            || (stored_site_bases > 0 && stored_site_bases % binding_length != 0)
        {
            return Err(AnnotationError::InvalidPrimerBindingSiteLength {
                stored_bases: stored_site_bases,
                binding_length,
            });
        }

        let parent_document = self.history_parent();
        let target = if let Some(index) = index {
            let Some(existing) = self.primers.get_mut(index) else {
                return Err(AnnotationError::PrimerIndexOutOfRange(index));
            };
            if *existing == primer {
                return Ok(index);
            }
            *existing = primer;
            index
        } else {
            self.primers.push(primer);
            self.primers.len() - 1
        };
        let description = if index.is_some() {
            format!("Updated primer '{}'", self.primers[target].name)
        } else {
            format!("Added primer '{}'", self.primers[target].name)
        };
        self.record_history(HistoryOperation::Primer, description, parent_document);
        Ok(target)
    }

    /// Removes a primer and records an undoable history parent.
    ///
    /// # Errors
    ///
    /// Returns an error when the primer index does not exist.
    pub fn remove_primer(&mut self, index: usize) -> Result<(), AnnotationError> {
        if index >= self.primers.len() {
            return Err(AnnotationError::PrimerIndexOutOfRange(index));
        }
        let parent_document = self.history_parent();
        let primer = self.primers.remove(index);
        self.record_history(
            HistoryOperation::Primer,
            format!("Removed primer '{}'", primer.name),
            parent_document,
        );
        Ok(())
    }

    fn history_parent(&self) -> Option<Box<Self>> {
        if self.sequence.len() > MAX_EMBEDDED_PARENT_BASES {
            return None;
        }
        let mut parent = self.clone();
        parent.history.clear();
        Some(Box::new(parent))
    }

    fn record_history(
        &mut self,
        operation: HistoryOperation,
        description: String,
        parent_document: Option<Box<Self>>,
    ) {
        for entry in &mut self.history {
            entry.parent_document = None;
        }
        if self.history.len() >= MAX_HISTORY_ENTRIES {
            let remove_count = self.history.len() + 1 - MAX_HISTORY_ENTRIES;
            self.history.drain(..remove_count);
        }
        self.history.push(HistoryEntry {
            operation,
            description,
            recorded_at: "Edited in DOTDNA".to_owned(),
            parent_document,
        });
    }

    #[must_use]
    pub fn validate(&self) -> Vec<DocumentDiagnostic> {
        let mut diagnostics = Vec::new();
        self.validate_features(&mut diagnostics);
        self.validate_primers(&mut diagnostics);
        diagnostics
    }

    fn validate_features(&self, diagnostics: &mut Vec<DocumentDiagnostic>) {
        for (feature_index, feature) in self.features.iter().enumerate() {
            if feature.segments.is_empty() {
                diagnostics.push(DocumentDiagnostic::error(
                    "feature-without-location",
                    format!("Feature '{}' has no sequence location.", feature.name),
                    "Set a valid feature range or remove the annotation.",
                ));
            }
            for (segment_index, segment) in feature.segments.iter().enumerate() {
                if !segment.span.is_valid_for(self.sequence.len()) {
                    diagnostics.push(DocumentDiagnostic::error(
                        "invalid-feature-span",
                        format!(
                            "Feature '{}' segment {} uses an invalid {}–{} range for a {} bp sequence.",
                            feature.name,
                            segment_index + 1,
                            segment.span.start + 1,
                            segment.span.end,
                            self.sequence.len()
                        ),
                        "Correct the annotation coordinates before editing or exporting this document.",
                    ));
                }
            }
            if feature
                .reading_frame
                .is_some_and(|frame| !(0..=2).contains(&frame))
            {
                diagnostics.push(DocumentDiagnostic::error(
                    "invalid-reading-frame",
                    format!("Feature '{}' has an invalid reading frame.", feature.name),
                    "Choose reading frame 1, 2, or 3.",
                ));
            }
            if feature_index > 50_000 {
                diagnostics.push(DocumentDiagnostic::warning(
                    "large-feature-table",
                    "This document contains more than 50,000 features.",
                    "Hide unneeded annotations to improve map performance.",
                ));
                break;
            }
        }
    }

    fn validate_primers(&self, diagnostics: &mut Vec<DocumentDiagnostic>) {
        for primer in &self.primers {
            let normalized = normalize_dna(&primer.sequence);
            if normalized.len() > 500 {
                diagnostics.push(DocumentDiagnostic::error(
                    "primer-too-long",
                    format!(
                        "Primer '{}' is {} bases long and cannot be analyzed safely.",
                        primer.name,
                        normalized.len()
                    ),
                    "Shorten the primer to 500 bases or fewer before analysis or PCR.",
                ));
            }
            if normalized.is_empty()
                || !normalized
                    .bytes()
                    .all(|base| matches!(base, b'A' | b'C' | b'G' | b'T'))
            {
                diagnostics.push(DocumentDiagnostic::error(
                    "invalid-primer-sequence",
                    format!(
                        "Primer '{}' contains unsupported or ambiguous bases.",
                        primer.name
                    ),
                    "Use only A, C, G, and T in primer sequences.",
                ));
            }
            match primer.binding_length {
                None => diagnostics.push(DocumentDiagnostic::warning(
                    "primer-binding-region-not-set",
                    format!(
                        "Primer '{}' has no explicit 3′ binding length.",
                        primer.name
                    ),
                    "Set the 3′ template-binding length before PCR simulation.",
                )),
                Some(length) if length == 0 || length > normalized.len() => {
                    diagnostics.push(DocumentDiagnostic::error(
                        "invalid-primer-binding-length",
                        format!("Primer '{}' has an invalid 3′ binding length.", primer.name),
                        format!(
                            "Choose a binding length between 1 and {} bases.",
                            normalized.len()
                        ),
                    ));
                }
                Some(_) => {}
            }
            for site in &primer.binding_sites {
                if !site.span.is_valid_for(self.sequence.len()) {
                    diagnostics.push(DocumentDiagnostic::error(
                        "invalid-primer-binding-site",
                        format!(
                            "Primer '{}' has an out-of-bounds binding site.",
                            primer.name
                        ),
                        "Recalculate the primer binding site against this template.",
                    ));
                }
                if !matches!(site.strand, Strand::Forward | Strand::Reverse) {
                    diagnostics.push(DocumentDiagnostic::error(
                        "invalid-primer-strand",
                        format!("Primer '{}' has no usable binding strand.", primer.name),
                        "Choose the forward or reverse template strand.",
                    ));
                }
            }
            if let Some(binding_length) = primer.binding_length {
                let stored_site_bases = primer
                    .binding_sites
                    .iter()
                    .map(|site| site.span.len())
                    .sum::<usize>();
                if primer
                    .binding_sites
                    .iter()
                    .any(|site| site.span.len() > binding_length)
                    || (stored_site_bases > 0 && stored_site_bases % binding_length != 0)
                {
                    diagnostics.push(DocumentDiagnostic::error(
                        "invalid-primer-binding-site-length",
                        format!(
                            "Primer '{}' has a stored site that does not match its {}-base binding region.",
                            primer.name, binding_length
                        ),
                        "Recalculate the primer binding site against this template.",
                    ));
                }
            }
        }
    }
}

fn validate_label(
    value: &str,
    label: &'static str,
    maximum: usize,
) -> Result<String, AnnotationError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AnnotationError::MissingLabel(label));
    }
    if trimmed.chars().count() > maximum {
        return Err(AnnotationError::LabelTooLong { label, maximum });
    }
    Ok(trimmed.to_owned())
}

fn validate_color(color: Option<&str>) -> Result<(), AnnotationError> {
    if color.is_none_or(|value| {
        value.len() == 7
            && value.starts_with('#')
            && value[1..]
                .bytes()
                .all(|character| character.is_ascii_hexdigit())
    }) {
        Ok(())
    } else {
        Err(AnnotationError::InvalidColor)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceEdit {
    pub old_span: SequenceSpan,
    pub replacement_length: usize,
}

fn shift_coordinate(value: usize, removed: usize, inserted: usize) -> usize {
    if inserted >= removed {
        value.saturating_add(inserted - removed)
    } else {
        value.saturating_sub(removed - inserted)
    }
}

fn remap_span(span: SequenceSpan, edit: SequenceEdit) -> SequenceSpan {
    let removed = edit.old_span.len();
    let start = if span.start >= edit.old_span.end {
        shift_coordinate(span.start, removed, edit.replacement_length)
    } else if span.start > edit.old_span.start {
        edit.old_span.start
    } else {
        span.start
    };
    let end = if span.end <= edit.old_span.start {
        span.end
    } else if span.end >= edit.old_span.end {
        shift_coordinate(span.end, removed, edit.replacement_length)
    } else {
        edit.old_span.start + edit.replacement_length
    };
    SequenceSpan::new(start, end)
}

fn edit_affects_span(span: SequenceSpan, edit: SequenceEdit) -> bool {
    if edit.old_span.is_empty() {
        return edit.replacement_length > 0
            && edit.old_span.start > span.start
            && edit.old_span.start < span.end;
    }
    span.start < edit.old_span.end && edit.old_span.start < span.end
}

fn edit_breaks_circular_site(
    sites: &[PrimerBindingSite],
    edit: SequenceEdit,
    topology: Topology,
    sequence_length: usize,
) -> bool {
    topology == Topology::Circular
        && edit.old_span.is_empty()
        && edit.replacement_length > 0
        && (edit.old_span.start == 0 || edit.old_span.start == sequence_length)
        && sites.iter().any(|site| site.span.start == 0)
        && sites.iter().any(|site| site.span.end == sequence_length)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DocumentStats {
    pub length: usize,
    pub gc_percent: f64,
    pub unknown_bases: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDiagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub action: String,
}

impl DocumentDiagnostic {
    fn error(code: &str, message: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            severity: DiagnosticSeverity::Error,
            code: code.to_owned(),
            message: message.into(),
            action: action.into(),
        }
    }

    fn warning(code: &str, message: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            severity: DiagnosticSeverity::Warning,
            code: code.to_owned(),
            message: message.into(),
            action: action.into(),
        }
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum SequenceError {
    #[error("the document does not contain a DNA sequence")]
    Empty,
    #[error("unsupported DNA base '{0}'")]
    InvalidBase(char),
    #[error(
        "IUPAC-aware searches longer than {maximum} bases are not supported (received {length}); search for a shorter distinctive region"
    )]
    AmbiguousSearchTooLong { length: usize, maximum: usize },
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum AnnotationError {
    #[error("enter a {0}")]
    MissingLabel(&'static str),
    #[error("the {label} must be {maximum} characters or fewer")]
    LabelTooLong { label: &'static str, maximum: usize },
    #[error("set at least one valid feature location")]
    FeatureLocationRequired,
    #[error("a feature may contain at most 128 segments")]
    TooManyFeatureSegments,
    #[error("feature range {start}–{end} is invalid for a {sequence_length} bp sequence")]
    InvalidFeatureSpan {
        start: usize,
        end: usize,
        sequence_length: usize,
    },
    #[error("choose reading frame 1, 2, or 3")]
    InvalidReadingFrame,
    #[error("colors must use six-digit hexadecimal notation such as #5cc8d7")]
    InvalidColor,
    #[error("feature index {0} does not exist")]
    FeatureIndexOutOfRange(usize),
    #[error("primer sequences may contain only A, C, G, and T")]
    InvalidPrimerSequence,
    #[error("primer length {0} exceeds the 500-base safety limit")]
    PrimerTooLong(usize),
    #[error("set the number of 3′ primer bases that bind the template")]
    PrimerBindingLengthRequired,
    #[error("3′ binding length {binding_length} is invalid for a {primer_length}-base primer")]
    InvalidPrimerBindingLength {
        binding_length: usize,
        primer_length: usize,
    },
    #[error("a primer binding site has an invalid range or strand")]
    InvalidPrimerBindingSite,
    #[error(
        "stored primer sites cover {stored_bases} bases, which is inconsistent with the {binding_length}-base binding region"
    )]
    InvalidPrimerBindingSiteLength {
        stored_bases: usize,
        binding_length: usize,
    },
    #[error("primer index {0} does not exist")]
    PrimerIndexOutOfRange(usize),
}

#[must_use]
pub fn normalize_dna(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace() && !character.is_ascii_digit())
        .map(|character| match character.to_ascii_uppercase() {
            'U' => 'T',
            base => base,
        })
        .collect()
}

const fn is_supported_base(base: char) -> bool {
    matches!(
        base,
        'A' | 'C'
            | 'G'
            | 'T'
            | 'R'
            | 'Y'
            | 'S'
            | 'W'
            | 'K'
            | 'M'
            | 'B'
            | 'D'
            | 'H'
            | 'V'
            | 'N'
            | '-'
    )
}

/// Returns the reverse complement of a supported DNA sequence.
///
/// # Errors
///
/// Returns an error when the sequence contains an unsupported symbol.
pub fn reverse_complement(sequence: &str) -> Result<String, SequenceError> {
    let normalized = normalize_dna(sequence);
    if normalized.is_empty() {
        return Err(SequenceError::Empty);
    }
    if let Some(base) = normalized.chars().find(|base| !is_supported_base(*base)) {
        return Err(SequenceError::InvalidBase(base));
    }
    Ok(normalized
        .chars()
        .rev()
        .map(|base| match base {
            'A' => 'T',
            'C' => 'G',
            'G' => 'C',
            'T' => 'A',
            'R' => 'Y',
            'Y' => 'R',
            'S' => 'S',
            'W' => 'W',
            'K' => 'M',
            'M' => 'K',
            'B' => 'V',
            'D' => 'H',
            'H' => 'D',
            'V' => 'B',
            'N' => 'N',
            '-' => '-',
            _ => unreachable!("normalization only retains supported bases"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_dna_and_reports_statistics() {
        let document = SequenceDocument::new("example", "ac gt\nNN").unwrap();
        assert_eq!(document.sequence, "ACGTNN");
        assert_eq!(document.stats().length, 6);
        assert!((document.stats().gc_percent - 50.0).abs() < f64::EPSILON);
        assert_eq!(document.stats().unknown_bases, 2);
    }

    #[test]
    fn reverse_complements_ambiguous_dna() {
        assert_eq!(
            reverse_complement("ACGTRYSWKMBDHVN").unwrap(),
            "NBDHVKMWSRYACGT"
        );
    }

    #[test]
    fn rejects_unsupported_bases() {
        assert_eq!(
            SequenceDocument::new("invalid", "ACGT?").unwrap_err(),
            SequenceError::InvalidBase('?')
        );
    }

    #[test]
    fn spans_are_zero_based_and_half_open() {
        let span = SequenceSpan::new(4, 11);
        assert_eq!(span.len(), 7);
        assert!(!span.is_empty());
    }

    #[test]
    fn validation_returns_actionable_coordinate_and_primer_diagnostics() {
        let mut document = SequenceDocument::new("invalid", "ACGTACGT").unwrap();
        document.features.push(Feature {
            id: None,
            name: "outside".to_owned(),
            kind: "misc_feature".to_owned(),
            color: None,
            strand: Strand::Forward,
            segments: vec![FeatureSegment {
                span: SequenceSpan::new(4, 12),
                color: None,
                name: None,
                kind: None,
            }],
            qualifiers: Vec::new(),
            reading_frame: None,
        });
        document.primers.push(Primer {
            id: None,
            name: "unset".to_owned(),
            sequence: "ACGT".to_owned(),
            binding_length: None,
            description: None,
            color: None,
            phosphorylated: false,
            binding_sites: Vec::new(),
        });
        let diagnostics = document.validate();
        assert!(
            diagnostics
                .iter()
                .any(|item| item.code == "invalid-feature-span")
        );
        assert!(
            diagnostics
                .iter()
                .any(|item| item.code == "primer-binding-region-not-set")
        );
        assert!(diagnostics.iter().all(|item| !item.action.is_empty()));
    }

    #[test]
    fn sequence_edits_shift_downstream_features_and_record_a_parent() {
        let mut document = SequenceDocument::new("edit", "AAAACCCCGGGG").unwrap();
        document.features.push(Feature {
            id: None,
            name: "downstream".to_owned(),
            kind: "misc_feature".to_owned(),
            color: None,
            strand: Strand::Forward,
            segments: vec![FeatureSegment {
                span: SequenceSpan::new(8, 12),
                color: None,
                name: None,
                kind: None,
            }],
            qualifiers: Vec::new(),
            reading_frame: None,
        });
        let edit = document.replace_sequence("AAAATTTTCCCCGGGG").unwrap();
        assert_eq!(edit.old_span, SequenceSpan::new(4, 4));
        assert_eq!(edit.replacement_length, 4);
        assert_eq!(
            document.features[0].segments[0].span,
            SequenceSpan::new(12, 16)
        );
        assert_eq!(document.history.len(), 1);
        assert_eq!(
            document.history[0]
                .parent_document
                .as_deref()
                .unwrap()
                .sequence,
            "AAAACCCCGGGG"
        );
    }

    #[test]
    fn sequence_edits_clear_overlapping_primer_sites_and_shift_untouched_sites() {
        let mut overlapping = SequenceDocument::new("overlap", "AACGTACGTT").unwrap();
        overlapping.primers.push(authored_primer());
        overlapping.replace_sequence("AACGTT").unwrap();
        assert!(overlapping.primers[0].binding_sites.is_empty());

        let mut downstream = SequenceDocument::new("downstream", "AAAACGTACGTT").unwrap();
        let mut primer = authored_primer();
        primer.binding_sites[0].span = SequenceSpan::new(4, 10);
        downstream.primers.push(primer);
        downstream.replace_sequence("TTAAAACGTACGTT").unwrap();
        assert_eq!(
            downstream.primers[0].binding_sites[0].span,
            SequenceSpan::new(6, 12)
        );

        let mut boundary = SequenceDocument::new("boundary", "AACGTACGTT").unwrap();
        boundary.primers.push(authored_primer());
        boundary.replace_sequence("AACGTACGATT").unwrap();
        assert_eq!(
            boundary.primers[0].binding_sites[0].span,
            SequenceSpan::new(2, 8),
            "an insertion immediately after the binding site does not expand it"
        );

        let mut circular = SequenceDocument::new("origin", "AACGTACGTT").unwrap();
        circular.topology = Topology::Circular;
        let mut wrapped = authored_primer();
        wrapped.binding_length = Some(4);
        wrapped.binding_sites = vec![
            PrimerBindingSite {
                span: SequenceSpan::new(8, 10),
                strand: Strand::Forward,
            },
            PrimerBindingSite {
                span: SequenceSpan::new(0, 2),
                strand: Strand::Forward,
            },
        ];
        circular.primers.push(wrapped);
        circular.replace_sequence("GAACGTACGTT").unwrap();
        assert!(circular.primers[0].binding_sites.is_empty());
    }

    #[test]
    fn sequence_history_bounds_embedded_parent_data() {
        let mut document = SequenceDocument::new("small", "AAAACCCC").unwrap();
        document.replace_sequence("AAAATCCC").unwrap();
        document.replace_sequence("AAAAGCCC").unwrap();
        assert_eq!(document.history.len(), 2);
        assert!(document.history[0].parent_document.is_none());
        assert!(document.history[1].parent_document.is_some());

        let large_sequence = "A".repeat(2_000_001);
        let mut large = SequenceDocument::new("large", &large_sequence).unwrap();
        let mut replacement = large_sequence;
        replacement.replace_range(1_000_000..1_000_001, "C");
        large.replace_sequence(&replacement).unwrap();
        assert!(large.history[0].parent_document.is_none());
    }

    fn authored_feature() -> Feature {
        Feature {
            id: Some("feature-1".to_owned()),
            name: "mNeonGreen".to_owned(),
            kind: "CDS".to_owned(),
            color: Some("#5cc8d7".to_owned()),
            strand: Strand::Forward,
            segments: vec![FeatureSegment {
                span: SequenceSpan::new(2, 8),
                color: Some("#123456".to_owned()),
                name: Some("exon 1".to_owned()),
                kind: Some("exon".to_owned()),
            }],
            qualifiers: vec![Qualifier {
                name: "note".to_owned(),
                value: "preserve me".to_owned(),
            }],
            reading_frame: Some(0),
        }
    }

    fn authored_primer() -> Primer {
        Primer {
            id: Some("primer-1".to_owned()),
            name: "mutagenic forward".to_owned(),
            sequence: "GGATCCACGTAC".to_owned(),
            binding_length: Some(6),
            description: Some("BamHI tail".to_owned()),
            color: Some("#79d6e5".to_owned()),
            phosphorylated: true,
            binding_sites: vec![PrimerBindingSite {
                span: SequenceSpan::new(2, 8),
                strand: Strand::Forward,
            }],
        }
    }

    #[test]
    fn feature_mutations_validate_preserve_metadata_and_record_history() {
        let mut document = SequenceDocument::new("annotations", "AACGTACGTT").unwrap();
        let index = document.upsert_feature(None, authored_feature()).unwrap();
        assert_eq!(index, 0);
        assert_eq!(document.history[0].operation, HistoryOperation::Annotation);
        let mut replacement = document.features[0].clone();
        replacement.name = "renamed".to_owned();
        document
            .upsert_feature(Some(index), replacement.clone())
            .unwrap();
        assert_eq!(
            document.features[0].segments[0].name.as_deref(),
            Some("exon 1")
        );
        assert_eq!(document.features[0].qualifiers[0].value, "preserve me");
        let history_length = document.history.len();
        document.upsert_feature(Some(index), replacement).unwrap();
        assert_eq!(
            document.history.len(),
            history_length,
            "a no-op does not create history"
        );
        document.remove_feature(index).unwrap();
        assert!(document.features.is_empty());
        assert_eq!(
            document.history.last().unwrap().operation,
            HistoryOperation::Annotation
        );
    }

    #[test]
    fn feature_mutations_reject_invalid_ranges_and_frames() {
        let mut document = SequenceDocument::new("annotations", "AACGTACGTT").unwrap();
        let mut feature = authored_feature();
        feature.segments[0].span = SequenceSpan::new(8, 12);
        assert!(matches!(
            document.upsert_feature(None, feature),
            Err(AnnotationError::InvalidFeatureSpan { .. })
        ));
        let mut feature = authored_feature();
        feature.reading_frame = Some(3);
        assert_eq!(
            document.upsert_feature(None, feature),
            Err(AnnotationError::InvalidReadingFrame)
        );
    }

    #[test]
    fn primer_mutations_preserve_tail_metadata_and_require_explicit_binding() {
        let mut document = SequenceDocument::new("primers", "AACGTACGTT").unwrap();
        let index = document.upsert_primer(None, authored_primer()).unwrap();
        assert_eq!(document.primers[index].sequence, "GGATCCACGTAC");
        assert_eq!(document.primers[index].binding_length, Some(6));
        assert_eq!(document.primers[index].sequence.len() - 6, 6);
        assert_eq!(document.history[0].operation, HistoryOperation::Primer);
        let mut replacement = document.primers[index].clone();
        replacement.name = "renamed primer".to_owned();
        document.upsert_primer(Some(index), replacement).unwrap();
        assert!(document.primers[index].phosphorylated);
        assert_eq!(
            document.primers[index].description.as_deref(),
            Some("BamHI tail")
        );
        document.remove_primer(index).unwrap();
        assert!(document.primers.is_empty());

        let mut invalid = authored_primer();
        invalid.binding_length = None;
        assert_eq!(
            document.upsert_primer(None, invalid),
            Err(AnnotationError::PrimerBindingLengthRequired)
        );

        let mut inconsistent_site = authored_primer();
        inconsistent_site.binding_sites[0].span = SequenceSpan::new(2, 5);
        assert!(matches!(
            document.upsert_primer(None, inconsistent_site),
            Err(AnnotationError::InvalidPrimerBindingSiteLength { .. })
        ));
    }
}
