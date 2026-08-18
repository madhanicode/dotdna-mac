import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  detail: string;
  group: string;
  shortcut?: string;
  keywords?: string[];
  disabled?: boolean;
  disabledReason?: string;
  run: () => void;
};

export function filterPaletteCommands(commands: PaletteCommand[], query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return commands;
  return commands
    .map((command, order) => {
      const label = command.label.toLowerCase();
      const haystack = [command.label, command.detail, command.group, ...(command.keywords ?? [])].join(" ").toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) return null;
      const joined = tokens.join(" ");
      const score = label === joined ? 0 : label.startsWith(joined) ? 1 : label.includes(joined) ? 2 : 3;
      return { command, order, score };
    })
    .filter((item): item is { command: PaletteCommand; order: number; score: number } => item !== null)
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map(({ command }) => command);
}

function nextEnabledIndex(commands: PaletteCommand[], current: number, direction: 1 | -1) {
  if (!commands.length) return -1;
  for (let offset = 1; offset <= commands.length; offset += 1) {
    const candidate = (current + direction * offset + commands.length) % commands.length;
    if (!commands[candidate].disabled) return candidate;
  }
  return -1;
}

export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: (restoreFocus: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const results = useMemo(() => filterPaletteCommands(commands, query), [commands, query]);
  const resultsKey = results.map((command) => `${command.id}:${command.disabled ? 1 : 0}`).join("|");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected((current) => current >= 0 && current < results.length && !results[current].disabled ? current : results.findIndex((command) => !command.disabled));
  }, [query, resultsKey]);

  useEffect(() => {
    if (selected >= 0) optionRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const execute = (command: PaletteCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose(false);
    window.queueMicrotask(command.run);
  };

  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose(true)}>
      <section aria-label="Command palette" aria-modal="true" className="command-palette" onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose(true);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSelected((current) => nextEnabledIndex(results, current, event.key === "ArrowDown" ? 1 : -1));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const ordered = event.key === "Home" ? results : [...results].reverse();
          const command = ordered.find((item) => !item.disabled);
          setSelected(command ? results.indexOf(command) : -1);
        } else if (event.key === "Enter") {
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          execute(results[selected]);
        } else if (event.key === "Tab") {
          event.preventDefault();
          setSelected((current) => nextEnabledIndex(results, current, event.shiftKey ? -1 : 1));
        }
      }} role="dialog">
        <header><span>⌘K</span><input aria-activedescendant={selected >= 0 ? `command-${results[selected]?.id}` : undefined} aria-autocomplete="list" aria-controls="command-results" aria-expanded="true" aria-label="Search commands" autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="Type a command or action…" ref={inputRef} role="combobox" value={query} /><kbd>esc</kbd></header>
        <div aria-activedescendant={selected >= 0 ? `command-${results[selected]?.id}` : undefined} className="command-results" id="command-results" role="listbox">
          {results.length === 0 ? <p>No commands match “{query}”.</p> : results.map((command, index) => {
            const previousGroup = index > 0 ? results[index - 1].group : null;
            return <div className="command-result-wrap" key={command.id}>{command.group !== previousGroup && <small>{command.group}</small>}<button aria-disabled={command.disabled || undefined} aria-selected={selected === index} className={selected === index ? "selected" : ""} id={`command-${command.id}`} onClick={() => execute(command)} onMouseMove={() => !command.disabled && setSelected(index)} ref={(element) => { optionRefs.current[index] = element; }} role="option"><span><strong>{command.label}</strong><em>{command.disabled ? command.disabledReason ?? command.detail : command.detail}</em></span>{command.shortcut && <kbd>{command.shortcut}</kbd>}</button></div>;
          })}
        </div>
        <footer><span><b>↑↓</b> navigate</span><span><b>↵</b> run</span><span><b>esc</b> close</span></footer>
      </section>
    </div>
  );
}
