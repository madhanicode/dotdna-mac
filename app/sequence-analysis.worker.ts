/// <reference lib="webworker" />

import { findOpenReadingFrames, findRestrictionSites, RESTRICTION_ENZYMES } from "./sequence-analysis";
import type { OrfStartMode } from "./sequence-analysis";

type Request = {
  id: number;
  sequence: string;
  circular: boolean;
  includeOrfs: boolean;
  includeRestrictionSites: boolean;
  minimumAminoAcids: number;
  startMode: OrfStartMode;
};

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  self.postMessage({
    id: request.id,
    orfs: request.includeOrfs ? findOpenReadingFrames(request.sequence, { circular: request.circular, minAminoAcids: request.minimumAminoAcids, startMode: request.startMode }) : [],
    restrictionSites: request.includeRestrictionSites ? findRestrictionSites(request.sequence, RESTRICTION_ENZYMES, request.circular) : [],
  });
};

export {};
