"use client";

type Mode = "ambient" | "ptt";

interface Props {
  mode: Mode;
  onChange: (mode: Mode) => void;
}

interface CardProps {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
  subtitle: string;
}

function ModeCard({ active, onClick, label, title, subtitle }: CardProps) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start p-3 rounded-[14px] border transition-all text-left"
      style={
        active
          ? {
              backgroundColor: "var(--robin-dim)",
              borderColor: "var(--robin)",
              borderWidth: "0.5px",
              boxShadow: "0 0 0 3px rgba(224,75,32,0.08)",
            }
          : {
              backgroundColor: "var(--surface)",
              borderColor: "var(--border2)",
            }
      }
    >
      <span
        className="text-[8px] font-bold font-space-mono uppercase tracking-widest mb-1"
        style={{ color: active ? "var(--robin)" : "var(--muted)" }}
      >
        {active ? "Active Mode" : "Tap to Switch"}
      </span>
      <span
        className="text-sm font-bold font-syne"
        style={{ color: active ? "var(--robin)" : "var(--text)" }}
      >
        {title}
      </span>
      <span
        className="text-[11px] font-syne mt-0.5"
        style={{ color: "var(--muted)" }}
      >
        {subtitle}
      </span>
    </button>
  );
}

export default function ModeToggle({ mode, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <ModeCard
        active={mode === "ambient"}
        onClick={() => onChange("ambient")}
        label="active"
        title="Ambient"
        subtitle="Always listening"
      />
      <ModeCard
        active={mode === "ptt"}
        onClick={() => onChange("ptt")}
        label="inactive"
        title="Push-to-talk"
        subtitle="Hold to dictate"
      />
    </div>
  );
}
