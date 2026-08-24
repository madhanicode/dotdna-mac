"use client";

import { ChangeEvent, DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddgeneAnnotations } from "./AddgeneAnnotations";
import { AnalysisPanels } from "./AnalysisPanels";
import { DesignVerifyTools } from "./DesignVerifyTools";
import { DocumentInspector } from "./DocumentInspector";
import { MolecularTools } from "./MolecularTools";
import { acknowledgeOrfAnnotation, createOrfCdsFeature, detachOrfAnnotation, isOrfAnnotationStale } from "./orf-annotations";
import { PlasmidMap } from "./PlasmidMap";
import { SequenceEditor } from "./SequenceEditor";
import type { AssemblyResult } from "./design-tools";
import { applySequenceEdit, SequenceEdit } from "./sequence-edit";
import { parseTextSequence, toDotDnaProject, toGenBank } from "./sequence-formats";
import { findOpenReadingFrames } from "./sequence-analysis";
import type { OpenReadingFrame } from "./sequence-analysis";
import { createSequenceData, parseSnapGene, SnapGeneData, SnapGeneFeature, SnapGenePrimer, toFasta, updateSequenceData } from "./snapgene";
import {
  clearWorkspaceRecovery,
  createWorkspaceRecovery,
  DEFAULT_WORKSPACE_UI_STATE,
  loadWorkspaceRecoveries,
  mergeWorkspaceRecovery,
  saveWorkspaceRecovery,
} from "./workspace-recovery";
import type { RecoveryAnnotation, RecoveryHistoryEntry, RecoverySnapshot, WorkspaceRecoveryRecord, WorkspaceUiState } from "./workspace-recovery";

const numberFormatter = new Intl.NumberFormat("en-US");

type DisplayAnnotation = RecoveryAnnotation;
type HistoryEntry = RecoveryHistoryEntry;
type WorkspaceSnapshot = RecoverySnapshot;

