use std::collections::BTreeMap;

use dotdna_core::{
    DocumentMetadata, DocumentNotes, Feature, FeatureSegment, PacketFormat, Primer,
    PrimerBindingSite, Qualifier, SequenceDocument, SequenceProperties, SequenceSpan,
    SnapGeneHeader, SnapGenePacket, Strand, Topology,
};
use roxmltree::{Document, Node};
use thiserror::Error;

const PACKET_HEADER_LENGTH: usize = 5;

#[derive(Debug, Error)]
pub enum SnapGeneError {
    #[error("this file is too small to be a SnapGene DNA file")]
    TooSmall,
    #[error("this does not appear to be a SnapGene .dna file: the header packet is missing")]
    MissingHeaderPacket,
    #[error("the SnapGene file is incomplete or damaged")]
    Incomplete,
    #[error("the SnapGene file has trailing bytes that are not a complete packet")]
    TrailingBytes,
    #[error("this does not appear to be a SnapGene .dna file")]
    InvalidCookie,
    #[error("this SnapGene file contains more than one DNA sequence packet")]
    MultipleSequences,
    #[error("no DNA sequence was found in this SnapGene file")]
    MissingSequence,
    #[error("the file contains sequence symbols this reader does not support: {0}")]
    UnsupportedSequence(String),
    #[error("packet {packet_type:#04X} is not valid UTF-8")]
    InvalidUtf8 { packet_type: u8 },
    #[error("packet {packet_type:#04X} contains invalid XML: {source}")]
    InvalidXml {
        packet_type: u8,
        #[source]
        source: roxmltree::Error,
    },
}

#[derive(Default)]
struct ParsedPackets {
    sequence: Option<String>,
    dna_flags: u8,
    features: Vec<Feature>,
    primers: Vec<Primer>,
    notes: DocumentNotes,
    metadata: DocumentMetadata,
    has_cookie: bool,
}

fn packet_name(packet_type: u8) -> &'static str {
    match packet_type {
        0x00 => "DNA sequence",
        0x01 => "Compressed DNA",
        0x02 => "Unknown data",
        0x03 => "Enzyme data",
        0x05 => "Primers",
        0x06 => "Notes",
        0x07 => "History",
        0x08 => "Sequence properties",
        0x09 => "SnapGene header",
        0x0A => "Features",
        0x0B => "Sequence history",
        0x0C => "Protein features",
        0x0D => "Display settings",
        0x0E => "Custom enzyme sets",
        0x0F => "History tree",
        0x10 => "Additional metadata",
        0x11 => "Alignable sequences",
        0x12 => "Sequence colors",
        0x13 => "Feature visibility",
        0x1C => "Enzyme visibility",
        _ => "Unrecognized packet",
    }
}

const fn packet_is_decoded(packet_type: u8) -> bool {
    matches!(
        packet_type,
        0x00 | 0x05 | 0x06 | 0x08 | 0x09 | 0x0A | 0x0E | 0x11 | 0x1C
    )
}

fn xml(packet_type: u8, bytes: &[u8]) -> Result<Document<'_>, SnapGeneError> {
    let value =
        std::str::from_utf8(bytes).map_err(|_| SnapGeneError::InvalidUtf8 { packet_type })?;
    Document::parse(value).map_err(|source| SnapGeneError::InvalidXml {
        packet_type,
        source,
    })
}

fn clean_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut inside_tag = false;
    for character in value.replace("<br>", "\n").replace("<br/>", "\n").chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            '\r' => {}
            _ if !inside_tag => result.push(character),
            _ => {}
        }
    }
    result.trim().to_owned()
}

fn element_text(document: &Document<'_>, tag: &str) -> Option<String> {
    document
        .descendants()
        .find(|node| node.has_tag_name(tag))
        .and_then(|node| node.text())
        .map(clean_text)
        .filter(|value| !value.is_empty())
}

fn element_attribute(document: &Document<'_>, tag: &str, attribute: &str) -> Option<String> {
    document
        .descendants()
        .find(|node| node.has_tag_name(tag))
        .and_then(|node| node.attribute(attribute))
        .map(ToOwned::to_owned)
}

