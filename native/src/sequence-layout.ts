const complements: Record<string, string> = {
  A: "T", C: "G", G: "C", T: "A", R: "Y", Y: "R", S: "S", W: "W",
  K: "M", M: "K", B: "V", V: "B", D: "H", H: "D", N: "N", "-": "-",
};

export type SequenceRow = {
  index: number;
  start: number;
  end: number;
  forward: string;
  complement: string;
};

export function complementSequence(sequence: string) {
  return [...sequence.toUpperCase()].map((base) => complements[base] ?? "N").join("");
}

export function sequenceRow(sequence: string, index: number, lineLength = 60): SequenceRow {
  const start = index * lineLength;
  const forward = sequence.slice(start, start + lineLength);
  return {
    index,
    start,
    end: start + forward.length,
    forward,
    complement: complementSequence(forward),
  };
}

export function visibleRowRange(scrollTop: number, viewportHeight: number, totalRows: number, rowHeight = 42, overscan = 4) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { first, last };
}
