"use client";

import { motion } from "framer-motion";

export type SpeakerType = "physician" | "patient" | "interim";

export interface TranscriptLineData {
  id: string;
  speaker: SpeakerType;
  text: string;
}

interface Props {
  line: TranscriptLineData;
}

const SPEAKER_STYLES: Record<
  SpeakerType,
  { bg: string; border: string; label: string; labelColor: string }
> = {
  physician: {
    bg: "var(--robin-dim)",
    border: "var(--robin)",
    label: "DR",
    labelColor: "var(--robin)",
  },
  patient: {
    bg: "var(--surface2)",
    border: "var(--border2)",
    label: "PT",
    labelColor: "var(--muted)",
  },
  interim: {
    bg: "var(--amber-dim)",
    border: "var(--amber)",
    label: "DR",
    labelColor: "var(--amber)",
  },
};

export default function TranscriptLine({ line }: Props) {
  const style = SPEAKER_STYLES[line.speaker];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="flex items-start gap-2 px-3 py-2 rounded-lg"
      style={{
        backgroundColor: style.bg,
        borderLeft: `2px solid ${style.border}`,
      }}
    >
      <span
        className="text-[9px] font-bold font-space-mono uppercase shrink-0 mt-0.5"
        style={{ color: style.labelColor }}
      >
        {style.label}
      </span>
      <span className="text-xs font-syne leading-relaxed" style={{ color: "var(--text)" }}>
        {line.text}
        {line.speaker === "interim" && (
          <motion.span
            animate={{ opacity: [1, 0] }}
            transition={{ duration: 0.7, repeat: Infinity, repeatType: "reverse" }}
            className="inline-block w-[2px] h-3 ml-0.5 rounded-full align-middle"
            style={{ backgroundColor: "var(--amber)" }}
          />
        )}
      </span>
    </motion.div>
  );
}
