/// <reference lib="webworker" />

import { findAddgeneCandidates, parseAddgeneCatalog } from "./addgene";
import type { AddgeneCatalogRecord } from "./addgene";

type LoadRequest = { id: number; kind: "load"; bytes: ArrayBuffer; sequence: string; circular: boolean };
type MatchRequest = { id: number; kind: "match"; sequence: string; circular: boolean };

let records: AddgeneCatalogRecord[] = [];

self.onmessage = (event: MessageEvent<LoadRequest | MatchRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "load") records = parseAddgeneCatalog(new TextDecoder().decode(request.bytes));
    self.postMessage({
      id: request.id,
      recordCount: records.length,
      candidates: findAddgeneCandidates(records, request.sequence, request.circular),
    });
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : "Could not index that Addgene catalog." });
  }
};

export {};
