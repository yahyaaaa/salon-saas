"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "@/components/ui";

export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A select you can type into.
 *
 * Built from an input and a listbox rather than a `<select>`, because the lists
 * it is used for -- every country, every IANA timezone -- are too long to scroll
 * and a native select only matches on the first few characters you type.
 *
 * The chosen value is mirrored into a hidden input, so the surrounding form
 * submits normally and keeps working when the page is replayed without
 * JavaScript.
 */
export function Combobox({
  name,
  options,
  defaultValue = "",
  placeholder,
  required,
  onSelect,
  id,
  invalid,
}: {
  name: string;
  options: ComboboxOption[];
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  onSelect?: (value: string) => void;
  id?: string;
  invalid?: boolean;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${inputId}-list`;

  const selected = options.find((o) => o.value === defaultValue);
  const [query, setQuery] = useState(selected?.label ?? defaultValue);
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // An empty box, or one still showing the current selection, lists
    // everything -- otherwise reopening it would show a single result.
    if (!q || q === selected?.label.toLowerCase()) return options.slice(0, 100);
    return options
      .filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      .slice(0, 100);
  }, [query, options, selected]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function choose(option: ComboboxOption) {
    setValue(option.value);
    setQuery(option.label);
    setOpen(false);
    onSelect?.(option.value);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return Math.max(0, Math.min(matches.length - 1, next));
      });
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = matches[active];
      if (option) choose(option);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapper} className="relative">
      <input type="hidden" name={name} value={value} />

      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        required={required && !value}
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
          // Typing past a selection clears it, so a half-typed country cannot
          // be submitted as the previously chosen one.
          if (value) setValue("");
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={cn(
          "block w-full rounded-lg border bg-white px-3 py-2 text-sm text-ink-900",
          "placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 focus:outline-none",
          invalid ? "border-red-400" : "border-ink-300",
        )}
      />

      {open && matches.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-ink-200 bg-white py-1 shadow-lg"
        >
          {matches.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm",
                  index === active ? "bg-brand-50 text-brand-700" : "text-ink-700",
                )}
              >
                <span className="truncate">{option.label}</span>
                {option.hint ? (
                  <span className="shrink-0 text-xs text-ink-400">{option.hint}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
