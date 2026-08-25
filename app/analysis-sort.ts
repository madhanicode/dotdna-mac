import type { OpenReadingFrame, RestrictionEnzyme, RestrictionSite } from "./sequence-analysis.ts";

export type SortDirection = "asc" | "desc";
export type OrfSortKey = "frame" | "range" | "length" | "protein";
export type RestrictionSortKey = "enzyme" | "recognition" | "sites" | "coordinates";

export type RestrictionEnzymeRow = {
  enzyme: RestrictionEnzyme;
  sites: RestrictionSite[];
};

function orderedComparison(comparison: number, direction: SortDirection) {
  return direction === "asc" ? comparison : -comparison;
}

export function sortOrfs(orfs: OpenReadingFrame[], key: OrfSortKey, direction: SortDirection) {
  return [...orfs].sort((left, right) => {
    let comparison = 0;
    if (key === "frame") comparison = left.frame - right.frame;
    if (key === "range") comparison = left.start - right.start || left.end - right.end;
    if (key === "length") comparison = left.aminoAcidLength - right.aminoAcidLength;
    if (key === "protein") comparison = left.protein.localeCompare(right.protein);
    return orderedComparison(comparison, direction) || left.start - right.start || left.id.localeCompare(right.id);
  });
}

export function sortRestrictionRows(rows: RestrictionEnzymeRow[], key: RestrictionSortKey, direction: SortDirection) {
  return [...rows].sort((left, right) => {
    let comparison = 0;
    if (key === "enzyme") comparison = left.enzyme.name.localeCompare(right.enzyme.name);
    if (key === "recognition") comparison = left.enzyme.recognition.localeCompare(right.enzyme.recognition);
    if (key === "sites") comparison = left.sites.length - right.sites.length;
    if (key === "coordinates") comparison = (left.sites[0]?.position ?? Number.MAX_SAFE_INTEGER) - (right.sites[0]?.position ?? Number.MAX_SAFE_INTEGER);
    return orderedComparison(comparison, direction) || left.enzyme.name.localeCompare(right.enzyme.name);
  });
}
