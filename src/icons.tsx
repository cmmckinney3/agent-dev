// Lightweight inline icon set (Lucide-style, 24x24 viewBox, currentColor).
// Kept local so the app has zero icon-font / network dependency.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (p: IconProps) => (
  <Base {...p}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </Base>
);

export const StopIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Base>
);

export const RestartIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Base>
);

export const FolderIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 5h5l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4 5Z" />
  </Base>
);

export const BroadcastIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="2" />
    <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
  </Base>
);

export const CrucibleIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 10h14l-1.6 7.2A2.4 2.4 0 0 1 15 19H9a2.4 2.4 0 0 1-2.4-1.8L5 10Z" />
    <path d="M7 10c.9-1.3 2.5-2 5-2s4.1.7 5 2" />
    <path d="M9 14h6" />
    <path d="M12 5V3" />
    <path d="M7.5 6 6 4.5" />
    <path d="M16.5 6 18 4.5" />
  </Base>
);

export const SendIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
  </Base>
);

export const TerminalIcon = (p: IconProps) => (
  <Base {...p}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </Base>
);

export const SearchIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Base>
);

export const CloseIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Base>
);

/** Square divided into two columns — split a pane into a new column. */
export const SplitRightIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <path d="M12 5v14" />
  </Base>
);

/** Square divided into two rows — split a pane downward. */
export const SplitDownIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <path d="M3 12h18" />
  </Base>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 15 6-6 6 6" />
  </Base>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 9 6 6 6-6" />
  </Base>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m15 18-6-6 6-6" />
  </Base>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m9 18 6-6-6-6" />
  </Base>
);

/** Stylized board with three columns — the task board identity. */
export const KanbanIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="10" rx="1" />
    <rect x="17" y="4" width="5" height="13" rx="1" />
  </Base>
);

export const PlusIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

export const TrashIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </Base>
);

export const PencilIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Base>
);

/** Drag handle for rearranging session panes. */
export const GripIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="9" cy="6" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="18" r="1" />
  </Base>
);

/** Bring the bound pane to attention — used by "Focus pane". */
export const CrosshairIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="2" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="2" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="22" y2="12" />
  </Base>
);

/** Panel-left glyph for the collapse/expand rail toggle. */
export const PanelLeftIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </Base>
);

/** The agent-catalog identity — opens the Agents manager. */
export const BotIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 8V4H8" />
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </Base>
);

/** Pulse line — the Usage page identity. */
export const ActivityIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </Base>
);

export const CheckIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Base>
);

/** Failed-run outcome badge. */
export const AlertTriangleIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Base>
);

/** Sliders — the Settings page identity. */
export const SettingsIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 21v-7" />
    <path d="M4 10V3" />
    <path d="M12 21v-9" />
    <path d="M12 8V3" />
    <path d="M20 21v-5" />
    <path d="M20 12V3" />
    <path d="M1 14h6" />
    <path d="M9 8h6" />
    <path d="M17 16h6" />
  </Base>
);

/** API credentials (Providers section). */
export const KeyIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.7 12.3 8.3-8.3" />
    <path d="m16.5 6.5 2.5 2.5" />
    <path d="m19.5 3.5 2.5 2.5" />
  </Base>
);

/** Stored workspace data (History & data section). */
export const DatabaseIcon = (p: IconProps) => (
  <Base {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </Base>
);
