import { restrictionEnzymes, type RestrictionSite } from "./restriction-sites";
import type { DigestCommandFragment, DigestCommandResult, DigestEnd, OpenDocument } from "./types";

export function restrictionSiteCounts(sites: RestrictionSite[]) {
  return sites.reduce<Record<string, number>>((counts, site) => {
    counts[site.enzyme] = (counts[site.enzyme] ?? 0) + 1;
    return counts;
  }, {});
}

export function defaultDigestEnzyme(siteCounts: Record<string, number>, truncatedEnzymes: ReadonlySet<string> = new Set()) {
  return restrictionEnzymes.find((enzyme) => siteCounts[enzyme.enzyme] === 1 && !truncatedEnzymes.has(enzyme.enzyme))?.enzyme
    ?? restrictionEnzymes.find((enzyme) => (siteCounts[enzyme.enzyme] ?? 0) > 0 && !truncatedEnzymes.has(enzyme.enzyme))?.enzyme
    ?? null;
}

export function digestResultIsCurrent(result: DigestCommandResult, active: Pick<OpenDocument, "id" | "revision">) {
  return result.templateId === active.id && result.templateRevision === active.revision;
}

export function digestSourceLabel(fragment: DigestCommandFragment) {
  const ranges = fragment.sourceSpans.map((span) => `${(span.start + 1).toLocaleString()}–${span.end.toLocaleString()}`);
  return `${ranges.join(" / ")}${fragment.sourceSpans.length > 1 ? " · crosses origin" : ""}`;
}

export function digestEndLabel(end: DigestEnd) {
  if (end.endType === "natural") return "Natural template end";
  const enzymes = end.enzymeNames.join("/");
  if (end.endType === "blunt") return `${enzymes} · blunt`;
  const polarity = end.endType === "five-prime" ? "5′" : "3′";
  const strand = end.overhangStrand === "forward" ? "forward" : "reverse";
  return `${enzymes} · ${end.overhangLength}-nt ${polarity} ${end.overhangSequence} · ${strand} strand`;
}