fn parse_external_range(value: &str) -> Option<SequenceSpan> {
    let mut numbers = value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<usize>().ok());
    let start = numbers.next()?;
    let end = numbers.next().unwrap_or(start);
    if start == 0 || end < start {
        return None;
    }
    Some(SequenceSpan::new(start - 1, end))
}

fn feature_segment(node: Node<'_, '_>) -> Option<FeatureSegment> {
    let span = parse_external_range(node.attribute("range")?)?;
    Some(FeatureSegment {
        span,
        color: node.attribute("color").map(ToOwned::to_owned),
        name: node.attribute("name").map(ToOwned::to_owned),
        kind: node.attribute("type").map(ToOwned::to_owned),
    })
}

fn qualifier(node: Node<'_, '_>) -> Qualifier {
    let value_node = node.children().find(|child| child.has_tag_name("V"));
    let value = value_node
        .and_then(|value| {
            value
                .attribute("text")
                .or_else(|| value.attribute("int"))
                .or_else(|| value.attribute("bool"))
                .or_else(|| value.text())
        })
        .map(clean_text)
        .unwrap_or_default();
    Qualifier {
        name: node.attribute("name").unwrap_or("qualifier").to_owned(),
        value,
    }
}

fn parse_features(document: &Document<'_>) -> Vec<Feature> {
    document
        .descendants()
        .filter(|node| node.has_tag_name("Feature"))
        .map(|node| {
            let directionality = node
                .attribute("directionality")
                .and_then(|value| value.parse::<u8>().ok())
                .unwrap_or_default();
            let strand = match directionality {
                1 => Strand::Forward,
                2 => Strand::Reverse,
                3 => Strand::Both,
                _ => Strand::None,
            };
            let segments = node
                .children()
                .filter(|child| child.has_tag_name("Segment"))
                .filter_map(feature_segment)
                .collect::<Vec<_>>();
            let color = segments
                .iter()
                .find_map(|segment| segment.color.as_ref())
                .cloned();
            Feature {
                id: None,
                name: node
                    .attribute("name")
                    .unwrap_or("Unnamed feature")
                    .to_owned(),
                kind: node.attribute("type").unwrap_or("feature").to_owned(),
                color,
                strand,
                segments,
                qualifiers: node
                    .children()
                    .filter(|child| child.has_tag_name("Q"))
                    .map(qualifier)
                    .collect(),
                reading_frame: node
                    .attribute("readingFrame")
                    .and_then(|value| value.parse::<i8>().ok()),
            }
        })
        .collect()
}

fn attributes(node: Node<'_, '_>) -> BTreeMap<String, String> {
    node.attributes()
        .map(|attribute| (attribute.name().to_owned(), attribute.value().to_owned()))
        .collect()
}

fn parse_primers(document: &Document<'_>) -> (Vec<Primer>, BTreeMap<String, String>) {
    let mut settings = document
        .descendants()
        .find(|node| node.has_tag_name("Primers"))
        .map(attributes)
        .unwrap_or_default();
    if let Some(hybridization) = document
        .descendants()
        .find(|node| node.has_tag_name("HybridizationParams"))
    {
        settings.extend(attributes(hybridization));
    }

    let primers = document
        .descendants()
        .filter(|node| node.has_tag_name("Primer"))
        .map(|node| {
            let sequence = node
                .attribute("sequence")
                .unwrap_or_default()
                .to_ascii_uppercase();
            let binding_sites = node
                .children()
                .filter(|child| child.has_tag_name("BindingSite"))
                .filter_map(|site| {
                    let range = site
                        .attribute("location")
                        .or_else(|| site.attribute("range"))?;
                    Some(PrimerBindingSite {
                        span: parse_external_range(range)?,
                        strand: if site.attribute("boundStrand") == Some("1") {
                            Strand::Reverse
                        } else {
                            Strand::Forward
                        },
                    })
                })
                .collect::<Vec<_>>();
            let binding_length = binding_sites
                .iter()
                .map(|site| site.span.len())
                .filter(|length| *length > 0 && *length <= sequence.len())
                .max();
            let phosphorylated = node
                .attribute("phosphorylated")
                .or_else(|| node.attribute("fivePrimePhosphorylated"))
                .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
            Primer {
                id: None,
                name: node
                    .attribute("name")
                    .unwrap_or("Unnamed primer")
                    .to_owned(),
                sequence,
                binding_length,
                description: node.attribute("description").map(clean_text),
                color: node.attribute("color").map(ToOwned::to_owned),
                phosphorylated,
                binding_sites,
            }
        })
        .collect();
    (primers, settings)
}

