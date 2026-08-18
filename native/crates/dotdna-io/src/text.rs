use dotdna_core::SequenceDocument;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{parse_dotdna_project, parse_genbank};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SequenceFormat {
    Fasta,
    GenBank,
    PlainDna,
    DotDnaProject,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportedDocument {
    pub format: SequenceFormat,
    pub document: SequenceDocument,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum TextImportError {
    #[error("paste or choose a sequence first")]
    Empty,
    #[error("no DNA sequence was found after the FASTA header")]
    EmptyFasta,
    #[error("the sequence document is invalid: {0}")]
    InvalidSequence(String),
    #[error("the GenBank document is invalid: {0}")]
    InvalidGenBank(String),
    #[error("the DOTDNA project is invalid: {0}")]
    InvalidProject(String),
}

/// Parses FASTA, `GenBank`, portable `DOTDNA` projects, or plain DNA.
///
/// # Errors
///
/// Returns an explicit import error when the input is empty or contains no DNA.
pub fn parse_text_document(name: &str, text: &str) -> Result<ImportedDocument, TextImportError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(TextImportError::Empty);
    }

    if trimmed.starts_with('{') {
        return parse_dotdna_project(trimmed)
            .map(|document| ImportedDocument {
                format: SequenceFormat::DotDnaProject,
                document,
            })
            .map_err(|error| TextImportError::InvalidProject(error.to_string()));
    }

    if trimmed.lines().any(|line| line.starts_with("LOCUS"))
        && trimmed.lines().any(|line| line.starts_with("ORIGIN"))
    {
        return parse_genbank(name, trimmed)
            .map(|document| ImportedDocument {
                format: SequenceFormat::GenBank,
                document,
            })
            .map_err(|error| TextImportError::InvalidGenBank(error.to_string()));
    }

    if trimmed.starts_with('>') {
        let mut lines = trimmed.lines();
        let title = lines
            .next()
            .map(|line| line.trim_start_matches('>').trim())
            .filter(|title| !title.is_empty())
            .unwrap_or("sequence");
        let sequence = lines
            .filter(|line| !line.trim_start().starts_with(';'))
            .collect::<String>();
        let mut document =
            SequenceDocument::new(if name.is_empty() { title } else { name }, &sequence)
                .map_err(|_| TextImportError::EmptyFasta)?;
        document.notes.description = Some(title.to_owned());
        return Ok(ImportedDocument {
            format: SequenceFormat::Fasta,
            document,
        });
    }

    SequenceDocument::new(
        if name.is_empty() {
            "pasted-sequence.dna"
        } else {
            name
        },
        trimmed,
    )
    .map(|document| ImportedDocument {
        format: SequenceFormat::PlainDna,
        document,
    })
    .map_err(|error| TextImportError::InvalidSequence(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_fasta() {
        let imported = parse_text_document("", ">pUC fragment\nACGT NNNN\n").unwrap();
        assert_eq!(imported.format, SequenceFormat::Fasta);
        assert_eq!(imported.document.name, "pUC fragment");
        assert_eq!(imported.document.sequence, "ACGTNNNN");
    }

    #[test]
    fn imports_plain_dna() {
        let imported = parse_text_document("raw.dna", "acgt nn\nacgt").unwrap();
        assert_eq!(imported.format, SequenceFormat::PlainDna);
        assert_eq!(imported.document.sequence, "ACGTNNACGT");
    }

    #[test]
    fn rejects_empty_input() {
        assert_eq!(parse_text_document("", "   "), Err(TextImportError::Empty));
    }
}
