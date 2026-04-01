"use client";

import { useEffect, useRef } from "react";
import type { TranscriptSegment } from "@/hooks/useDeepgram";

interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  interimText: string;
}

// Cycles through 8 distinct colors for any number of speakers
const SPEAKER_COLOR_CYCLE = [
  "text-blue-700",
  "text-emerald-700",
  "text-violet-700",
  "text-orange-600",
  "text-rose-600",
  "text-cyan-700",
  "text-amber-600",
  "text-teal-700",
];

function getSpeakerStyle(speaker: number | undefined) {
  if (speaker === undefined) return { label: "—", class: "text-gray-400" };
  const colorClass = SPEAKER_COLOR_CYCLE[speaker % SPEAKER_COLOR_CYCLE.length];
  return { label: `Spkr ${speaker}`, class: `${colorClass} font-semibold` };
}

// Merge consecutive segments from the same speaker into blocks
function groupSegments(segments: TranscriptSegment[]) {
  return segments.reduce<Array<{ speaker: number | undefined; text: string }>>(
    (acc, seg) => {
      const last = acc[acc.length - 1];
      if (last && last.speaker === seg.speaker) {
        last.text += ` ${seg.text}`;
        return acc;
      }
      acc.push({ speaker: seg.speaker, text: seg.text });
      return acc;
    },
    []
  );
}

export type { TranscriptSegment };

export default function TranscriptPanel({
  segments,
  interimText,
}: TranscriptPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const finalSegments = segments.filter((s) => s.isFinal);
  const grouped = groupSegments(finalSegments);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [segments, interimText]);

  const isEmpty = finalSegments.length === 0 && !interimText;

  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">Live Transcript</h3>
        {finalSegments.length > 0 && (
          <span className="text-xs text-gray-400">
            {new Set(finalSegments.map((s) => s.speaker).filter((s) => s !== undefined)).size} speaker(s)
          </span>
        )}
      </div>
      <div className="h-64 overflow-y-auto px-4 py-3 space-y-2 text-sm leading-relaxed">
        {isEmpty ? (
          <p className="text-gray-400 italic">
            Transcript will appear here when you start recording...
          </p>
        ) : (
          <>
            {grouped.map((block, i) => {
              const style = getSpeakerStyle(block.speaker);
              return (
                <div key={i} className="flex gap-2">
                  <span className={`shrink-0 text-xs mt-0.5 w-12 ${style.class}`}>
                    {style.label}
                  </span>
                  <span className="text-gray-900">{block.text}</span>
                </div>
              );
            })}
            {interimText && (
              <div className="flex gap-2">
                <span className="shrink-0 text-xs mt-0.5 w-12 text-gray-300">···</span>
                <span className="text-gray-400 italic">{interimText}</span>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
