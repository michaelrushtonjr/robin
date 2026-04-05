"use client";

export interface ConfirmCardData {
  id: string;
  message: string;
  detail?: string;
  payload: unknown;
  commandType: string;
  shiftId: string;
  encounterId?: string;
}

interface ConfirmCardProps {
  card: ConfirmCardData;
  onConfirm: (card: ConfirmCardData) => void;
  onDismiss: (id: string) => void;
}

export default function ConfirmCard({
  card,
  onConfirm,
  onDismiss,
}: ConfirmCardProps) {
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
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-bold font-syne"
            style={{ color: "var(--amber)" }}
          >
            Robin heard:
          </p>
          <p
            className="text-sm font-syne mt-0.5 italic"
            style={{ color: "var(--text)" }}
          >
            {card.message}
          </p>
          {card.detail && (
            <p
              className="text-xs font-space-mono mt-1"
              style={{ color: "var(--muted)" }}
            >
              {card.detail}
            </p>
          )}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => onConfirm(card)}
              className="px-4 py-1.5 rounded-[10px] font-syne font-bold text-sm text-white transition-all active:scale-95"
              style={{
                backgroundColor: "var(--robin)",
                boxShadow: "0 2px 8px rgba(224,75,32,0.25)",
              }}
            >
              Confirm
            </button>
            <button
              onClick={() => onDismiss(card.id)}
              className="px-4 py-1.5 rounded-[10px] border font-syne font-semibold text-sm transition-all active:scale-95"
              style={{
                borderColor: "var(--border2)",
                color: "var(--muted)",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
