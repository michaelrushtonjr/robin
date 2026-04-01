"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";

interface Props {
  isActive: boolean;
  wordCount: number;
}

const BAR_COUNT = 32;

export default function WaveformVisualizer({ isActive, wordCount }: Props) {
  const bars = useMemo(
    () =>
      Array.from({ length: BAR_COUNT }, (_, i) => ({
        id: i,
        peak: Math.floor(Math.random() * 28) + 8,
        delay: (i / BAR_COUNT) * 0.6,
      })),
    []
  );

  return (
    <div className="bg-[var(--surface)] rounded-[18px] border border-[var(--border)] p-5">
      {/* Bars */}
      <div className="flex items-end justify-center gap-[3px] h-12 mb-4">
        {bars.map((bar) => (
          <motion.div
            key={bar.id}
            className="w-[3px] rounded-sm"
            style={{ backgroundColor: "var(--robin)", opacity: 0.7 }}
            animate={
              isActive
                ? {
                    height: [3, bar.peak, 3],
                    transition: {
                      duration: 0.8 + Math.random() * 0.4,
                      repeat: Infinity,
                      repeatType: "mirror",
                      delay: bar.delay,
                      ease: "easeInOut",
                    },
                  }
                : { height: 3 }
            }
            initial={{ height: 3 }}
          />
        ))}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 divide-x divide-[var(--border)]">
        {[
          { label: "Words", value: wordCount.toString() },
          { label: "Confidence", value: "98%" },
          { label: "Speakers", value: "2" },
        ].map((stat) => (
          <div key={stat.label} className="flex flex-col items-center gap-0.5 px-2">
            <span
              className="text-[9px] uppercase tracking-widest font-space-mono"
              style={{ color: "var(--muted)" }}
            >
              {stat.label}
            </span>
            <span
              className="text-base font-bold font-space-mono"
              style={{ color: "var(--text)" }}
            >
              {stat.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
