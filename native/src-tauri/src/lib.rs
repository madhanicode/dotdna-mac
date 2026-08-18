use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use dotdna_core::{
    DocumentDiagnostic, PcrOptions, PcrProduct, PrimerAnalysis, PrimerBinding, SequenceDocument,
    ThermodynamicConditions, analyze_primer, find_primer_bindings,
    simulate_inverse_pcr as run_inverse_pcr,
    simulate_overlap_extension_pcr as run_overlap_extension_pcr, simulate_pcr as run_standard_pcr,
};
use dotdna_io::{SequenceFormat, parse_snapgene_named, parse_text_document, to_dotdna_project};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    path: Option<PathBuf>,
    format: String,
    document: SequenceDocument,
    length: usize,
    gc_percent: f64,
    unknown_bases: usize,
    diagnostics: Vec<DocumentDiagnostic>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RequestedPcrMode {
    Standard,
    Inverse,
    OverlapExtension,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PcrCommandRequest {
    mode: RequestedPcrMode,
    template_name: String,
    template_sequence: String,
    circular: bool,
    forward_primer: String,
    reverse_primer: String,
    internal_reverse_primer: Option<String>,
    internal_forward_primer: Option<String>,
    options: PcrOptions,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PcrCommandResult {
    product: PcrProduct,
    document: DocumentSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: String,
    message: String,
    action: String,
}

impl CommandError {
    fn new(code: &str, message: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            action: action.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrimerCheckInput {
    name: String,
    sequence: String,
    binding_length: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrimerCheckRequest {
    template_sequence: String,
    circular: bool,
    primers: Vec<PrimerCheckInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrimerCheckResult {
    name: String,
    status: &'static str,
    headline: String,
    action: Option<String>,
    analysis: Option<PrimerAnalysis>,
    bindings: Vec<PrimerBinding>,
}

impl DocumentSummary {
    fn new(path: Option<PathBuf>, format: impl Into<String>, document: SequenceDocument) -> Self {
        let stats = document.stats();
        let diagnostics = document.validate();
        Self {
            path,
            format: format.into(),
            document,
            length: stats.length,
            gc_percent: stats.gc_percent,
            unknown_bases: stats.unknown_bases,
            diagnostics,
        }
    }
}

fn format_name(format: SequenceFormat) -> &'static str {
    match format {
        SequenceFormat::Fasta => "FASTA",
        SequenceFormat::GenBank => "GenBank",
        SequenceFormat::PlainDna => "Plain DNA",
        SequenceFormat::DotDnaProject => "DOTDNA Project",
    }
}

fn read_document(path: &Path) -> Result<DocumentSummary, String> {
    const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled.dna");
    let byte_length = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len();
    if byte_length > MAX_DOCUMENT_BYTES {
        let whole_megabytes = byte_length / (1024 * 1024);
        let tenths = byte_length % (1024 * 1024) * 10 / (1024 * 1024);
        return Err(format!(
            "This file is {whole_megabytes}.{tenths} MB; DOTDNA limits individual imports to 64 MB."
        ));
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let is_snapgene = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("dna"));

    if is_snapgene {
        let document = parse_snapgene_named(name, &bytes).map_err(|error| error.to_string())?;
        return Ok(DocumentSummary::new(
            Some(path.to_path_buf()),
            "SnapGene",
            document,
        ));
    }

    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "This file is neither a valid SnapGene document nor UTF-8 text".to_owned())?;
    let imported = parse_text_document(name, text).map_err(|error| error.to_string())?;
    Ok(DocumentSummary::new(
        Some(path.to_path_buf()),
        format_name(imported.format),
        imported.document,
    ))
}

fn write_document(path: &Path, document: SequenceDocument) -> Result<DocumentSummary, String> {
    static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(0);
    let saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs()
        .to_string();
    let text = to_dotdna_project(&document.name, &document, &saved_at)
        .map_err(|error| error.to_string())?;
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("dotdna-project");
    let (temporary_path, mut temporary_file) = (0..100)
        .find_map(|_| {
            let nonce = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
            let candidate =
                directory.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nonce));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error)),
            }
        })
        .transpose()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Could not reserve a unique temporary save file.".to_owned())?;
    if let Err(error) = temporary_file
        .write_all(text.as_bytes())
        .and_then(|()| temporary_file.flush())
        .and_then(|()| temporary_file.sync_all())
    {
        drop(temporary_file);
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error.to_string());
    }
    drop(temporary_file);
    if let Err(error) = std::fs::rename(&temporary_path, path) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error.to_string());
    }
    std::fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(DocumentSummary::new(
        Some(path.to_path_buf()),
        "DOTDNA Project",
        document,
    ))
}

