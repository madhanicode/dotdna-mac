use dotdna_core::{
    Feature, FeatureSegment, Qualifier, SequenceDocument, SequenceSpan, Strand, Topology,
};
use thiserror::Error;

const FEATURE_COLORS: [&str; 7] = [
    "#ff9900", "#17b6c9", "#58c882", "#ff725e", "#8a6be8", "#d9b318", "#e455a7",
];

#[derive(Debug, Error, Eq, PartialEq)]
pub enum GenBankError {
    #[error("no DNA sequence was found in the GenBank ORIGIN section")]
    MissingSequence,
    #[error("the GenBank sequence is invalid: {0}")]
    InvalidSequence(String),
}

#[derive(Debug)]
struct FeatureRecord {
    kind: String,
    location: String,
    qualifier_lines: Vec<String>,
}

fn field_value(text: &str, field: &str) -> Option<String> {
    let lines = text.lines().collect::<Vec<_>>();
    let start = lines.iter().position(|line| line.starts_with(field))?;
    let mut pieces = vec![lines[start].get(12..).unwrap_or_default().trim().to_owned()];
    for line in lines.iter().skip(start + 1) {
        if line.len() < 13 || !line.starts_with("            ") {
            break;
        }
        let rest = line.get(12..).unwrap_or_default();
        if rest.is_empty() || rest.starts_with(' ') {
            break;
        }
        pieces.push(rest.trim().to_owned());
    }
    let result = pieces.join(" ").trim().to_owned();
    (!result.is_empty()).then_some(result)
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1].replace("\"\"", "\"")
    } else {
        trimmed.to_owned()
    }
}

fn location_number(value: &str) -> Option<usize> {
    let local = value.rsplit_once(':').map_or(value, |(_, local)| local);
    let digits = local
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
}

fn parse_location(location: &str, color: Option<&str>) -> Vec<FeatureSegment> {
    let mut expression = location.trim();
    while let Some(open) = expression.find('(') {
        if !expression.ends_with(')') {
            break;
        }
        let operator = &expression[..open];
        if !matches!(
            operator.to_ascii_lowercase().as_str(),
            "complement" | "join" | "order"
        ) {
            break;
        }
        expression = &expression[open + 1..expression.len() - 1];
    }
    expression
        .split(',')
        .filter_map(|part| {
            let part = part.trim();
            let (start, end, kind) = if let Some((start, end)) = part.split_once("..") {
                (location_number(start)?, location_number(end)?, "standard")
            } else if let Some((start, end)) = part.split_once('^') {
                (location_number(start)?, location_number(end)?, "between")
            } else {
                let point = location_number(part)?;
                (point, point, "point")
            };
            (start > 0 && end >= start).then(|| FeatureSegment {
                span: SequenceSpan::new(start - 1, end),
                color: color.map(ToOwned::to_owned),
                name: None,
                kind: Some(kind.to_owned()),
            })
        })
        .collect()
}

fn feature_records(text: &str) -> Vec<FeatureRecord> {
    let mut in_features = false;
    let mut records = Vec::<FeatureRecord>::new();
    for line in text.lines() {
        if line.starts_with("FEATURES") {
            in_features = true;
            continue;
        }
        if line.starts_with("ORIGIN") {
            break;
        }
        if !in_features {
            continue;
        }
        if line.len() >= 6 && line.starts_with("     ") && !line.as_bytes()[5].is_ascii_whitespace()
        {
            let rest = line.get(5..).unwrap_or_default();
            let split = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let kind = rest[..split].to_owned();
            let location = rest[split..].trim().to_owned();
            records.push(FeatureRecord {
                kind,
                location,
                qualifier_lines: Vec::new(),
            });
        } else if let Some(record) = records.last_mut()
            && line.starts_with("                     ")
        {
            let value = line.get(21..).unwrap_or_default().trim();
            if !value.starts_with('/') && record.qualifier_lines.is_empty() {
                record.location.push_str(value);
            } else if value.starts_with('/') {
                record.qualifier_lines.push(value.to_owned());
            } else if let Some(last) = record.qualifier_lines.last_mut() {
                last.push(' ');
                last.push_str(value);
            }
        }
    }
    records
}

fn parse_qualifier(line: &str) -> Option<Qualifier> {
    let value = line.strip_prefix('/')?;
    if let Some((name, value)) = value.split_once('=') {
        Some(Qualifier {
            name: name.to_owned(),
            value: unquote(value),
        })
    } else {
        Some(Qualifier {
            name: value.to_owned(),
            value: "true".to_owned(),
        })
    }
}

