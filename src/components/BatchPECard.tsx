"use client";

interface PatientOption {
  id: string;
  label: string;
  room: string | null;
  done: boolean;
}

interface BatchPECardProps {
  patients: PatientOption[];
  onSelect: (encounterId: string) => void;
  onDismiss: () => void;
}

export default function BatchPECard({
  patients,
  onSelect,
  onDismiss,
}: BatchPECardProps) {
  const remaining = patients.filter((p) => !p.done);

  return (
    <div
      className="rounded-[18px] p-4"
      style={{
        backgroundColor: "var(--robin-dim)",
        border: "1px solid rgba(224,75,32,0.20)",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white font-bold font-syne text-xs mt-0.5"
          style={{ backgroundColor: "var(--robin)" }}
        >
          R
        </div>
        <div className="flex-1">
          <p
            className="text-sm font-bold font-syne mb-2"
            style={{ color: "var(--robin)" }}
          >
            Physical Exams Needed
          </p>
          <div className="flex flex-wrap gap-2">
            {patients.map((p) => (
              <button
                key={p.id}
                onClick={() => !p.done && onSelect(p.id)}
                disabled={p.done}
                className="px-3 py-1.5 rounded-[10px] text-sm font-syne font-semibold transition-all active:scale-95 disabled:opacity-40"
                style={{
                  backgroundColor: p.done
                    ? "var(--teal-dim)"
                    : "var(--surface)",
                  border: `1px solid ${p.done ? "rgba(0,168,150,0.20)" : "var(--border2)"}`,
                  color: p.done ? "var(--teal)" : "var(--text)",
                }}
              >
                {p.label}
                {p.room ? ` — Rm ${p.room}` : ""}
                {p.done ? " ✓" : ""}
              </button>
            ))}
          </div>
          <p
            className="text-[10px] font-space-mono mt-2"
            style={{ color: "rgba(224,75,32,0.60)" }}
          >
            {remaining.length > 0
              ? "Tap a patient to dictate."
              : "All done!"}
          </p>
          <button
            onClick={onDismiss}
            className="mt-1 text-xs font-syne"
            style={{ color: "var(--muted)" }}
          >
            {remaining.length === 0 ? "Close" : "Skip remaining"}
          </button>
        </div>
      </div>
    </div>
  );
}