#[tauri::command]
async fn open_document(path: String) -> Result<DocumentSummary, String> {
    tauri::async_runtime::spawn_blocking(move || read_document(Path::new(&path)))
        .await
        .map_err(|error| format!("The document worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn save_document(
    path: String,
    document: SequenceDocument,
) -> Result<DocumentSummary, String> {
    tauri::async_runtime::spawn_blocking(move || write_document(Path::new(&path), document))
        .await
        .map_err(|error| format!("The document writer stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn import_sequence(name: &str, text: &str) -> Result<DocumentSummary, String> {
    let imported = parse_text_document(name, text).map_err(|error| error.to_string())?;
    Ok(DocumentSummary::new(
        None,
        format_name(imported.format),
        imported.document,
    ))
}

fn product_name(template_name: &str, mode: &RequestedPcrMode) -> String {
    let base = template_name
        .rsplit_once('.')
        .map_or(template_name, |(stem, _)| stem);
    let suffix = match mode {
        RequestedPcrMode::Standard => "PCR Product",
        RequestedPcrMode::Inverse => "Inverse-PCR Product",
        RequestedPcrMode::OverlapExtension => "Overlap-Extension Product",
    };
    format!("{base} — {suffix}.dna")
}

#[allow(clippy::needless_pass_by_value)] // Tauri deserializes command payloads into owned values.
fn simulate_pcr_product_blocking(
    request: PcrCommandRequest,
) -> Result<PcrCommandResult, CommandError> {
    if matches!(request.mode, RequestedPcrMode::Inverse) && !request.circular {
        return Err(CommandError::new(
            "inverse-requires-circular-template",
            "Inverse PCR requires a circular template.",
            "Mark the source molecule as circular or use standard PCR.",
        ));
    }
    let product = match request.mode {
        RequestedPcrMode::Standard => run_standard_pcr(
            &request.template_sequence,
            &request.forward_primer,
            &request.reverse_primer,
            request.circular,
            &request.options,
        ),
        RequestedPcrMode::Inverse => run_inverse_pcr(
            &request.template_sequence,
            &request.forward_primer,
            &request.reverse_primer,
            &request.options,
        ),
        RequestedPcrMode::OverlapExtension => {
            let internal_reverse = request.internal_reverse_primer.as_deref().unwrap_or_default();
            let internal_forward = request.internal_forward_primer.as_deref().unwrap_or_default();
            if internal_reverse.is_empty() || internal_forward.is_empty() {
                return Err(CommandError::new(
                    "internal-primers-required",
                    "Overlap-extension PCR requires two internal primers.",
                    "Choose complementary internal primers that encode the desired overlap or mutation.",
                ));
            }
            run_overlap_extension_pcr(
                &request.template_sequence,
                &request.forward_primer,
                internal_reverse,
                internal_forward,
                &request.reverse_primer,
                request.circular,
                &request.options,
            )
        }
    }
    .map_err(|error| {
        CommandError::new(
            "invalid-primer",
            error.to_string(),
            "Review the primer sequence and its explicit 3′ template-binding length.",
        )
    })?
    .ok_or_else(|| match request.mode {
        RequestedPcrMode::Standard => CommandError::new(
            "no-valid-product",
            "No inward-facing primer pair passed 3′ binding validation.",
            "Verify primer orientation, lengthen the exact 3′ match, or choose another binding site.",
        ),
        RequestedPcrMode::Inverse => CommandError::new(
            "no-valid-product",
            "No outward-facing primer pair produced an origin-spanning amplicon.",
            "Place the reverse primer to the left of the forward primer on the circular map.",
        ),
        RequestedPcrMode::OverlapExtension => CommandError::new(
            "no-valid-product",
            "The two primary amplicons did not form a valid exact overlap.",
            "Confirm all four binding regions and use an internal overlap of at least 15 bp.",
        ),
    })?;

    let name = product_name(&request.template_name, &request.mode);
    let document = product.to_document(&name).map_err(|error| {
        CommandError::new(
            "product-document-failed",
            error.to_string(),
            "Review the predicted sequence before trying again.",
        )
    })?;
    Ok(PcrCommandResult {
        document: DocumentSummary::new(None, "PCR Product", document),
        product,
    })
}

#[tauri::command]
async fn simulate_pcr_product(
    request: PcrCommandRequest,
) -> Result<PcrCommandResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || simulate_pcr_product_blocking(request))
        .await
        .map_err(|error| {
            CommandError::new(
                "pcr-worker-failed",
                format!("The PCR worker stopped unexpectedly: {error}"),
                "Try the design again or use a smaller template.",
            )
        })?
}

fn analyze_document_primers_blocking(request: PrimerCheckRequest) -> Vec<PrimerCheckResult> {
    request
        .primers
        .into_iter()
        .map(|primer| {
            let analysis = analyze_primer(
                &primer.sequence,
                primer.binding_length,
                ThermodynamicConditions::default(),
            );
            let bindings = primer
                .binding_length
                .map_or_else(Vec::new, |binding_length| {
                    find_primer_bindings(
                        &request.template_sequence,
                        &primer.sequence,
                        request.circular,
                        Some(binding_length),
                        None,
                        None,
                    )
                    .unwrap_or_default()
                });
            let (status, headline, action) = if primer.binding_length.is_none() {
                (
                    "needs-binding-region",
                    "3′ binding region not set".to_owned(),
                    Some("Set the number of 3′ bases that hybridize to the template.".to_owned()),
                )
            } else if analysis.is_err() {
                (
                    "invalid",
                    "Primer sequence is invalid".to_owned(),
                    Some("Use only unambiguous A, C, G, and T bases.".to_owned()),
                )
            } else if bindings.is_empty() {
                (
                    "no-binding",
                    "No validated template binding".to_owned(),
                    Some("Verify the sequence and preserve an exact 3′ terminal match.".to_owned()),
                )
            } else if bindings.len() > 1 {
                (
                    "multiple-bindings",
                    format!("{} possible template bindings", bindings.len()),
                    Some("Lengthen or move the 3′ binding region to make it unique.".to_owned()),
                )
            } else {
                ("validated", "Unique 3′ binding validated".to_owned(), None)
            };
            PrimerCheckResult {
                name: primer.name,
                status,
                headline,
                action,
                analysis: analysis.ok(),
                bindings,
            }
        })
        .collect()
}

#[tauri::command]
async fn analyze_document_primers(
    request: PrimerCheckRequest,
) -> Result<Vec<PrimerCheckResult>, String> {
    tauri::async_runtime::spawn_blocking(move || analyze_document_primers_blocking(request))
        .await
        .map_err(|error| format!("The primer worker stopped unexpectedly: {error}"))
}

fn replace_document_sequence_blocking(
    mut document: SequenceDocument,
    new_sequence: &str,
) -> Result<DocumentSummary, String> {
    document
        .replace_sequence(new_sequence)
        .map_err(|error| error.to_string())?;
    Ok(DocumentSummary::new(None, "Edited DNA", document))
}

#[tauri::command]
async fn replace_document_sequence(
    document: SequenceDocument,
    new_sequence: String,
) -> Result<DocumentSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        replace_document_sequence_blocking(document, &new_sequence)
    })
    .await
    .map_err(|error| format!("The sequence editor stopped unexpectedly: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the DOTDNA desktop application.
///
/// # Panics
///
/// Panics when the native Tauri runtime cannot be initialized.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            import_sequence,
            simulate_pcr_product,
            analyze_document_primers,
            replace_document_sequence
        ])
        .run(tauri::generate_context!())
        .expect("DOTDNA failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_sequence_for_the_frontend_boundary() {
        let result = import_sequence("sample.fasta", ">sample\nACGTACGT").expect("valid FASTA");
        assert_eq!(result.length, 8);
        assert_eq!(result.format, "FASTA");
        assert_eq!(result.document.sequence, "ACGTACGT");
    }

    #[test]
    fn native_boundary_returns_computed_pcr_product_document() {
        let template = "AAAATGCGTACGTTTTCCGGAATTAAAA";
        let result = simulate_pcr_product_blocking(PcrCommandRequest {
            mode: RequestedPcrMode::Standard,
            template_name: "template.dna".to_owned(),
            template_sequence: template.to_owned(),
            circular: false,
            forward_primer: "ATGCGT".to_owned(),
            reverse_primer: "TTCCGG".to_owned(),
            internal_reverse_primer: None,
            internal_forward_primer: None,
            options: PcrOptions {
                forward_binding_length: Some(6),
                reverse_binding_length: Some(6),
                ..PcrOptions::default()
            },
        })
        .unwrap();
        assert!(result.product.sequence.starts_with("ATGCGT"));
        assert!(result.product.sequence.ends_with("CCGGAA"));
        assert_eq!(result.document.document.sequence, result.product.sequence);
        assert_eq!(
            result.document.document.topology,
            dotdna_core::Topology::Linear
        );
        assert!(!result.document.document.features.is_empty());
    }

    #[test]
    fn native_boundary_applies_sequence_edits_with_history() {
        let document = SequenceDocument::new("edit", "AAAACCCC").unwrap();
        let result = replace_document_sequence_blocking(document, "AAAATTTTCCCC").unwrap();
        assert_eq!(result.document.sequence, "AAAATTTTCCCC");
        assert_eq!(result.document.history.len(), 1);
        assert_eq!(
            result.document.history[0]
                .parent_document
                .as_deref()
                .unwrap()
                .sequence,
            "AAAACCCC"
        );
    }

    #[test]
    fn native_boundary_saves_an_atomic_dotdna_project() {
        let path = std::env::temp_dir().join(format!(
            "dotdna-save-test-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("worker")
        ));
        let preexisting_sibling = path.with_extension("json.tmp");
        std::fs::write(&preexisting_sibling, "keep me").unwrap();
        let document = SequenceDocument::new("saved molecule", "ACGTACGT").unwrap();
        let result = write_document(&path, document).unwrap();
        assert_eq!(result.format, "DOTDNA Project");
        assert_eq!(result.path.as_deref(), Some(path.as_path()));
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("\"format\": \"dotdna-project\""));
        assert_eq!(
            std::fs::read_to_string(&preexisting_sibling).unwrap(),
            "keep me"
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(preexisting_sibling).unwrap();
    }
}
