use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use dotdna_core::{
    DigestEnd, DigestError, DocumentDiagnostic, Feature, OpenReadingFrame, OrfAnalysisResult,
    OrfTranslation, PcrOptions, PcrProduct, Primer, PrimerAnalysis, PrimerBinding, RestrictionCut,
    SequenceDocument, SequenceMatch, SequenceSpan, ThermodynamicConditions, Topology,
    analyze_orfs_with_status, analyze_primer, find_primer_bindings_limited, find_sequence_matches,
    simulate_inverse_pcr as run_inverse_pcr,
    simulate_overlap_extension_pcr as run_overlap_extension_pcr, simulate_pcr as run_standard_pcr,
    simulate_restriction_digest as run_restriction_digest, translate_open_reading_frame,
};
use dotdna_io::{SequenceFormat, parse_snapgene_named, parse_text_document, to_dotdna_project};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    path: Option<PathBuf>,
    format: String,
    file_version: Option<String>,
    document: SequenceDocument,
    length: usize,
    gc_percent: f64,
    unknown_bases: usize,
    diagnostics: Vec<DocumentDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavePathResolution {
    path: PathBuf,
    file_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFolderFile {
    path: PathBuf,
    relative_path: PathBuf,
    name: String,
    format: &'static str,
    byte_length: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFolderSummary {
    path: PathBuf,
    name: String,
    files: Vec<ProjectFolderFile>,
    truncated: bool,
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMenuState {
    enabled: Vec<String>,
    active_view: Option<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DigestCommandRequest {
    template_id: String,
    template_revision: u64,
    document: SequenceDocument,
    enzyme_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestCommandFragment {
    index: usize,
    source_spans: Vec<SequenceSpan>,
    length: usize,
    gc_percent: f64,
    upstream_end: DigestEnd,
    downstream_end: DigestEnd,
    document: DocumentSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestCommandResult {
    template_id: String,
    template_revision: u64,
    enzyme_names: Vec<String>,
    cuts: Vec<RestrictionCut>,
    fragments: Vec<DigestCommandFragment>,
    warnings: Vec<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDocumentRequest {
    name: String,
    sequence: String,
    circular: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrfAnalysisRequest {
    sequence: String,
    circular: bool,
    minimum_amino_acids: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrfTranslationRequest {
    sequence: String,
    circular: bool,
    orf: OpenReadingFrame,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindSequenceRequest {
    sequence: String,
    query: String,
    circular: bool,
    maximum_results: usize,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum DocumentMutation {
    CreateFeature {
        feature: Feature,
    },
    ReplaceFeature {
        index: usize,
        expected: Feature,
        replacement: Feature,
    },
    DeleteFeature {
        index: usize,
        expected: Feature,
    },
    CreatePrimer {
        primer: Primer,
    },
    ReplacePrimer {
        index: usize,
        expected: Primer,
        replacement: Primer,
    },
    DeletePrimer {
        index: usize,
        expected: Primer,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentMutationRequest {
    document: SequenceDocument,
    mutation: DocumentMutation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentMutationResult {
    summary: DocumentSummary,
    changed: bool,
    entity_index: Option<usize>,
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
    bindings_truncated: bool,
}

impl DocumentSummary {
    fn new(path: Option<PathBuf>, format: impl Into<String>, document: SequenceDocument) -> Self {
        let stats = document.stats();
        let diagnostics = document.validate();
        Self {
            path,
            format: format.into(),
            file_version: None,
            document,
            length: stats.length,
            gc_percent: stats.gc_percent,
            unknown_bases: stats.unknown_bases,
            diagnostics,
        }
    }

    fn from_file(
        path: PathBuf,
        format: impl Into<String>,
        document: SequenceDocument,
        metadata: &std::fs::Metadata,
        bytes: &[u8],
    ) -> Self {
        let mut summary = Self::new(Some(path), format, document);
        summary.file_version = Some(file_version(metadata, bytes));
        summary
    }
}

fn file_version(metadata: &std::fs::Metadata, bytes: &[u8]) -> String {
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{}:{modified_nanos}:{hash:016x}", metadata.len())
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
    let canonical_path = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    let path = canonical_path.as_path();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled.dna");
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let byte_length = metadata.len();
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
        return Ok(DocumentSummary::from_file(
            path.to_path_buf(),
            "SnapGene",
            document,
            &metadata,
            &bytes,
        ));
    }

    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "This file is neither a valid SnapGene document nor UTF-8 text".to_owned())?;
    let imported = parse_text_document(name, text).map_err(|error| error.to_string())?;
    Ok(DocumentSummary::from_file(
        path.to_path_buf(),
        format_name(imported.format),
        imported.document,
        &metadata,
        &bytes,
    ))
}

fn current_file_version(path: &Path) -> Result<Option<String>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(Some(file_version(&metadata, &bytes)))
}

fn write_document(
    path: &Path,
    document: SequenceDocument,
    expected_file_version: Option<&str>,
    destination_must_be_absent: bool,
) -> Result<DocumentSummary, String> {
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
    let directory_lock = std::fs::File::open(directory).map_err(|error| error.to_string())?;
    if let Err(error) = directory_lock.lock() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(format!("DOTDNA could not lock the save folder ({error})."));
    }
    if destination_must_be_absent {
        if let Err(error) = std::fs::hard_link(&temporary_path, path) {
            let _ = std::fs::remove_file(&temporary_path);
            return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                "Another process created the Save As destination. Choose a different file name or review the new file before replacing it.".to_owned()
            } else {
                error.to_string()
            });
        }
        let _ = std::fs::remove_file(&temporary_path);
    } else if let Some(expected) = expected_file_version {
        match current_file_version(path) {
            Ok(Some(actual)) if actual == expected => {}
            Ok(_) => {
                let _ = std::fs::remove_file(&temporary_path);
                return Err("The project changed on disk after it was opened. Use Save As to preserve both versions, or reopen the file before replacing it.".to_owned());
            }
            Err(error) => {
                let _ = std::fs::remove_file(&temporary_path);
                return Err(error);
            }
        }
        if let Err(error) = std::fs::rename(&temporary_path, path) {
            let _ = std::fs::remove_file(&temporary_path);
            return Err(error.to_string());
        }
    } else {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("DOTDNA could not establish the destination's prior state. Reopen the Save As dialog and try again.".to_owned());
    }
    directory_lock
        .sync_all()
        .map_err(|error| error.to_string())?;
    let canonical_path = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    let metadata = std::fs::metadata(&canonical_path).map_err(|error| error.to_string())?;
    Ok(DocumentSummary::from_file(
        canonical_path,
        "DOTDNA Project",
        document,
        &metadata,
        text.as_bytes(),
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
    expected_file_version: Option<String>,
    destination_must_be_absent: bool,
) -> Result<DocumentSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_document(
            Path::new(&path),
            document,
            expected_file_version.as_deref(),
            destination_must_be_absent,
        )
    })
    .await
    .map_err(|error| format!("The document writer stopped unexpectedly: {error}"))?
}

fn resolve_save_path_blocking(path: &Path) -> Result<SavePathResolution, String> {
    let resolved_path = if path.exists() {
        std::fs::canonicalize(path).map_err(|error| error.to_string())?
    } else {
        let file_name = path
            .file_name()
            .ok_or_else(|| "Choose a file name for the DOTDNA project.".to_owned())?;
        let parent = path
            .parent()
            .filter(|value| !value.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let canonical_parent = std::fs::canonicalize(parent).map_err(|error| error.to_string())?;
        canonical_parent.join(file_name)
    };
    let file_version = current_file_version(&resolved_path)?;
    Ok(SavePathResolution {
        path: resolved_path,
        file_version,
    })
}

#[tauri::command]
async fn resolve_save_path(path: String) -> Result<SavePathResolution, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_save_path_blocking(Path::new(&path)))
        .await
        .map_err(|error| format!("The save-path worker stopped unexpectedly: {error}"))?
}

const MAX_PROJECT_FOLDER_FILES: usize = 2_000;
const MAX_PROJECT_FOLDER_ENTRIES: usize = 20_000;
const MAX_PROJECT_FOLDER_DEPTH: usize = 12;
const MAX_PROJECT_FOLDER_WARNINGS: usize = 100;

struct ProjectFolderScan {
    visited_entries: usize,
    truncated: bool,
    warnings: Vec<String>,
}

fn project_file_format(path: &Path) -> Option<&'static str> {
    let file_name = path.file_name()?.to_str()?.to_ascii_lowercase();
    if file_name.ends_with(".dotdna.json") {
        return Some("DOTDNA");
    }
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "dotdna" => Some("DOTDNA"),
        "dna" => Some("SnapGene"),
        "gb" | "gbk" | "genbank" => Some("GenBank"),
        "fa" | "fas" | "fasta" | "fna" => Some("FASTA"),
        "txt" => Some("DNA text"),
        _ => None,
    }
}

fn ignored_project_directory(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".venv"
        )
}

fn add_project_warning(scan: &mut ProjectFolderScan, warning: String) {
    if scan.warnings.len() < MAX_PROJECT_FOLDER_WARNINGS {
        scan.warnings.push(warning);
    }
}

fn bounded_project_entries(
    root: &Path,
    directory: &Path,
    scan: &mut ProjectFolderScan,
) -> Vec<std::fs::DirEntry> {
    let canonical_directory = match std::fs::canonicalize(directory) {
        Ok(path) if path.starts_with(root) => path,
        Ok(path) => {
            add_project_warning(
                scan,
                format!(
                    "Skipped a folder outside the project root: {}",
                    path.display()
                ),
            );
            return Vec::new();
        }
        Err(error) => {
            add_project_warning(
                scan,
                format!("Could not resolve {}: {error}", directory.display()),
            );
            return Vec::new();
        }
    };
    let entries = match std::fs::read_dir(&canonical_directory) {
        Ok(entries) => entries,
        Err(error) => {
            let relative = directory.strip_prefix(root).unwrap_or(directory);
            add_project_warning(
                scan,
                format!("Could not read {}: {error}", relative.display()),
            );
            return Vec::new();
        }
    };
    let mut readable_entries = Vec::new();
    for entry in entries {
        if scan.visited_entries >= MAX_PROJECT_FOLDER_ENTRIES {
            scan.truncated = true;
            break;
        }
        scan.visited_entries += 1;
        match entry {
            Ok(entry) => readable_entries.push(entry),
            Err(error) => {
                add_project_warning(scan, format!("A folder entry could not be read: {error}"));
            }
        }
    }
    readable_entries.sort_by_key(std::fs::DirEntry::file_name);
    readable_entries
}

fn project_file_summary(
    root: &Path,
    entry: &std::fs::DirEntry,
    metadata: &std::fs::Metadata,
    format: &'static str,
    scan: &mut ProjectFolderScan,
) -> Option<ProjectFolderFile> {
    let path = entry.path();
    let canonical_path = match std::fs::canonicalize(&path) {
        Ok(path) if path.starts_with(root) => path,
        Ok(_) => return None,
        Err(error) => {
            add_project_warning(
                scan,
                format!("Could not resolve {}: {error}", path.display()),
            );
            return None;
        }
    };
    let relative_path = canonical_path
        .strip_prefix(root)
        .unwrap_or(&canonical_path)
        .to_path_buf();
    Some(ProjectFolderFile {
        name: entry.file_name().to_string_lossy().into_owned(),
        path: canonical_path,
        relative_path,
        format,
        byte_length: metadata.len(),
    })
}

fn scan_project_directory(
    root: &Path,
    directory: &Path,
    depth: usize,
    files: &mut Vec<ProjectFolderFile>,
    scan: &mut ProjectFolderScan,
) {
    if depth > MAX_PROJECT_FOLDER_DEPTH {
        scan.truncated = true;
        return;
    }
    for entry in bounded_project_entries(root, directory, scan) {
        if files.len() >= MAX_PROJECT_FOLDER_FILES {
            scan.truncated = true;
            return;
        }
        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                add_project_warning(
                    scan,
                    format!("Could not inspect {}: {error}", path.display()),
                );
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !ignored_project_directory(&name)
                && scan.visited_entries < MAX_PROJECT_FOLDER_ENTRIES
            {
                scan_project_directory(root, &path, depth + 1, files, scan);
            } else if !ignored_project_directory(&name) {
                scan.truncated = true;
            }
            if files.len() >= MAX_PROJECT_FOLDER_FILES {
                return;
            }
        } else if metadata.is_file()
            && let Some(format) = project_file_format(&path)
            && let Some(file) = project_file_summary(root, &entry, &metadata, format, scan)
        {
            files.push(file);
        }
    }
}

fn scan_project_folder_blocking(path: &Path) -> Result<ProjectFolderSummary, String> {
    let root = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    let metadata = std::fs::metadata(&root).map_err(|error| error.to_string())?;
    if !metadata.is_dir() {
        return Err("Choose a folder containing DNA documents.".to_owned());
    }
    let mut files = Vec::new();
    let mut scan = ProjectFolderScan {
        visited_entries: 0,
        truncated: false,
        warnings: Vec::new(),
    };
    scan_project_directory(&root, &root, 0, &mut files, &mut scan);
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Project Folder")
        .to_owned();
    Ok(ProjectFolderSummary {
        path: root,
        name,
        files,
        truncated: scan.truncated,
        warnings: scan.warnings,
    })
}

#[tauri::command]
async fn scan_project_folder(path: String) -> Result<ProjectFolderSummary, String> {
    tauri::async_runtime::spawn_blocking(move || scan_project_folder_blocking(Path::new(&path)))
        .await
        .map_err(|error| format!("The project-folder worker stopped unexpectedly: {error}"))?
}

fn create_document_blocking(request: &CreateDocumentRequest) -> Result<DocumentSummary, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Enter a name for the new DNA document.".to_owned());
    }
    if name.chars().count() > 255 {
        return Err("Document names must be 255 characters or fewer.".to_owned());
    }
    let mut document =
        SequenceDocument::new(name, &request.sequence).map_err(|error| error.to_string())?;
    document.topology = if request.circular {
        Topology::Circular
    } else {
        Topology::Linear
    };
    Ok(DocumentSummary::new(None, "Unsaved DNA", document))
}