fn qualifier_value<'a>(qualifiers: &'a [Qualifier], name: &str) -> Option<&'a str> {
    qualifiers
        .iter()
        .find(|qualifier| qualifier.name.eq_ignore_ascii_case(name))
        .map(|qualifier| qualifier.value.as_str())
}

fn parse_features(text: &str) -> Vec<Feature> {
    feature_records(text)
        .into_iter()
        .enumerate()
        .map(|(index, record)| {
            let qualifiers = record
                .qualifier_lines
                .iter()
                .filter_map(|line| parse_qualifier(line))
                .collect::<Vec<_>>();
            let color = qualifier_value(&qualifiers, "color")
                .or_else(|| qualifier_value(&qualifiers, "ApEinfo_fwdcolor"))
                .map_or_else(
                    || FEATURE_COLORS[index % FEATURE_COLORS.len()].to_owned(),
                    ToOwned::to_owned,
                );
            let reverse = record.location.to_ascii_lowercase().contains("complement(");
            Feature {
                id: None,
                name: qualifier_value(&qualifiers, "label")
                    .or_else(|| qualifier_value(&qualifiers, "gene"))
                    .or_else(|| qualifier_value(&qualifiers, "product"))
                    .or_else(|| qualifier_value(&qualifiers, "note"))
                    .unwrap_or(&record.kind)
                    .to_owned(),
                kind: record.kind,
                color: Some(color.clone()),
                strand: if reverse {
                    Strand::Reverse
                } else {
                    Strand::Forward
                },
                segments: parse_location(&record.location, Some(&color)),
                reading_frame: qualifier_value(&qualifiers, "codon_start")
                    .and_then(|value| value.parse::<i8>().ok())
                    .map(|frame| frame - 1),
                qualifiers,
            }
        })
        .collect()
}

fn origin_sequence(text: &str) -> Option<String> {
    let origin = text.split_once("ORIGIN")?.1;
    let body = origin.split("//").next().unwrap_or(origin);
    let sequence = body
        .chars()
        .filter(char::is_ascii_alphabetic)
        .collect::<String>();
    (!sequence.is_empty()).then_some(sequence)
}

/// Parses a `GenBank` flat file.
///
/// # Errors
///
/// Returns an error when `ORIGIN` is missing or the DNA symbols are unsupported.
pub fn parse_genbank(name: &str, text: &str) -> Result<SequenceDocument, GenBankError> {
    let sequence = origin_sequence(text).ok_or(GenBankError::MissingSequence)?;
    let mut document = SequenceDocument::new(name, &sequence)
        .map_err(|error| GenBankError::InvalidSequence(error.to_string()))?;
    let locus = text.lines().find(|line| line.starts_with("LOCUS"));
    document.topology = if locus.is_some_and(|line| line.to_ascii_lowercase().contains("circular"))
    {
        Topology::Circular
    } else {
        Topology::Linear
    };
    document.features = parse_features(text);
    document.notes.accession_number = field_value(text, "ACCESSION");
    document.notes.description = field_value(text, "DEFINITION");
    if locus.is_some_and(|line| {
        line.split_whitespace()
            .any(|part| part.eq_ignore_ascii_case("SYN"))
    }) {
        document.notes.sequence_type = Some("Synthetic".to_owned());
    }
    Ok(document)
}

fn feature_location(feature: &Feature) -> String {
    let mut locations = feature
        .segments
        .iter()
        .map(|segment| {
            let start = segment.span.start + 1;
            let end = segment.span.end;
            if start == end {
                start.to_string()
            } else {
                format!("{start}..{end}")
            }
        })
        .collect::<Vec<_>>();
    if locations.is_empty() {
        locations.push("1".to_owned());
    }
    let compound = if locations.len() > 1 {
        format!("join({})", locations.join(","))
    } else {
        locations.remove(0)
    };
    if feature.strand == Strand::Reverse {
        format!("complement({compound})")
    } else {
        compound
    }
}

fn quote_qualifier(value: &str) -> String {
    value.replace('"', "\"\"").replace(['\r', '\n'], " ")
}

