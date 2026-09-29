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
    (
      panel?.querySelector<HTMLElement>(
        "input:not(:disabled),textarea:not(:disabled)",
      ) ?? panel?.querySelector<HTMLElement>("button:not(:disabled)")
    )?.focus();
    // Listen on the document, not the panel: an action that removes the focused
    // control (Clear, Send back…) drops focus to <body>, and a panel listener
    // would then miss Escape and let Tab walk into the page behind the dialog.
    const key = (e: KeyboardEvent) => {
      if (!panel) return;
      // Only the topmost dialog answers (the palette can open over another);
      // portals mount in order, so that is the last one in the document.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== panel) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
      if (e.key !== "Tab") return;
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
      if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
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