fn parse_notes(document: &Document<'_>) -> DocumentNotes {
    DocumentNotes {
        uuid: element_text(document, "UUID"),
        sequence_type: element_text(document, "Type"),
        created: element_text(document, "Created"),
        created_utc: element_attribute(document, "Created", "UTC"),
        last_modified: element_text(document, "LastModified"),
        last_modified_utc: element_attribute(document, "LastModified", "UTC"),
        created_by: element_text(document, "CreatedBy"),
        accession_number: element_text(document, "AccessionNumber"),
        description: element_text(document, "Description"),
        comments: element_text(document, "Comments"),
        sequence_class: element_text(document, "SequenceClass"),
        transformed_into: element_text(document, "TransformedInto"),
    }
}

fn parse_properties(document: &Document<'_>) -> SequenceProperties {
    SequenceProperties {
        upstream_stickiness: element_text(document, "UpstreamStickiness")
            .and_then(|value| value.parse().ok()),
        downstream_stickiness: element_text(document, "DownstreamStickiness")
            .and_then(|value| value.parse().ok()),
        upstream_modification: element_text(document, "UpstreamModification"),
        downstream_modification: element_text(document, "DownstreamModification"),
    }
}

fn packet_format(packet_type: u8, packet: &[u8]) -> PacketFormat {
    if packet_type == 0x09 {
        PacketFormat::Cookie
    } else if packet_type == 0x00 {
        PacketFormat::Sequence
    } else if std::str::from_utf8(packet).is_ok_and(|value| value.trim_start().starts_with('<')) {
        PacketFormat::Xml
    } else {
        PacketFormat::Binary
    }
}

fn parse_packet(
    packet_type: u8,
    packet: &[u8],
    parsed: &mut ParsedPackets,
) -> Result<(), SnapGeneError> {
    match packet_type {
        0x09 => {
            parsed.has_cookie = packet.starts_with(b"SnapGene");
            if packet.len() >= 14 {
                parsed.metadata.snapgene_header = SnapGeneHeader {
                    sequence_type: Some(u16::from_be_bytes([packet[8], packet[9]])),
                    export_version: Some(u16::from_be_bytes([packet[10], packet[11]])),
                    import_version: Some(u16::from_be_bytes([packet[12], packet[13]])),
                };
            }
        }
        0x00 if packet.len() > 1 => {
            if parsed.sequence.is_some() {
                return Err(SnapGeneError::MultipleSequences);
            }
            parsed.dna_flags = packet[0];
            let sequence = std::str::from_utf8(&packet[1..])
                .map_err(|_| SnapGeneError::InvalidUtf8 { packet_type })?
                .chars()
                .filter(|character| !character.is_whitespace())
                .flat_map(char::to_uppercase)
                .collect();
            parsed.sequence = Some(sequence);
        }
        0x0A => parsed.features = parse_features(&xml(packet_type, packet)?),
        0x05 => {
            let (primers, settings) = parse_primers(&xml(packet_type, packet)?);
            parsed.primers = primers;
            parsed.metadata.primer_settings = settings;
        }
        0x06 => parsed.notes = parse_notes(&xml(packet_type, packet)?),
        0x08 => {
            parsed.metadata.sequence_properties = parse_properties(&xml(packet_type, packet)?);
        }
        0x0E => {
            let document = xml(packet_type, packet)?;
            parsed.metadata.custom_enzyme_set_count = document
                .descendants()
                .filter(|node| node.has_tag_name("EnzymeSet") || node.has_tag_name("Set"))
                .count();
        }
        0x11 => {
            let document = xml(packet_type, packet)?;
            parsed.metadata.alignable_sequence_count = document
                .descendants()
                .filter(|node| {
                    node.has_tag_name("AlignableSequence") || node.has_tag_name("Sequence")
                })
                .count();
        }
        0x1C => {
            let document = xml(packet_type, packet)?;
            parsed.metadata.enzyme_visibilities = document
                .descendants()
                .find(|node| node.has_tag_name("EnzymeVisibilities"))
                .and_then(|node| node.attribute("vals"))
                .unwrap_or_default()
                .split(|character: char| {
                    character == ',' || character == ';' || character.is_whitespace()
                })
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect();
        }
        _ => {}
    }
    Ok(())
}

