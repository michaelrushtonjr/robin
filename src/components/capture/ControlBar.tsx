"use client";

interface Props {
  isPaused: boolean;
  onPause: () => void;
  onDashboard: () => void;
  onEnd: () => void;
}

export default function ControlBar({ isPaused, onPause, onDashboard, onEnd }: Props) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {/* Pause / Resume */}
      <button
        onClick={onPause}
        className="flex items-center justify-center gap-1.5 py-3.5 rounded-[14px] border font-syne text-sm font-semibold transition-all active:scale-95"
        style={{
          backgroundColor: "var(--surface)",
          borderColor: "var(--border2)",
          color: "var(--muted)",
        }}
      >
        {isPaused ? (
          <>
            <span>▶</span>
            <span>Resume</span>
          </>
        ) : (
          <>
            <span>⏸</span>
            <span>Pause</span>
          </>
        )}
      </button>

      {/* Dashboard — center CTA */}
      <button
        onClick={onDashboard}
        className="flex items-center justify-center gap-1.5 py-3.5 rounded-[14px] font-syne text-sm font-bold text-white transition-all active:scale-95"
        style={{
          backgroundColor: "var(--robin)",
          boxShadow: "0 3px 12px rgba(224,75,32,0.30)",
        }}
      >
        Dashboard
      </button>

      {/* End encounter */}
      <button
        onClick={onEnd}
        className="flex items-center justify-center gap-1.5 py-3.5 rounded-[14px] border font-syne text-sm font-semibold transition-all active:scale-95"
        style={{
          backgroundColor: "var(--surface)",
          borderColor: "rgba(224,75,32,0.25)",
          color: "var(--robin)",
        }}
      >
        End
      </button>
    </div>
  );
}