/// Serializes a document as a `GenBank` flat file.
#[must_use]
pub fn to_genbank(name: &str, document: &SequenceDocument, date: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let mut safe_name = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(16)
        .collect::<String>();
    if safe_name.is_empty() {
        "DOTDNA".clone_into(&mut safe_name);
    }
    let topology = match document.topology {
        Topology::Circular => "circular",
        Topology::Linear => "linear",
    };
    let mut lines = vec![
        format!(
            "LOCUS       {safe_name:<16} {:>11} bp    DNA     {topology:<8} UNK {date}",
            document.sequence.len()
        ),
        format!(
            "DEFINITION  {}",
            document
                .notes
                .description
                .as_deref()
                .unwrap_or("Exported from DOTDNA.")
        ),
        format!(
            "ACCESSION   {}",
            document.notes.accession_number.as_deref().unwrap_or(".")
        ),
        "FEATURES             Location/Qualifiers".to_owned(),
        format!("     source          1..{}", document.sequence.len()),
        "                     /organism=\"synthetic construct\"".to_owned(),
    ];
    for feature in &document.features {
        if feature.kind.trim().eq_ignore_ascii_case("source") {
            continue;
        }
        let kind = feature.kind.chars().take(15).collect::<String>();
        lines.push(format!("     {kind:<16}{}", feature_location(feature)));
        lines.push(format!(
            "                     /label=\"{}\"",
            quote_qualifier(&feature.name)
        ));
        if let Some(color) = &feature.color {
            lines.push(format!("                     /color=\"{color}\""));
        }
        for qualifier in &feature.qualifiers {
            if qualifier.name.eq_ignore_ascii_case("label")
                || qualifier.name.eq_ignore_ascii_case("color")
            {
                continue;
            }
            lines.push(format!(
                "                     /{}=\"{}\"",
                qualifier.name,
                quote_qualifier(&qualifier.value)
            ));
        }
    }
    lines.push("ORIGIN".to_owned());
    for (index, chunk) in document.sequence.as_bytes().chunks(60).enumerate() {
        let grouped = chunk
            .chunks(10)
            .map(|part| {
                std::str::from_utf8(part)
                    .unwrap_or_default()
                    .to_ascii_lowercase()
            })
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!("{:>9} {grouped}", index * 60 + 1));
    }
    lines.push("//".to_owned());
    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_sequence_topology_and_features() {
        let mut source = SequenceDocument::new("source.fa", "ATGAAATAA").unwrap();
        source.topology = Topology::Circular;
        source.features.push(Feature {
            id: None,
            name: "demo CDS".to_owned(),
            kind: "CDS".to_owned(),
            color: Some("#ff9900".to_owned()),
            strand: Strand::Forward,
            segments: vec![FeatureSegment {
                span: SequenceSpan::new(0, 9),
                color: Some("#ff9900".to_owned()),
                name: None,
                kind: Some("standard".to_owned()),
            }],
            qualifiers: vec![Qualifier {
                name: "product".to_owned(),
                value: "demo protein".to_owned(),
            }],
            reading_frame: Some(0),
        });

        let exported = to_genbank("source.dna", &source, "17-AUG-2026");
        let imported = parse_genbank("source.gb", &exported).unwrap();
        assert_eq!(imported.sequence, source.sequence);
        assert_eq!(imported.topology, Topology::Circular);
        let coding = imported
            .features
            .iter()
            .find(|feature| feature.kind == "CDS")
            .unwrap();
        assert_eq!(coding.name, "demo CDS");
        assert!(
            coding.qualifiers.iter().any(|qualifier| {
                qualifier.name == "product" && qualifier.value == "demo protein"
            })
        );
    }

    #[test]
    fn parses_multiline_compound_points_fuzzy_bounds_and_remote_locations() {
        let input = "LOCUS       TEST                    100 bp    DNA     circular\nFEATURES             Location/Qualifiers\n     misc_feature    complement(join(<1,\n                     J00194.1:40..>45))\n                     /label=\"compound\"\nORIGIN\n        1 aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa\n       61 aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa\n//\n";
        let document = parse_genbank("compound.gb", input).unwrap();
        let feature = document
            .features
            .iter()
            .find(|item| item.name == "compound")
            .unwrap();
        assert_eq!(feature.strand, Strand::Reverse);
        assert_eq!(feature.segments.len(), 2);
        assert_eq!(feature.segments[0].span, SequenceSpan::new(0, 1));
        assert_eq!(feature.segments[1].span, SequenceSpan::new(39, 45));
    }

    #[test]
    fn export_does_not_duplicate_source_features() {
        let input = "LOCUS       TEST                      8 bp    DNA     linear\nFEATURES             Location/Qualifiers\n     source          1..8\n                     /organism=\"synthetic construct\"\nORIGIN\n        1 acgtacgt\n//\n";
        let document = parse_genbank("source.gb", input).unwrap();
        assert_eq!(document.features[0].kind, "source");
        let exported = to_genbank("source.gb", &document, "17-AUG-2026");
        assert_eq!(
            exported
                .lines()
                .filter(|line| line.starts_with("     source"))
                .count(),
            1
        );
    }
}
