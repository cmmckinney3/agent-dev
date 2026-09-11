import { ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";
export default function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    (panel?.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled)') ?? panel?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
      if (e.key !== "Tab" || !panel) return;
      const els = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
        ),
      ).filter((el) => el.getClientRects().length > 0);
      if (!els.length) {
        e.preventDefault();
        return;
      }
      const first = els[0],
        last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    panel?.addEventListener("keydown", key);
    return () => {
      panel?.removeEventListener("keydown", key);
      prior?.focus();
    };
  }, []);
  return createPortal(
    <div className="dialog-scrim">
      <div
        ref={ref}
        className={`dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="dialog-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
