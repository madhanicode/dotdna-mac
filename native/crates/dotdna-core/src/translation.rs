use serde::{Deserialize, Serialize};

use crate::{SequenceError, SequenceSpan, Strand, normalize_dna, reverse_complement};

const MAX_ORF_RESULTS: usize = 50_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodonKind {
    Start,
    Stop,
    Amino,
    Ambiguous,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedCodon {
    pub center: usize,
    pub amino_acid: char,
    pub kind: CodonKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenReadingFrame {
    pub id: String,
    pub intervals: Vec<SequenceSpan>,
    pub strand: Strand,
    pub frame: i8,
    pub wraps_origin: bool,
    pub nucleotide_length: usize,
    pub amino_acid_length: usize,
    pub coding_start: usize,
    pub coding_stop: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrfTranslation {
    pub orf_id: String,
    pub strand: Strand,
    pub frame: i8,
    pub amino_acids: String,
    pub codons: Vec<TranslatedCodon>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrfAnalysisResult {
    pub orfs: Vec<OpenReadingFrame>,
    pub truncated: bool,
}

fn codon_at(sequence: &[u8], start: usize, circular: bool) -> Option<[u8; 3]> {
    if sequence.is_empty() || (!circular && start + 3 > sequence.len()) {
        return None;
    }
    Some([
        sequence[start % sequence.len()],
        sequence[(start + 1) % sequence.len()],
        sequence[(start + 2) % sequence.len()],
    ])
}

fn translate_codon(codon: [u8; 3]) -> char {
    match codon {
        [b'T', b'T', b'T' | b'C'] => 'F',
        [b'T', b'T', b'A' | b'G'] | [b'C', b'T', _] => 'L',
        [b'A', b'T', b'T' | b'C' | b'A'] => 'I',
        [b'A', b'T', b'G'] => 'M',
        [b'G', b'T', _] => 'V',
        [b'T', b'C', _] | [b'A', b'G', b'T' | b'C'] => 'S',
        [b'C', b'C', _] => 'P',
        [b'A', b'C', _] => 'T',
        [b'G', b'C', _] => 'A',
        [b'T', b'A', b'T' | b'C'] => 'Y',
        [b'T', b'A' | b'G', b'A'] | [b'T', b'A', b'G'] => '*',
        [b'C', b'A', b'T' | b'C'] => 'H',
        [b'C', b'A', b'A' | b'G'] => 'Q',
        [b'A', b'A', b'T' | b'C'] => 'N',
        [b'A', b'A', b'A' | b'G'] => 'K',
        [b'G', b'A', b'T' | b'C'] => 'D',
        [b'G', b'A', b'A' | b'G'] => 'E',
        [b'T', b'G', b'T' | b'C'] => 'C',
        [b'T', b'G', b'G'] => 'W',
        [b'C', b'G', _] | [b'A', b'G', b'A' | b'G'] => 'R',
        [b'G', b'G', _] => 'G',
        _ => 'X',
    }
}

fn canonical_intervals(start: usize, length: usize, sequence_length: usize) -> Vec<SequenceSpan> {
    let start = start % sequence_length;
    let end = start + length.min(sequence_length);
    if end <= sequence_length {
        vec![SequenceSpan::new(start, end)]
    } else {
        vec![
            SequenceSpan::new(start, sequence_length),
            SequenceSpan::new(0, end - sequence_length),
        ]
    }
}

fn build_orf(
    oriented: &[u8],
    start: usize,
    stop: usize,
    strand: Strand,
    frame: i8,
    circular: bool,
) -> OpenReadingFrame {
    let sequence_length = oriented.len();
    let nucleotide_length = stop + 3 - start;
    let reference_start = if strand == Strand::Forward {
        start % sequence_length
    } else {
        (sequence_length - ((start + nucleotide_length) % sequence_length)) % sequence_length
    };
    let intervals = if circular {
        canonical_intervals(reference_start, nucleotide_length, sequence_length)
    } else {
        vec![SequenceSpan::new(
            reference_start,
            reference_start + nucleotide_length,
        )]
    };
    OpenReadingFrame {
        id: format!(
            "{}:{}:{nucleotide_length}",
            if strand == Strand::Forward { "f" } else { "r" },
            start % sequence_length
        ),
        wraps_origin: intervals.len() > 1,
        intervals,
        strand,
        frame,
        nucleotide_length,
        amino_acid_length: nucleotide_length / 3 - 1,
        coding_start: start,
        coding_stop: stop,
    }
}

fn scan_strand(
    oriented: &[u8],
    strand: Strand,
    circular: bool,
    minimum_amino_acids: usize,
    maximum_results_per_frame: usize,
) -> (Vec<OpenReadingFrame>, bool) {
    let sequence_length = oriented.len();
    let scan_limit = if circular {
        sequence_length.saturating_mul(2)
    } else {
        sequence_length
    };
    let mut frames = Vec::new();
    let mut truncated = false;
    for frame_offset in 0..3 {
        let frame = if strand == Strand::Forward {
            i8::try_from(frame_offset + 1).expect("frame is in 1..=3")
        } else {
            -i8::try_from(frame_offset + 1).expect("frame is in 1..=3")
        };
        let mut starts = Vec::new();
        let mut overflow_start = None;
        let mut frame_results = 0;
        let mut position = frame_offset;
        while position < scan_limit {
            let Some(codon) = codon_at(oriented, position, circular) else {
                break;
            };
            starts.retain(|start| position + 3 - *start <= sequence_length);
            if codon == *b"ATG" && (!circular || position < sequence_length) {
                if starts.len() + frame_results < maximum_results_per_frame {
                    starts.push(position);
                } else {
                    overflow_start.get_or_insert(position);
                }
            }
            if codon == *b"TAA" || codon == *b"TAG" || codon == *b"TGA" {
                for start in starts.drain(..) {
                    let nucleotide_length = position + 3 - start;
                    if nucleotide_length <= sequence_length
                        && nucleotide_length / 3 > minimum_amino_acids
                    {
                        frames.push(build_orf(
                            oriented, start, position, strand, frame, circular,
                        ));
                        frame_results += 1;
                    }
                }
                if overflow_start.take().is_some_and(|start| {
                    let nucleotide_length = position + 3 - start;
                    nucleotide_length <= sequence_length
                        && nucleotide_length / 3 > minimum_amino_acids
                }) {
                    truncated = true;
                }
            }
            position += 3;
        }
    }
    (frames, truncated)
}

/// Finds complete start-to-stop ORFs in all six reading frames.
///
/// Circular analysis follows each frame through the origin once and caps every
/// result at one molecule length, preventing duplicate or unbounded ORFs.
///
/// # Errors
///
/// Returns an error when the sequence is empty or contains an unsupported DNA symbol.
pub fn analyze_orfs(
    sequence: &str,
    circular: bool,
    minimum_amino_acids: usize,
) -> Result<Vec<OpenReadingFrame>, SequenceError> {
    Ok(analyze_orfs_with_status(sequence, circular, minimum_amino_acids)?.orfs)
}

/// Finds complete ORFs with an explicit disclosure when per-frame result caps
/// are reached.
///
/// # Errors
///
/// Returns an error when the sequence is empty or contains an unsupported DNA symbol.
pub fn analyze_orfs_with_status(
    sequence: &str,
    circular: bool,
    minimum_amino_acids: usize,
) -> Result<OrfAnalysisResult, SequenceError> {
    let normalized = normalize_dna(sequence);
    let reverse = reverse_complement(&normalized)?;
    let maximum_per_frame = MAX_ORF_RESULTS.div_ceil(6);
    let (mut frames, forward_truncated) = scan_strand(
        normalized.as_bytes(),
        Strand::Forward,
        circular,
        minimum_amino_acids,
        maximum_per_frame,
    );
    let (reverse_frames, reverse_truncated) = scan_strand(
        reverse.as_bytes(),
        Strand::Reverse,
        circular,
        minimum_amino_acids,
        maximum_per_frame,
    );
    frames.extend(reverse_frames);
    frames.sort_by(|left, right| {
        left.intervals[0]
            .start
            .cmp(&right.intervals[0].start)
            .then_with(|| left.frame.cmp(&right.frame))
            .then_with(|| right.nucleotide_length.cmp(&left.nucleotide_length))
    });
    Ok(OrfAnalysisResult {
        orfs: frames,
        truncated: forward_truncated || reverse_truncated,
    })
}

/// Translates one ORF returned by [`analyze_orfs`] and maps each amino acid to
/// the center of its genomic codon.
///
/// # Errors
///
/// Returns an error when the sequence is invalid or the ORF coordinates do not
/// belong to the supplied molecule.
pub fn translate_open_reading_frame(
    sequence: &str,
    circular: bool,
    orf: &OpenReadingFrame,
) -> Result<OrfTranslation, SequenceError> {
    let normalized = normalize_dna(sequence);
    let reverse = reverse_complement(&normalized)?;
    let oriented = if orf.strand == Strand::Forward {
        normalized.as_bytes()
    } else {
        reverse.as_bytes()
    };
    let scan_limit = if circular {
        oriented.len().saturating_mul(2)
    } else {
        oriented.len()
    };
    if orf.coding_start >= oriented.len()
        || orf.coding_stop >= scan_limit
        || orf.coding_stop + 3 - orf.coding_start != orf.nucleotide_length
        || orf.nucleotide_length > oriented.len()
    {
        return Err(SequenceError::Empty);
    }
    let mut codons = Vec::with_capacity(orf.nucleotide_length / 3);
    let mut amino_acids = String::with_capacity(orf.nucleotide_length / 3);
    for position in (orf.coding_start..=orf.coding_stop).step_by(3) {
        let amino_acid = codon_at(oriented, position, circular).map_or('X', translate_codon);
        let center = if orf.strand == Strand::Forward {
            (position + 1) % oriented.len()
        } else {
            oriented.len() - 1 - ((position + 1) % oriented.len())
        };
        let kind = if position == orf.coding_start {
            CodonKind::Start
        } else if amino_acid == '*' {
            CodonKind::Stop
        } else if amino_acid == 'X' {
            CodonKind::Ambiguous
        } else {
            CodonKind::Amino
        };
        amino_acids.push(amino_acid);
        codons.push(TranslatedCodon {
            center,
            amino_acid,
            kind,
        });
    }
    Ok(OrfTranslation {
        orf_id: orf.id.clone(),
        strand: orf.strand,
        frame: orf.frame,
        amino_acids,
        codons,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_known_codons_and_marks_start_and_stop() {
        let frames = analyze_orfs("CCCATGAAACCCGGGTAGAAA", false, 2).unwrap();
        let frame = frames
            .iter()
            .find(|frame| frame.strand == Strand::Forward)
            .unwrap();
        let translation =
            translate_open_reading_frame("CCCATGAAACCCGGGTAGAAA", false, frame).unwrap();
        assert_eq!(translation.amino_acids, "MKPG*");
        assert_eq!(frame.amino_acid_length, 4);
        assert_eq!(translation.codons[0].kind, CodonKind::Start);
        assert_eq!(translation.codons.last().unwrap().kind, CodonKind::Stop);
        assert_eq!(frame.intervals, vec![SequenceSpan::new(3, 18)]);
    }

    #[test]
    fn finds_reverse_strand_orfs_and_maps_centers_to_reference_coordinates() {
        let frames = analyze_orfs("TTATTTCAT", false, 1).unwrap();
        let frame = frames
            .iter()
            .find(|frame| frame.strand == Strand::Reverse)
            .unwrap();
        let translation = translate_open_reading_frame("TTATTTCAT", false, frame).unwrap();
        assert_eq!(translation.amino_acids, "MK*");
        assert_eq!(frame.intervals, vec![SequenceSpan::new(0, 9)]);
        assert_eq!(
            translation
                .codons
                .iter()
                .map(|codon| codon.center)
                .collect::<Vec<_>>(),
            vec![7, 4, 1]
        );
    }

    #[test]
    fn finds_an_orf_that_crosses_a_circular_origin() {
        let frames = analyze_orfs("AAATAACCCATG", true, 1).unwrap();
        let frame = frames
            .iter()
            .find(|frame| frame.strand == Strand::Forward && frame.wraps_origin)
            .unwrap();
        let translation = translate_open_reading_frame("AAATAACCCATG", true, frame).unwrap();
        assert_eq!(translation.amino_acids, "MK*");
        assert_eq!(
            frame.intervals,
            vec![SequenceSpan::new(9, 12), SequenceSpan::new(0, 6)]
        );
    }

    #[test]
    fn omits_open_ended_orfs_and_respects_minimum_length() {
        assert!(analyze_orfs("ATGAAAAAA", false, 0).unwrap().is_empty());
        assert!(analyze_orfs("ATGAAATAA", false, 3).unwrap().is_empty());
    }

    #[test]
    fn reports_all_six_frame_designations() {
        for offset in 0..3 {
            let forward = format!("{}ATGAAATAA", "A".repeat(offset));
            let frames = analyze_orfs(&forward, false, 1).unwrap();
            assert!(
                frames
                    .iter()
                    .any(|frame| frame.frame == i8::try_from(offset + 1).unwrap())
            );

            let reverse = reverse_complement(&forward).unwrap();
            let frames = analyze_orfs(&reverse, false, 1).unwrap();
            assert!(
                frames
                    .iter()
                    .any(|frame| frame.frame == -i8::try_from(offset + 1).unwrap())
            );
        }
    }

    #[test]
    fn repeated_starts_return_bounded_lightweight_summaries() {
        let sequence = format!("{}TAA", "ATG".repeat(MAX_ORF_RESULTS + 1));
        let result = analyze_orfs_with_status(&sequence, false, 0).unwrap();
        assert!(result.truncated);
        assert!(result.orfs.len() <= MAX_ORF_RESULTS);
        assert!(result.orfs.iter().all(|frame| frame.amino_acid_length > 0));
    }
}
