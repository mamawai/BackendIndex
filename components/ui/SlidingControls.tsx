"use client";

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SlidingOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

function placeSegThumb(box: HTMLElement, animate: boolean) {
  const th = box.querySelector<HTMLElement>(".th");
  const on = box.querySelector<HTMLElement>('[aria-pressed="true"]');
  if (!th) return;
  th.style.transition = animate ? "" : "none";
  if (!on) {
    th.style.width = "0px";
    return;
  }
  th.style.transform = `translateX(${on.offsetLeft}px)`;
  th.style.width = `${on.offsetWidth}px`;
}

/**
 * Segmented control with a 200ms gliding raised pill thumb matching wiib-web Seg.
 */
export function Seg<T extends string>({
  value,
  onChange,
  options,
  className = "",
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SlidingOption<T>[];
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const placedRef = useRef(false);

  useLayoutEffect(() => {
    if (!ref.current) return;
    placeSegThumb(ref.current, placedRef.current);
    placedRef.current = true;
  }, [value]);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const ro = new ResizeObserver(() => placeSegThumb(box, false));
    ro.observe(box);
    box.querySelectorAll("button").forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [options.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!d) return;
    const btns = Array.from(e.currentTarget.querySelectorAll("button"));
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement) + d;
    if (idx < 0 || idx >= btns.length) return;
    e.preventDefault();
    btns[idx].focus();
    onChange(options[idx].value);
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`seg ${className}`}
    >
      <i className="th" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function placeTabBar(box: HTMLElement, animate: boolean) {
  const bar = box.querySelector<HTMLElement>(".bar2");
  const on = box.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!bar) return;
  bar.style.transition = animate ? "" : "none";
  if (!on) {
    bar.style.width = "0px";
    return;
  }
  bar.style.transform = `translateX(${on.offsetLeft}px)`;
  bar.style.width = `${on.offsetWidth}px`;
}

/**
 * Underline tabs with a smooth sliding ink bar matching wiib-web Tabs.
 */
export function SlidingTabs<T extends string>({
  value,
  onChange,
  items,
  className = "",
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: SlidingOption<T>[];
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const placedRef = useRef(false);
  const keys = items.map((i) => i.value).join("|");

  useLayoutEffect(() => {
    if (!ref.current) return;
    placeTabBar(ref.current, placedRef.current);
    placedRef.current = true;
  }, [value]);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const ro = new ResizeObserver(() => placeTabBar(box, false));
    ro.observe(box);
    box.querySelectorAll("button").forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [keys]);

  return (
    <div ref={ref} role="tablist" aria-label={label} className={`tabs ${className}`}>
      <i className="bar2" aria-hidden="true" />
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          onClick={() => it.value !== value && onChange(it.value)}
        >
          {it.label}
          {it.count != null && (
            <span className="rounded-full bg-[var(--color-fill)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted-foreground)]">
              {it.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Smooth grid-template-rows accordion container (180-200ms height & opacity transition).
 */
export function Collapsible({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`col ${open ? "open" : ""}`} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  );
}