/// Parses a `SnapGene` DNA file with a default document name.
///
/// # Errors
///
/// Returns a structured error for malformed packets, unsupported DNA, or XML.
pub fn parse_snapgene(bytes: &[u8]) -> Result<SequenceDocument, SnapGeneError> {
    parse_snapgene_named("Untitled.dna", bytes)
}

/// Parses a `SnapGene` DNA file and assigns the supplied display name.
///
/// # Errors
///
/// Returns a structured error for malformed packets, unsupported DNA, or XML.
pub fn parse_snapgene_named(name: &str, bytes: &[u8]) -> Result<SequenceDocument, SnapGeneError> {
    if bytes.len() < 19 {
        return Err(SnapGeneError::TooSmall);
    }
    if bytes.first() != Some(&0x09) {
        return Err(SnapGeneError::MissingHeaderPacket);
    }

    let mut cursor = 0;
    let mut parsed = ParsedPackets::default();
    while cursor + PACKET_HEADER_LENGTH <= bytes.len() {
        let packet_type = bytes[cursor];
        let length = u32::from_be_bytes([
            bytes[cursor + 1],
            bytes[cursor + 2],
            bytes[cursor + 3],
            bytes[cursor + 4],
        ]) as usize;
        let start = cursor + PACKET_HEADER_LENGTH;
        let end = start.checked_add(length).ok_or(SnapGeneError::Incomplete)?;
        if end > bytes.len() {
            return Err(SnapGeneError::Incomplete);
        }
        let packet = &bytes[start..end];
        let index = parsed.metadata.snapgene_packets.len();
        parsed.metadata.snapgene_packets.push(SnapGenePacket {
            index,
            packet_type,
            name: packet_name(packet_type).to_owned(),
            byte_length: length,
            format: packet_format(packet_type, packet),
            decoded: packet_is_decoded(packet_type),
        });
        parse_packet(packet_type, packet, &mut parsed)?;
        cursor = end;
    }

    if cursor != bytes.len() {
        return Err(SnapGeneError::TrailingBytes);
    }
    if !parsed.has_cookie {
        return Err(SnapGeneError::InvalidCookie);
    }
    let sequence = parsed.sequence.ok_or(SnapGeneError::MissingSequence)?;
    let mut document = SequenceDocument::new(name, &sequence)
        .map_err(|error| SnapGeneError::UnsupportedSequence(error.to_string()))?;
    document.topology = if parsed.dna_flags & 0x01 != 0 {
        Topology::Circular
    } else {
        Topology::Linear
    };
    document.double_stranded = parsed.dna_flags & 0x02 != 0;
    document.features = parsed.features;
    document.primers = parsed.primers;
    document.notes = parsed.notes;
    document.metadata = parsed.metadata;
    Ok(document)
}

