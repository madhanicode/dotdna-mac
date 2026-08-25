import type { SortDirection } from "./analysis-sort";

export type SortState<Key extends string> = { key: Key; direction: SortDirection };

export function nextSort<Key extends string>(current: SortState<Key>, key: Key, defaultDirection: SortDirection = "asc") {
  return current.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" } satisfies SortState<Key>
    : { key, direction: defaultDirection } satisfies SortState<Key>;
}

export function SortableTableHeader({ label, active, direction, onSort }: { label: string; active: boolean; direction: SortDirection; onSort: () => void }) {
  return (
    <th aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={`table-sort-button ${active ? "active" : ""}`} onClick={onSort} title={`Sort by ${label}`}>
        {label}<span aria-hidden="true">{active ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}
