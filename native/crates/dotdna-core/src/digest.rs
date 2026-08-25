use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    Feature, FeatureSegment, HistoryEntry, HistoryOperation, Primer, PrimerBindingSite, Qualifier,
    SequenceDocument, SequenceSpan, Strand, Topology,
};

const MAX_DIGEST_CUTS: usize = 200;
const MAX_PROJECTED_FEATURES: usize = 50_000;
const MAX_PROJECTED_PRIMERS: usize = 10_000;
const MAX_PROJECTED_ANNOTATION_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy)]
struct ProjectionBudget {
    features: usize,
    primers: usize,
    annotation_bytes: usize,
}

#[derive(Clone, Copy)]
struct EnzymeDefinition {
    name: &'static str,
    recognition_sequence: &'static str,
    top_cut_offset: isize,
    bottom_cut_offset: isize,
}

const ENZYMES: [EnzymeDefinition; 6] = [
    EnzymeDefinition {
        name: "BamHI",
        recognition_sequence: "GGATCC",
        top_cut_offset: 1,
        bottom_cut_offset: 5,
    },
    EnzymeDefinition {
        name: "BsaI",
        recognition_sequence: "GGTCTC",
        top_cut_offset: 7,
        bottom_cut_offset: 11,
    },
    EnzymeDefinition {
        name: "EcoRI",
        recognition_sequence: "GAATTC",
        top_cut_offset: 1,
        bottom_cut_offset: 5,
    },
    EnzymeDefinition {
        name: "HindIII",
        recognition_sequence: "AAGCTT",
        top_cut_offset: 1,
        bottom_cut_offset: 5,
    },
    EnzymeDefinition {
        name: "NotI",
        recognition_sequence: "GCGGCCGC",
        top_cut_offset: 2,
        bottom_cut_offset: 6,
    },
    EnzymeDefinition {
        name: "XhoI",
        recognition_sequence: "CTCGAG",
        top_cut_offset: 1,
        bottom_cut_offset: 5,
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DigestEndType {
    Natural,
    Blunt,
    FivePrime,
    ThreePrime,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestEnd {
    pub enzyme_names: Vec<String>,
    pub end_type: DigestEndType,
    pub overhang_sequence: String,
    pub overhang_length: usize,
    pub overhang_strand: Strand,
    pub top_cut_position: Option<usize>,
    pub bottom_cut_position: Option<usize>,
}

impl DigestEnd {
    fn natural() -> Self {
        Self {
            enzyme_names: Vec::new(),
            end_type: DigestEndType::Natural,
            overhang_sequence: String::new(),
            overhang_length: 0,
            overhang_strand: Strand::None,
            top_cut_position: None,
            bottom_cut_position: None,
        }
    }

    fn label(&self) -> String {
        if self.end_type == DigestEndType::Natural {
            return "natural template end".to_owned();
        }
        let enzymes = self.enzyme_names.join("/");
        match self.end_type {
            DigestEndType::Natural => "natural template end".to_owned(),
            DigestEndType::Blunt => format!("{enzymes} blunt end"),
            DigestEndType::FivePrime => format!(
                "{enzymes} {}-nt 5′ overhang ({}, {} strand)",
                self.overhang_length,
                self.overhang_sequence,
                if self.overhang_strand == Strand::Forward {
                    "forward"
                } else {
                    "reverse"
                }
            ),
            DigestEndType::ThreePrime => format!(
                "{enzymes} {}-nt 3′ overhang ({}, {} strand)",
                self.overhang_length,
                self.overhang_sequence,
                if self.overhang_strand == Strand::Forward {
                    "forward"
                } else {
                    "reverse"
                }
            ),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictionCut {
    pub enzyme_names: Vec<String>,
    pub recognition_sequence: String,
    pub recognition_spans: Vec<SequenceSpan>,
    pub strand: Strand,
    pub top_cut_position: usize,
    pub bottom_cut_position: usize,
    pub end_type: DigestEndType,
    pub overhang_sequence: String,
    pub overhang_length: usize,
}

impl RestrictionCut {
    fn end(&self, upstream: bool) -> DigestEnd {
        let overhang_strand = match (self.end_type, upstream) {
            (DigestEndType::FivePrime, true) | (DigestEndType::ThreePrime, false) => {
                Strand::Forward
            }
            (DigestEndType::FivePrime, false) | (DigestEndType::ThreePrime, true) => {
                Strand::Reverse
            }
            (DigestEndType::Natural | DigestEndType::Blunt, _) => Strand::None,
        };
        let overhang_sequence = if overhang_strand == Strand::Reverse {
            reverse_complement(&self.overhang_sequence)
        } else {
            self.overhang_sequence.clone()
        };
        DigestEnd {
            enzyme_names: self.enzyme_names.clone(),
            end_type: self.end_type,
            overhang_sequence,
            overhang_length: self.overhang_length,
            overhang_strand,
            top_cut_position: Some(self.top_cut_position),
            bottom_cut_position: Some(self.bottom_cut_position),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestFragment {
    pub index: usize,
    pub source_spans: Vec<SequenceSpan>,
    pub length: usize,
    pub gc_percent: f64,
    pub upstream_end: DigestEnd,
    pub downstream_end: DigestEnd,
    pub document: SequenceDocument,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictionDigest {
    pub enzyme_names: Vec<String>,
    pub cuts: Vec<RestrictionCut>,
    pub fragments: Vec<DigestFragment>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DigestError {
    #[error("Select at least one restriction enzyme.")]
    NoEnzymes,
    #[error("Restriction digestion requires a non-empty double-stranded DNA template.")]
    InvalidTemplate,
    #[error("'{0}' is not in the supported restriction-enzyme catalog.")]
    UnknownEnzyme(String),
    #[error("The selected enzymes do not produce a valid cut on this template.")]
    NoCuts,
    #[error("The selected enzymes produce more than {MAX_DIGEST_CUTS} cuts.")]
    TooManyCuts,
    #[error("Selected enzymes produce conflicting cleavage geometry at top-strand position {0}.")]
    ConflictingCuts(usize),
    #[error("The digest would project too many annotations into its fragment documents.")]
    TooManyAnnotations,
    #[error("A projected restriction fragment did not pass document validation.")]
    InvalidProduct,
}

fn reverse_complement(sequence: &str) -> String {
    sequence
        .bytes()
        .rev()
        .map(|base| match base {
            b'A' => 'T',
            b'C' => 'G',
            b'G' => 'C',
            b'T' => 'A',
            _ => 'N',
        })
        .collect()
}

fn normalized_position(position: isize, length: usize) -> usize {
    position.rem_euclid(length.cast_signed()).cast_unsigned()
}

fn circular_spans(start: usize, span_length: usize, sequence_length: usize) -> Vec<SequenceSpan> {
    let end = start + span_length;
    if end <= sequence_length {
        vec![SequenceSpan::new(start, end)]
    } else {
        vec![
            SequenceSpan::new(start, sequence_length),
            SequenceSpan::new(0, end - sequence_length),
        ]
    }
}

fn extract_between(sequence: &str, start: isize, length: usize, circular: bool) -> String {
    if length == 0 {
        return String::new();
    }
    if !circular {
        let start = start.cast_unsigned();
        return sequence[start..start + length].to_owned();
    }
    let bytes = sequence.as_bytes();
    (0..length)
        .map(|offset| bytes[normalized_position(start + offset.cast_signed(), bytes.len())] as char)
        .collect()
}

fn candidate_cut(
    sequence: &str,
    topology: Topology,
    definition: EnzymeDefinition,
    position: usize,
    strand: Strand,
) -> Option<RestrictionCut> {
    let circular = topology == Topology::Circular;
    let recognition_length = definition.recognition_sequence.len();
    let position_signed = position.cast_signed();
    let recognition_length_signed = recognition_length.cast_signed();
    let (top_raw, bottom_raw) = if strand == Strand::Forward {
        (
            position_signed + definition.top_cut_offset,
            position_signed + definition.bottom_cut_offset,
        )
    } else {
        (
            position_signed + recognition_length_signed - definition.bottom_cut_offset,
            position_signed + recognition_length_signed - definition.top_cut_offset,
        )
    };
    let sequence_length = sequence.len().cast_signed();
    if !circular
        && (top_raw <= 0
            || bottom_raw <= 0
            || top_raw >= sequence_length
            || bottom_raw >= sequence_length)
    {
        return None;
    }
    let top_cut_position = if circular {
        normalized_position(top_raw, sequence.len())
    } else {
        top_raw.cast_unsigned()
    };
    let bottom_cut_position = if circular {
        normalized_position(bottom_raw, sequence.len())
    } else {
        bottom_raw.cast_unsigned()
    };
    let difference = bottom_raw - top_raw;
    let (end_type, overhang_length) = match difference.cmp(&0) {
        std::cmp::Ordering::Equal => (DigestEndType::Blunt, 0),
        std::cmp::Ordering::Greater => (DigestEndType::FivePrime, difference.cast_unsigned()),
        std::cmp::Ordering::Less => (DigestEndType::ThreePrime, difference.unsigned_abs()),
    };
    let overhang_start = top_raw.min(bottom_raw);
    let overhang_sequence = extract_between(sequence, overhang_start, overhang_length, circular);
    let recognition_spans = if circular {
        circular_spans(position, recognition_length, sequence.len())
    } else {
        vec![SequenceSpan::new(position, position + recognition_length)]
    };
    Some(RestrictionCut {
        enzyme_names: vec![definition.name.to_owned()],
        recognition_sequence: definition.recognition_sequence.to_owned(),
        recognition_spans,
        strand,
        top_cut_position,
        bottom_cut_position,
        end_type,
        overhang_sequence,
        overhang_length,
    })
}

fn scan_definition(
    document: &SequenceDocument,
    definition: EnzymeDefinition,
    cuts: &mut Vec<RestrictionCut>,
) -> Result<(usize, usize), DigestError> {
    let sequence = document.sequence.as_str();
    let recognition = definition.recognition_sequence;
    let reverse = reverse_complement(recognition);
    let mut orientations = vec![(recognition, Strand::Forward)];
    if reverse != recognition {
        orientations.push((reverse.as_str(), Strand::Reverse));
    }
    if document.topology == Topology::Circular && sequence.len() < recognition.len() {
        return Ok((0, 0));
    }
    let searchable = if document.topology == Topology::Circular {
        format!(
            "{}{}",
            sequence,
            &sequence[..recognition.len().saturating_sub(1)]
        )
    } else {
        sequence.to_owned()
    };
    let mut recognized = 0;
    let mut valid = 0;
    for (pattern, strand) in orientations {
        let pattern = pattern.as_bytes();
        for (position, window) in searchable.as_bytes().windows(pattern.len()).enumerate() {
            if position >= sequence.len() || window != pattern {
                continue;
            }
            recognized += 1;
            if let Some(cut) =
                candidate_cut(sequence, document.topology, definition, position, strand)
            {
                cuts.push(cut);
                if cuts.len() > MAX_DIGEST_CUTS {
                    return Err(DigestError::TooManyCuts);
                }
                valid += 1;
            }
        }
    }
    Ok((recognized, valid))
}

fn deduplicate_cuts(mut cuts: Vec<RestrictionCut>) -> Result<Vec<RestrictionCut>, DigestError> {
    cuts.sort_by(|left, right| {
        left.top_cut_position
            .cmp(&right.top_cut_position)
            .then(left.bottom_cut_position.cmp(&right.bottom_cut_position))
            .then(left.enzyme_names.cmp(&right.enzyme_names))
    });
    let mut merged: Vec<RestrictionCut> = Vec::new();
    for cut in cuts {
        if let Some(previous) = merged.last_mut()
            && previous.top_cut_position == cut.top_cut_position
        {
            if previous.bottom_cut_position != cut.bottom_cut_position
                || previous.end_type != cut.end_type
                || previous.overhang_sequence != cut.overhang_sequence
            {
                return Err(DigestError::ConflictingCuts(cut.top_cut_position));
            }
            for enzyme in cut.enzyme_names {
                if !previous.enzyme_names.contains(&enzyme) {
                    previous.enzyme_names.push(enzyme);
                }
            }
            previous.enzyme_names.sort();
            continue;
        }
        merged.push(cut);
        if merged.len() > MAX_DIGEST_CUTS {
            return Err(DigestError::TooManyCuts);
        }
    }
    let mut bottoms = BTreeMap::new();
    for cut in &merged {
        if bottoms
            .insert(cut.bottom_cut_position, cut.top_cut_position)
            .is_some_and(|top| top != cut.top_cut_position)
        {
            return Err(DigestError::ConflictingCuts(cut.top_cut_position));
        }
    }
    Ok(merged)
}

fn validate_non_overlapping_cuts(
    cuts: &[RestrictionCut],
    topology: Topology,
    sequence_length: usize,
) -> Result<(), DigestError> {
    let mut occupied = HashSet::new();
    for cut in cuts {
        let start = match (topology, cut.end_type) {
            (Topology::Circular, DigestEndType::ThreePrime) => cut.bottom_cut_position,
            (Topology::Circular, _) => cut.top_cut_position,
            (Topology::Linear, _) => cut.top_cut_position.min(cut.bottom_cut_position),
        };
        for offset in 0..cut.overhang_length {
            let position = if topology == Topology::Circular {
                (start + offset) % sequence_length
            } else {
                start + offset
            };
            if !occupied.insert(position) {
                return Err(DigestError::ConflictingCuts(cut.top_cut_position));
            }
        }
    }
    let cut_interval = |cut: &RestrictionCut, top: isize| {
        let bottom = match cut.end_type {
            DigestEndType::Natural | DigestEndType::Blunt => top,
            DigestEndType::FivePrime => top + cut.overhang_length.cast_signed(),
            DigestEndType::ThreePrime => top - cut.overhang_length.cast_signed(),
        };
        (top.min(bottom), top.max(bottom))
    };
    match topology {
        Topology::Linear => {
            for pair in cuts.windows(2) {
                let (_, left_maximum) =
                    cut_interval(&pair[0], pair[0].top_cut_position.cast_signed());
                let (right_minimum, _) =
                    cut_interval(&pair[1], pair[1].top_cut_position.cast_signed());
                if left_maximum >= right_minimum {
                    return Err(DigestError::ConflictingCuts(pair[1].top_cut_position));
                }
            }
        }
        Topology::Circular => {
            for (index, cut) in cuts.iter().enumerate() {
                let next = &cuts[(index + 1) % cuts.len()];
                let top = cut.top_cut_position.cast_signed();
                let next_top = next.top_cut_position.cast_signed()
                    + if index + 1 == cuts.len() {
                        sequence_length.cast_signed()
                    } else {
                        0
                    };
                let (_, left_maximum) = cut_interval(cut, top);
                let (right_minimum, _) = cut_interval(next, next_top);
                if cuts.len() > 1 && left_maximum >= right_minimum {
                    return Err(DigestError::ConflictingCuts(next.top_cut_position));
                }
            }
        }
    }
    Ok(())
}

fn sequence_for_spans(sequence: &str, spans: &[SequenceSpan]) -> String {
    let capacity = spans.iter().map(|span| span.len()).sum();
    let mut output = String::with_capacity(capacity);
    for span in spans {
        output.push_str(&sequence[span.start..span.end]);
    }
    output
}

fn map_span(span: SequenceSpan, source_spans: &[SequenceSpan]) -> Vec<SequenceSpan> {
    let mut mapped = Vec::new();
    let mut offset = 0;
    for source in source_spans {
        let start = span.start.max(source.start);
        let end = span.end.min(source.end);
        if start < end {
            mapped.push(SequenceSpan::new(
                offset + start - source.start,
                offset + end - source.start,
            ));
        }
        offset += source.len();
    }
    mapped
}

fn estimated_text_bytes(value: &str) -> usize {
    value.len().saturating_mul(6).saturating_add(8)
}

fn estimated_segment_text_bytes(segment: &FeatureSegment) -> usize {
    [
        segment.color.as_deref(),
        segment.name.as_deref(),
        segment.kind.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(estimated_text_bytes)
    .sum()
}

fn estimated_feature_bytes(
    feature: &Feature,
    segment_count: usize,
    segment_text_bytes: usize,
    extra_note: bool,
) -> usize {
    let text_bytes = estimated_text_bytes(&feature.name)
        .saturating_add(estimated_text_bytes(&feature.kind))
        .saturating_add(feature.id.as_deref().map_or(0, estimated_text_bytes))
        .saturating_add(feature.color.as_deref().map_or(0, estimated_text_bytes))
        .saturating_add(
            feature
                .qualifiers
                .iter()
                .map(|qualifier| {
                    estimated_text_bytes(&qualifier.name)
                        .saturating_add(estimated_text_bytes(&qualifier.value))
                })
                .sum::<usize>(),
        )
        .saturating_add(segment_text_bytes);
    text_bytes
        .saturating_add(segment_count.saturating_mul(160))
        .saturating_add(if extra_note { 320 } else { 0 })
        .saturating_add(256)
}

fn estimated_primer_bytes(primer: &Primer, site_count: usize) -> usize {
    estimated_text_bytes(&primer.name)
        .saturating_add(estimated_text_bytes(&primer.sequence))
        .saturating_add(primer.id.as_deref().map_or(0, estimated_text_bytes))
        .saturating_add(
            primer
                .description
                .as_deref()
                .map_or(0, estimated_text_bytes),
        )
        .saturating_add(primer.color.as_deref().map_or(0, estimated_text_bytes))
        .saturating_add(site_count.saturating_mul(96))
        .saturating_add(256)
}

fn map_features(
    features: &[Feature],
    source_spans: &[SequenceSpan],
    maximum: usize,
    maximum_bytes: usize,
    linearized_circular: bool,
) -> Result<(Vec<Feature>, usize), DigestError> {
    let mut output = Vec::new();
    let mut projected_bytes = 0;
    for feature in features {
        let original_length = feature
            .segments
            .iter()
            .map(|segment| segment.span.len())
            .sum::<usize>();
        let mut mapped_locations = Vec::new();
        let mut severed = false;
        for segment in &feature.segments {
            let mapped_spans = map_span(segment.span, source_spans);
            severed |= linearized_circular && mapped_spans.len() > 1;
            mapped_locations.extend(mapped_spans.into_iter().map(|span| (span, segment)));
        }
        if mapped_locations.is_empty() {
            continue;
        }
        mapped_locations.sort_by_key(|(span, _)| span.start);
        let mapped_length = mapped_locations
            .iter()
            .map(|(span, _)| span.len())
            .sum::<usize>();
        let partial = mapped_length != original_length || severed;
        let rotation_clears_frame = !partial && source_spans.len() > 1;
        let segment_text_bytes = mapped_locations
            .iter()
            .map(|(_, segment)| estimated_segment_text_bytes(segment))
            .sum::<usize>()
            .saturating_add(
                feature
                    .segments
                    .iter()
                    .map(estimated_segment_text_bytes)
                    .sum(),
            );
        let feature_bytes = estimated_feature_bytes(
            feature,
            mapped_locations.len(),
            segment_text_bytes,
            partial || rotation_clears_frame,
        );
        if feature_bytes > maximum_bytes.saturating_sub(projected_bytes) {
            return Err(DigestError::TooManyAnnotations);
        }
        let mapped_segments = mapped_locations
            .into_iter()
            .map(|(span, segment)| FeatureSegment {
                span,
                color: segment.color.clone(),
                name: segment.name.clone(),
                kind: segment.kind.clone(),
            })
            .collect();
        let mut mapped = feature.clone();
        mapped.segments = mapped_segments;
        if partial {
            mapped.reading_frame = None;
            mapped.qualifiers.retain(|qualifier| {
                !matches!(
                    qualifier.name.to_ascii_lowercase().as_str(),
                    "translation" | "codon_start" | "transl_except"
                )
            });
            mapped.qualifiers.push(Qualifier {
                name: "note".to_owned(),
                value: "Feature was clipped by restriction digestion.".to_owned(),
            });
        } else if rotation_clears_frame && mapped.reading_frame.take().is_some() {
            mapped.qualifiers.push(Qualifier {
                name: "note".to_owned(),
                value: "Reading frame was cleared after circular coordinate rotation.".to_owned(),
            });
        }
        if output.len() >= maximum {
            return Err(DigestError::TooManyAnnotations);
        }
        output.push(mapped);
        projected_bytes += feature_bytes;
    }
    Ok((output, projected_bytes))
}

fn map_primers(
    primers: &[Primer],
    source_spans: &[SequenceSpan],
    maximum: usize,
    maximum_bytes: usize,
    linearized_circular: bool,
) -> Result<(Vec<Primer>, usize), DigestError> {
    let mut output = Vec::new();
    let mut projected_bytes = 0;
    for primer in primers {
        let Some(binding_length) = primer.binding_length else {
            continue;
        };
        let mut mapped_sites = Vec::new();
        let mut logical_site = Vec::new();
        let mut logical_site_length = 0;
        for site in &primer.binding_sites {
            logical_site_length += site.span.len();
            logical_site.push(site);
            if logical_site_length < binding_length {
                continue;
            }
            if logical_site_length == binding_length {
                let split_by_cut = linearized_circular
                    && logical_site
                        .iter()
                        .any(|site| map_span(site.span, source_spans).len() > 1);
                let mut mapped = logical_site
                    .iter()
                    .flat_map(|site| {
                        map_span(site.span, source_spans).into_iter().map(|span| {
                            PrimerBindingSite {
                                span,
                                strand: site.strand,
                            }
                        })
                    })
                    .collect::<Vec<_>>();
                mapped.sort_by_key(|site| site.span.start);
                let mut contiguous: Vec<PrimerBindingSite> = Vec::new();
                for site in mapped {
                    if let Some(previous) = contiguous.last_mut()
                        && previous.strand == site.strand
                        && previous.span.end == site.span.start
                    {
                        previous.span.end = site.span.end;
                    } else {
                        contiguous.push(site);
                    }
                }
                if !split_by_cut
                    && contiguous.len() == 1
                    && contiguous[0].span.len() == binding_length
                {
                    mapped_sites.extend(contiguous);
                }
            }
            logical_site.clear();
            logical_site_length = 0;
        }
        if mapped_sites.is_empty() {
            continue;
        }
        let primer_bytes = estimated_primer_bytes(primer, mapped_sites.len());
        if primer_bytes > maximum_bytes.saturating_sub(projected_bytes) {
            return Err(DigestError::TooManyAnnotations);
        }
        let mut mapped = primer.clone();
        mapped.binding_sites = mapped_sites;
        if output.len() >= maximum {
            return Err(DigestError::TooManyAnnotations);
        }
        output.push(mapped);
        projected_bytes += primer_bytes;
    }
    Ok((output, projected_bytes))
}

fn fragment_name(template_name: &str, enzymes: &[String], index: usize) -> String {
    let stem = template_name
        .rsplit_once('.')
        .map_or(template_name, |(stem, _)| stem);
    format!("{stem} — {} digest fragment {index}.dna", enzymes.join("+"))
}

fn restriction_fragment_feature(
    template_name: &str,
    enzyme_names: &[String],
    index: usize,
    length: usize,
    upstream_end: &DigestEnd,
    downstream_end: &DigestEnd,
) -> Feature {
    Feature {
        id: None,
        name: format!("Restriction fragment {index}"),
        kind: "misc_feature".to_owned(),
        color: Some("#5cc8d7".to_owned()),
        strand: Strand::Both,
        segments: vec![FeatureSegment {
            span: SequenceSpan::new(0, length),
            color: None,
            name: None,
            kind: Some("restriction_fragment".to_owned()),
        }],
        qualifiers: vec![
            Qualifier {
                name: "source".to_owned(),
                value: template_name.to_owned(),
            },
            Qualifier {
                name: "enzymes".to_owned(),
                value: enzyme_names.join(", "),
            },
            Qualifier {
                name: "upstream_end".to_owned(),
                value: upstream_end.label(),
            },
            Qualifier {
                name: "downstream_end".to_owned(),
                value: downstream_end.label(),
            },
        ],
        reading_frame: None,
    }
}

fn add_fragment_provenance(
    document: &mut SequenceDocument,
    template_name: &str,
    enzyme_names: &[String],
    index: usize,
) {
    document.notes.description = Some(format!(
        "Restriction fragment {index} from {template_name} after complete in-silico digestion with {}.",
        enzyme_names.join(", ")
    ));
    document.history.push(HistoryEntry {
        operation: HistoryOperation::Digest,
        description: format!(
            "Created restriction fragment with {}",
            enzyme_names.join(", ")
        ),
        recorded_at: "Generated by DOTDNA".to_owned(),
        parent_document: None,
    });
}

fn build_fragment(
    template: &SequenceDocument,
    enzyme_names: &[String],
    index: usize,
    source_spans: Vec<SequenceSpan>,
    upstream_end: DigestEnd,
    downstream_end: DigestEnd,
    budget: ProjectionBudget,
) -> Result<(DigestFragment, usize), DigestError> {
    if budget.features == 0 {
        return Err(DigestError::TooManyAnnotations);
    }
    let document_text_bytes = estimated_text_bytes(&template.name)
        .saturating_mul(3)
        .saturating_add(
            enzyme_names
                .iter()
                .map(|name| estimated_text_bytes(name))
                .sum::<usize>()
                .saturating_mul(3),
        )
        .saturating_add(1_024);
    if document_text_bytes > budget.annotation_bytes {
        return Err(DigestError::TooManyAnnotations);
    }
    let sequence = sequence_for_spans(&template.sequence, &source_spans);
    let mut document = SequenceDocument::new(
        fragment_name(&template.name, enzyme_names, index),
        &sequence,
    )
    .map_err(|_| DigestError::InvalidTemplate)?;
    document.double_stranded = template.double_stranded;
    document.topology = Topology::Linear;
    let (features, feature_bytes) = map_features(
        &template.features,
        &source_spans,
        budget.features - 1,
        budget.annotation_bytes.saturating_sub(document_text_bytes),
        template.topology == Topology::Circular && sequence.len() == template.sequence.len(),
    )?;
    let (primers, primer_bytes) = map_primers(
        &template.primers,
        &source_spans,
        budget.primers,
        budget
            .annotation_bytes
            .saturating_sub(document_text_bytes)
            .saturating_sub(feature_bytes),
        template.topology == Topology::Circular && sequence.len() == template.sequence.len(),
    )?;
    document.features = features;
    document.primers = primers;
    let fragment_feature = restriction_fragment_feature(
        &template.name,
        enzyme_names,
        index,
        sequence.len(),
        &upstream_end,
        &downstream_end,
    );
    let marker_segment_bytes = fragment_feature
        .segments
        .iter()
        .map(estimated_segment_text_bytes)
        .sum();
    let marker_bytes = estimated_feature_bytes(&fragment_feature, 1, marker_segment_bytes, false);
    if marker_bytes
        > budget
            .annotation_bytes
            .saturating_sub(document_text_bytes)
            .saturating_sub(feature_bytes)
            .saturating_sub(primer_bytes)
    {
        return Err(DigestError::TooManyAnnotations);
    }
    document.features.push(fragment_feature);
    add_fragment_provenance(&mut document, &template.name, enzyme_names, index);
    if !document.validate().is_empty() {
        return Err(DigestError::InvalidProduct);
    }
    let stats = document.stats();
    Ok((
        DigestFragment {
            index,
            source_spans,
            length: stats.length,
            gc_percent: stats.gc_percent,
            upstream_end,
            downstream_end,
            document,
        },
        feature_bytes
            .saturating_add(primer_bytes)
            .saturating_add(marker_bytes)
            .saturating_add(document_text_bytes),
    ))
}

fn build_linear_fragments(
    template: &SequenceDocument,
    enzyme_names: &[String],
    cuts_by_top: &BTreeMap<usize, &RestrictionCut>,
) -> Result<Vec<DigestFragment>, DigestError> {
    let mut boundaries = vec![0];
    boundaries.extend(
        cuts_by_top
            .keys()
            .copied()
            .filter(|position| *position > 0 && *position < template.sequence.len()),
    );
    boundaries.push(template.sequence.len());
    boundaries.sort_unstable();
    boundaries.dedup();

    let mut fragments = Vec::new();
    let mut projected_features = 0;
    let mut projected_primers = 0;
    let mut projected_annotation_bytes = 0;
    for (offset, pair) in boundaries.windows(2).enumerate() {
        let start = pair[0];
        let end = pair[1];
        if start == end {
            continue;
        }
        let upstream_end = cuts_by_top
            .get(&start)
            .map_or_else(DigestEnd::natural, |cut| cut.end(true));
        let downstream_end = cuts_by_top
            .get(&end)
            .map_or_else(DigestEnd::natural, |cut| cut.end(false));
        let (fragment, annotation_bytes) = build_fragment(
            template,
            enzyme_names,
            offset + 1,
            vec![SequenceSpan::new(start, end)],
            upstream_end,
            downstream_end,
            ProjectionBudget {
                features: MAX_PROJECTED_FEATURES.saturating_sub(projected_features),
                primers: MAX_PROJECTED_PRIMERS.saturating_sub(projected_primers),
                annotation_bytes: MAX_PROJECTED_ANNOTATION_BYTES
                    .saturating_sub(projected_annotation_bytes),
            },
        )?;
        projected_features += fragment.document.features.len();
        projected_primers += fragment.document.primers.len();
        projected_annotation_bytes += annotation_bytes;
        fragments.push(fragment);
    }
    Ok(fragments)
}

fn circular_fragment_spans(
    start: usize,
    end: usize,
    cut_count: usize,
    sequence_length: usize,
) -> Vec<SequenceSpan> {
    if cut_count == 1 {
        if start == 0 {
            vec![SequenceSpan::new(0, sequence_length)]
        } else {
            vec![
                SequenceSpan::new(start, sequence_length),
                SequenceSpan::new(0, start),
            ]
        }
    } else if end > start {
        vec![SequenceSpan::new(start, end)]
    } else {
        vec![
            SequenceSpan::new(start, sequence_length),
            SequenceSpan::new(0, end),
        ]
    }
}

fn build_circular_fragments(
    template: &SequenceDocument,
    enzyme_names: &[String],
    cuts_by_top: &BTreeMap<usize, &RestrictionCut>,
) -> Result<Vec<DigestFragment>, DigestError> {
    let positions = cuts_by_top.keys().copied().collect::<Vec<_>>();
    let mut fragments = Vec::new();
    let mut projected_features = 0;
    let mut projected_primers = 0;
    let mut projected_annotation_bytes = 0;
    for (offset, start) in positions.iter().copied().enumerate() {
        let end = positions[(offset + 1) % positions.len()];
        let (fragment, annotation_bytes) = build_fragment(
            template,
            enzyme_names,
            offset + 1,
            circular_fragment_spans(start, end, positions.len(), template.sequence.len()),
            cuts_by_top[&start].end(true),
            cuts_by_top[&end].end(false),
            ProjectionBudget {
                features: MAX_PROJECTED_FEATURES.saturating_sub(projected_features),
                primers: MAX_PROJECTED_PRIMERS.saturating_sub(projected_primers),
                annotation_bytes: MAX_PROJECTED_ANNOTATION_BYTES
                    .saturating_sub(projected_annotation_bytes),
            },
        )?;
        projected_features += fragment.document.features.len();
        projected_primers += fragment.document.primers.len();
        projected_annotation_bytes += annotation_bytes;
        fragments.push(fragment);
    }
    Ok(fragments)
}

/// Simulates a complete digest and returns deterministic linear fragment documents.
///
/// # Errors
///
/// Returns an error for unsupported enzymes, invalid templates, no valid cleavage, conflicting
/// cut geometry, or a digest that exceeds the bounded interactive fragment limit.
pub fn simulate_restriction_digest(
    template: &SequenceDocument,
    selected_enzymes: &[String],
) -> Result<RestrictionDigest, DigestError> {
    if template.sequence.is_empty() || !template.double_stranded {
        return Err(DigestError::InvalidTemplate);
    }
    if selected_enzymes.is_empty() {
        return Err(DigestError::NoEnzymes);
    }
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    for requested in selected_enzymes {
        let definition = ENZYMES
            .iter()
            .copied()
            .find(|definition| definition.name.eq_ignore_ascii_case(requested.trim()))
            .ok_or_else(|| DigestError::UnknownEnzyme(requested.clone()))?;
        if seen.insert(definition.name) {
            selected.push(definition);
        }
    }
    let enzyme_names = selected
        .iter()
        .map(|definition| definition.name.to_owned())
        .collect::<Vec<_>>();
    let mut raw_cuts = Vec::new();
    let mut warnings = vec![
        "In-silico cleavage does not account for methylation, star activity, buffer compatibility, incubation temperature, or partial digestion.".to_owned(),
    ];
    for definition in selected {
        let (recognized, valid) = scan_definition(template, definition, &mut raw_cuts)?;
        if valid == 0 {
            warnings.push(if recognized == 0 {
                format!("{} has no recognition site in this template.", definition.name)
            } else {
                format!(
                    "{} recognition was found, but one or both cleavage positions lie at or beyond a linear template end.",
                    definition.name
                )
            });
        } else if valid > 1 {
            warnings.push(format!(
                "{} cuts this template at {valid} physical sites; verify that a complete multi-cutter digest is intended.",
                definition.name
            ));
        }
    }
    let cuts = deduplicate_cuts(raw_cuts)?;
    if cuts.is_empty() {
        return Err(DigestError::NoCuts);
    }
    validate_non_overlapping_cuts(&cuts, template.topology, template.sequence.len())?;
    if template
        .sequence
        .bytes()
        .any(|base| !matches!(base, b'A' | b'C' | b'G' | b'T'))
    {
        warnings.push("Ambiguous bases are treated as non-matching; verify enzyme sites across each ambiguous region.".to_owned());
    }
    let mut cuts_by_top: BTreeMap<usize, &RestrictionCut> = BTreeMap::new();
    for cut in &cuts {
        cuts_by_top.insert(cut.top_cut_position, cut);
    }
    if template.topology == Topology::Linear
        && let Some(pair) = cuts
            .windows(2)
            .find(|pair| pair[0].bottom_cut_position > pair[1].bottom_cut_position)
    {
        return Err(DigestError::ConflictingCuts(pair[1].top_cut_position));
    }
    let fragments = match template.topology {
        Topology::Linear => build_linear_fragments(template, &enzyme_names, &cuts_by_top)?,
        Topology::Circular => build_circular_fragments(template, &enzyme_names, &cuts_by_top)?,
    };
    if fragments
        .iter()
        .map(|fragment| fragment.length)
        .sum::<usize>()
        != template.sequence.len()
    {
        return Err(DigestError::InvalidProduct);
    }
    Ok(RestrictionDigest {
        enzyme_names,
        cuts,
        fragments,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(sequence: &str, topology: Topology) -> SequenceDocument {
        let mut document = SequenceDocument::new("template.dna", sequence).unwrap();
        document.topology = topology;
        document
    }

    #[test]
    fn linear_digest_creates_n_plus_one_fragments_with_explicit_sticky_ends() {
        let template = document("AAAAGAATTCCCCCGGATCCAAAA", Topology::Linear);
        let digest =
            simulate_restriction_digest(&template, &["EcoRI".to_owned(), "BamHI".to_owned()])
                .unwrap();
        assert_eq!(digest.cuts.len(), 2);
        assert_eq!(digest.fragments.len(), 3);
        assert_eq!(
            digest
                .fragments
                .iter()
                .map(|fragment| fragment.length)
                .sum::<usize>(),
            template.sequence.len()
        );
        assert!(
            digest
                .cuts
                .iter()
                .all(|cut| cut.end_type == DigestEndType::FivePrime)
        );
        assert!(digest.cuts.iter().all(|cut| cut.overhang_length == 4));
        assert!(
            digest
                .fragments
                .iter()
                .all(|fragment| fragment.document.topology == Topology::Linear)
        );
    }

    #[test]
    fn one_circular_cut_rotates_a_full_length_linear_product() {
        let template = document("TTTGAATTCAAA", Topology::Circular);
        let digest = simulate_restriction_digest(&template, &["EcoRI".to_owned()]).unwrap();
        assert_eq!(digest.fragments.len(), 1);
        let fragment = &digest.fragments[0];
        assert_eq!(fragment.length, template.sequence.len());
        assert_eq!(fragment.document.sequence, "AATTCAAATTTG");
        assert_eq!(fragment.upstream_end.end_type, DigestEndType::FivePrime);
        assert_eq!(fragment.downstream_end.end_type, DigestEndType::FivePrime);
    }

    #[test]
    fn origin_spanning_type_iis_site_has_normalized_cuts() {
        let template = document("TCTCAAAAGG", Topology::Circular);
        let digest = simulate_restriction_digest(&template, &["BsaI".to_owned()]).unwrap();
        assert_eq!(digest.cuts.len(), 1);
        assert!(digest.cuts[0].top_cut_position < template.sequence.len());
        assert!(digest.cuts[0].bottom_cut_position < template.sequence.len());
        assert_eq!(digest.fragments[0].length, template.sequence.len());
    }

    #[test]
    fn clips_features_and_marks_partial_annotations() {
        let mut template = document("AAAAGAATTCCCCCCCC", Topology::Linear);
        template.features.push(Feature {
            id: None,
            name: "crossing".to_owned(),
            kind: "CDS".to_owned(),
            color: None,
            strand: Strand::Forward,
            segments: vec![FeatureSegment {
                span: SequenceSpan::new(2, 10),
                color: None,
                name: None,
                kind: None,
            }],
            qualifiers: vec![
                Qualifier {
                    name: "translation".to_owned(),
                    value: "FULLPROTEIN".to_owned(),
                },
                Qualifier {
                    name: "gene".to_owned(),
                    value: "kept-name".to_owned(),
                },
            ],
            reading_frame: Some(0),
        });
        let digest = simulate_restriction_digest(&template, &["EcoRI".to_owned()]).unwrap();
        let clipped = digest
            .fragments
            .iter()
            .flat_map(|fragment| &fragment.document.features)
            .find(|feature| feature.name == "crossing")
            .unwrap();
        assert_eq!(clipped.reading_frame, None);
        assert!(
            clipped
                .qualifiers
                .iter()
                .any(|qualifier| qualifier.value.contains("clipped"))
        );
        assert!(
            clipped
                .qualifiers
                .iter()
                .all(|qualifier| !qualifier.name.eq_ignore_ascii_case("translation"))
        );
        assert!(
            clipped
                .qualifiers
                .iter()
                .any(|qualifier| qualifier.name == "gene")
        );
    }

    #[test]
    fn no_cut_is_an_error_instead_of_a_false_product() {
        let template = document("ACGTACGT", Topology::Circular);
        assert_eq!(
            simulate_restriction_digest(&template, &["EcoRI".to_owned()]),
            Err(DigestError::NoCuts)
        );
    }

    #[test]
    fn two_circular_cuts_create_two_reference_ordered_fragments() {
        let template = document("GAATTCAAAAGAATTC", Topology::Circular);
        let digest = simulate_restriction_digest(&template, &["EcoRI".to_owned()]).unwrap();
        assert_eq!(digest.cuts.len(), 2);
        assert_eq!(digest.fragments.len(), 2);
        assert_eq!(
            digest.fragments[0].source_spans,
            vec![SequenceSpan::new(1, 11)]
        );
        assert_eq!(
            digest.fragments[1].source_spans,
            vec![SequenceSpan::new(11, 16), SequenceSpan::new(0, 1)]
        );
        assert_eq!(
            digest
                .fragments
                .iter()
                .map(|fragment| fragment.length)
                .sum::<usize>(),
            template.sequence.len()
        );
    }

    #[test]
    fn palindromic_site_is_not_double_counted() {
        let template = document("AAAAGAATTCAAAA", Topology::Linear);
        let digest = simulate_restriction_digest(&template, &["EcoRI".to_owned()]).unwrap();
        assert_eq!(digest.cuts.len(), 1);
        assert_eq!(digest.fragments.len(), 2);
    }

    #[test]
    fn type_iis_cleavage_beyond_a_linear_end_is_not_materialized() {
        let template = document("GGTCTC", Topology::Linear);
        assert_eq!(
            simulate_restriction_digest(&template, &["BsaI".to_owned()]),
            Err(DigestError::NoCuts)
        );

        let boundary_nick = document("AAAAAGAGACCAAAAAAAA", Topology::Linear);
        assert_eq!(
            simulate_restriction_digest(&boundary_nick, &["BsaI".to_owned()]),
            Err(DigestError::NoCuts)
        );
    }

    #[test]
    fn overlapping_staggered_cuts_are_rejected() {
        let template = document("AAAAGGTCTCGAGAAAAAAAA", Topology::Linear);
        assert!(matches!(
            simulate_restriction_digest(&template, &["XhoI".to_owned(), "BsaI".to_owned()]),
            Err(DigestError::ConflictingCuts(_))
        ));

        let touching = document("GGATCCAAAAGAGACC", Topology::Linear);
        assert!(matches!(
            simulate_restriction_digest(&touching, &["BamHI".to_owned(), "BsaI".to_owned()]),
            Err(DigestError::ConflictingCuts(_))
        ));
    }

    #[test]
    fn rejects_single_stranded_templates_and_unbounded_repetitive_digests() {
        let mut single_stranded = document("AAAAGAATTCAAAA", Topology::Linear);
        single_stranded.double_stranded = false;
        assert_eq!(
            simulate_restriction_digest(&single_stranded, &["EcoRI".to_owned()]),
            Err(DigestError::InvalidTemplate)
        );

        let repetitive = document(&"GAATTC".repeat(MAX_DIGEST_CUTS + 1), Topology::Linear);
        assert_eq!(
            simulate_restriction_digest(&repetitive, &["EcoRI".to_owned()]),
            Err(DigestError::TooManyCuts)
        );
    }

    #[test]
    fn models_blunt_and_three_prime_end_geometry() {
        let sequence = "AACCGG";
        let blunt = candidate_cut(
            sequence,
            Topology::Linear,
            EnzymeDefinition {
                name: "BluntTest",
                recognition_sequence: sequence,
                top_cut_offset: 3,
                bottom_cut_offset: 3,
            },
            0,
            Strand::Forward,
        )
        .unwrap();
        assert_eq!(blunt.end_type, DigestEndType::Blunt);
        assert_eq!(blunt.overhang_length, 0);

        let three_prime = candidate_cut(
            sequence,
            Topology::Linear,
            EnzymeDefinition {
                name: "ThreePrimeTest",
                recognition_sequence: sequence,
                top_cut_offset: 5,
                bottom_cut_offset: 1,
            },
            0,
            Strand::Forward,
        )
        .unwrap();
        assert_eq!(three_prime.end_type, DigestEndType::ThreePrime);
        assert_eq!(three_prime.overhang_sequence, "ACCG");
        assert_eq!(three_prime.end(false).overhang_strand, Strand::Forward);
        assert_eq!(three_prime.end(true).overhang_strand, Strand::Reverse);
        assert_eq!(three_prime.end(true).overhang_sequence, "CGGT");
    }

    #[test]
    fn rejects_incompatible_cuts_at_the_same_top_strand_boundary() {
        let sequence = "AACCGG";
        let first = candidate_cut(
            sequence,
            Topology::Linear,
            EnzymeDefinition {
                name: "First",
                recognition_sequence: sequence,
                top_cut_offset: 1,
                bottom_cut_offset: 5,
            },
            0,
            Strand::Forward,
        )
        .unwrap();
        let second = candidate_cut(
            sequence,
            Topology::Linear,
            EnzymeDefinition {
                name: "Second",
                recognition_sequence: sequence,
                top_cut_offset: 1,
                bottom_cut_offset: 4,
            },
            0,
            Strand::Forward,
        )
        .unwrap();
        assert_eq!(
            deduplicate_cuts(vec![first, second]),
            Err(DigestError::ConflictingCuts(1))
        );
    }

    #[test]
    fn preserves_only_complete_logical_primer_sites() {
        let mut template = document("AAAAGAATTCCCCCCCCCCCC", Topology::Linear);
        template.notes.uuid = Some("source-only-uuid".to_owned());
        template.primers = vec![
            Primer {
                id: Some("complete".to_owned()),
                name: "complete".to_owned(),
                sequence: "CCCC".to_owned(),
                binding_length: Some(4),
                description: None,
                color: None,
                phosphorylated: false,
                binding_sites: vec![PrimerBindingSite {
                    span: SequenceSpan::new(10, 14),
                    strand: Strand::Forward,
                }],
            },
            Primer {
                id: Some("crossing".to_owned()),
                name: "crossing".to_owned(),
                sequence: "AATT".to_owned(),
                binding_length: Some(4),
                description: None,
                color: None,
                phosphorylated: false,
                binding_sites: vec![PrimerBindingSite {
                    span: SequenceSpan::new(3, 7),
                    strand: Strand::Forward,
                }],
            },
        ];
        let digest = simulate_restriction_digest(&template, &["EcoRI".to_owned()]).unwrap();
        let product_with_complete = digest
            .fragments
            .iter()
            .find(|fragment| {
                fragment
                    .document
                    .primers
                    .iter()
                    .any(|primer| primer.name == "complete")
            })
            .unwrap();
        assert!(digest.fragments.iter().all(|fragment| {
            !fragment
                .document
                .primers
                .iter()
                .any(|primer| primer.name == "crossing")
        }));
        assert_eq!(product_with_complete.document.notes.uuid, None);
        for fragment in &digest.fragments {
            assert!(fragment.document.validate().is_empty());
            assert!(fragment.document.history.iter().any(|entry| {
                entry.operation == HistoryOperation::Digest && entry.parent_document.is_none()
            }));
        }
    }

    #[test]
    fn origin_split_primer_site_is_kept_only_when_both_spans_survive() {
        let primer = Primer {
            id: None,
            name: "origin".to_owned(),
            sequence: "AAAA".to_owned(),
            binding_length: Some(4),
            description: None,
            color: None,
            phosphorylated: false,
            binding_sites: vec![
                PrimerBindingSite {
                    span: SequenceSpan::new(10, 12),
                    strand: Strand::Forward,
                },
                PrimerBindingSite {
                    span: SequenceSpan::new(0, 2),
                    strand: Strand::Forward,
                },
            ],
        };
        let complete = map_primers(
            std::slice::from_ref(&primer),
            &[SequenceSpan::new(8, 12), SequenceSpan::new(0, 4)],
            1,
            MAX_PROJECTED_ANNOTATION_BYTES,
            true,
        )
        .unwrap()
        .0;
        assert_eq!(complete.len(), 1);
        assert_eq!(
            complete[0]
                .binding_sites
                .iter()
                .map(|site| site.span.len())
                .sum::<usize>(),
            4
        );
        assert!(
            map_primers(
                &[primer],
                &[SequenceSpan::new(8, 12)],
                1,
                MAX_PROJECTED_ANNOTATION_BYTES,
                true,
            )
            .unwrap()
            .0
            .is_empty()
        );
    }

    #[test]
    fn circular_linearization_drops_cut_primer_and_marks_cut_feature() {
        let mut template = document("TTTGAATTCAAA", Topology::Circular);
        template.features.push(Feature {
            id: None,
            name: "cut feature".to_owned(),
            kind: "CDS".to_owned(),
            color: None,
            strand: Strand::Forward,
            segments: vec![FeatureSegment {
                span: SequenceSpan::new(2, 6),
                color: None,
                name: None,
                kind: None,
            }],
            qualifiers: Vec::new(),
            reading_frame: Some(0),
        });
        template.primers.push(Primer {
            id: None,
            name: "cut primer".to_owned(),
            sequence: "TGAA".to_owned(),
            binding_length: Some(4),
            description: None,
            color: None,
            phosphorylated: false,
            binding_sites: vec![PrimerBindingSite {
                span: SequenceSpan::new(2, 6),
                strand: Strand::Forward,
            }],
        });
        template.primers.push(Primer {
            id: None,
            name: "whole template".to_owned(),
            sequence: template.sequence.clone(),
            binding_length: Some(template.sequence.len()),
            description: None,
            color: None,
            phosphorylated: false,
            binding_sites: vec![PrimerBindingSite {
                span: SequenceSpan::new(0, template.sequence.len()),
                strand: Strand::Forward,
            }],
        });
        let digest = simulate_restriction_digest(&template, &["EcoRI".to_owned()]).unwrap();
        let product = &digest.fragments[0].document;
        assert!(product.primers.is_empty());
        let feature = product
            .features
            .iter()
            .find(|feature| feature.name == "cut feature")
            .unwrap();
        assert_eq!(feature.reading_frame, None);
        assert!(
            feature
                .qualifiers
                .iter()
                .any(|qualifier| qualifier.value.contains("clipped"))
        );
    }

    #[test]
    fn feature_exactly_between_linear_cuts_is_not_marked_clipped() {
        let mut template = document("GAATTCAAAAGAATTC", Topology::Linear);
        template.features.push(Feature {
            id: None,
            name: "middle".to_owned(),
            kind: "CDS".to_owned(),
            color: None,
            strand: Strand::Forward,
            segments: vec![FeatureSegment {
                span: SequenceSpan::new(1, 11),
                color: None,
                name: None,
                kind: None,
            }],
            qualifiers: Vec::new(),
            reading_frame: Some(0),
        });
        let digest = simulate_restriction_digest(&template, &["EcoRI".to_owned()]).unwrap();
        let feature = digest.fragments[1]
            .document
            .features
            .iter()
            .find(|feature| feature.name == "middle")
            .unwrap();
        assert_eq!(feature.reading_frame, Some(0));
        assert!(feature.qualifiers.is_empty());
    }

    #[test]
    fn projected_annotation_payload_is_bounded_before_clone_amplification() {
        let mut template = document(&"GAATTC".repeat(10), Topology::Linear);
        template.features.push(Feature {
            id: Some("large-feature".to_owned()),
            name: "large".to_owned(),
            kind: "misc_feature".to_owned(),
            color: None,
            strand: Strand::Both,
            segments: vec![FeatureSegment {
                span: SequenceSpan::new(0, template.sequence.len()),
                color: None,
                name: None,
                kind: None,
            }],
            qualifiers: vec![Qualifier {
                name: "note".to_owned(),
                value: "x".repeat(1_000_000),
            }],
            reading_frame: None,
        });
        assert_eq!(
            simulate_restriction_digest(&template, &["EcoRI".to_owned()]),
            Err(DigestError::TooManyAnnotations)
        );
    }
}