#[must_use]
pub fn to_fasta(name: &str, sequence: &str) -> String {
    let stem = name
        .strip_suffix(".dna")
        .or_else(|| name.strip_suffix(".DNA"))
        .unwrap_or(name);
    let safe_name = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let mut output = format!(">{safe_name}\n");
    for chunk in sequence.as_bytes().chunks(80) {
        output.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(packet_type: u8, payload: &[u8]) -> Vec<u8> {
        let mut result = vec![packet_type];
        let payload_length =
            u32::try_from(payload.len()).expect("test packet is smaller than 4 GiB");
        result.extend_from_slice(&payload_length.to_be_bytes());
        result.extend_from_slice(payload);
        result
    }

    fn header() -> Vec<u8> {
        packet(0x09, b"SnapGene\0\x01\0\x0f\0\x13")
    }

    #[test]
    fn decodes_sequence_features_and_header() {
        let mut bytes = header();
        bytes.extend(packet(0x00, b"\x03ACGTGGCN"));
        bytes.extend(packet(
            0x0A,
            br##"<Features><Feature name="Demo" type="CDS" directionality="2" readingFrame="-1"><Segment range="2-4" color="#00ff00"/><Segment range="6-7" color="#11aa22"/><Q name="note"><V text="&lt;b&gt;Example&lt;/b&gt; protein"/></Q></Feature></Features>"##,
        ));
        let parsed = parse_snapgene(&bytes).unwrap();

        assert_eq!(parsed.sequence, "ACGTGGCN");
        assert_eq!(parsed.stats().length, 8);
        assert!((parsed.stats().gc_percent - 5.0 / 7.0 * 100.0).abs() < f64::EPSILON);
        assert_eq!(parsed.stats().unknown_bases, 1);
        assert_eq!(parsed.topology, Topology::Circular);
        assert!(parsed.double_stranded);
        assert_eq!(parsed.features[0].strand, Strand::Reverse);
        assert_eq!(parsed.features[0].segments[0].span, SequenceSpan::new(1, 4));
        assert_eq!(parsed.features[0].segments[1].span, SequenceSpan::new(5, 7));
        assert_eq!(
            parsed.features[0].qualifiers,
            [Qualifier {
                name: "note".to_owned(),
                value: "Example protein".to_owned(),
            }]
        );
        assert_eq!(parsed.metadata.snapgene_header.export_version, Some(15));
        assert_eq!(parsed.metadata.snapgene_packets.len(), 3);
        assert!(
            parsed
                .metadata
                .snapgene_packets
                .iter()
                .all(|packet| packet.decoded)
        );
    }

    #[test]
    fn decodes_primers_notes_and_end_chemistry() {
        let mut bytes = header();
        bytes.extend(packet(0x00, b"\x02ACGTACGT"));
        bytes.extend(packet(0x05, br##"<Primers><HybridizationParams minContinuousMatchLen="10"/><Primer name="Fwd" sequence="ACGT" description="demo" color="#123456"><BindingSite location="2-5" boundStrand="0"/></Primer></Primers>"##));
        bytes.extend(packet(0x06, br#"<Notes><UUID>abc-123</UUID><Type>Synthetic</Type><Created UTC="12:30:00">2026.8.7</Created><CreatedBy>DOTDNA</CreatedBy><Description>&lt;p&gt;Example molecule&lt;/p&gt;</Description></Notes>"#));
        bytes.extend(packet(0x08, br"<AdditionalSequenceProperties><UpstreamStickiness>2</UpstreamStickiness><DownstreamStickiness>-1</DownstreamStickiness><UpstreamModification>Phosphorylated</UpstreamModification><DownstreamModification>Unmodified</DownstreamModification></AdditionalSequenceProperties>"));
        let parsed = parse_snapgene(&bytes).unwrap();

        assert_eq!(parsed.primers[0].name, "Fwd");
        assert_eq!(parsed.primers[0].binding_length, Some(4));
        assert_eq!(
            parsed.primers[0].binding_sites[0].span,
            SequenceSpan::new(1, 5)
        );
        assert_eq!(
            parsed.metadata.primer_settings.get("minContinuousMatchLen"),
            Some(&"10".to_owned())
        );
        assert_eq!(parsed.notes.created_by.as_deref(), Some("DOTDNA"));
        assert_eq!(
            parsed.notes.description.as_deref(),
            Some("Example molecule")
        );
        assert_eq!(
            parsed.metadata.sequence_properties.upstream_stickiness,
            Some(2)
        );
        assert_eq!(
            parsed
                .metadata
                .sequence_properties
                .upstream_modification
                .as_deref(),
            Some("Phosphorylated")
        );
    }

    #[test]
    fn formats_fasta_at_eighty_bases() {
        assert_eq!(
            to_fasta("demo file.dna", &"A".repeat(81)),
            format!(">demo_file\n{}\nA\n", "A".repeat(80))
        );
    }
}