type RecoveryStatus = "loading" | "idle" | "restored" | "saving" | "saved" | "error";
function coordinates(range: string | null) {
  const match = range?.match(/(\d+)\s*-\s*(\d+)/);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

function localSaveTime(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const autosaveEnabledRef = useRef(false);
  const saveGenerationRef = useRef(0);
  const workspaceRevisionRef = useRef(0);
  const [data, setData] = useState<SnapGeneData | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [motif, setMotif] = useState("");
  const [customAnnotations, setCustomAnnotations] = useState<DisplayAnnotation[]>([]);
  const [showAnnotationForm, setShowAnnotationForm] = useState(false);
  const [annotationName, setAnnotationName] = useState("");
  const [annotationStart, setAnnotationStart] = useState("1");
  const [annotationEnd, setAnnotationEnd] = useState("");
  const [annotationType, setAnnotationType] = useState("misc_feature");
  const [annotationColor, setAnnotationColor] = useState("#17b6c9");
  const [annotationError, setAnnotationError] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [showPasteImport, setShowPasteImport] = useState(false);
  const [pastedName, setPastedName] = useState("pasted-sequence.dna");
  const [pastedSequence, setPastedSequence] = useState("");
  const [pastedCircular, setPastedCircular] = useState(false);
  const [importFormat, setImportFormat] = useState("SnapGene");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [undoStack, setUndoStack] = useState<WorkspaceSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<WorkspaceSnapshot[]>([]);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>("loading");
  const [recoveredAt, setRecoveredAt] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [workspaceUi, setWorkspaceUi] = useState<WorkspaceUiState>(() => structuredClone(DEFAULT_WORKSPACE_UI_STATE));
  const [recoveryRecords, setRecoveryRecords] = useState<WorkspaceRecoveryRecord[]>([]);
  const [showRecoveryHistory, setShowRecoveryHistory] = useState(false);

  const applyRecoveryRecord = useCallback((record: WorkspaceRecoveryRecord) => {
    const workspace = record.workspace;
    setData(workspace.data);
    setFileName(workspace.fileName);
    setImportFormat(workspace.importFormat);
    setMotif(workspace.motif);
    setCustomAnnotations(workspace.customAnnotations);
    setHistory(workspace.history);
    setUndoStack(workspace.undoStack);
    setRedoStack(workspace.redoStack);
    setWorkspaceUi(workspace.ui);
    setRecoveredAt(record.savedAt);
    setLastSavedAt(record.savedAt);
    setRecoveryStatus("restored");
    window.setTimeout(() => window.scrollTo({ top: workspace.ui.windowScrollY, behavior: "auto" }), 0);
  }, []);

  const updateSequenceNavigation = useCallback((navigation: Pick<WorkspaceUiState, "selection" | "caret">) => {
    setWorkspaceUi((current) => current.selection?.start === navigation.selection?.start
      && current.selection?.end === navigation.selection?.end
      && current.caret === navigation.caret
      ? current
      : { ...current, ...navigation });
  }, []);

  const updateSequenceScroll = useCallback((sequenceScrollTop: number) => {
    setWorkspaceUi((current) => current.sequenceScrollTop === sequenceScrollTop ? current : { ...current, sequenceScrollTop });
  }, []);

  useEffect(() => {
    let active = true;
    const startingRevision = workspaceRevisionRef.current;
    void loadWorkspaceRecoveries().then((records) => {
      if (!active || workspaceRevisionRef.current !== startingRevision) return;
      setRecoveryRecords(records);
      const record = records[0];
      if (record) {
        applyRecoveryRecord(record);
      } else {
        setRecoveryStatus("idle");
      }
      autosaveEnabledRef.current = true;
      setRecoveryReady(true);
    }).catch(() => {
      if (!active) return;
      autosaveEnabledRef.current = true;
      setRecoveryReady(true);
      setRecoveryStatus("error");
    });
    return () => { active = false; };
  }, [applyRecoveryRecord]);

  useEffect(() => {
    if (!recoveryReady || !autosaveEnabledRef.current || !data || !fileName) return;
    const generation = ++saveGenerationRef.current;
    const record = createWorkspaceRecovery({
      data,
      fileName,
      importFormat,
      motif,
      customAnnotations,
      history,
      undoStack,
      redoStack,
      ui: workspaceUi,
    });
    setRecoveryStatus("saving");
    void saveWorkspaceRecovery(record).then(() => {
      if (saveGenerationRef.current !== generation) return;
      setLastSavedAt(record.savedAt);
      setRecoveryRecords((current) => mergeWorkspaceRecovery(current, record));
      setRecoveryStatus("saved");
    }).catch(() => {
      if (saveGenerationRef.current === generation) setRecoveryStatus("error");
    });
  }, [recoveryReady, data, fileName, importFormat, motif, customAnnotations, history, undoStack, redoStack, workspaceUi]);

  useEffect(() => {
    if (!data) return;
    let timeout = 0;
    const rememberScroll = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        setWorkspaceUi((current) => current.windowScrollY === window.scrollY ? current : { ...current, windowScrollY: window.scrollY });
      }, 350);
    };
    window.addEventListener("scroll", rememberScroll, { passive: true });
    return () => { window.removeEventListener("scroll", rememberScroll); window.clearTimeout(timeout); };
  }, [data]);

  const annotations = useMemo<DisplayAnnotation[]>(
    () => [
      ...(data?.features ?? []).map((feature, index) => ({
        ...feature,
        id: `file-${index}`,
        isCustom: false,
      })),
      ...customAnnotations,
    ],
    [data, customAnnotations],
  );
  const sortedAnnotations = useMemo(() => [...annotations].sort((left, right) => {
    const leftPosition = coordinates(left.range);
    const rightPosition = coordinates(right.range);
    const key = workspaceUi.annotationSort.key;
    let comparison = 0;
    if (key === "name") comparison = left.name.localeCompare(right.name);
    if (key === "type") comparison = left.type.localeCompare(right.type);
    if (key === "start") comparison = (leftPosition?.start ?? Number.MAX_SAFE_INTEGER) - (rightPosition?.start ?? Number.MAX_SAFE_INTEGER);
    if (key === "length") comparison = ((leftPosition?.end ?? 0) - (leftPosition?.start ?? 0)) - ((rightPosition?.end ?? 0) - (rightPosition?.start ?? 0));
    return (workspaceUi.annotationSort.direction === "asc" ? comparison : -comparison) || left.name.localeCompare(right.name);
  }), [annotations, workspaceUi.annotationSort]);

  function navigateToRange(start: number, end: number) {
    if (!data) return;
    const selection = {
      start: Math.max(1, Math.min(data.length, Math.min(start, end))),
      end: Math.max(1, Math.min(data.length, Math.max(start, end))),
    };
    setWorkspaceUi((current) => ({ ...current, workspaceView: "split", selection, caret: Math.min(data.length + 1, selection.end + 1) }));
    window.setTimeout(() => document.querySelector("#sequence")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }

  function loadWorkspace(nextData: SnapGeneData, nextName: string, format: string) {
    workspaceRevisionRef.current += 1;
    autosaveEnabledRef.current = true;
    setData(nextData);
    setFileName(nextName);
    setImportFormat(format);
    setMotif("");
    setCustomAnnotations([]);
    setShowAnnotationForm(false);
    setEditingAnnotationId(null);
    setAnnotationError("");
    setHistory([]);
    setUndoStack([]);
    setRedoStack([]);
    setWorkspaceUi(structuredClone(DEFAULT_WORKSPACE_UI_STATE));
    setShowPasteImport(false);
    setPastedSequence("");
    setRecoveredAt(null);
  }

  async function discardRecoveryData() {
    const confirmed = window.confirm("Discard this project and delete its on-device recovery data? Exported files will not be affected.");
    if (!confirmed) return;
    workspaceRevisionRef.current += 1;
    autosaveEnabledRef.current = false;
    saveGenerationRef.current += 1;
    try {
      await clearWorkspaceRecovery();
      setData(null);
      setFileName("");
      setError("");
      setMotif("");
      setCustomAnnotations([]);
      setHistory([]);
      setUndoStack([]);
      setRedoStack([]);
      setWorkspaceUi(structuredClone(DEFAULT_WORKSPACE_UI_STATE));
      setRecoveryRecords([]);
      setShowRecoveryHistory(false);
      setRecoveredAt(null);
      setLastSavedAt(null);
      setRecoveryStatus("idle");
    } catch {
      autosaveEnabledRef.current = true;
      setRecoveryStatus("error");
    }
  }

  function restoreRecoveryRecord(record: WorkspaceRecoveryRecord) {
    if (record.savedAt === recoveredAt || window.confirm(`Replace the open workspace with the ${localSaveTime(record.savedAt)} recovery snapshot?`)) {
      workspaceRevisionRef.current += 1;
      autosaveEnabledRef.current = true;
      applyRecoveryRecord(record);
      setShowRecoveryHistory(false);
    }
  }

  async function deleteRecoveryRecord(record: WorkspaceRecoveryRecord) {
    if (!window.confirm(`Delete the ${localSaveTime(record.savedAt)} recovery snapshot from this device?`)) return;
    try {
      await clearWorkspaceRecovery(record.savedAt);
      setRecoveryRecords((current) => current.filter(({ savedAt }) => savedAt !== record.savedAt));
    } catch {
      setRecoveryStatus("error");
    }
  }

  function currentSnapshot(): WorkspaceSnapshot | null {
    return data ? { data, customAnnotations, history } : null;
  }

  function commitWorkspace(nextData: SnapGeneData, nextCustomAnnotations: DisplayAnnotation[], description: string) {
    const snapshot = currentSnapshot();
    if (snapshot) setUndoStack((current) => [...current, snapshot]);
    setRedoStack([]);
    setData(nextData);
    setCustomAnnotations(nextCustomAnnotations);
    setHistory((current) => [...current, { description, timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
  }

  function undo() {
    const previous = undoStack.at(-1);
    const snapshot = currentSnapshot();
    if (!previous || !snapshot) return;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, snapshot]);
    setData(previous.data);
    setCustomAnnotations(previous.customAnnotations);
    setHistory(previous.history);
  }

  function redo() {
    const next = redoStack.at(-1);
    const snapshot = currentSnapshot();
    if (!next || !snapshot) return;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, snapshot]);
    setData(next.data);
    setCustomAnnotations(next.customAnnotations);
    setHistory(next.history);
  }

  function applyEdit(edit: SequenceEdit) {
    if (!data) return;
    const fileResult = applySequenceEdit(data.sequence, data.features, edit);
    const customResult = applySequenceEdit(data.sequence, customAnnotations, edit);
    const nextCustom = customResult.features as DisplayAnnotation[];
    commitWorkspace(updateSequenceData(data, fileResult.sequence, { features: fileResult.features }), nextCustom, fileResult.description);
  }

  function changeTopology(circular: boolean) {
    if (!data || data.circular === circular) return;
    commitWorkspace(updateSequenceData(data, data.sequence, { circular }), customAnnotations, circular ? "Circularized the sequence" : "Linearized the sequence");
  }

  function changePrimers(primers: SnapGenePrimer[], description: string) {
    if (!data) return;
    commitWorkspace(updateSequenceData(data, data.sequence, { primers }), customAnnotations, description);
  }

  function importAddgeneAnnotations(features: SnapGeneFeature[], source: string) {
    if (!data) return;
    const existing = new Set(annotations.map((feature) => `${feature.type}\u0000${feature.name}\u0000${feature.range}\u0000${feature.strand}`));
    const imported = features
      .filter((feature) => feature.type.toLowerCase() !== "source")
      .filter((feature) => {
        const fingerprint = `${feature.type}\u0000${feature.name}\u0000${feature.range}\u0000${feature.strand}`;
        if (existing.has(fingerprint)) return false;
        existing.add(fingerprint);
        return true;
      })
      .map((feature, index): DisplayAnnotation => ({ ...feature, id: `addgene-${Date.now()}-${index}`, isCustom: true }));
    if (!imported.length) {
      setAnnotationError("All transferable Addgene annotations are already present in this workspace.");
      return;
    }
    commitWorkspace(data, [...customAnnotations, ...imported], `Imported ${imported.length} annotations from ${source}`);
    setAnnotationError("");
  }

  function createCdsFromOrf(orf: OpenReadingFrame) {
    if (!data) return;
    const feature = createOrfCdsFeature(orf, data.length, data.sequence, {
      minimumAminoAcids: workspaceUi.analysis.minimumAminoAcids,
      startMode: workspaceUi.analysis.startMode,
    });
    const annotation: DisplayAnnotation = {
      ...feature,
      id: `orf-${orf.id}-${Date.now()}`,
      isCustom: true,
    };
    commitWorkspace(data, [...customAnnotations, annotation], `Created CDS annotation from ORF frame ${orf.frame > 0 ? "+" : ""}${orf.frame}`);
  }

  function replaceAnnotation(feature: DisplayAnnotation, replacement: DisplayAnnotation, description: string) {
    if (!data) return;
    if (feature.isCustom) {
      commitWorkspace(data, customAnnotations.map((item) => item.id === feature.id ? replacement : item), description);
      return;
    }
    const fileIndex = Number(feature.id.replace("file-", ""));
    commitWorkspace(updateSequenceData(data, data.sequence, { features: data.features.map((item, index) => index === fileIndex ? replacement : item) }), customAnnotations, description);
  }

  function refreshOrfAnnotation(feature: DisplayAnnotation) {
    if (!data) return;
    const position = coordinates(feature.range);
    const candidates = findOpenReadingFrames(data.sequence, {
      circular: data.circular,
      minAminoAcids: workspaceUi.analysis.minimumAminoAcids,
      startMode: workspaceUi.analysis.startMode,
    }).filter(({ strand }) => strand === feature.strand);
    const closest = candidates.sort((left, right) => {
      const leftDistance = Math.abs(left.start - (position?.start ?? left.start)) + Math.abs(left.end - (position?.end ?? left.end));
      const rightDistance = Math.abs(right.start - (position?.start ?? right.start)) + Math.abs(right.end - (position?.end ?? right.end));
      return leftDistance - rightDistance;
    })[0];
    if (!closest) {
      setAnnotationError("No current ORF on this strand meets the finder settings. Keep or detach the annotation instead.");
      return;
    }
    const refreshed = createOrfCdsFeature(closest, data.length, data.sequence, {
      minimumAminoAcids: workspaceUi.analysis.minimumAminoAcids,
      startMode: workspaceUi.analysis.startMode,
    });
    replaceAnnotation(feature, { ...refreshed, id: feature.id, isCustom: feature.isCustom }, `Refreshed ORF annotation ${feature.name}`);
  }

  function keepOrfAnnotation(feature: DisplayAnnotation) {
    if (!data) return;
    replaceAnnotation(feature, { ...acknowledgeOrfAnnotation(feature, data.sequence), id: feature.id, isCustom: feature.isCustom }, `Reviewed ORF annotation ${feature.name}`);
  }

  function detachOrfPrediction(feature: DisplayAnnotation) {
    replaceAnnotation(feature, { ...detachOrfAnnotation(feature), id: feature.id, isCustom: feature.isCustom }, `Detached ${feature.name} from its ORF prediction`);
  }

  function openAssemblyProduct(result: AssemblyResult, name: string) {
    const safeName = `${name.trim() || "assembly"}.dna`;
    loadWorkspace(createSequenceData(result.sequence, { circular: result.circular, features: result.features }), safeName, "DOTDNA Assembly");
    window.setTimeout(() => document.querySelector("#map")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function readFile(file?: File) {
    if (!file) return;
    setError("");
    setCopied(false);

    try {
      const buffer = await file.arrayBuffer();
      try {
        const parsed = parseSnapGene(buffer);
        loadWorkspace(parsed, file.name, "SnapGene");
      } catch {
        const imported = parseTextSequence(file.name, new TextDecoder().decode(buffer));
        loadWorkspace(imported.data, imported.name || file.name, imported.format);
      }
    } catch (caught) {
      setData(null);
      setFileName("");
      setError(caught instanceof Error ? caught.message : "I couldn’t read that file.");
    }
  }

  function importPastedSequence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const imported = parseTextSequence(pastedName.trim() || "pasted-sequence.dna", pastedSequence);
      const nextData = imported.format === "Plain DNA" || imported.format === "FASTA"
        ? updateSequenceData(imported.data, imported.data.sequence, { circular: pastedCircular })
        : imported.data;
      loadWorkspace(nextData, imported.name, imported.format);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "I couldn’t read that sequence.");
    }
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    void readFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void readFile(event.dataTransfer.files?.[0]);
  }

  async function copySequence() {
    if (!data) return;
    await navigator.clipboard.writeText(data.sequence);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadText(name: string, contents: string, type = "text/plain;charset=utf-8") {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadFasta() {
    if (!data) return;
    downloadText(fileName.replace(/\.[^.]+$/i, "") + ".fasta", toFasta(fileName, data.sequence));
  }

  function downloadGenBank() {
    if (!data) return;
    downloadText(fileName.replace(/\.[^.]+$/i, "") + ".gb", toGenBank(fileName, data, annotations));
  }

  function downloadProject() {
    if (!data) return;
    downloadText(fileName.replace(/\.[^.]+$/i, "") + ".dotdna.json", toDotDnaProject(fileName, data, annotations), "application/json;charset=utf-8");
  }

  function addAnnotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;

    const name = annotationName.trim();
    const start = Number(annotationStart);
    const end = Number(annotationEnd);

    if (!name) {
      setAnnotationError("Give the annotation a name.");
      return;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > data.length) {
      setAnnotationError(`Use a valid range between 1 and ${numberFormatter.format(data.length)}.`);
      return;
    }

    const existing = editingAnnotationId ? annotations.find(({ id }) => id === editingAnnotationId) : null;
    const annotation: DisplayAnnotation = {
      ...(existing ?? {} as DisplayAnnotation),
      id: existing?.id ?? `added-${Date.now()}`,
      isCustom: existing?.isCustom ?? true,
      name,
      type: annotationType.trim() || "misc_feature",
      range: `${start}-${end}`,
      color: annotationColor,
      directionality: 1,
      strand: "+",
      segments: [{ range: `${start}-${end}`, start, end, color: annotationColor, name: null, type: "standard" }],
      qualifiers: [],
      readingFrame: null,
    };
    if (existing && !existing.isCustom) {
      const fileIndex = Number(existing.id.replace("file-", ""));
      const nextFeatures = data.features.map((feature, index) => index === fileIndex ? annotation : feature);
      commitWorkspace(updateSequenceData(data, data.sequence, { features: nextFeatures }), customAnnotations, `Edited annotation ${name}`);
    } else if (existing) {
      commitWorkspace(data, customAnnotations.map((feature) => feature.id === existing.id ? annotation : feature), `Edited annotation ${name}`);
    } else {
      commitWorkspace(data, [...customAnnotations, annotation], `Added annotation ${name}`);
    }
    setAnnotationName("");
    setAnnotationStart("1");
    setAnnotationEnd("");
    setAnnotationError("");
    setShowAnnotationForm(false);
    setEditingAnnotationId(null);
  }

  function saveInlineAnnotation(featureIndex: number | null, draft: { name: string; type: string; color: string; start: number; end: number }) {
    if (!data) return;
    const existing = featureIndex === null ? null : annotations[featureIndex];
    const range = `${draft.start}-${draft.end}`;
    const annotation: DisplayAnnotation = {
      ...(existing ?? {} as DisplayAnnotation),
      id: existing?.id ?? `added-${Date.now()}`,
      isCustom: existing?.isCustom ?? true,
      name: draft.name,
      type: draft.type,
      range,
      color: draft.color,
      directionality: existing?.directionality ?? 1,
      strand: existing?.strand ?? "+",
      segments: [{ range, start: draft.start, end: draft.end, color: draft.color, name: null, type: "standard" }],
      qualifiers: existing?.qualifiers ?? [],
      readingFrame: existing?.readingFrame ?? null,
    };
    if (existing && !existing.isCustom) {
      const fileIndex = Number(existing.id.replace("file-", ""));
      commitWorkspace(updateSequenceData(data, data.sequence, { features: data.features.map((feature, index) => index === fileIndex ? annotation : feature) }), customAnnotations, `Edited annotation ${draft.name}`);
    } else if (existing) {
      commitWorkspace(data, customAnnotations.map((feature) => feature.id === existing.id ? annotation : feature), `Edited annotation ${draft.name}`);
    } else {
      commitWorkspace(data, [...customAnnotations, annotation], `Added annotation ${draft.name}`);
    }
  }

  function removeAnnotation(feature: DisplayAnnotation) {
    if (!data) return;
    if (feature.isCustom) {
      commitWorkspace(data, customAnnotations.filter((item) => item.id !== feature.id), `Removed annotation ${feature.name}`);
      return;
    }
    const fileIndex = Number(feature.id.replace("file-", ""));
    commitWorkspace(updateSequenceData(data, data.sequence, { features: data.features.filter((_, index) => index !== fileIndex) }), customAnnotations, `Removed annotation ${feature.name}`);
  }

  return (
    <main id="top">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="DOTDNA home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          DOTDNA
        </a>
        <span className="privacy-note"><span />Stays on your device</span>
      </header>

      {!data && <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Local-first plasmid workspace</p>
          <h1>Your plasmids,<br /><em>ready to work.</em></h1>
          <p className="lede">
            Open SnapGene, GenBank, FASTA, DOTDNA projects, or paste raw DNA. Map, edit,
            annotate, design primers, assemble fragments, verify alignments, simulate PCR and digests,
            translate, and export—all locally.
          </p>
          <div className="hero-proof" aria-label="Product benefits">
            <span>No account</span>
            <span>No upload</span>
            <span>No fuss</span>
          </div>
        </div>

        <div
          className={`drop-card ${isDragging ? "is-dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <div className="corner-label">01 / OPEN</div>
          {showPasteImport ? (
            <form className="paste-import-form" onSubmit={importPastedSequence}>
              <div className="paste-form-heading"><div><span>PASTE OR IMPORT TEXT</span><h2>Start from sequence text</h2></div><button type="button" onClick={() => { setShowPasteImport(false); setError(""); }} aria-label="Close pasted sequence form">×</button></div>
              <label><span>Document name</span><input value={pastedName} onChange={(event) => setPastedName(event.target.value)} /></label>
              <label><span>DNA, FASTA, GenBank, or DOTDNA project</span><textarea value={pastedSequence} onChange={(event) => setPastedSequence(event.target.value)} placeholder=">my_sequence&#10;ACGT…" spellCheck={false} autoFocus /></label>
              <label className="paste-topology"><input type="checkbox" checked={pastedCircular} onChange={(event) => setPastedCircular(event.target.checked)} /><span>Treat raw DNA or FASTA as circular</span></label>
              <button className="primary-button" type="submit">Open sequence <span aria-hidden="true">↗</span></button>
            </form>
          ) : (
            <>
              <div className="drop-icon" aria-hidden="true"><span>↓</span></div>
              <h2>{isDragging ? "Release to read" : "Drop a sequence file here"}</h2>
              <p>.dna · .gb · .fasta · .dotdna.json · text</p>
              <div className="import-actions">
                <button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>Choose file <span aria-hidden="true">↗</span></button>
                <button className="ghost-button" type="button" onClick={() => { setShowPasteImport(true); setError(""); }}>Paste sequence</button>
              </div>
              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                accept=".dna,.gb,.gbk,.genbank,.fa,.fas,.fasta,.fna,.json,.dotdna,.txt,application/octet-stream,text/plain,application/json"
                onChange={handleInput}
              />
            </>
          )}
          <div className="local-processing">
            <span className="lock-dot" aria-hidden="true" />
            Processed locally. Your sequence stays private.
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
        </div>
      </section>}

      {data ? (
        <section className="results" aria-live="polite">
          <nav className="workspace-nav" aria-label="Sequence workspace">
            <a href="#map">Map</a>
            <a href="#annotations">Annotations</a>
            <a href="#addgene">Addgene</a>
            <a href="#analysis">ORFs &amp; enzymes</a>
            <a href="#primers">Primers &amp; PCR</a>
            <a href="#design">Assemble &amp; align</a>
            <a href="#editor">Edit</a>
            <a href="#sequence">Sequence</a>
            <a href="#file-details">File details</a>
          </nav>
          {recoveredAt && (
            <div className="recovery-banner" role="status">
              <span className="recovery-banner-mark" aria-hidden="true">↻</span>
              <div>
                <strong>Recovered your last workspace</strong>
                <p>{fileName} and its edits were restored from {localSaveTime(recoveredAt)}.</p>
              </div>
              <div className="recovery-banner-actions">
                <button type="button" onClick={() => setShowRecoveryHistory((current) => !current)}>Recovery history ({recoveryRecords.length})</button>
                <button type="button" onClick={() => void discardRecoveryData()}>Discard recovery data</button>
              </div>
            </div>
          )}
          {showRecoveryHistory && (
            <section className="recovery-history" aria-labelledby="recovery-history-heading">
              <div><span className="panel-kicker">ON-DEVICE SNAPSHOTS</span><h3 id="recovery-history-heading">Recovery history</h3></div>
              <ol>
                {recoveryRecords.map((record, index) => (
                  <li key={record.savedAt}>
                    <div><strong>{record.workspace.fileName}</strong><span>{localSaveTime(record.savedAt)} · {numberFormatter.format(record.workspace.data.length)} bp · {record.workspace.history.length} edits</span></div>
                    {index === 0 && <b>Latest</b>}
                    <button type="button" onClick={() => restoreRecoveryRecord(record)}>Restore</button>
                    <button type="button" onClick={() => void deleteRecoveryRecord(record)} aria-label={`Delete recovery snapshot from ${localSaveTime(record.savedAt)}`}>×</button>
                  </li>
                ))}
              </ol>
              <p>Up to ten atomic snapshots stay on this device. Export a project for a portable copy.</p>
            </section>
          )}
          <div className="result-heading">
            <div>
              <p className="eyebrow cyan">{importFormat} workspace</p>
              <h2>{fileName}</h2>
              <p className={`autosave-status ${recoveryStatus === "error" ? "error" : ""}`} role={recoveryStatus === "error" ? "alert" : "status"}>
                <span aria-hidden="true" />
                {recoveryStatus === "saving"
                  ? "Saving on this device…"
                  : recoveryStatus === "error"
                    ? "On-device autosave is unavailable"
                    : lastSavedAt
                      ? `Saved on this device · ${localSaveTime(lastSavedAt)}`
                      : "On-device autosave ready"}
              </p>
            </div>
            <div className="result-actions">
              <button type="button" className="secondary-button" onClick={copySequence}>
                {copied ? "Copied!" : "Copy sequence"}
              </button>
              <details className="export-menu">
                <summary className="primary-button compact">Export <span aria-hidden="true">↓</span></summary>
                <div><button type="button" onClick={downloadFasta}>FASTA sequence</button><button type="button" onClick={downloadGenBank}>GenBank + annotations</button><button type="button" onClick={downloadProject}>DOTDNA project</button></div>
              </details>
              <button type="button" className="new-file-button" onClick={() => void discardRecoveryData()}>Discard autosave</button>
            </div>
          </div>

          <div className="stat-grid">
            <article><span>Length</span><strong>{numberFormatter.format(data.length)}</strong><small>base pairs</small></article>
            <article><span>GC content</span><strong>{data.gcPercent.toFixed(2)}%</strong><small>canonical bases</small></article>
            <article><span>Topology</span><strong>{data.circular ? "Circular" : "Linear"}</strong><small>{data.doubleStranded ? "double-stranded" : "single-stranded"}</small></article>
            <article><span>Features</span><strong>{annotations.length}</strong><small>{customAnnotations.length ? `${data.features.length} from file · ${customAnnotations.length} added` : "annotations found"}</small></article>
          </div>

          <section className="primary-workspace" aria-labelledby="primary-workspace-heading">
            <div className="primary-workspace-heading">
              <div>
                <span className="panel-kicker">SEQUENCE WORKSPACE</span>
                <h3 id="primary-workspace-heading">Map and bases, side by side</h3>
              </div>
              <div className="workspace-view-controls" role="group" aria-label="Workspace view">
                {(["split", "sequence", "plasmid"] as const).map((view) => (
                  <button type="button" className={workspaceUi.workspaceView === view ? "active" : ""} aria-pressed={workspaceUi.workspaceView === view} onClick={() => setWorkspaceUi((current) => ({ ...current, workspaceView: view }))} key={view}>
                    {view === "split" ? "Split" : view === "sequence" ? "Sequence" : "Plasmid"}
                  </button>
                ))}
              </div>
            </div>
            <div className={`primary-workspace-panes ${workspaceUi.workspaceView}`}>
              <div className="primary-workspace-pane sequence-pane" hidden={workspaceUi.workspaceView === "plasmid"}>
                <SequenceEditor sequence={data.sequence} circular={data.circular} features={annotations} primers={data.primers} motif={motif} canUndo={undoStack.length > 0} canRedo={redoStack.length > 0} history={history} navigation={{ selection: workspaceUi.selection, caret: workspaceUi.caret }} initialScrollTop={workspaceUi.sequenceScrollTop} onNavigationChange={updateSequenceNavigation} onScrollTopChange={updateSequenceScroll} onApply={applyEdit} onUndo={undo} onRedo={redo} onTopologyChange={changeTopology} onMotifChange={setMotif} onSaveAnnotation={saveInlineAnnotation} onRemoveAnnotation={(featureIndex) => removeAnnotation(annotations[featureIndex])} />
              </div>
              <div className="primary-workspace-pane plasmid-pane" hidden={workspaceUi.workspaceView === "sequence"}>
                <PlasmidMap fileName={fileName} sequence={data.sequence} circular={data.circular} features={annotations} selectedRange={workspaceUi.selection} onSelectRange={navigateToRange} />
              </div>
            </div>
          </section>

          <section className="annotation-section" id="annotations" aria-labelledby="annotation-heading">
            <div className="annotation-header">
              <div>
                <span className="panel-kicker">ANNOTATION MAP</span>
                <h3 id="annotation-heading">What’s on this sequence</h3>
              </div>
              <button
                type="button"
                className={showAnnotationForm ? "secondary-button" : "primary-button compact"}
                onClick={() => { const opening = !showAnnotationForm; setShowAnnotationForm(opening); setEditingAnnotationId(null); setAnnotationError(""); if (opening) { setAnnotationName(""); setAnnotationStart("1"); setAnnotationEnd(""); setAnnotationType("misc_feature"); setAnnotationColor("#17b6c9"); } }}
              >
                {showAnnotationForm ? "Cancel" : "+ Add annotation"}
              </button>
              <label className="annotation-sort-control"><span>Sort annotations</span><select value={`${workspaceUi.annotationSort.key}:${workspaceUi.annotationSort.direction}`} onChange={(event) => { const [key, direction] = event.target.value.split(":") as [WorkspaceUiState["annotationSort"]["key"], WorkspaceUiState["annotationSort"]["direction"]]; setWorkspaceUi((current) => ({ ...current, annotationSort: { key, direction } })); }}><option value="start:asc">Position ↑</option><option value="start:desc">Position ↓</option><option value="name:asc">Name A–Z</option><option value="name:desc">Name Z–A</option><option value="type:asc">Type A–Z</option><option value="length:desc">Longest first</option><option value="length:asc">Shortest first</option></select></label>
            </div>

            {showAnnotationForm && (
              <form className="annotation-form" onSubmit={addAnnotation}>
                <label className="field-wide"><span>Name</span><input value={annotationName} onChange={(event) => setAnnotationName(event.target.value)} placeholder="e.g. promoter" autoFocus /></label>
                <label><span>Start</span><input type="number" min="1" max={data.length} value={annotationStart} onChange={(event) => setAnnotationStart(event.target.value)} /></label>
                <label><span>End</span><input type="number" min="1" max={data.length} value={annotationEnd} onChange={(event) => setAnnotationEnd(event.target.value)} placeholder={String(data.length)} /></label>
                <label><span>Type</span><input value={annotationType} onChange={(event) => setAnnotationType(event.target.value)} /></label>
                <label className="color-field"><span>Color</span><input type="color" value={annotationColor} onChange={(event) => setAnnotationColor(event.target.value)} /></label>
                <button type="submit" className="primary-button compact">{editingAnnotationId ? "Update annotation" : "Save annotation"} <span aria-hidden="true">↗</span></button>
                {annotationError && <p className="annotation-error" role="alert">{annotationError}</p>}
              </form>
            )}

            {annotations.length ? (
              <div className="annotation-map">
                <div className="annotation-scale"><span>1 bp</span><span>{numberFormatter.format(Math.round(data.length / 2))}</span><span>{numberFormatter.format(data.length)} bp</span></div>
                {sortedAnnotations.map((feature) => {
                  const position = coordinates(feature.range);
                  const staleOrf = isOrfAnnotationStale(feature, data.sequence);
                  const left = position ? ((position.start - 1) / data.length) * 100 : 0;
                  const width = position ? ((position.end - position.start + 1) / data.length) * 100 : 0;
                  return (
                    <div className="annotation-track" key={`map-${feature.id}`}>
                      <button type="button" className="annotation-track-label" onClick={() => { if (position) navigateToRange(position.start, position.end); }}><strong>{feature.name}{staleOrf && <em>Needs review</em>}</strong><small>{feature.type} · {feature.range ?? "no range"}</small></button>
                      <div className="annotation-rail">
                        {position && <button type="button" className={`annotation-bar ${workspaceUi.selection?.start === position.start && workspaceUi.selection?.end === position.end ? "selected" : ""}`} onClick={() => navigateToRange(position.start, position.end)} style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%`, backgroundColor: feature.color ?? "#17b6c9" }} title={`${feature.name}: ${feature.range}`} aria-label={`Select ${feature.name}, ${feature.range}`} />}
                      </div>
                      {staleOrf && <div className="annotation-review-actions"><button type="button" onClick={() => refreshOrfAnnotation(feature)}>Refresh ORF</button><button type="button" onClick={() => keepOrfAnnotation(feature)}>Keep coordinates</button><button type="button" onClick={() => detachOrfPrediction(feature)}>Detach</button></div>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="empty-features map-empty">No annotations yet. Add the first one above.</p>
            )}
            <p className="session-note">Changes are autosaved on this device. Export a DOTDNA project or GenBank file for a portable copy.</p>
          </section>

          <AddgeneAnnotations sequence={data.sequence} circular={data.circular} onApply={importAddgeneAnnotations} />

          <AnalysisPanels key={fileName} sequence={data.sequence} circular={data.circular} annotations={annotations} preferences={workspaceUi.analysis} onPreferencesChange={(analysis) => setWorkspaceUi((current) => ({ ...current, analysis }))} onNavigate={navigateToRange} onCreateCds={createCdsFromOrf} />

          <MolecularTools key={`${fileName}-molecular`} fileName={fileName} sequence={data.sequence} circular={data.circular} primers={data.primers} activeTab={workspaceUi.molecularTab} primerSort={workspaceUi.primerSort} onActiveTabChange={(molecularTab) => setWorkspaceUi((current) => ({ ...current, molecularTab }))} onPrimerSortChange={(primerSort) => setWorkspaceUi((current) => ({ ...current, primerSort }))} onPrimersChange={changePrimers} />

          <DesignVerifyTools key={`${fileName}-design`} fileName={fileName} sequence={data.sequence} circular={data.circular} features={annotations} activeTab={workspaceUi.designTab} onActiveTabChange={(designTab) => setWorkspaceUi((current) => ({ ...current, designTab }))} onOpenProduct={openAssemblyProduct} />

          <DocumentInspector data={data} packetSort={workspaceUi.packetSort} onPacketSortChange={(packetSort) => setWorkspaceUi((current) => ({ ...current, packetSort }))} />
        </section>
      ) : (
        <section className="how-it-works">
          <div className="how-title">
            <p className="eyebrow cyan">What comes out</p>
            <h2>From sequence file<br />to working construct.</h2>
          </div>
          <div className="steps">
            <article><span>01</span><h3>Open</h3><p>Reads SnapGene, GenBank, FASTA, raw DNA, and portable DOTDNA projects.</p></article>
            <article><span>02</span><h3>Work</h3><p>Map, edit, annotate, design primers, assemble, align, digest, and translate.</p></article>
            <article><span>03</span><h3>Export</h3><p>Take FASTA, annotated GenBank, protein, amplicon, map PNG, or a complete project.</p></article>
          </div>
        </section>
      )}

      <footer>
        <a className="brand footer-brand" href="#top">DOTDNA</a>
        <p>Private sequence work, saved on your device.</p>
        <p className="footer-tech">.dna · GenBank · FASTA · DOTDNA</p>
      </footer>
    </main>
  );
}