#[tauri::command]
async fn create_document(request: CreateDocumentRequest) -> Result<DocumentSummary, String> {
    tauri::async_runtime::spawn_blocking(move || create_document_blocking(&request))
        .await
        .map_err(|error| format!("The new-document worker stopped unexpectedly: {error}"))?
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

fn digest_command_error(error: &DigestError) -> CommandError {
    match error {
        DigestError::NoEnzymes => CommandError::new(
            "enzymes-required",
            error.to_string(),
            "Select at least one enzyme with a complete cleavage site.",
        ),
        DigestError::InvalidTemplate => CommandError::new(
            "double-stranded-template-required",
            error.to_string(),
            "Open a non-empty double-stranded DNA document before running a digest.",
        ),
        DigestError::UnknownEnzyme(_) => CommandError::new(
            "unknown-enzyme",
            error.to_string(),
            "Choose an enzyme from the supported catalog instead of entering a free-form name.",
        ),
        DigestError::NoCuts => CommandError::new(
            "no-valid-cuts",
            error.to_string(),
            "Choose an enzyme that cuts this template; Type IIS cleavage must also remain within both linear ends.",
        ),
        DigestError::TooManyCuts => CommandError::new(
            "too-many-cuts",
            error.to_string(),
            "Choose a rarer cutter or a smaller enzyme set; DOTDNA will not create a truncated digest.",
        ),
        DigestError::ConflictingCuts(_) => CommandError::new(
            "conflicting-cuts",
            error.to_string(),
            "Remove one of the enzymes that cleaves the same top-strand boundary with incompatible end chemistry.",
        ),
        DigestError::TooManyAnnotations => CommandError::new(
            "too-many-projected-annotations",
            error.to_string(),
            "Hide or remove unneeded annotations, or choose a digest with fewer fragments.",
        ),
        DigestError::InvalidProduct => CommandError::new(
            "invalid-digest-product",
            error.to_string(),
            "Resolve invalid source annotations before creating restriction fragments.",
        ),
    }
}

#[allow(clippy::needless_pass_by_value)] // Tauri deserializes command payloads into owned values.
fn simulate_restriction_digest_blocking(
    request: DigestCommandRequest,
) -> Result<DigestCommandResult, CommandError> {
    let digest = run_restriction_digest(&request.document, &request.enzyme_names)
        .map_err(|error| digest_command_error(&error))?;
    let fragments = digest
        .fragments
        .into_iter()
        .map(|fragment| DigestCommandFragment {
            index: fragment.index,
            source_spans: fragment.source_spans,
            length: fragment.length,
            gc_percent: fragment.gc_percent,
            upstream_end: fragment.upstream_end,
            downstream_end: fragment.downstream_end,
            document: DocumentSummary::new(None, "Restriction Fragment", fragment.document),
        })
        .collect();
    Ok(DigestCommandResult {
        template_id: request.template_id,
        template_revision: request.template_revision,
        enzyme_names: digest.enzyme_names,
        cuts: digest.cuts,
        fragments,
        warnings: digest.warnings,
    })
}

#[tauri::command]
async fn simulate_restriction_digest(
    request: DigestCommandRequest,
) -> Result<DigestCommandResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || simulate_restriction_digest_blocking(request))
        .await
        .map_err(|error| {
            CommandError::new(
                "digest-worker-failed",
                format!("The restriction-digest worker stopped unexpectedly: {error}"),
                "Try the digest again or choose a smaller template and enzyme set.",
            )
        })?
}

