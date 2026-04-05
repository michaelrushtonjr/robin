"use client";

interface EncounterOption {
  id: string;
  label: string;
  room: string | null;
}

interface DisambiguationCardProps {
  options: EncounterOption[];
  onSelect: (encounterId: string) => void;
  onDismiss: () => void;
}

export default function DisambiguationCard({
  options,
  onSelect,
  onDismiss,
}: DisambiguationCardProps) {
  return (
    <div
      className="rounded-[18px] p-4"
      style={{
        backgroundColor: "var(--amber-dim)",
        border: "1px solid rgba(245,166,35,0.20)",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white font-bold font-syne text-xs mt-0.5"
          style={{ backgroundColor: "var(--amber)" }}
        >
          R
        </div>
        <div className="flex-1">
          <p
            className="text-sm font-bold font-syne mb-2"
            style={{ color: "var(--amber)" }}
          >
            Which encounter?
          </p>
          <div className="flex flex-wrap gap-2">
            {options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => onSelect(opt.id)}
                className="px-3 py-1.5 rounded-[10px] text-sm font-syne font-semibold transition-all active:scale-95"
                style={{
                  backgroundColor: "var(--surface)",
                  border: "1px solid var(--border2)",
                  color: "var(--text)",
                }}
              >
                {opt.label}
                {opt.room ? ` — Rm ${opt.room}` : ""}
              </button>
            ))}
          </div>
          <button
            onClick={onDismiss}
            className="mt-2 text-xs font-syne"
            style={{ color: "var(--muted)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
