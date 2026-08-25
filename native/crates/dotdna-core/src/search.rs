use serde::{Deserialize, Serialize};

use crate::{SequenceError, SequenceSpan, Strand, normalize_dna, reverse_complement};

/// Ambiguity-aware matching uses a bounded bit-parallel state machine. Exact
/// A/C/G/T searches use linear-time KMP and are not subject to this limit.
pub const MAX_AMBIGUOUS_QUERY_LENGTH: usize = 512;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceMatch {
    pub start: usize,
    pub intervals: Vec<SequenceSpan>,
    pub wraps_origin: bool,
    pub strand: Strand,
}

const fn base_mask(base: u8) -> u8 {
    match base {
        b'A' => 0b0001,
        b'C' => 0b0010,
        b'G' => 0b0100,
        b'T' => 0b1000,
        b'R' => 0b0101,
        b'Y' => 0b1010,
        b'S' => 0b0110,
        b'W' => 0b1001,
        b'K' => 0b1100,
        b'M' => 0b0011,
        b'B' => 0b1110,
        b'D' => 0b1101,
        b'H' => 0b1011,
        b'V' => 0b0111,
        b'N' => 0b1111,
        _ => 0,
    }
}

fn intervals(
    start: usize,
    length: usize,
    sequence_length: usize,
    circular: bool,
) -> Vec<SequenceSpan> {
    let end = start + length;
    if !circular || end <= sequence_length {
        vec![SequenceSpan::new(start, end.min(sequence_length))]
    } else {
        vec![
            SequenceSpan::new(start, sequence_length),
            SequenceSpan::new(0, end - sequence_length),
        ]
    }
}

const fn is_unambiguous(sequence: &[u8]) -> bool {
    let mut index = 0;
    while index < sequence.len() {
        if !matches!(sequence[index], b'A' | b'C' | b'G' | b'T') {
            return false;
        }
        index += 1;
    }
    true
}

fn push_match(
    matches: &mut Vec<SequenceMatch>,
    start: usize,
    length: usize,
    sequence_length: usize,
    circular: bool,
    strand: Strand,
) {
    let match_intervals = intervals(start, length, sequence_length, circular);
    matches.push(SequenceMatch {
        start,
        wraps_origin: match_intervals.len() > 1,
        intervals: match_intervals,
        strand,
    });
}

fn scan_exact_orientation(
    sequence: &[u8],
    query: &[u8],
    strand: Strand,
    circular: bool,
    maximum_results: usize,
) -> Vec<SequenceMatch> {
    if query.is_empty() || query.len() > sequence.len() || maximum_results == 0 {
        return Vec::new();
    }
    let mut prefix = vec![0; query.len()];
    let mut prefix_length = 0;
    for index in 1..query.len() {
        while prefix_length > 0 && query[index] != query[prefix_length] {
            prefix_length = prefix[prefix_length - 1];
        }
        if query[index] == query[prefix_length] {
            prefix_length += 1;
        }
        prefix[index] = prefix_length;
    }

    let scan_length = if circular {
        sequence.len() + query.len() - 1
    } else {
        sequence.len()
    };
    let mut matches = Vec::new();
    prefix_length = 0;
    for position in 0..scan_length {
        let base = sequence[position % sequence.len()];
        while prefix_length > 0 && base != query[prefix_length] {
            prefix_length = prefix[prefix_length - 1];
        }
        if base == query[prefix_length] {
            prefix_length += 1;
        }
        if prefix_length == query.len() {
            let start = position + 1 - query.len();
            push_match(
                &mut matches,
                start,
                query.len(),
                sequence.len(),
                circular,
                strand,
            );
            if matches.len() >= maximum_results {
                break;
            }
            prefix_length = prefix[prefix_length - 1];
        }
    }
    matches
}

fn scan_ambiguous_orientation(
    sequence: &[u8],
    query: &[u8],
    strand: Strand,
    circular: bool,
    maximum_results: usize,
) -> Vec<SequenceMatch> {
    if query.is_empty() || query.len() > sequence.len() || maximum_results == 0 {
        return Vec::new();
    }

    let block_count = query.len().div_ceil(u64::BITS as usize);
    let mut character_masks = (0..16)
        .map(|_| vec![0_u64; block_count])
        .collect::<Vec<_>>();
    for (position, query_base) in query.iter().enumerate() {
        let query_mask = base_mask(*query_base);
        for template_mask in 1_u8..16 {
            if query_mask & template_mask != 0 {
                character_masks[usize::from(template_mask)][position / 64] |=
                    1_u64 << (position % 64);
            }
        }
    }

    let scan_length = if circular {
        sequence.len() + query.len() - 1
    } else {
        sequence.len()
    };
    let final_bit = 1_u64 << ((query.len() - 1) % 64);
    let final_block = block_count - 1;
    let mut state = vec![0_u64; block_count];
    let mut matches = Vec::new();
    for position in 0..scan_length {
        let template_mask = usize::from(base_mask(sequence[position % sequence.len()]));
        let masks = &character_masks[template_mask];
        let mut carry = 1_u64;
        for block in 0..block_count {
            let next_carry = state[block] >> 63;
            state[block] = ((state[block] << 1) | carry) & masks[block];
            carry = next_carry;
        }
        if state[final_block] & final_bit != 0 {
            let start = position + 1 - query.len();
            push_match(
                &mut matches,
                start,
                query.len(),
                sequence.len(),
                circular,
                strand,
            );
            if matches.len() >= maximum_results {
                break;
            }
        }
    }
    matches
}

