"use client";

import { useEffect, useRef, useState } from "react";
import { findOpenReadingFrames, findRestrictionSites, RESTRICTION_ENZYMES } from "./sequence-analysis";
import type { OpenReadingFrame, OrfStartMode, RestrictionSite } from "./sequence-analysis";

type Options = {
  circular: boolean;
  includeOrfs?: boolean;
  includeRestrictionSites?: boolean;
  minimumAminoAcids?: number;
  startMode?: OrfStartMode;
};

type Result = { orfs: OpenReadingFrame[]; restrictionSites: RestrictionSite[]; pending: boolean };
type StoredResult = {
  query: { sequence: string; circular: boolean; includeOrfs: boolean; includeRestrictionSites: boolean; minimumAminoAcids: number; startMode: OrfStartMode } | null;
  orfs: OpenReadingFrame[];
  restrictionSites: RestrictionSite[];
};

export function useSequenceAnalysis(sequence: string, options: Options): Result {
  const requestId = useRef(0);
  const [result, setResult] = useState<StoredResult>({ query: null, orfs: [], restrictionSites: [] });
  const circular = options.circular;
  const includeOrfs = options.includeOrfs ?? true;
  const includeRestrictionSites = options.includeRestrictionSites ?? true;
  const minimumAminoAcids = options.minimumAminoAcids ?? 50;
  const startMode = options.startMode ?? "atg";

  useEffect(() => {
    const id = ++requestId.current;
    let active = true;
    let worker: Worker | null = null;
    let fallbackTimer = 0;
    const complete = (orfs: OpenReadingFrame[], restrictionSites: RestrictionSite[]) => {
      if (active && requestId.current === id) setResult({
        query: { sequence, circular, includeOrfs, includeRestrictionSites, minimumAminoAcids, startMode },
        orfs,
        restrictionSites,
      });
    };

    try {
      worker = new Worker(new URL("./sequence-analysis.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ id: number; orfs: OpenReadingFrame[]; restrictionSites: RestrictionSite[] }>) => {
        if (event.data.id === id) complete(event.data.orfs, event.data.restrictionSites);
      };
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        fallbackTimer = window.setTimeout(() => complete(
          includeOrfs ? findOpenReadingFrames(sequence, { circular, minAminoAcids: minimumAminoAcids, startMode }) : [],
          includeRestrictionSites ? findRestrictionSites(sequence, RESTRICTION_ENZYMES, circular) : [],
        ), 0);
      };
      worker.postMessage({ id, sequence, circular, includeOrfs, includeRestrictionSites, minimumAminoAcids, startMode });
    } catch {
      fallbackTimer = window.setTimeout(() => complete(
        includeOrfs ? findOpenReadingFrames(sequence, { circular, minAminoAcids: minimumAminoAcids, startMode }) : [],
        includeRestrictionSites ? findRestrictionSites(sequence, RESTRICTION_ENZYMES, circular) : [],
      ), 0);
    }

    return () => {
      active = false;
      window.clearTimeout(fallbackTimer);
      worker?.terminate();
    };
  }, [sequence, circular, includeOrfs, includeRestrictionSites, minimumAminoAcids, startMode]);

  const current = result.query?.sequence === sequence
    && result.query.circular === circular
    && result.query.includeOrfs === includeOrfs
    && result.query.includeRestrictionSites === includeRestrictionSites
    && result.query.minimumAminoAcids === minimumAminoAcids
    && result.query.startMode === startMode;
  return current
    ? { orfs: result.orfs, restrictionSites: result.restrictionSites, pending: false }
    : { orfs: [], restrictionSites: [], pending: true };
}
