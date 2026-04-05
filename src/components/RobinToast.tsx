"use client";

import { useEffect, useState } from "react";

export interface ToastData {
  id: string;
  message: string;
  type: "success" | "info";
}

interface RobinToastProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

export default function RobinToast({ toasts, onDismiss }: RobinToastProps) {
  return (
    <div className="fixed bottom-20 left-0 right-0 z-50 flex flex-col items-center gap-2 px-4 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastData;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Fade in
    requestAnimationFrame(() => setVisible(true));
    // Auto-dismiss after 4s
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(toast.id), 300);
    }, 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      className="pointer-events-auto max-w-md w-full rounded-[14px] px-4 py-3 flex items-start gap-3 transition-all duration-300"
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
      }}
    >
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-white font-bold font-space-mono text-[10px] mt-0.5"
        style={{ backgroundColor: "var(--robin)" }}
      >
        R
      </div>
      <div className="flex-1 min-w-0">
        <p
          className="text-sm font-syne leading-snug"
          style={{ color: "var(--text)" }}
        >
          {toast.message}
        </p>
      </div>
      <button
        onClick={() => {
          setVisible(false);
          setTimeout(() => onDismiss(toast.id), 300);
        }}
        className="shrink-0 text-xs font-syne mt-0.5"
        style={{ color: "var(--muted)" }}
      >
        Dismiss
      </button>
    </div>
  );
}
