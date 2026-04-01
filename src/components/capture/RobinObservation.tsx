"use client";

import { motion } from "framer-motion";

type ObservationType = "mdm_flag" | "documentation" | "liability" | "coding";

interface Props {
  type: ObservationType;
  message: string;
}

const TYPE_LABELS: Record<ObservationType, string> = {
  mdm_flag:      "MDM FLAG",
  documentation: "DOCUMENTATION",
  liability:     "LIABILITY",
  coding:        "CODING",
};

export default function RobinObservation({ type, message }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 28 }}
      className="flex items-start gap-3 bg-[var(--surface)] rounded-[14px] border border-[var(--border)] overflow-hidden"
      style={{ borderLeft: "3px solid var(--robin)" }}
    >
      {/* Robin badge */}
      <div
        className="shrink-0 w-[30px] h-[30px] rounded-lg flex items-center justify-center mt-3 ml-3"
        style={{ backgroundColor: "var(--robin)" }}
      >
        <span className="text-white font-bold text-xs font-space-mono">R</span>
      </div>

      {/* Content */}
      <div className="py-3 pr-3">
        <p
          className="text-[9px] uppercase tracking-widest font-space-mono font-bold mb-0.5"
          style={{ color: "var(--robin)" }}
        >
          ROBIN · {TYPE_LABELS[type]}
        </p>
        <p className="text-xs font-syne leading-relaxed" style={{ color: "var(--text)" }}>
          {message}
        </p>
      </div>
    </motion.div>
  );
}
