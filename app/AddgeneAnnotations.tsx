"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { apiResultToCandidate, findAddgeneCandidates, parseAddgeneCatalog } from "./addgene";
import type { AddgeneApiResult, AddgeneCandidate } from "./addgene";
import type { SnapGeneFeature } from "./snapgene";

type AddgeneStatus = { configured: boolean; secureStorageAvailable: boolean };
type AddgeneBridge = {
  status: () => Promise<AddgeneStatus>;
  configure: (token: string) => Promise<AddgeneStatus>;
  clear: () => Promise<void>;
  fetchPlasmid: (plasmidId: string) => Promise<AddgeneApiResult>;
};

declare global {
  interface Window { dotdnaAddgene?: AddgeneBridge }
}

type Props = {
  sequence: string;
  circular: boolean;
  onApply: (features: SnapGeneFeature[], source: string) => void;
};

function percentage(value: number) {
  return `${(value * 100).toFixed(value >= 0.995 ? 0 : 1)}%`;
}

function candidateKey(candidate: AddgeneCandidate) {
  return `${candidate.record.id}-${candidate.record.sequence.length}-${candidate.record.name}`;
}

export function AddgeneAnnotations({ sequence, circular, onApply }: Props) {
  const [status, setStatus] = useState<AddgeneStatus | null>(null);
  const [token, setToken] = useState("");
  const [plasmidId, setPlasmidId] = useState("");
  const [remoteCandidate, setRemoteCandidate] = useState<AddgeneCandidate | null>(null);
  const [localRecordCount, setLocalRecordCount] = useState(0);
  const [localCandidates, setLocalCandidates] = useState<AddgeneCandidate[]>([]);
  const [catalogName, setCatalogName] = useState("");
  const [pending, setPending] = useState<"connect" | "fetch" | "catalog" | null>(null);
  const [error, setError] = useState("");
  const [appliedKey, setAppliedKey] = useState("");
  const catalogWorkerRef = useRef<Worker | null>(null);
  const catalogRequestRef = useRef(0);
  const bridgeAvailable = typeof window !== "undefined" && Boolean(window.dotdnaAddgene);

  useEffect(() => {
    let active = true;
    if (!window.dotdnaAddgene) return;
    void window.dotdnaAddgene.status().then((next) => { if (active) setStatus(next); }).catch(() => {
      if (active) setStatus({ configured: false, secureStorageAvailable: false });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const id = ++catalogRequestRef.current;
    catalogWorkerRef.current?.postMessage({ id, kind: "match", sequence, circular });
  }, [sequence, circular]);

  useEffect(() => () => catalogWorkerRef.current?.terminate(), []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.dotdnaAddgene) return;
    setPending("connect");
    setError("");
    try {
      const next = await window.dotdnaAddgene.configure(token);
      setStatus(next);
      setToken("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the Addgene API token.");
    } finally { setPending(null); }
  }

  async function disconnect() {
    if (!window.dotdnaAddgene) return;
    setPending("connect");
    setError("");
    try {
      await window.dotdnaAddgene.clear();
      setStatus({ configured: false, secureStorageAvailable: true });
      setRemoteCandidate(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the Addgene API token.");
    } finally { setPending(null); }
  }

  async function fetchPlasmid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.dotdnaAddgene) return;
    setPending("fetch");
    setError("");
    setRemoteCandidate(null);
    try {
      const result = await window.dotdnaAddgene.fetchPlasmid(plasmidId);
      setRemoteCandidate(apiResultToCandidate(result, sequence, circular));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not retrieve that Addgene plasmid.");
    } finally { setPending(null); }
  }

  async function openCatalog(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPending("catalog");
    setError("");
    try {
      const bytes = await file.arrayBuffer();
      setCatalogName(file.name);
      const id = ++catalogRequestRef.current;
      try {
        catalogWorkerRef.current?.terminate();
        const worker = new Worker(new URL("./addgene-catalog.worker.ts", import.meta.url), { type: "module" });
        catalogWorkerRef.current = worker;
        worker.onmessage = (message: MessageEvent<{ id: number; recordCount?: number; candidates?: AddgeneCandidate[]; error?: string }>) => {
          if (message.data.id !== catalogRequestRef.current) return;
          if (message.data.error) {
            setLocalRecordCount(0);
            setLocalCandidates([]);
            setError(message.data.error);
          } else {
            setLocalRecordCount(message.data.recordCount ?? 0);
            setLocalCandidates(message.data.candidates ?? []);
          }
          setPending(null);
        };
        worker.onerror = () => {
          if (id !== catalogRequestRef.current) return;
          setLocalRecordCount(0);
          setLocalCandidates([]);
          setError("The local Addgene catalog worker could not finish indexing this file.");
          setPending(null);
        };
        worker.postMessage({ id, kind: "load", bytes, sequence, circular }, [bytes]);
        return;
      } catch {
        const records = parseAddgeneCatalog(new TextDecoder().decode(bytes));
        setLocalRecordCount(records.length);
        setLocalCandidates(findAddgeneCandidates(records, sequence, circular));
        setPending(null);
      }
    } catch (caught) {
      setLocalRecordCount(0);
      setLocalCandidates([]);
      setCatalogName("");
      setError(caught instanceof Error ? caught.message : "Could not read that Addgene catalog.");
      setPending(null);
    }
  }

  function apply(candidate: AddgeneCandidate) {
    if (!candidate.transform || !candidate.annotations.length) return;
    onApply(candidate.annotations, `Addgene #${candidate.record.id || "local"} ${candidate.record.name}`);
    setAppliedKey(candidateKey(candidate));
  }

  function candidateCard(candidate: AddgeneCandidate, remote = false) {
    const key = candidateKey(candidate);
    const exact = Boolean(candidate.transform);
    return (
      <article className={`addgene-candidate ${exact ? "exact" : "near"}`} key={key}>
        <div>
          <span>{exact ? "Exact whole-sequence match" : "Review-only candidate"}</span>
          <strong>{candidate.record.name}</strong>
          <small>{candidate.record.id ? `Addgene #${candidate.record.id} · ` : ""}{candidate.record.sequence.length.toLocaleString()} bp · {percentage(candidate.similarity)} similarity</small>
          {exact && candidate.transform && <small>{candidate.transform.orientation === "reverse" ? "Reverse-complement" : "Forward"}{candidate.transform.rotated ? ` · circular offset ${candidate.transform.offset.toLocaleString()} bp` : ""} · {candidate.annotations.length} transferable annotations</small>}
          {!exact && <p>Coordinates are disabled because this is not an exact whole-sequence match. Open the source and review differences before transferring annotations.</p>}
        </div>
        {exact && candidate.annotations.length > 0
          ? <button type="button" className="primary-button compact" onClick={() => apply(candidate)}>{appliedKey === key ? "Applied ✓" : `Apply ${candidate.annotations.length}`}</button>
          : remote && exact ? <b>No annotations returned</b> : null}
      </article>
    );
  }

  return (
    <section className="addgene-section" id="addgene" aria-labelledby="addgene-heading">
      <div className="addgene-heading">
        <div><span className="panel-kicker">OPT-IN REFERENCE ANNOTATION</span><h3 id="addgene-heading">Match with Addgene</h3></div>
        <p>The open sequence is never uploaded. Use an exact plasmid ID through Addgene’s official API, or match a licensed catalog file entirely on this device.</p>
      </div>
      <div className="addgene-grid">
        <div className="addgene-panel">
          <span className="addgene-step">01 · OFFICIAL API</span>
          <h4>Retrieve a known plasmid</h4>
          {!bridgeAvailable ? (
            <p className="addgene-notice">Official API retrieval is available in the DOTDNA desktop app. Local catalog matching still works here.</p>
          ) : status?.configured ? (
            <>
              <div className="addgene-connected"><i />API token secured with macOS credential encryption <button type="button" onClick={() => void disconnect()} disabled={pending === "connect"}>Disconnect</button></div>
              <form className="addgene-id-form" onSubmit={fetchPlasmid}>
                <label><span>Addgene plasmid ID</span><input inputMode="numeric" value={plasmidId} onChange={(event) => setPlasmidId(event.target.value)} placeholder="e.g. 52961" /></label>
                <button type="submit" className="secondary-button" disabled={pending === "fetch"}>{pending === "fetch" ? "Retrieving…" : "Retrieve annotations"}</button>
              </form>
            </>
          ) : (
            <form className="addgene-token-form" onSubmit={connect}>
              <label><span>Addgene API token</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Stored encrypted on this Mac" disabled={status?.secureStorageAvailable === false} /></label>
              <button type="submit" className="secondary-button" disabled={pending === "connect" || status?.secureStorageAvailable === false}>{pending === "connect" ? "Connecting…" : "Connect"}</button>
              <p>Requires approved Addgene developer access and the licensed catalog-sequence scope. DOTDNA does not scrape Addgene pages.</p>
            </form>
          )}
          {remoteCandidate && <div className="addgene-results">{candidateCard(remoteCandidate, true)}</div>}
        </div>
        <div className="addgene-panel">
          <span className="addgene-step">02 · PRIVATE LOCAL INDEX</span>
          <h4>Match a licensed catalog export</h4>
          <label className="addgene-file-button">
            <input type="file" accept=".json,application/json" onChange={(event) => void openCatalog(event)} />
            <span>{pending === "catalog" ? "Indexing locally…" : catalogName || "Choose Addgene JSON catalog"}</span>
          </label>
          <p className="addgene-catalog-meta">{localRecordCount ? `${localRecordCount.toLocaleString()} sequence records indexed in a local worker · ${localCandidates.length} candidate matches` : "The file is read into a local worker only. It is not copied to a server or included in recovery snapshots."}</p>
          {localCandidates.length > 0 && <div className="addgene-results">{localCandidates.map((candidate) => candidateCard(candidate))}</div>}
        </div>
      </div>
      {error && <p className="addgene-error" role="alert">{error}</p>}
      <div className="addgene-guardrail"><strong>Coordinate guardrail</strong><span>Annotations can be applied only after exact full-length matching, including safe circular rotation and reverse-complement transforms. Similar sequences remain review-only.</span><a href="https://developers.addgene.org/" target="_blank" rel="noreferrer">Addgene developer access ↗</a></div>
    </section>
  );
}
