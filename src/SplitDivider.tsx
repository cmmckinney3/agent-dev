import { useRef, useState } from "react";
export default function SplitDivider({
  orientation,
  label,
  valueNow,
  onResize,
}: {
  orientation: "col" | "row";
  label: string;
  valueNow: number;
  onResize: (sizes: number[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<
    { origin: number; sizes: number[]; index: number } | undefined
  >(undefined);
  const [active, setActive] = useState(false);
  const measure = () => {
    const children = Array.from(ref.current?.parentElement?.children ?? []);
    let index = -1;
    const sizes: number[] = [];
    for (const child of children) {
      if (child === ref.current) index = sizes.length - 1;
      else if (!child.classList.contains("ws-divider")) {
        const r = child.getBoundingClientRect();
        sizes.push(orientation === "col" ? r.width : r.height);
      }
    }
    return { sizes, index };
  };
  const shift = (base: { sizes: number[]; index: number }, delta: number) => {
    const { sizes, index } = base;
    if (index < 0 || index >= sizes.length - 1) return;
    const next = [...sizes];
    const pair = next[index] + next[index + 1];
    const min = Math.min(orientation === "col" ? 220 : 140, pair / 2);
    next[index] = Math.max(min, Math.min(pair - min, next[index] + delta));
    next[index + 1] = pair - next[index];
    onResize(next);
  };
  return (
    <div
      ref={ref}
      className={`ws-divider ${orientation} ${active ? "dragging" : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation === "col" ? "vertical" : "horizontal"}
      aria-valuenow={valueNow}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      title="Drag to resize; double-click to equalize"
      onPointerDown={(e) => {
        if (e.button) return;
        drag.current = {
          ...measure(),
          origin: orientation === "col" ? e.clientX : e.clientY,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (drag.current)
          shift(
            drag.current,
            (orientation === "col" ? e.clientX : e.clientY) -
              drag.current.origin,
          );
      }}
      onPointerUp={() => {
        drag.current = undefined;
        setActive(false);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setActive(false);
      }}
      onDoubleClick={() => {
        const b = measure();
        shift(b, (b.sizes[b.index + 1] - b.sizes[b.index]) / 2);
      }}
      onKeyDown={(e) => {
        const keys =
          orientation === "col"
            ? ["ArrowLeft", "ArrowRight"]
            : ["ArrowUp", "ArrowDown"];
        if (keys.includes(e.key)) {
          e.preventDefault();
          shift(measure(), e.key === keys[0] ? -32 : 32);
        }
      }}
    />
  );
}
