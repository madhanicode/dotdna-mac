import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultDigestEnzyme, digestEndLabel, digestResultIsCurrent, digestSourceLabel } from "./digest-workflows";
import { restrictionEnzymes } from "./restriction-sites";
import type { CommandError, DigestCommandFragment, DigestCommandResult, OpenDocument } from "./types";

function commandError(error: unknown): CommandError {
  if (error && typeof error === "object" && "message" in error && "action" in error) return error as CommandError;
  return { code: "digest-failed", message: "The restriction digest could not be completed.", action: String(error) };
}

export function DigestSheet({ active, siteCounts, truncatedEnzymes, onClose, onCreate, onBusyChange }: {
  active: OpenDocument;
  siteCounts: Record<string, number>;
  truncatedEnzymes: string[];
  onClose: () => void;
  onCreate: (result: DigestCommandResult, fragment: DigestCommandFragment) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const truncatedEnzymeSet = useMemo(() => new Set(truncatedEnzymes), [truncatedEnzymes]);
  const initialEnzyme = defaultDigestEnzyme(siteCounts, truncatedEnzymeSet);
  const [selectedEnzymes, setSelectedEnzymes] = useState<Set<string>>(() => new Set(initialEnzyme ? [initialEnzyme] : []));
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<DigestCommandResult | null>(null);
  const [selectedFragment, setSelectedFragment] = useState<number | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [busy, setBusy] = useState(Boolean(initialEnzyme));
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeCallbackRef = useRef(onClose);
  const busyRef = useRef(busy);
  const busyChangeRef = useRef(onBusyChange);
  const requestTokenRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const queuedRequestRef = useRef<(() => void) | null>(null);
  closeCallbackRef.current = onClose;
  busyRef.current = busy;
  busyChangeRef.current = onBusyChange;

  const selectedNames = useMemo(() => restrictionEnzymes.map((enzyme) => enzyme.enzyme).filter((name) => selectedEnzymes.has(name)), [selectedEnzymes]);
  const selectedKey = selectedNames.join("|");
  const visibleEnzymes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? restrictionEnzymes.filter((enzyme) => `${enzyme.enzyme} ${enzyme.recognitionSequence}`.toLowerCase().includes(normalized)) : restrictionEnzymes;
  }, [query]);
  const currentFragment = result?.fragments.find((fragment) => fragment.index === selectedFragment) ?? null;

  useEffect(() => busyChangeRef.current(busy), [busy]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (busyRef.current) dialogRef.current?.focus();
    else searchRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) closeCallbackRef.current();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
    else if (document.activeElement === dialogRef.current) searchRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    const token = ++requestTokenRef.current;
    setResult(null);
    setSelectedFragment(null);
    setError(null);
    if (!selectedNames.length) {
      setBusy(false);
      return;
    }
    setBusy(true);
    const execute = () => {
      if (requestTokenRef.current !== token) return;
      if (requestInFlightRef.current) {
        queuedRequestRef.current = execute;
        return;
      }
      requestInFlightRef.current = true;
      void invoke<DigestCommandResult>("simulate_restriction_digest", {
        request: {
          templateId: active.id,
          templateRevision: active.revision,
          document: active.document,
          enzymeNames: selectedNames,
        },
      }).then((next) => {
        if (requestTokenRef.current !== token || !digestResultIsCurrent(next, active)) return;
        setResult(next);
      }).catch((reason: unknown) => {
        if (requestTokenRef.current === token) setError(commandError(reason));
      }).finally(() => {
        requestInFlightRef.current = false;
        const queued = queuedRequestRef.current;
        queuedRequestRef.current = null;
        if (queued) queued();
        else if (requestTokenRef.current === token) setBusy(false);
      });
    };
    execute();
    return () => {
      if (queuedRequestRef.current === execute) queuedRequestRef.current = null;
      if (requestTokenRef.current === token) requestTokenRef.current = token + 1;
    };
  }, [active.document, active.id, active.revision, selectedKey]);

  const toggleEnzyme = (name: string) => {
    if (busyRef.current) return;
    setSelectedEnzymes((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectUniqueCutters = () => {
    if (busyRef.current) return;
    setSelectedEnzymes(new Set(restrictionEnzymes.filter((enzyme) => siteCounts[enzyme.enzyme] === 1 && !truncatedEnzymeSet.has(enzyme.enzyme)).map((enzyme) => enzyme.enzyme)));
  };

  const createSelected = () => {
    if (!result || !currentFragment || busy || !digestResultIsCurrent(result, active)) return;
    onCreate(result, currentFragment);
  };

  const status = busy
    ? `Calculating a complete digest with ${selectedNames.join(", ")}`
    : result
      ? `Digest complete: ${result.cuts.length} cut${result.cuts.length === 1 ? "" : "s"}, ${result.fragments.length} fragment${result.fragments.length === 1 ? "" : "s"}, ${result.warnings.length} advisor${result.warnings.length === 1 ? "y" : "ies"}`
      : error ? `Digest unavailable: ${error.message}` : "Select one or more restriction enzymes";

  return <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <div aria-live="polite" className="sr-only" role="status">{status}</div>
    <section className="workflow-sheet digest-sheet" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Restriction Digest" tabIndex={-1}>
      <header><div><small>ACTION WORKFLOW</small><h2>Restriction Digest</h2><p>Predict a complete double-strand digest and create one selected linear fragment.</p></div><button disabled={busy} onClick={onClose} aria-label="Close Restriction Digest">×</button></header>
      <div className="workflow-steps"><span className="active"><b>1</b> Enzymes</span><span className={result ? "active" : ""}><b>2</b> Fragments</span><span className={currentFragment ? "active" : ""}><b>3</b> Verify</span></div>
      <div className="digest-body">
        <section className="digest-enzyme-panel" aria-label="Restriction enzymes">
          <header><label><span>Find enzyme</span><input aria-label="Find restriction enzyme" disabled={busy} ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or recognition sequence" /></label><div><button disabled={busy} onClick={selectUniqueCutters}>Select unique cutters</button><button disabled={busy || selectedNames.length === 0} onClick={() => setSelectedEnzymes(new Set())}>Clear</button></div>{truncatedEnzymes.length > 0 && <p className="digest-scan-note">Display counts are capped only for: {truncatedEnzymes.join(", ")}. Product calculation remains complete and authoritative.</p>}</header>
          <div className="digest-enzyme-list">{visibleEnzymes.length ? visibleEnzymes.map((enzyme) => {
            const count = siteCounts[enzyme.enzyme] ?? 0;
            const truncated = truncatedEnzymeSet.has(enzyme.enzyme);
            const topOffset = `${enzyme.topCutOffset >= 0 ? "+" : ""}${enzyme.topCutOffset}`;
            const bottomOffset = `${enzyme.bottomCutOffset >= 0 ? "+" : ""}${enzyme.bottomCutOffset}`;
            return <label className={selectedEnzymes.has(enzyme.enzyme) ? "selected" : ""} key={enzyme.enzyme}><input checked={selectedEnzymes.has(enzyme.enzyme)} disabled={busy} onChange={() => toggleEnzyme(enzyme.enzyme)} type="checkbox" /><span><strong>{enzyme.enzyme}</strong><small className="mono">{enzyme.recognitionSequence} · top cut {topOffset}, bottom cut {bottomOffset}</small></span><em>{count.toLocaleString()}{truncated ? "+" : ""} site{count === 1 && !truncated ? "" : "s"}</em></label>;
          }) : <p>No supported enzymes match “{query}”.</p>}</div>
        </section>
        <section aria-busy={busy} className="digest-fragment-panel" aria-label="Digest fragments">
          {busy && <div className="workflow-state">Deriving both strand cuts, end chemistry, and fragment annotations…</div>}
          {!busy && !selectedNames.length && <div className="digest-empty"><strong>Choose an enzyme</strong><p>DOTDNA will calculate complete cleavage in Rust; display-site coordinates are not used as product inputs.</p></div>}
          {error && <div className="workflow-warning error" role="alert"><b>{error.message}</b><p>{error.action}</p></div>}
          {result && <>
            <div className="digest-summary"><div><span>Enzymes</span><strong>{result.enzymeNames.join(" + ")}</strong></div><div><span>Physical cuts</span><strong>{result.cuts.length}</strong></div><div><span>Fragments</span><strong>{result.fragments.length}</strong></div></div>
            {result.warnings.length > 0 && <details className="product-warnings" open><summary>Review {result.warnings.length} digest advisor{result.warnings.length === 1 ? "y" : "ies"} before creating</summary>{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
            <div className="digest-fragment-list" role="radiogroup" aria-label="Select a digest fragment">{result.fragments.map((fragment) => <label className={selectedFragment === fragment.index ? "selected" : ""} key={fragment.index}><input checked={selectedFragment === fragment.index} onChange={() => setSelectedFragment(fragment.index)} type="radio" name="digest-fragment" /><span><strong>Fragment {fragment.index}</strong><small>{digestSourceLabel(fragment)}</small><small>Left end: {digestEndLabel(fragment.upstreamEnd)}</small><small>Right end: {digestEndLabel(fragment.downstreamEnd)}</small></span><em>{fragment.length.toLocaleString()} bp<br />{fragment.document.document.features.length.toLocaleString()} features</em></label>)}</div>
          </>}
        </section>
      </div>
      <footer><span>{currentFragment ? `Fragment ${currentFragment.index} · ${currentFragment.length.toLocaleString()} bp · ${currentFragment.gcPercent.toFixed(1)}% GC` : "Select one predicted fragment to create"}</span><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !currentFragment} onClick={createSelected}>Create Selected Fragment</button></footer>
    </section>
  </div>;
}
