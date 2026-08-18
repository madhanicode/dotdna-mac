use std::collections::BTreeMap;

use dotdna_core::{
    DocumentMetadata, DocumentNotes, Feature, FeatureSegment, HistoryEntry, HistoryOperation,
    PacketFormat, Primer, PrimerBindingSite, Qualifier, SequenceDocument, SequenceProperties,
    SequenceSpan, SnapGeneHeader, SnapGenePacket, Strand, Topology,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ProjectError {
    #[error("this DOTDNA project contains invalid JSON: {0}")]
    InvalidJson(String),
    #[error("this is not a supported DOTDNA project file")]
    Unsupported,
    #[error("the DOTDNA project sequence is invalid: {0}")]
    InvalidSequence(String),
    #[error("the DOTDNA project could not be serialized: {0}")]
    Serialization(String),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFile {
    format: String,
    version: u8,
    name: String,
    saved_at: String,
    data: LegacySequenceData,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySequenceData {
    sequence: String,
    length: usize,
    gc_percent: f64,
    unknown_bases: usize,
    circular: bool,
    double_stranded: bool,
    #[serde(default)]
    features: Vec<LegacyFeature>,
    #[serde(default)]
    primers: Vec<LegacyPrimer>,
    #[serde(default)]
    primer_settings: BTreeMap<String, String>,
    #[serde(default)]
    notes: LegacyNotes,
    #[serde(default)]
    sequence_properties: LegacySequenceProperties,
    #[serde(default)]
    enzyme_visibilities: Vec<String>,
    #[serde(default)]
    custom_enzyme_set_count: usize,
    #[serde(default)]
    alignable_sequence_count: usize,
    #[serde(default)]
    header: LegacyHeader,
    #[serde(default)]
    packets: Vec<LegacyPacket>,
    #[serde(default)]
    packet_count: usize,
    #[serde(default)]
    history: Vec<LegacyHistoryEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHistoryEntry {
    operation: HistoryOperation,
    description: String,
    recorded_at: String,
    parent: Option<LegacyHistorySnapshot>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHistorySnapshot {
    name: String,
    sequence: String,
    circular: bool,
    double_stranded: bool,
    #[serde(default)]
    features: Vec<LegacyFeature>,
    #[serde(default)]
    primers: Vec<LegacyPrimer>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyFeature {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    range: Option<String>,
    color: Option<String>,
    #[serde(default)]
    directionality: u8,
    strand: Option<String>,
    #[serde(default)]
    segments: Vec<LegacySegment>,
    #[serde(default)]
    qualifiers: Vec<Qualifier>,
    reading_frame: Option<i8>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct LegacySegment {
    range: String,
    start: Option<usize>,
    end: Option<usize>,
    color: Option<String>,
    name: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPrimer {
    #[serde(default)]
    id: Option<String>,
    name: String,
    sequence: String,
    binding_length: Option<usize>,
    description: Option<String>,
    color: Option<String>,
    #[serde(default)]
    phosphorylated: bool,
    #[serde(default)]
    binding_sites: Vec<LegacyBindingSite>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyBindingSite {
    range: String,
    start: Option<usize>,
    end: Option<usize>,
    bound_strand: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyNotes {
    uuid: Option<String>,
    #[serde(rename = "type")]
    sequence_type: Option<String>,
    created: Option<String>,
    created_utc: Option<String>,
    last_modified: Option<String>,
    last_modified_utc: Option<String>,
    created_by: Option<String>,
    accession_number: Option<String>,
    description: Option<String>,
    comments: Option<String>,
    sequence_class: Option<String>,
    transformed_into: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySequenceProperties {
    upstream_stickiness: Option<i32>,
    downstream_stickiness: Option<i32>,
    upstream_modification: Option<String>,
    downstream_modification: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHeader {
    sequence_type: Option<u16>,
    export_version: Option<u16>,
    import_version: Option<u16>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPacket {
    index: usize,
    #[serde(rename = "type")]
    packet_type: u8,
    hex_type: String,
    name: String,
    byte_length: usize,
    format: Option<PacketFormat>,
    decoded: bool,
}

fn strand_from_legacy(value: Option<&str>, directionality: u8) -> Strand {
    match value {
        Some("+") => Strand::Forward,
        Some("-") => Strand::Reverse,
        Some("both") => Strand::Both,
        _ => match directionality {
            1 => Strand::Forward,
            2 => Strand::Reverse,
            3 => Strand::Both,
            _ => Strand::None,
        },
    }
}

const fn directionality(strand: Strand) -> u8 {
    match strand {
        Strand::Forward => 1,
        Strand::Reverse => 2,
        Strand::Both => 3,
        Strand::None => 0,
    }
}

const fn strand_name(strand: Strand) -> Option<&'static str> {
    match strand {
        Strand::Forward => Some("+"),
        Strand::Reverse => Some("-"),
        Strand::Both => Some("both"),
        Strand::None => None,
    }
}

fn span_from_legacy(start: Option<usize>, end: Option<usize>, range: &str) -> Option<SequenceSpan> {
    let values = start.zip(end).or_else(|| {
        let mut numbers = range
            .split(|character: char| !character.is_ascii_digit())
            .filter(|value| !value.is_empty())
            .filter_map(|value| value.parse::<usize>().ok());
        let start = numbers.next()?;
        Some((start, numbers.next().unwrap_or(start)))
    })?;
    (values.0 > 0 && values.1 >= values.0).then(|| SequenceSpan::new(values.0 - 1, values.1))
}

fn segment_from_legacy(segment: LegacySegment) -> Option<FeatureSegment> {
    Some(FeatureSegment {
        span: span_from_legacy(segment.start, segment.end, &segment.range)?,
        color: segment.color,
        name: segment.name,
        kind: segment.kind,
    })
}

impl From<LegacyFeature> for Feature {
    fn from(feature: LegacyFeature) -> Self {
        let LegacyFeature {
            id,
            name,
            kind,
            color,
            directionality,
            strand,
            segments,
            qualifiers,
            reading_frame,
            ..
        } = feature;
        Self {
            id,
            name,
            kind,
            color,
            strand: strand_from_legacy(strand.as_deref(), directionality),
            segments: segments
                .into_iter()
                .filter_map(segment_from_legacy)
                .collect(),
            qualifiers,
            reading_frame,
        }
    }
}

impl From<LegacyPrimer> for Primer {
    fn from(primer: LegacyPrimer) -> Self {
        Self {
            id: primer.id,
            name: primer.name,
            sequence: primer.sequence,
            binding_length: primer.binding_length,
            description: primer.description,
            color: primer.color,
            phosphorylated: primer.phosphorylated,
            binding_sites: primer
                .binding_sites
                .into_iter()
                .filter_map(|site| {
                    Some(PrimerBindingSite {
                        span: span_from_legacy(site.start, site.end, &site.range)?,
                        strand: if site.bound_strand == "-" {
                            Strand::Reverse
                        } else {
                            Strand::Forward
                        },
                    })
                })
                .collect(),
        }
    }
}

impl From<LegacyNotes> for DocumentNotes {
    fn from(notes: LegacyNotes) -> Self {
        Self {
            uuid: notes.uuid,
            sequence_type: notes.sequence_type,
            created: notes.created,
            created_utc: notes.created_utc,
            last_modified: notes.last_modified,
            last_modified_utc: notes.last_modified_utc,
            created_by: notes.created_by,
            accession_number: notes.accession_number,
            description: notes.description,
            comments: notes.comments,
            sequence_class: notes.sequence_class,
            transformed_into: notes.transformed_into,
        }
    }
}

fn history_from_legacy(entry: LegacyHistoryEntry) -> Result<HistoryEntry, ProjectError> {
    let parent_document = entry
        .parent
        .map(|snapshot| {
            let mut parent = SequenceDocument::new(snapshot.name, &snapshot.sequence)
                .map_err(|error| ProjectError::InvalidSequence(error.to_string()))?;
            parent.topology = if snapshot.circular {
                Topology::Circular
            } else {
                Topology::Linear
            };
            parent.double_stranded = snapshot.double_stranded;
            parent.features = snapshot.features.into_iter().map(Feature::from).collect();
            parent.primers = snapshot.primers.into_iter().map(Primer::from).collect();
            Ok(Box::new(parent))
        })
        .transpose()?;
    Ok(HistoryEntry {
        operation: entry.operation,
        description: entry.description,
        recorded_at: entry.recorded_at,
        parent_document,
    })
}

fn document_from_legacy(data: LegacySequenceData) -> Result<SequenceDocument, ProjectError> {
    let mut document = SequenceDocument::new("DOTDNA project", &data.sequence)
        .map_err(|error| ProjectError::InvalidSequence(error.to_string()))?;
    document.topology = if data.circular {
        Topology::Circular
    } else {
        Topology::Linear
    };
    document.double_stranded = data.double_stranded;
    document.features = data.features.into_iter().map(Feature::from).collect();
    document.primers = data.primers.into_iter().map(Primer::from).collect();
    document.notes = data.notes.into();
    document.metadata = DocumentMetadata {
        primer_settings: data.primer_settings,
        sequence_properties: SequenceProperties {
            upstream_stickiness: data.sequence_properties.upstream_stickiness,
            downstream_stickiness: data.sequence_properties.downstream_stickiness,
            upstream_modification: data.sequence_properties.upstream_modification,
            downstream_modification: data.sequence_properties.downstream_modification,
        },
        enzyme_visibilities: data.enzyme_visibilities,
        custom_enzyme_set_count: data.custom_enzyme_set_count,
        alignable_sequence_count: data.alignable_sequence_count,
        snapgene_header: SnapGeneHeader {
            sequence_type: data.header.sequence_type,
            export_version: data.header.export_version,
            import_version: data.header.import_version,
        },
        snapgene_packets: data
            .packets
            .into_iter()
            .map(|packet| SnapGenePacket {
                index: packet.index,
                packet_type: packet.packet_type,
                name: packet.name,
                byte_length: packet.byte_length,
                format: packet.format.unwrap_or(PacketFormat::Binary),
                decoded: packet.decoded,
            })
            .collect(),
    };
    document.history = data
        .history
        .into_iter()
        .map(history_from_legacy)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(document)
}

impl From<&FeatureSegment> for LegacySegment {
    fn from(segment: &FeatureSegment) -> Self {
        let start = segment.span.start + 1;
        let end = segment.span.end;
        Self {
            range: format!("{start}-{end}"),
            start: Some(start),
            end: Some(end),
            color: segment.color.clone(),
            name: segment.name.clone(),
            kind: segment.kind.clone(),
        }
    }
}

impl From<&Feature> for LegacyFeature {
    fn from(feature: &Feature) -> Self {
        let segments = feature
            .segments
            .iter()
            .map(LegacySegment::from)
            .collect::<Vec<_>>();
        Self {
            id: feature.id.clone(),
            name: feature.name.clone(),
            kind: feature.kind.clone(),
            range: (!segments.is_empty()).then(|| {
                segments
                    .iter()
                    .map(|segment| segment.range.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            }),
            color: feature.color.clone(),
            directionality: directionality(feature.strand),
            strand: strand_name(feature.strand).map(ToOwned::to_owned),
            segments,
            qualifiers: feature.qualifiers.clone(),
            reading_frame: feature.reading_frame,
        }
    }
}

impl From<&Primer> for LegacyPrimer {
    fn from(primer: &Primer) -> Self {
        Self {
            id: primer.id.clone(),
            name: primer.name.clone(),
            sequence: primer.sequence.clone(),
            binding_length: primer.binding_length,
            description: primer.description.clone(),
            color: primer.color.clone(),
            phosphorylated: primer.phosphorylated,
            binding_sites: primer
                .binding_sites
                .iter()
                .map(|site| {
                    let start = site.span.start + 1;
                    let end = site.span.end;
                    LegacyBindingSite {
                        range: format!("{start}-{end}"),
                        start: Some(start),
                        end: Some(end),
                        bound_strand: if site.strand == Strand::Reverse {
                            "-".to_owned()
                        } else {
                            "+".to_owned()
                        },
                    }
                })
                .collect(),
        }
    }
}

impl From<&DocumentNotes> for LegacyNotes {
    fn from(notes: &DocumentNotes) -> Self {
        Self {
            uuid: notes.uuid.clone(),
            sequence_type: notes.sequence_type.clone(),
            created: notes.created.clone(),
            created_utc: notes.created_utc.clone(),
            last_modified: notes.last_modified.clone(),
            last_modified_utc: notes.last_modified_utc.clone(),
            created_by: notes.created_by.clone(),
            accession_number: notes.accession_number.clone(),
            description: notes.description.clone(),
            comments: notes.comments.clone(),
            sequence_class: notes.sequence_class.clone(),
            transformed_into: notes.transformed_into.clone(),
        }
    }
}

fn legacy_data(document: &SequenceDocument) -> LegacySequenceData {
    let stats = document.stats();
    LegacySequenceData {
        sequence: document.sequence.clone(),
        length: stats.length,
        gc_percent: stats.gc_percent,
        unknown_bases: stats.unknown_bases,
        circular: document.topology == Topology::Circular,
        double_stranded: document.double_stranded,
        features: document.features.iter().map(LegacyFeature::from).collect(),
        primers: document.primers.iter().map(LegacyPrimer::from).collect(),
        primer_settings: document.metadata.primer_settings.clone(),
        notes: LegacyNotes::from(&document.notes),
        sequence_properties: LegacySequenceProperties {
            upstream_stickiness: document.metadata.sequence_properties.upstream_stickiness,
            downstream_stickiness: document.metadata.sequence_properties.downstream_stickiness,
            upstream_modification: document
                .metadata
                .sequence_properties
                .upstream_modification
                .clone(),
            downstream_modification: document
                .metadata
                .sequence_properties
                .downstream_modification
                .clone(),
        },
        enzyme_visibilities: document.metadata.enzyme_visibilities.clone(),
        custom_enzyme_set_count: document.metadata.custom_enzyme_set_count,
        alignable_sequence_count: document.metadata.alignable_sequence_count,
        header: LegacyHeader {
            sequence_type: document.metadata.snapgene_header.sequence_type,
            export_version: document.metadata.snapgene_header.export_version,
            import_version: document.metadata.snapgene_header.import_version,
        },
        packets: document
            .metadata
            .snapgene_packets
            .iter()
            .map(|packet| LegacyPacket {
                index: packet.index,
                packet_type: packet.packet_type,
                hex_type: format!("0x{:02X}", packet.packet_type),
                name: packet.name.clone(),
                byte_length: packet.byte_length,
                format: Some(packet.format),
                decoded: packet.decoded,
            })
            .collect(),
        packet_count: document.metadata.snapgene_packets.len(),
        history: document
            .history
            .iter()
            .map(|entry| LegacyHistoryEntry {
                operation: entry.operation.clone(),
                description: entry.description.clone(),
                recorded_at: entry.recorded_at.clone(),
                parent: entry
                    .parent_document
                    .as_deref()
                    .map(|parent| LegacyHistorySnapshot {
                        name: parent.name.clone(),
                        sequence: parent.sequence.clone(),
                        circular: parent.topology == Topology::Circular,
                        double_stranded: parent.double_stranded,
                        features: parent.features.iter().map(LegacyFeature::from).collect(),
                        primers: parent.primers.iter().map(LegacyPrimer::from).collect(),
                    }),
            })
            .collect(),
    }
}

/// Parses a portable `DOTDNA` project version 1.
///
/// # Errors
///
/// Returns an error for invalid JSON, unsupported versions, or invalid DNA.
pub fn parse_dotdna_project(text: &str) -> Result<SequenceDocument, ProjectError> {
    let project: ProjectFile =
        serde_json::from_str(text).map_err(|error| ProjectError::InvalidJson(error.to_string()))?;
    if project.format != "dotdna-project"
        || project.version != 1
        || project.data.sequence.is_empty()
    {
        return Err(ProjectError::Unsupported);
    }
    let mut document = document_from_legacy(project.data)?;
    document.name = if project.name.is_empty() {
        "DOTDNA project".to_owned()
    } else {
        project.name
    };
    Ok(document)
}

/// Serializes a portable `DOTDNA` project version 1.
///
/// # Errors
///
/// Returns an error when JSON serialization fails.
pub fn to_dotdna_project(
    name: &str,
    document: &SequenceDocument,
    saved_at: &str,
) -> Result<String, ProjectError> {
    let project = ProjectFile {
        format: "dotdna-project".to_owned(),
        version: 1,
        name: name.to_owned(),
        saved_at: saved_at.to_owned(),
        data: legacy_data(document),
    };
    serde_json::to_string_pretty(&project)
        .map(|mut json| {
            json.push('\n');
            json
        })
        .map_err(|error| ProjectError::Serialization(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_portable_project_and_metadata() {
        let mut source = SequenceDocument::new("demo.fa", "ACGTACGT").unwrap();
        source.topology = Topology::Circular;
        source
            .metadata
            .primer_settings
            .insert("minContinuousMatchLen".to_owned(), "10".to_owned());
        let parent = SequenceDocument::new("ancestor.dna", "ACGTTCGT").unwrap();
        source.history.push(HistoryEntry {
            operation: HistoryOperation::Pcr,
            description: "Created PCR product".to_owned(),
            recorded_at: "2026-08-17T20:00:00.000Z".to_owned(),
            parent_document: Some(Box::new(parent)),
        });
        let serialized = to_dotdna_project("demo", &source, "2026-08-17T20:00:00.000Z").unwrap();
        let imported = parse_dotdna_project(&serialized).unwrap();
        assert_eq!(imported.name, "demo");
        assert_eq!(imported.sequence, "ACGTACGT");
        assert_eq!(imported.topology, Topology::Circular);
        assert_eq!(
            imported
                .metadata
                .primer_settings
                .get("minContinuousMatchLen")
                .map(String::as_str),
            Some("10")
        );
        assert_eq!(imported.history.len(), 1);
        assert_eq!(imported.history[0].operation, HistoryOperation::Pcr);
        let imported_parent = imported.history[0].parent_document.as_deref().unwrap();
        assert_eq!(imported_parent.name, "ancestor.dna");
        assert_eq!(imported_parent.sequence, "ACGTTCGT");
        assert!(imported_parent.history.is_empty());
    }
}