fn analyze_document_primers_blocking(request: PrimerCheckRequest) -> Vec<PrimerCheckResult> {
    const MAX_INTERACTIVE_BINDINGS: usize = 100;
    request
        .primers
        .into_iter()
        .map(|primer| {
            let analysis = analyze_primer(
                &primer.sequence,
                primer.binding_length,
                ThermodynamicConditions::default(),
            );
            let binding_result = primer.binding_length.map_or_else(
                || Ok((Vec::new(), false)),
                |binding_length| {
                    find_primer_bindings_limited(
                        &request.template_sequence,
                        &primer.sequence,
                        request.circular,
                        binding_length,
                        MAX_INTERACTIVE_BINDINGS,
                    )
                },
            );
            let (bindings, bindings_truncated, binding_error) = match binding_result {
                Ok((bindings, truncated)) => (bindings, truncated, None),
                Err(error) => (Vec::new(), false, Some(error)),
            };
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
            } else if let Some(error) = binding_error {
                (
                    "invalid",
                    error.to_string(),
                    Some(
                        "Shorten the 3′ binding region so it fits within the template.".to_owned(),
                    ),
                )
            } else if bindings.is_empty() {
                (
                    "no-binding",
                    "No validated template binding".to_owned(),
                    Some("Verify the sequence and preserve an exact 3′ terminal match.".to_owned()),
                )
            } else if bindings_truncated {
                (
                    "multiple-bindings",
                    format!("More than {MAX_INTERACTIVE_BINDINGS} possible template bindings"),
                    Some("Lengthen or move the 3′ binding region to make it unique.".to_owned()),
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
                bindings_truncated,
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

#[tauri::command]
async fn analyze_open_reading_frames(
    request: OrfAnalysisRequest,
) -> Result<OrfAnalysisResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analyze_orfs_with_status(
            &request.sequence,
            request.circular,
            request.minimum_amino_acids,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("The ORF worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn translate_selected_open_reading_frame(
    request: OrfTranslationRequest,
) -> Result<OrfTranslation, String> {
    const MAX_TRANSLATED_AMINO_ACIDS: usize = 250_000;
    if request.orf.amino_acid_length > MAX_TRANSLATED_AMINO_ACIDS {
        return Err(format!(
            "This ORF contains {} amino acids. DOTDNA limits an on-screen translation track to {} amino acids; export or narrow the region before translating it.",
            request.orf.amino_acid_length, MAX_TRANSLATED_AMINO_ACIDS
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        translate_open_reading_frame(&request.sequence, request.circular, &request.orf)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("The translation worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn find_sequence(request: FindSequenceRequest) -> Result<Vec<SequenceMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        find_sequence_matches(
            &request.sequence,
            &request.query,
            request.circular,
            request.maximum_results,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("The sequence-search worker stopped unexpectedly: {error}"))?
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

#[allow(clippy::needless_pass_by_value)]
fn apply_document_mutation_blocking(
    request: DocumentMutationRequest,
) -> Result<DocumentMutationResult, String> {
    let mut document = request.document;
    let before = document.clone();
    let entity_index = match request.mutation {
        DocumentMutation::CreateFeature { feature } => Some(
            document
                .upsert_feature(None, feature)
                .map_err(|error| error.to_string())?,
        ),
        DocumentMutation::ReplaceFeature {
            index,
            expected,
            replacement,
        } => {
            if document.features.get(index) != Some(&expected) {
                return Err("The feature changed before this edit could be applied. Reopen the feature sheet and try again.".to_owned());
            }
            Some(
                document
                    .upsert_feature(Some(index), replacement)
                    .map_err(|error| error.to_string())?,
            )
        }
        DocumentMutation::DeleteFeature { index, expected } => {
            if document.features.get(index) != Some(&expected) {
                return Err("The feature changed before it could be removed. Reopen the feature list and try again.".to_owned());
            }
            document
                .remove_feature(index)
                .map_err(|error| error.to_string())?;
            None
        }
        DocumentMutation::CreatePrimer { primer } => Some(
            document
                .upsert_primer(None, primer)
                .map_err(|error| error.to_string())?,
        ),
        DocumentMutation::ReplacePrimer {
            index,
            expected,
            mut replacement,
        } => {
            if document.primers.get(index) != Some(&expected) {
                return Err("The primer changed before this edit could be applied. Reopen the primer sheet and try again.".to_owned());
            }
            if (replacement.sequence != expected.sequence
                || replacement.binding_length != expected.binding_length)
                && replacement.binding_sites == expected.binding_sites
            {
                replacement.binding_sites.clear();
            }
            Some(
                document
                    .upsert_primer(Some(index), replacement)
                    .map_err(|error| error.to_string())?,
            )
        }
        DocumentMutation::DeletePrimer { index, expected } => {
            if document.primers.get(index) != Some(&expected) {
                return Err("The primer changed before it could be removed. Reopen the primer list and try again.".to_owned());
            }
            document
                .remove_primer(index)
                .map_err(|error| error.to_string())?;
            None
        }
    };
    let changed = document != before;
    Ok(DocumentMutationResult {
        summary: DocumentSummary::new(None, "Edited DNA", document),
        changed,
        entity_index,
    })
}

#[tauri::command]
async fn apply_document_mutation(
    request: DocumentMutationRequest,
) -> Result<DocumentMutationResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply_document_mutation_blocking(request))
        .await
        .map_err(|error| format!("The annotation worker stopped unexpectedly: {error}"))?
}

fn build_application_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};

    let quit = MenuItem::with_id(app, "file.quit", "Quit DOTDNA", true, Some("CmdOrCtrl+Q"))?;
    Submenu::with_items(
        app,
        "DOTDNA",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About DOTDNA"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn build_file_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};

    let new_document = MenuItem::with_id(app, "file.new", "New DNA…", true, Some("CmdOrCtrl+N"))?;
    let open_document = MenuItem::with_id(app, "file.open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let open_folder = MenuItem::with_id(
        app,
        "file.open-folder",
        "Open Project Folder…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let save_document = MenuItem::with_id(app, "file.save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as = MenuItem::with_id(
        app,
        "file.save-as",
        "Save As…",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let close_document = MenuItem::with_id(
        app,
        "file.close",
        "Close Document",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_document,
            &open_document,
            &open_folder,
            &PredefinedMenuItem::separator(app)?,
            &save_document,
            &save_as,
            &PredefinedMenuItem::separator(app)?,
            &close_document,
        ],
    )
}

fn build_edit_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};

    let undo_document = MenuItem::with_id(
        app,
        "edit.undo-document",
        "Undo Sequence Edit",
        false,
        None::<&str>,
    )?;
    let redo_document = MenuItem::with_id(
        app,
        "edit.redo-document",
        "Redo Sequence Edit",
        false,
        None::<&str>,
    )?;

    Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo_document,
            &redo_document,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::undo(app, Some("Undo Text Edit"))?,
            &PredefinedMenuItem::redo(app, Some("Redo Text Edit"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )
}

fn build_view_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};

    let command_palette = MenuItem::with_id(
        app,
        "view.command-palette",
        "Search Commands…",
        true,
        Some("CmdOrCtrl+K"),
    )?;

    let map = CheckMenuItem::with_id(app, "view.map", "Map", false, true, Some("CmdOrCtrl+1"))?;
    let sequence = CheckMenuItem::with_id(
        app,
        "view.sequence",
        "Sequence",
        false,
        false,
        Some("CmdOrCtrl+2"),
    )?;
    let features = CheckMenuItem::with_id(
        app,
        "view.features",
        "Features",
        false,
        false,
        Some("CmdOrCtrl+3"),
    )?;
    let primers = CheckMenuItem::with_id(
        app,
        "view.primers",
        "Primers",
        false,
        false,
        Some("CmdOrCtrl+4"),
    )?;
    let history = CheckMenuItem::with_id(
        app,
        "view.history",
        "History",
        false,
        false,
        Some("CmdOrCtrl+5"),
    )?;
    Submenu::with_items(
        app,
        "View",
        true,
        &[
            &command_palette,
            &PredefinedMenuItem::separator(app)?,
            &map,
            &sequence,
            &features,
            &primers,
            &history,
        ],
    )
}

fn build_actions_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};

    let pcr = MenuItem::with_id(app, "actions.pcr", "PCR…", false, None::<&str>)?;
    let inverse_pcr = MenuItem::with_id(
        app,
        "actions.inverse-pcr",
        "Inverse PCR…",
        false,
        None::<&str>,
    )?;
    let overlap_pcr = MenuItem::with_id(
        app,
        "actions.overlap-pcr",
        "Overlap-Extension PCR…",
        false,
        None::<&str>,
    )?;
    let digest = MenuItem::with_id(
        app,
        "actions.restriction-digest",
        "Restriction Digest…",
        false,
        None::<&str>,
    )?;
    let assembly = MenuItem::with_id(
        app,
        "actions.assembly",
        "Assembly… (Planned)",
        false,
        None::<&str>,
    )?;
    Submenu::with_items(
        app,
        "Actions",
        true,
        &[
            &pcr,
            &inverse_pcr,
            &overlap_pcr,
            &PredefinedMenuItem::separator(app)?,
            &digest,
            &PredefinedMenuItem::separator(app)?,
            &assembly,
        ],
    )
}

fn build_window_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    use tauri::menu::{PredefinedMenuItem, Submenu};

    Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )
}

fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let application = build_application_submenu(app)?;
    let file = build_file_submenu(app)?;
    let edit = build_edit_submenu(app)?;
    let view = build_view_submenu(app)?;
    let actions = build_actions_submenu(app)?;
    let window = build_window_submenu(app)?;
    tauri::menu::Menu::with_items(app, &[&application, &file, &edit, &view, &actions, &window])
}

fn native_menu_item<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Option<tauri::menu::MenuItemKind<R>> {
    let menu = app.menu()?;
    for item in menu.items().ok()? {
        if item.id().as_ref() == id {
            return Some(item);
        }
        if let Some(submenu) = item.as_submenu()
            && let Some(child) = submenu.get(id)
        {
            return Some(child);
        }
    }
    None
}

fn set_native_menu_enabled<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    let item = native_menu_item(app, id).ok_or_else(|| format!("Menu item {id} was not found"))?;
    match item {
        tauri::menu::MenuItemKind::MenuItem(item) => item.set_enabled(enabled),
        tauri::menu::MenuItemKind::Check(item) => item.set_enabled(enabled),
        _ => return Err(format!("Menu item {id} cannot be enabled or disabled")),
    }
    .map_err(|error| error.to_string())
}

fn set_native_menu_checked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    checked: bool,
) -> Result<(), String> {
    let item = native_menu_item(app, id).ok_or_else(|| format!("Menu item {id} was not found"))?;
    item.as_check_menuitem()
        .ok_or_else(|| format!("Menu item {id} is not checkable"))?
        .set_checked(checked)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects owned command arguments.
fn update_native_menu_state(app: tauri::AppHandle, state: NativeMenuState) -> Result<(), String> {
    let NativeMenuState {
        enabled,
        active_view,
    } = state;
    let enabled: HashSet<String> = enabled.into_iter().collect();
    for id in [
        "file.new",
        "file.open",
        "file.open-folder",
        "file.save",
        "file.save-as",
        "file.close",
        "edit.undo-document",
        "edit.redo-document",
        "view.command-palette",
        "actions.pcr",
        "actions.inverse-pcr",
        "actions.overlap-pcr",
        "actions.restriction-digest",
    ] {
        set_native_menu_enabled(&app, id, enabled.contains(id))?;
    }

    for view in ["map", "sequence", "features", "primers", "history"] {
        let id = format!("view.{view}");
        set_native_menu_enabled(&app, &id, enabled.contains(&id))?;
        set_native_menu_checked(&app, &id, active_view.as_deref() == Some(view))?;
    }
    Ok(())
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
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "file.quit" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            } else if id.starts_with("file.")
                || id.starts_with("edit.")
                || id.starts_with("view.")
                || id.starts_with("actions.")
            {
                let _ = app.emit("dotdna-menu", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            resolve_save_path,
            scan_project_folder,
            create_document,
            import_sequence,
            simulate_pcr_product,
            simulate_restriction_digest,
            analyze_document_primers,
            analyze_open_reading_frames,
            translate_selected_open_reading_frame,
            find_sequence,
            replace_document_sequence,
            apply_document_mutation,
            update_native_menu_state
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
    fn project_folder_scan_is_bounded_sorted_and_does_not_follow_symlinks() {
        static NEXT_PROJECT_SCAN: AtomicU64 = AtomicU64::new(0);
        let nonce = NEXT_PROJECT_SCAN.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "dotdna-project-scan-{}-{nonce}",
            std::process::id()
        ));
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("zeta.dna"), b"not parsed during scan").unwrap();
        std::fs::write(nested.join("alpha.gbk"), b"not parsed during scan").unwrap();
        std::fs::write(root.join("notes.md"), b"ignored").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/hidden.fasta"), b"ignored").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, nested.join("cycle")).unwrap();

        let result = scan_project_folder_blocking(&root).unwrap();
        assert!(!result.truncated);
        assert!(result.warnings.is_empty());
        assert_eq!(result.files.len(), 2);
        assert_eq!(
            result.files[0].relative_path,
            PathBuf::from("nested/alpha.gbk")
        );
        assert_eq!(result.files[1].relative_path, PathBuf::from("zeta.dna"));

        std::fs::remove_dir_all(root).unwrap();
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
    fn native_boundary_returns_revision_keyed_digest_fragments() {
        let mut document =
            SequenceDocument::new("digest-template.dna", "AAAAGAATTCCCCCGGATCCAAAA").unwrap();
        document.topology = Topology::Linear;
        let result = simulate_restriction_digest_blocking(DigestCommandRequest {
            template_id: "document-7".to_owned(),
            template_revision: 12,
            document,
            enzyme_names: vec!["EcoRI".to_owned(), "BamHI".to_owned()],
        })
        .unwrap();

        assert_eq!(result.template_id, "document-7");
        assert_eq!(result.template_revision, 12);
        assert_eq!(result.cuts.len(), 2);
        assert_eq!(result.fragments.len(), 3);
        assert!(result.fragments.iter().all(|fragment| {
            fragment.document.document.topology == Topology::Linear
                && fragment.document.document.validate().is_empty()
        }));
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

    fn test_feature() -> Feature {
        Feature {
            id: Some("feature-1".to_owned()),
            name: "promoter".to_owned(),
            kind: "promoter".to_owned(),
            color: Some("#5cc8d7".to_owned()),
            strand: dotdna_core::Strand::Forward,
            segments: vec![dotdna_core::FeatureSegment {
                span: dotdna_core::SequenceSpan::new(1, 5),
                color: None,
                name: None,
                kind: None,
            }],
            qualifiers: Vec::new(),
            reading_frame: None,
        }
    }

    fn test_primer() -> Primer {
        Primer {
            id: Some("primer-1".to_owned()),
            name: "forward".to_owned(),
            sequence: "GGATCCACGT".to_owned(),
            binding_length: Some(4),
            description: Some("tail plus binding".to_owned()),
            color: Some("#79d6e5".to_owned()),
            phosphorylated: false,
            binding_sites: vec![dotdna_core::PrimerBindingSite {
                span: dotdna_core::SequenceSpan::new(2, 6),
                strand: dotdna_core::Strand::Forward,
            }],
        }
    }

    #[test]
    fn native_boundary_applies_atomic_feature_mutations_and_rejects_stale_targets() {
        let document = SequenceDocument::new("edit", "AACGTACGTT").unwrap();
        let created = apply_document_mutation_blocking(DocumentMutationRequest {
            document,
            mutation: DocumentMutation::CreateFeature {
                feature: test_feature(),
            },
        })
        .unwrap();
        assert!(created.changed);
        assert_eq!(created.entity_index, Some(0));
        assert_eq!(created.summary.document.history.len(), 1);

        let stale = apply_document_mutation_blocking(DocumentMutationRequest {
            document: created.summary.document,
            mutation: DocumentMutation::ReplaceFeature {
                index: 0,
                expected: Feature {
                    name: "stale".to_owned(),
                    ..test_feature()
                },
                replacement: test_feature(),
            },
        });
        assert!(stale.unwrap_err().contains("changed before"));
    }

    #[test]
    fn native_boundary_clears_stale_primer_sites_when_binding_changes() {
        let mut document = SequenceDocument::new("edit", "AACGTACGTT").unwrap();
        document.primers.push(test_primer());
        let expected = document.primers[0].clone();
        let mut replacement = expected.clone();
        replacement.sequence = "TTTTACGT".to_owned();
        let result = apply_document_mutation_blocking(DocumentMutationRequest {
            document,
            mutation: DocumentMutation::ReplacePrimer {
                index: 0,
                expected,
                replacement,
            },
        })
        .unwrap();
        assert!(result.summary.document.primers[0].binding_sites.is_empty());
        assert_eq!(
            result.summary.document.history.last().unwrap().operation,
            dotdna_core::HistoryOperation::Primer
        );
    }

    #[test]
    fn native_boundary_saves_an_atomic_dotdna_project() {
        let path = std::env::temp_dir().join(format!(
            "dotdna-save-test-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("worker")
        ));
        let _ = std::fs::remove_file(&path);
        let preexisting_sibling = path.with_extension("json.tmp");
        std::fs::write(&preexisting_sibling, "keep me").unwrap();
        let document = SequenceDocument::new("saved molecule", "ACGTACGT").unwrap();
        let result = write_document(&path, document, None, true).unwrap();
        assert_eq!(result.format, "DOTDNA Project");
        assert_eq!(result.path, Some(std::fs::canonicalize(&path).unwrap()));
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("\"format\": \"dotdna-project\""));
        assert_eq!(
            std::fs::read_to_string(&preexisting_sibling).unwrap(),
            "keep me"
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(preexisting_sibling).unwrap();
    }

    #[test]
    fn native_boundary_rejects_saving_over_an_externally_changed_project() {
        let path = std::env::temp_dir().join(format!(
            "dotdna-conflict-test-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("worker")
        ));
        let _ = std::fs::remove_file(&path);
        let original = SequenceDocument::new("original", "AAAACCCC").unwrap();
        let saved = write_document(&path, original, None, true).unwrap();
        let expected_version = saved.file_version.unwrap();
        std::fs::write(&path, "external replacement").unwrap();

        let edited = SequenceDocument::new("edited", "AAAAGGGG").unwrap();
        let error = write_document(&path, edited, Some(&expected_version), false).unwrap_err();
        assert!(error.contains("changed on disk"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "external replacement"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn native_boundary_does_not_clobber_a_new_save_as_destination() {
        let path = std::env::temp_dir().join(format!(
            "dotdna-save-as-claim-test-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("worker")
        ));
        let _ = std::fs::remove_file(&path);
        let resolution = resolve_save_path_blocking(&path).unwrap();
        assert!(resolution.file_version.is_none());
        std::fs::write(&path, "created by another process").unwrap();

        let document = SequenceDocument::new("new", "ACGTACGT").unwrap();
        let error = write_document(&path, document, None, true).unwrap_err();
        assert!(error.contains("created the Save As destination"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "created by another process"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn native_boundary_serializes_competing_project_saves() {
        let path = std::env::temp_dir().join(format!(
            "dotdna-concurrent-save-test-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("worker")
        ));
        let _ = std::fs::remove_file(&path);
        let initial = SequenceDocument::new("initial", "AAAACCCC").unwrap();
        let version = write_document(&path, initial, None, true)
            .unwrap()
            .file_version
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = ["AAAAGGGG", "AAAATTTT"]
            .into_iter()
            .map(|sequence| {
                let path = path.clone();
                let version = version.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let document = SequenceDocument::new("worker", sequence).unwrap();
                    barrier.wait();
                    write_document(&path, document, Some(&version), false)
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn native_boundary_creates_unsaved_circular_documents() {
        let result = create_document_blocking(&CreateDocumentRequest {
            name: "  New plasmid  ".to_owned(),
            sequence: "ac gt\nNN".to_owned(),
            circular: true,
        })
        .unwrap();
        assert_eq!(result.document.name, "New plasmid");
        assert_eq!(result.document.sequence, "ACGTNN");
        assert_eq!(result.document.topology, Topology::Circular);
        assert_eq!(result.format, "Unsaved DNA");
        assert!(result.path.is_none());
    }

    #[test]
    fn native_boundary_rejects_empty_new_documents() {
        let error = create_document_blocking(&CreateDocumentRequest {
            name: "Untitled DNA".to_owned(),
            sequence: "  \n  ".to_owned(),
            circular: false,
        })
        .unwrap_err();
        assert!(error.contains("does not contain a DNA sequence"));
    }

    #[test]
    fn native_boundary_resolves_new_save_paths_against_a_canonical_parent() {
        let path = std::env::temp_dir().join("new-dotdna-project.dotdna.json");
        let _ = std::fs::remove_file(&path);
        let resolved = resolve_save_path_blocking(&path).unwrap();
        let canonical_parent = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert_eq!(resolved.path.parent(), Some(canonical_parent.as_path()));
        assert_eq!(resolved.path.file_name(), path.file_name());
        assert!(resolved.file_version.is_none());
    }
}