/// Finds overlapping IUPAC-aware matches on both reference strands.
///
/// # Errors
///
/// Returns an error for an empty or unsupported query or template sequence.
pub fn find_sequence_matches(
    sequence: &str,
    query: &str,
    circular: bool,
    maximum_results: usize,
) -> Result<Vec<SequenceMatch>, SequenceError> {
    let sequence = normalize_dna(sequence);
    let query = normalize_dna(query);
    let reverse_query = reverse_complement(&query)?;
    // Validate the template with the same supported-alphabet boundary.
    reverse_complement(&sequence)?;
    let exact = is_unambiguous(sequence.as_bytes()) && is_unambiguous(query.as_bytes());
    if !exact && query.len() > MAX_AMBIGUOUS_QUERY_LENGTH {
        return Err(SequenceError::AmbiguousSearchTooLong {
            length: query.len(),
            maximum: MAX_AMBIGUOUS_QUERY_LENGTH,
        });
    }
    let scan = if exact {
        scan_exact_orientation
    } else {
        scan_ambiguous_orientation
    };
    let forward = scan(
        sequence.as_bytes(),
        query.as_bytes(),
        Strand::Forward,
        circular,
        maximum_results,
    );
    if reverse_query == query {
        return Ok(forward);
    }
    let reverse = scan(
        sequence.as_bytes(),
        reverse_query.as_bytes(),
        Strand::Reverse,
        circular,
        maximum_results,
    );
    let forward_quota = maximum_results.div_ceil(2).min(forward.len());
    let reverse_quota = (maximum_results / 2).min(reverse.len());
    let mut matches = Vec::with_capacity(maximum_results.min(forward.len() + reverse.len()));
    matches.extend(forward.iter().take(forward_quota).cloned());
    matches.extend(reverse.iter().take(reverse_quota).cloned());
    let mut remainder = forward
        .into_iter()
        .skip(forward_quota)
        .chain(reverse.into_iter().skip(reverse_quota))
        .collect::<Vec<_>>();
    remainder.sort_by_key(|item| item.start);
    matches.extend(remainder.into_iter().take(maximum_results - matches.len()));
    matches.sort_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| (left.strand == Strand::Reverse).cmp(&(right.strand == Strand::Reverse)))
    });
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_overlapping_iupac_matches_on_both_strands() {
        let matches = find_sequence_matches("AAAACAT", "MR", false, 100).unwrap();
        assert!(
            matches
                .iter()
                .any(|item| item.start == 0 && item.strand == Strand::Forward)
        );
        let reverse = find_sequence_matches("CAT", "ATG", false, 100).unwrap();
        assert_eq!(reverse.len(), 1);
        assert_eq!(reverse[0].strand, Strand::Reverse);
    }

    #[test]
    fn finds_and_splits_an_origin_spanning_match() {
        let matches = find_sequence_matches("TTAC", "ACTT", true, 100).unwrap();
        let origin_match = matches
            .iter()
            .find(|item| item.strand == Strand::Forward)
            .unwrap();
        assert_eq!(
            origin_match.intervals,
            vec![SequenceSpan::new(2, 4), SequenceSpan::new(0, 2)]
        );
        assert!(origin_match.wraps_origin);
    }

    #[test]
    fn caps_results_without_losing_coordinate_validity() {
        let matches = find_sequence_matches("AAAA", "A", false, 2).unwrap();
        assert_eq!(matches.len(), 2);
        assert!(matches.iter().all(|item| item.intervals[0].is_valid_for(4)));
    }

    #[test]
    fn scans_a_ten_megabase_document_with_bounded_results() {
        let sequence = "ACGT".repeat(2_500_000);
        let matches = find_sequence_matches(&sequence, "AAAAAAAA", false, 10).unwrap();
        assert!(matches.is_empty());
    }

    #[test]
    fn worst_case_exact_search_is_linear_on_a_ten_megabase_document() {
        let sequence = "A".repeat(10_000_000);
        let query = format!("{}C", "A".repeat(9_999));
        let matches = find_sequence_matches(&sequence, &query, false, 10).unwrap();
        assert!(matches.is_empty());
    }

    #[test]
    fn bounds_long_ambiguity_aware_searches_with_actionable_error() {
        let sequence = format!("{}N", "A".repeat(1_000));
        let query = "N".repeat(MAX_AMBIGUOUS_QUERY_LENGTH + 1);
        assert_eq!(
            find_sequence_matches(&sequence, &query, false, 10),
            Err(SequenceError::AmbiguousSearchTooLong {
                length: MAX_AMBIGUOUS_QUERY_LENGTH + 1,
                maximum: MAX_AMBIGUOUS_QUERY_LENGTH,
            })
        );
    }
}
