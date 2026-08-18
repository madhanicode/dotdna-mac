use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    Feature, FeatureSegment, HistoryEntry, HistoryOperation, Qualifier, SequenceDocument,
    SequenceSpan, Strand, Topology, normalize_dna, reverse_complement,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThermodynamicConditions {
    pub monovalent_molar: f64,
    pub divalent_molar: f64,
    pub dntp_molar: f64,
    pub primer_molar: f64,
}

impl Default for ThermodynamicConditions {
    fn default() -> Self {
        Self {
            monovalent_molar: 0.05,
            divalent_molar: 0.0015,
            dntp_molar: 0.0002,
            primer_molar: 0.000_000_25,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimerAnalysis {
    pub sequence: String,
    pub length: usize,
    pub gc_percent: f64,
    pub full_gc_percent: f64,
    pub melting_temperature: f64,
    pub molecular_weight: f64,
    pub binding_sequence: String,
    pub binding_length: usize,
    pub tail_sequence: String,
    pub tail_length: usize,
    pub enthalpy: f64,
    pub entropy: f64,
    pub hairpin_score: usize,
    pub self_dimer_score: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimerMismatch {
    /// Zero-based position in the full primer, written 5′ to 3′.
    pub primer_index: usize,
    pub primer_base: char,
    pub template_base: char,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub enum BindingStrand {
    #[serde(rename = "+")]
    Forward,
    #[serde(rename = "-")]
    Reverse,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimerBinding {
    /// Zero-based, half-open template coordinates. A wrapped span has `end < start`.
    pub span: SequenceSpan,
    pub strand: BindingStrand,
    pub wraps_origin: bool,
    pub binding_length: usize,
    pub tail_length: usize,
    pub binding_sequence: String,
    pub tail_sequence: String,
    pub template_sequence: String,
    pub mismatch_count: usize,
    pub mismatches: Vec<PrimerMismatch>,
    pub three_prime_match_length: usize,
    pub melting_temperature: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PcrOptions {
    pub forward_binding_length: Option<usize>,
    pub reverse_binding_length: Option<usize>,
    pub internal_reverse_binding_length: Option<usize>,
    pub internal_forward_binding_length: Option<usize>,
    pub minimum_three_prime_match: Option<usize>,
    pub maximum_mismatches: Option<usize>,
    pub minimum_overlap: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum PcrMode {
    #[serde(rename = "standard")]
    Standard,
    #[serde(rename = "inverse")]
    Inverse,
    #[serde(rename = "overlap-extension")]
    OverlapExtension,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PcrFeatureType {
    Primer,
    Tail,
    Mutation,
    Overlap,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcrProductFeature {
    pub name: String,
    pub feature_type: PcrFeatureType,
    pub span: SequenceSpan,
    pub strand: Strand,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcrProduct {
    pub mode: PcrMode,
    pub sequence: String,
    pub template_start: usize,
    pub template_end: usize,
    pub length: usize,
    pub gc_percent: f64,
    pub wraps_origin: bool,
    pub forward_binding: PrimerBinding,
    pub reverse_binding: PrimerBinding,
    pub features: Vec<PcrProductFeature>,
    pub warnings: Vec<String>,
    pub overlap_length: Option<usize>,
    pub fragments: Option<Box<[PcrProduct; 2]>>,
}

#[derive(Clone, Debug, Error, Eq, PartialEq, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "kebab-case")]
pub enum PcrError {
    #[error("a template sequence is required")]
    TemplateRequired,
    #[error("primers require unambiguous A, C, G, and T bases")]
    InvalidPrimer,
    #[error("the 3′ template-binding region must be between 1 and {primer_length} bases")]
    InvalidBindingLength { primer_length: usize },
}

#[derive(Clone, Copy, Debug, Default)]
struct BindingOptions {
    binding_length: Option<usize>,
    minimum_binding_length: Option<usize>,
    minimum_three_prime_match: Option<usize>,
    maximum_mismatches: Option<usize>,
    maximum_mismatch_fraction: Option<f64>,
    conditions: ThermodynamicConditions,
}

const NEAREST_NEIGHBOR: [(&str, (f64, f64)); 16] = [
    ("AA", (-7.9, -22.2)),
    ("TT", (-7.9, -22.2)),
    ("AT", (-7.2, -20.4)),
    ("TA", (-7.2, -21.3)),
    ("CA", (-8.5, -22.7)),
    ("TG", (-8.5, -22.7)),
    ("GT", (-8.4, -22.4)),
    ("AC", (-8.4, -22.4)),
    ("CT", (-7.8, -21.0)),
    ("AG", (-7.8, -21.0)),
    ("GA", (-8.2, -22.2)),
    ("TC", (-8.2, -22.2)),
    ("CG", (-10.6, -27.2)),
    ("GC", (-9.8, -24.4)),
    ("GG", (-8.0, -19.9)),
    ("CC", (-8.0, -19.9)),
];

#[allow(clippy::cast_precision_loss)]
fn gc_percent(sequence: &str) -> f64 {
    if sequence.is_empty() {
        return 0.0;
    }
    let gc = sequence
        .bytes()
        .filter(|base| matches!(base, b'G' | b'C'))
        .count();
    gc as f64 / sequence.len() as f64 * 100.0
}

fn nearest_neighbor_parameters(pair: &str) -> (f64, f64) {
    NEAREST_NEIGHBOR
        .iter()
        .find_map(|(candidate, parameters)| (*candidate == pair).then_some(*parameters))
        .expect("an unambiguous primer only contains known dinucleotides")
}

fn nearest_neighbor_tm(sequence: &str, conditions: ThermodynamicConditions) -> (f64, f64, f64) {
    if sequence.len() < 14 {
        let gc = sequence
            .bytes()
            .filter(|base| matches!(base, b'G' | b'C'))
            .count();
        #[allow(clippy::cast_precision_loss)]
        let temperature = (2 * (sequence.len() - gc) + 4 * gc) as f64;
        return (temperature, 0.0, 0.0);
    }

    let mut enthalpy = 0.2;
    let mut entropy = -5.7;
    for index in 0..sequence.len() - 1 {
        let (pair_enthalpy, pair_entropy) =
            nearest_neighbor_parameters(&sequence[index..index + 2]);
        enthalpy += pair_enthalpy;
        entropy += pair_entropy;
    }
    for terminal in [
        sequence.as_bytes()[0],
        sequence.as_bytes()[sequence.len() - 1],
    ] {
        if matches!(terminal, b'A' | b'T') {
            enthalpy += 2.2;
            entropy += 6.9;
        }
    }
    let self_complementary = reverse_complement(sequence).is_ok_and(|value| value == sequence);
    if self_complementary {
        entropy -= 1.4;
    }
    let available_magnesium = (conditions.divalent_molar - conditions.dntp_molar).max(0.0);
    let salt_equivalent =
        (conditions.monovalent_molar + 4.0 * available_magnesium.sqrt()).max(0.0001);
    let concentration_divisor = if self_complementary { 1.0 } else { 4.0 };
    let melting_temperature = (enthalpy * 1000.0)
        / (entropy + 1.987 * (conditions.primer_molar.max(1e-12) / concentration_divisor).ln())
        - 273.15
        + 16.6 * salt_equivalent.log10();
    (melting_temperature, enthalpy, entropy)
}

fn longest_complementary_run(left: &str, right: &str) -> usize {
    let complement = reverse_complement(right).unwrap_or_default();
    let left = left.as_bytes();
    let right = complement.as_bytes();
    let mut longest = 0;
    let first_offset = 1_i64 - i64::try_from(right.len()).unwrap_or(i64::MAX);
    let last_offset = i64::try_from(left.len()).unwrap_or(i64::MAX);
    for offset in first_offset..last_offset {
        let mut run = 0;
        for (left_index, left_base) in left.iter().enumerate() {
            let right_index = i64::try_from(left_index).unwrap_or(i64::MAX) - offset;
            if let Ok(right_index) = usize::try_from(right_index)
                && right.get(right_index) == Some(left_base)
            {
                run += 1;
                longest = longest.max(run);
            } else {
                run = 0;
            }
        }
    }
    longest
}

fn hairpin_score(sequence: &str) -> usize {
    let mut longest = 0;
    for left_end in 3..sequence.len().saturating_sub(3) {
        for right_start in left_end + 3..sequence.len() {
            longest = longest.max(longest_complementary_run(
                &sequence[..left_end],
                &sequence[right_start..],
            ));
        }
    }
    longest
}

/// Scores the explicit 3′ template-binding segment separately from any 5′ tail.
///
/// # Errors
///
/// Returns an error for ambiguous primer bases or an invalid binding length.
pub fn analyze_primer(
    value: &str,
    binding_length: Option<usize>,
    conditions: ThermodynamicConditions,
) -> Result<PrimerAnalysis, PcrError> {
    let sequence = normalize_dna(value);
    if sequence.is_empty()
        || !sequence
            .bytes()
            .all(|base| matches!(base, b'A' | b'C' | b'G' | b'T'))
    {
        return Err(PcrError::InvalidPrimer);
    }
    let binding_length = binding_length.unwrap_or(sequence.len());
    if binding_length == 0 || binding_length > sequence.len() {
        return Err(PcrError::InvalidBindingLength {
            primer_length: sequence.len(),
        });
    }
    let tail_length = sequence.len() - binding_length;
    let binding_sequence = sequence[tail_length..].to_owned();
    let (melting_temperature, enthalpy, entropy) =
        nearest_neighbor_tm(&binding_sequence, conditions);
    let numeric_length = u32::try_from(sequence.len()).unwrap_or(u32::MAX);
    Ok(PrimerAnalysis {
        length: sequence.len(),
        gc_percent: gc_percent(&binding_sequence),
        full_gc_percent: gc_percent(&sequence),
        melting_temperature,
        molecular_weight: f64::from(numeric_length) * 303.7 - 61.96,
        binding_sequence,
        binding_length,
        tail_sequence: sequence[..tail_length].to_owned(),
        tail_length,
        enthalpy,
        entropy,
        hairpin_score: hairpin_score(&sequence),
        self_dimer_score: longest_complementary_run(&sequence, &sequence),
        sequence,
    })
}

fn circular_slice(template: &str, start: usize, length: usize) -> String {
    let bytes = template.as_bytes();
    (0..length)
        .map(|offset| char::from(bytes[(start + offset) % bytes.len()]))
        .collect()
}

fn binding_at(
    template: &str,
    primer: &str,
    start: usize,
    length: usize,
    strand: BindingStrand,
    circular: bool,
    options: BindingOptions,
) -> Option<PrimerBinding> {
    if !circular && start + length > template.len() {
        return None;
    }
    let segment = if circular {
        circular_slice(template, start, length)
    } else {
        template[start..start + length].to_owned()
    };
    let binding_sequence = &primer[primer.len() - length..];
    let oriented_template = match strand {
        BindingStrand::Forward => segment,
        BindingStrand::Reverse => reverse_complement(&segment).ok()?,
    };
    let mut mismatches = Vec::new();
    let mut three_prime_match_length = 0;
    for index in (0..length).rev() {
        let primer_base = char::from(binding_sequence.as_bytes()[index]);
        let template_base = char::from(oriented_template.as_bytes()[index]);
        if primer_base == template_base {
            if index == length - 1 - three_prime_match_length {
                three_prime_match_length += 1;
            }
        } else {
            mismatches.push(PrimerMismatch {
                primer_index: primer.len() - length + index,
                primer_base,
                template_base,
            });
        }
    }
    mismatches.reverse();
    let minimum_three_prime_match = options
        .minimum_three_prime_match
        .unwrap_or(length.min(8))
        .min(length);
    let maximum_mismatches = options
        .maximum_mismatches
        .unwrap_or_else(|| 1_usize.max(length * 15 / 100));
    #[allow(clippy::cast_precision_loss)]
    let mismatch_fraction = mismatches.len() as f64 / length as f64;
    if three_prime_match_length < minimum_three_prime_match
        || mismatches.len() > maximum_mismatches
        || mismatch_fraction > options.maximum_mismatch_fraction.unwrap_or(0.2)
    {
        return None;
    }
    let (base_tm, _, _) = nearest_neighbor_tm(binding_sequence, options.conditions);
    let mismatch_penalty = mismatches.iter().fold(0.0, |penalty, mismatch| {
        let distance = primer.len() - mismatch.primer_index - 1;
        penalty
            + if distance < 5 {
                8.0
            } else if distance < 10 {
                6.0
            } else {
                4.0
            }
    });
    let end = (start + length) % template.len();
    Some(PrimerBinding {
        span: SequenceSpan::new(
            start,
            if start + length == template.len() {
                template.len()
            } else {
                end
            },
        ),
        strand,
        wraps_origin: start + length > template.len(),
        binding_length: length,
        tail_length: primer.len() - length,
        binding_sequence: binding_sequence.to_owned(),
        tail_sequence: primer[..primer.len() - length].to_owned(),
        template_sequence: oriented_template,
        mismatch_count: mismatches.len(),
        mismatches,
        three_prime_match_length,
        melting_temperature: base_tm - mismatch_penalty,
    })
}

fn binding_preference(binding: &PrimerBinding) -> isize {
    isize::try_from(binding.binding_length).unwrap_or(isize::MAX)
        - isize::try_from(binding.mismatch_count * 4).unwrap_or(isize::MAX)
}

fn find_primer_bindings_with_options(
    template_value: &str,
    primer_value: &str,
    circular: bool,
    options: BindingOptions,
) -> Result<Vec<PrimerBinding>, PcrError> {
    let template = normalize_dna(template_value);
    if template.is_empty() {
        return Err(PcrError::TemplateRequired);
    }
    let primer = analyze_primer(primer_value, None, options.conditions)?.sequence;
    if let Some(length) = options.binding_length
        && (length == 0 || length > primer.len())
    {
        return Err(PcrError::InvalidBindingLength {
            primer_length: primer.len(),
        });
    }
    let minimum_length = options.binding_length.unwrap_or_else(|| {
        primer
            .len()
            .min(options.minimum_binding_length.unwrap_or(12).max(12))
    });
    let maximum_length = options.binding_length.unwrap_or(primer.len());
    let mut best_by_anchor = BTreeMap::<(BindingStrand, usize), PrimerBinding>::new();
    for length in (minimum_length..=maximum_length).rev() {
        if !circular && length > template.len() {
            continue;
        }
        let last_start = if circular {
            template.len() - 1
        } else {
            template.len() - length
        };
        for start in 0..=last_start {
            for strand in [BindingStrand::Forward, BindingStrand::Reverse] {
                let Some(binding) =
                    binding_at(&template, &primer, start, length, strand, circular, options)
                else {
                    continue;
                };
                let anchor = match strand {
                    BindingStrand::Forward => (strand, (start + length - 1) % template.len()),
                    BindingStrand::Reverse => (strand, start),
                };
                let replace = best_by_anchor.get(&anchor).is_none_or(|current| {
                    binding_preference(&binding) > binding_preference(current)
                        || (binding_preference(&binding) == binding_preference(current)
                            && binding.binding_length > current.binding_length)
                });
                if replace {
                    best_by_anchor.insert(anchor, binding);
                }
            }
        }
    }
    let mut bindings: Vec<_> = best_by_anchor.into_values().collect();
    bindings.sort_by_key(|binding| (binding.span.start, binding.strand));
    Ok(bindings)
}

/// Finds acceptable bindings while preserving an explicit 3′ binding length.
///
/// # Errors
///
/// Returns an error for an empty template, ambiguous primer, or invalid binding length.
pub fn find_primer_bindings(
    template: &str,
    primer: &str,
    circular: bool,
    binding_length: Option<usize>,
    minimum_three_prime_match: Option<usize>,
    maximum_mismatches: Option<usize>,
) -> Result<Vec<PrimerBinding>, PcrError> {
    find_primer_bindings_with_options(
        template,
        primer,
        circular,
        BindingOptions {
            binding_length,
            minimum_three_prime_match,
            maximum_mismatches,
            ..BindingOptions::default()
        },
    )
}

fn binding_warnings(binding: &PrimerBinding, label: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    if binding.mismatch_count > 0 {
        let plural = if binding.mismatch_count == 1 {
            ""
        } else {
            "es"
        };
        warnings.push(format!(
            "{label} has {} intentional mismatch{plural}; verify the encoded product sequence.",
            binding.mismatch_count
        ));
    }
    if binding.melting_temperature < 50.0 {
        warnings.push(format!(
            "{label} annealing Tm is {:.1}°C; lengthen its 3′ binding region or lower the annealing temperature.",
            binding.melting_temperature
        ));
    }
    if binding.three_prime_match_length < 10 {
        warnings.push(format!(
            "{label} has only {} exact bases at its 3′ end; extend the exact 3′ match for reliable extension.",
            binding.three_prime_match_length
        ));
    }
    warnings
}

fn primer_features(
    primer: &str,
    binding: &PrimerBinding,
    product_length: usize,
    strand: BindingStrand,
    label: &str,
) -> Vec<PcrProductFeature> {
    let span = match strand {
        BindingStrand::Forward => SequenceSpan::new(0, primer.len()),
        BindingStrand::Reverse => SequenceSpan::new(product_length - primer.len(), product_length),
    };
    let feature_strand = match strand {
        BindingStrand::Forward => Strand::Forward,
        BindingStrand::Reverse => Strand::Reverse,
    };
    let mut features = vec![PcrProductFeature {
        name: format!("{label} primer"),
        feature_type: PcrFeatureType::Primer,
        span,
        strand: feature_strand,
        note: None,
    }];
    if binding.tail_length > 0 {
        let tail_span = match strand {
            BindingStrand::Forward => SequenceSpan::new(0, binding.tail_length),
            BindingStrand::Reverse => {
                SequenceSpan::new(product_length - binding.tail_length, product_length)
            }
        };
        features.push(PcrProductFeature {
            name: format!("{label} 5′ tail"),
            feature_type: PcrFeatureType::Tail,
            span: tail_span,
            strand: feature_strand,
            note: None,
        });
    }
    for mismatch in &binding.mismatches {
        let position = match strand {
            BindingStrand::Forward => mismatch.primer_index,
            BindingStrand::Reverse => product_length - mismatch.primer_index - 1,
        };
        if position < product_length {
            features.push(PcrProductFeature {
                name: format!("{label} mismatch"),
                feature_type: PcrFeatureType::Mutation,
                span: SequenceSpan::new(position, position + 1),
                strand: feature_strand,
                note: Some(format!(
                    "{}→{} in the primer 5′→3′ orientation",
                    mismatch.template_base, mismatch.primer_base
                )),
            });
        }
    }
    features
}

fn binding_options(length: Option<usize>, options: &PcrOptions) -> BindingOptions {
    BindingOptions {
        binding_length: length,
        minimum_three_prime_match: options.minimum_three_prime_match,
        maximum_mismatches: options.maximum_mismatches,
        ..BindingOptions::default()
    }
}

fn build_pcr_product(
    template: &str,
    forward_primer_value: &str,
    reverse_primer_value: &str,
    forward: PrimerBinding,
    reverse: PrimerBinding,
    mode: PcrMode,
    circular: bool,
) -> Result<Option<PcrProduct>, PcrError> {
    let forward_primer = analyze_primer(
        forward_primer_value,
        None,
        ThermodynamicConditions::default(),
    )?
    .sequence;
    let reverse_primer = analyze_primer(
        reverse_primer_value,
        None,
        ThermodynamicConditions::default(),
    )?
    .sequence;
    let forward_end = forward.span.start + forward.binding_length;
    let mut reverse_start = reverse.span.start;
    if circular && reverse_start < forward_end {
        reverse_start += template.len();
    }
    if reverse_start < forward_end {
        return Ok(None);
    }
    let internal_length = reverse_start - forward_end;
    if circular && internal_length > template.len() - forward.binding_length {
        return Ok(None);
    }
    let internal = if circular {
        circular_slice(template, forward_end % template.len(), internal_length)
    } else {
        template[forward_end..reverse_start].to_owned()
    };
    let sequence = format!(
        "{forward_primer}{internal}{}",
        reverse_complement(&reverse_primer).expect("validated primer has a complement")
    );
    let mut features = primer_features(
        &forward_primer,
        &forward,
        sequence.len(),
        BindingStrand::Forward,
        "Forward",
    );
    features.extend(primer_features(
        &reverse_primer,
        &reverse,
        sequence.len(),
        BindingStrand::Reverse,
        "Reverse",
    ));
    let mut warnings = binding_warnings(&forward, "Forward primer");
    warnings.extend(binding_warnings(&reverse, "Reverse primer"));
    let pair_complementarity = longest_complementary_run(&forward_primer, &reverse_primer);
    if pair_complementarity >= 5 {
        warnings.push(format!(
            "The primer pair has a {pair_complementarity}-base complementary run; inspect it for primer-dimer formation."
        ));
    }
    warnings = deduplicate(warnings);
    let length = sequence.len();
    Ok(Some(PcrProduct {
        mode,
        gc_percent: gc_percent(&sequence),
        template_start: forward.span.start,
        template_end: reverse.span.end,
        wraps_origin: circular && reverse.span.start < forward_end,
        forward_binding: forward,
        reverse_binding: reverse,
        sequence,
        length,
        features,
        warnings,
        overlap_length: None,
        fragments: None,
    }))
}

fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// Simulates an inward-facing PCR and chooses the shortest valid amplicon.
///
/// # Errors
///
/// Returns an error when a primer or its explicit binding length is invalid.
pub fn simulate_pcr(
    template_value: &str,
    forward_primer: &str,
    reverse_primer: &str,
    circular: bool,
    options: &PcrOptions,
) -> Result<Option<PcrProduct>, PcrError> {
    let template = normalize_dna(template_value);
    if template.is_empty() {
        return Err(PcrError::TemplateRequired);
    }
    let forward_bindings = find_primer_bindings_with_options(
        &template,
        forward_primer,
        circular,
        binding_options(options.forward_binding_length, options),
    )?;
    let reverse_bindings = find_primer_bindings_with_options(
        &template,
        reverse_primer,
        circular,
        binding_options(options.reverse_binding_length, options),
    )?;
    let forward_binding_count = forward_bindings
        .iter()
        .filter(|binding| binding.strand == BindingStrand::Forward)
        .count();
    let reverse_binding_count = reverse_bindings
        .iter()
        .filter(|binding| binding.strand == BindingStrand::Reverse)
        .count();
    let mut products = Vec::new();
    for forward in forward_bindings
        .iter()
        .filter(|binding| binding.strand == BindingStrand::Forward)
    {
        for reverse in reverse_bindings
            .iter()
            .filter(|binding| binding.strand == BindingStrand::Reverse)
        {
            if let Some(product) = build_pcr_product(
                &template,
                forward_primer,
                reverse_primer,
                forward.clone(),
                reverse.clone(),
                PcrMode::Standard,
                circular,
            )? {
                products.push(product);
            }
        }
    }
    products.sort_by_key(|product| (product.length, product.template_start));
    let mut product = products.into_iter().next();
    if let Some(product) = product.as_mut() {
        if forward_binding_count > 1 {
            product.warnings.push(format!(
                "The forward primer has {forward_binding_count} acceptable template bindings; lengthen or move its 3′ region to make the product unique."
            ));
        }
        if reverse_binding_count > 1 {
            product.warnings.push(format!(
                "The reverse primer has {reverse_binding_count} acceptable template bindings; lengthen or move its 3′ region to make the product unique."
            ));
        }
        product.warnings = deduplicate(std::mem::take(&mut product.warnings));
    }
    Ok(product)
}

/// Simulates outward-facing PCR across a circular template origin.
///
/// # Errors
///
/// Returns an error when a primer or its explicit binding length is invalid.
pub fn simulate_inverse_pcr(
    template_value: &str,
    forward_primer: &str,
    reverse_primer: &str,
    options: &PcrOptions,
) -> Result<Option<PcrProduct>, PcrError> {
    let template = normalize_dna(template_value);
    if template.is_empty() {
        return Err(PcrError::TemplateRequired);
    }
    let forward_bindings = find_primer_bindings_with_options(
        &template,
        forward_primer,
        true,
        binding_options(options.forward_binding_length, options),
    )?;
    let reverse_bindings = find_primer_bindings_with_options(
        &template,
        reverse_primer,
        true,
        binding_options(options.reverse_binding_length, options),
    )?;
    let forward_binding_count = forward_bindings
        .iter()
        .filter(|binding| binding.strand == BindingStrand::Forward)
        .count();
    let reverse_binding_count = reverse_bindings
        .iter()
        .filter(|binding| binding.strand == BindingStrand::Reverse)
        .count();
    let mut products = Vec::new();
    for forward in forward_bindings
        .iter()
        .filter(|binding| binding.strand == BindingStrand::Forward)
    {
        for reverse in reverse_bindings
            .iter()
            .filter(|binding| binding.strand == BindingStrand::Reverse)
        {
            if reverse.span.start >= forward.span.start {
                continue;
            }
            if let Some(mut product) = build_pcr_product(
                &template,
                forward_primer,
                reverse_primer,
                forward.clone(),
                reverse.clone(),
                PcrMode::Inverse,
                true,
            )? && product.wraps_origin
            {
                product.warnings.push(
                    "Inverse-PCR output is a linear amplicon; circularization or assembly is still required to make a plasmid."
                        .to_owned(),
                );
                products.push(product);
            }
        }
    }
    products.sort_by_key(|product| (product.length, product.template_start));
    let mut product = products.into_iter().next();
    if let Some(product) = product.as_mut() {
        if forward_binding_count > 1 || reverse_binding_count > 1 {
            product.warnings.push(format!(
                "The outward primer pair has {forward_binding_count} forward and {reverse_binding_count} reverse candidate bindings; make both 3′ regions unique before cycling."
            ));
        }
        product.warnings = deduplicate(std::mem::take(&mut product.warnings));
    }
    Ok(product)
}

fn longest_suffix_prefix(left: &str, right: &str, minimum: usize) -> usize {
    let maximum = left.len().min(right.len());
    (minimum..=maximum)
        .rev()
        .find(|length| left[left.len() - length..] == right[..*length])
        .unwrap_or(0)
}

fn consolidate_features(features: Vec<PcrProductFeature>) -> Vec<PcrProductFeature> {
    let mut consolidated: Vec<PcrProductFeature> = Vec::new();
    for feature in features {
        if feature.feature_type == PcrFeatureType::Mutation
            && let Some(existing) = consolidated.iter_mut().find(|candidate| {
                candidate.feature_type == PcrFeatureType::Mutation && candidate.span == feature.span
            })
        {
            "Overlap mutation".clone_into(&mut existing.name);
            existing.strand = Strand::Both;
            existing.note = Some("Encoded by both complementary internal primers.".to_owned());
            continue;
        }
        let duplicate = consolidated.iter().any(|candidate| {
            candidate.feature_type == feature.feature_type
                && candidate.span == feature.span
                && candidate.name == feature.name
        });
        if !duplicate {
            consolidated.push(feature);
        }
    }
    consolidated
}

/// Joins two primary PCR products through their longest exact suffix/prefix overlap.
///
/// # Errors
///
/// Returns an error when a primer or its explicit binding length is invalid.
#[allow(clippy::too_many_arguments)]
pub fn simulate_overlap_extension_pcr(
    template_value: &str,
    outer_forward_primer: &str,
    internal_reverse_primer: &str,
    internal_forward_primer: &str,
    outer_reverse_primer: &str,
    circular: bool,
    options: &PcrOptions,
) -> Result<Option<PcrProduct>, PcrError> {
    let mut left_options = options.clone();
    left_options.reverse_binding_length = options.internal_reverse_binding_length;
    let Some(left) = simulate_pcr(
        template_value,
        outer_forward_primer,
        internal_reverse_primer,
        circular,
        &left_options,
    )?
    else {
        return Ok(None);
    };
    let mut right_options = options.clone();
    right_options.forward_binding_length = options.internal_forward_binding_length;
    let Some(right) = simulate_pcr(
        template_value,
        internal_forward_primer,
        outer_reverse_primer,
        circular,
        &right_options,
    )?
    else {
        return Ok(None);
    };
    let minimum_overlap = options.minimum_overlap.unwrap_or(15).max(8);
    let overlap_length = longest_suffix_prefix(&left.sequence, &right.sequence, minimum_overlap);
    if overlap_length == 0 || overlap_length >= left.length || overlap_length >= right.length {
        return Ok(None);
    }
    let sequence = format!("{}{}", left.sequence, &right.sequence[overlap_length..]);
    let right_offset = left.length - overlap_length;
    let mut combined_features = left.features.clone();
    combined_features.extend(right.features.iter().cloned().map(|mut feature| {
        feature.span.start += right_offset;
        feature.span.end += right_offset;
        feature
    }));
    combined_features.push(PcrProductFeature {
        name: "Overlap-extension junction".to_owned(),
        feature_type: PcrFeatureType::Overlap,
        span: SequenceSpan::new(left.length - overlap_length, left.length),
        strand: Strand::Both,
        note: Some(format!(
            "{overlap_length} bp exact overlap between the two primary amplicons"
        )),
    });
    let features = consolidate_features(combined_features);
    let overlap_tm = analyze_primer(
        &left.sequence[left.length - overlap_length..],
        None,
        ThermodynamicConditions::default(),
    )?
    .melting_temperature;
    let mut warnings = left.warnings.clone();
    warnings.extend(right.warnings.clone());
    if overlap_length < 20 {
        warnings.push(format!(
            "The overlap is {overlap_length} bp; extend the mutagenic overlap to 20 bp or more if assembly is inefficient."
        ));
    }
    if overlap_tm < 50.0 {
        warnings.push(format!(
            "The overlap Tm is {overlap_tm:.1}°C; lengthen or rebalance the overlap."
        ));
    }
    let length = sequence.len();
    let template_start = left.template_start;
    let template_end = right.template_end;
    let wraps_origin = left.wraps_origin || right.wraps_origin;
    let forward_binding = left.forward_binding.clone();
    let reverse_binding = right.reverse_binding.clone();
    Ok(Some(PcrProduct {
        mode: PcrMode::OverlapExtension,
        gc_percent: gc_percent(&sequence),
        sequence,
        template_start,
        template_end,
        length,
        wraps_origin,
        forward_binding,
        reverse_binding,
        features,
        warnings: deduplicate(warnings),
        overlap_length: Some(overlap_length),
        fragments: Some(Box::new([left, right])),
    }))
}

impl PcrProduct {
    /// Creates a deterministic linear product document with primer, tail, mutation, and overlap annotations.
    ///
    /// # Errors
    ///
    /// Returns an error only if the product sequence is unexpectedly invalid.
    pub fn to_document(
        &self,
        name: impl Into<String>,
    ) -> Result<SequenceDocument, crate::SequenceError> {
        let mut document = SequenceDocument::new(name, &self.sequence)?;
        document.topology = Topology::Linear;
        document.features = self
            .features
            .iter()
            .map(|feature| {
                let (kind, color) = match feature.feature_type {
                    PcrFeatureType::Primer => ("primer_bind", "#5cc8d7"),
                    PcrFeatureType::Tail => ("primer_tail", "#e0bd55"),
                    PcrFeatureType::Mutation => ("mutation", "#ef675f"),
                    PcrFeatureType::Overlap => ("overlap", "#ae7ad8"),
                };
                Feature {
                    name: feature.name.clone(),
                    kind: kind.to_owned(),
                    color: Some(color.to_owned()),
                    strand: feature.strand,
                    segments: vec![FeatureSegment {
                        span: feature.span,
                        color: Some(color.to_owned()),
                        name: None,
                        kind: Some("standard".to_owned()),
                    }],
                    qualifiers: feature.note.as_ref().map_or_else(Vec::new, |note| {
                        vec![Qualifier {
                            name: "note".to_owned(),
                            value: note.clone(),
                        }]
                    }),
                    reading_frame: None,
                }
            })
            .collect();
        document.history.push(HistoryEntry {
            operation: HistoryOperation::Pcr,
            description: match self.mode {
                PcrMode::Standard => "Created standard PCR product",
                PcrMode::Inverse => "Created inverse-PCR product",
                PcrMode::OverlapExtension => "Created overlap-extension PCR product",
            }
            .to_owned(),
            recorded_at: "Generated by DOTDNA".to_owned(),
            parent_document: None,
        });
        Ok(document)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reverse(sequence: &str) -> String {
        reverse_complement(sequence).unwrap()
    }

    #[test]
    fn nearest_neighbor_tm_only_scores_explicit_binding_region() {
        let analysis = analyze_primer(
            "GGATCCACGTTGCAAGTCGATCGTAC",
            Some(20),
            ThermodynamicConditions::default(),
        )
        .unwrap();
        assert_eq!(analysis.tail_sequence, "GGATCC");
        assert_eq!(analysis.binding_sequence, "ACGTTGCAAGTCGATCGTAC");
        assert!((analysis.gc_percent - 50.0).abs() < f64::EPSILON);
        assert!(analysis.melting_temperature > 55.0 && analysis.melting_temperature < 61.0);
        assert!(analysis.enthalpy < -150.0);
    }

    #[test]
    fn tail_and_mismatch_are_in_product_but_three_prime_mismatch_is_rejected() {
        let template = "GATCACGTTGCAAGTCGATCGTACTTGACCGATGCTAGCTAGGATCCGATCGTACCTAGGCTAACGGTTCAGTACCGTATTCGAGCT";
        let binding = &template[4..24];
        let mut mismatched = binding.to_owned();
        mismatched.replace_range(6..7, "A");
        let forward = format!("GGATCC{mismatched}");
        let reverse_primer = reverse(&template[66..86]);
        let bindings =
            find_primer_bindings(template, &forward, false, Some(20), None, None).unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].tail_sequence, "GGATCC");
        assert_eq!(bindings[0].mismatch_count, 1);
        assert_eq!(bindings[0].three_prime_match_length, 13);

        let invalid_three_prime = format!("{}A", &forward[..forward.len() - 1]);
        assert!(
            find_primer_bindings(template, &invalid_three_prime, false, Some(20), None, None)
                .unwrap()
                .is_empty()
        );

        let options = PcrOptions {
            forward_binding_length: Some(20),
            reverse_binding_length: Some(20),
            ..PcrOptions::default()
        };
        let product = simulate_pcr(template, &forward, &reverse_primer, false, &options)
            .unwrap()
            .unwrap();
        assert!(product.sequence.starts_with(&forward));
        assert!(product.sequence.ends_with(&template[66..86]));
        assert!(
            product
                .features
                .iter()
                .any(|feature| feature.feature_type == PcrFeatureType::Tail)
        );
        assert!(
            product
                .features
                .iter()
                .any(|feature| feature.feature_type == PcrFeatureType::Mutation)
        );
        assert!(product.warnings.join(" ").contains("intentional mismatch"));
    }

    #[test]
    fn inverse_pcr_wraps_origin_and_creates_linear_product() {
        let template =
            "GATCACGTTGCAAGTCGATCGTACTTGACCGATGCTAGCTAGGATCCGATCGTACCTAGGCTAACGGTTCAGTACCGTA";
        let forward = &template[49..69];
        let reverse_primer = reverse(&template[9..29]);
        let options = PcrOptions {
            forward_binding_length: Some(20),
            reverse_binding_length: Some(20),
            ..PcrOptions::default()
        };
        let product = simulate_inverse_pcr(template, forward, &reverse_primer, &options)
            .unwrap()
            .unwrap();
        assert_eq!(product.mode, PcrMode::Inverse);
        assert!(product.wraps_origin);
        assert_eq!(product.length, template.len() - 20);
        assert_eq!(
            product.sequence,
            format!("{}{}", &template[49..], &template[..29])
        );
        assert!(product.warnings.last().unwrap().contains("linear amplicon"));
        assert_eq!(
            product.to_document("inverse product").unwrap().topology,
            Topology::Linear
        );
    }

    #[test]
    fn overlap_extension_creates_deterministic_junction_and_mutation() {
        let template = "TTGACGATCGTACGCTAGCATCGATGCACTGACCTGATCGTACGATGCTAGCTTACGGTACCTGACTAGCGTACCGATGCAATCGGTCAGTCA";
        let outer_forward = &template[4..24];
        let outer_reverse = reverse(&template[70..90]);
        let original_overlap = &template[30..54];
        let mut mutated_overlap = original_overlap.to_owned();
        mutated_overlap.replace_range(11..12, "C");
        let options = PcrOptions {
            forward_binding_length: Some(20),
            internal_reverse_binding_length: Some(16),
            internal_forward_binding_length: Some(16),
            reverse_binding_length: Some(20),
            ..PcrOptions::default()
        };
        let product = simulate_overlap_extension_pcr(
            template,
            outer_forward,
            &reverse(&mutated_overlap),
            &mutated_overlap,
            &outer_reverse,
            false,
            &options,
        )
        .unwrap()
        .unwrap();
        assert_eq!(product.mode, PcrMode::OverlapExtension);
        assert_eq!(product.overlap_length, Some(24));
        assert_eq!(
            product.sequence,
            format!("{}C{}", &template[4..41], &template[42..90])
        );
        assert!(
            product
                .features
                .iter()
                .any(|feature| feature.feature_type == PcrFeatureType::Overlap)
        );
        let mutations: Vec<_> = product
            .features
            .iter()
            .filter(|feature| feature.feature_type == PcrFeatureType::Mutation)
            .collect();
        assert_eq!(mutations.len(), 1);
        assert_eq!(mutations[0].strand, Strand::Both);
    }
}
