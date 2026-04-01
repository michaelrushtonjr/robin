"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import TranscriptLine, { type TranscriptLineData } from "./TranscriptLine";

interface Props {
  lines: TranscriptLineData[];
}

export default function TranscriptFeed({ lines }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className="bg-[var(--surface)] rounded-[18px] border border-[var(--border)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span
          className="text-[9px] uppercase tracking-widest font-space-mono"
          style={{ color: "var(--muted)" }}
        >
          Live Transcript
        </span>
        <div
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-full"
          style={{ backgroundColor: "rgba(224,75,32,0.10)" }}
        >
          <motion.span
            animate={{ opacity: [1, 0.2] }}
            transition={{ duration: 0.9, repeat: Infinity, repeatType: "reverse" }}
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "var(--robin)" }}
          />
          <span
            className="text-[9px] font-bold font-space-mono uppercase tracking-widest"
            style={{ color: "var(--robin)" }}
          >
            Live
          </span>
        </div>
      </div>

      {/* Lines */}
      <div className="flex flex-col gap-1 p-3 max-h-52 overflow-y-auto">
        <AnimatePresence initial={false}>
          {lines.length === 0 ? (
            <motion.p
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-xs font-space-mono text-center py-4"
              style={{ color: "var(--muted)" }}
            >
              Waiting for speech…
            </motion.p>
          ) : (
            lines.map((line) => <TranscriptLine key={line.id} line={line} />)
          )}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
