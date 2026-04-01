"use client";

import type { RobinInsight } from "@/lib/robinTypes";

interface Props {
  insights: RobinInsight[];
  loading: boolean;
}

export default function RobinInsightsPanel({ insights, loading }: Props) {
  const gaps = insights.filter((i) => i.type === "gap");
  const emInsight = insights.find((i) => i.type === "em");
  const ready = insights.find((i) => i.type === "ready");

  const highGaps = gaps.filter((g) => g.severity === "high");
  const medGaps = gaps.filter((g) => g.severity === "medium");

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-indigo-900">Robin</span>
          {loading && (
            <span className="text-xs text-indigo-400 animate-pulse">
              reviewing documentation…
            </span>
          )}
        </div>
        {!loading && ready && (
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              ready.noteQuality === "good"
                ? "bg-green-100 text-green-700 border border-green-200"
                : "bg-yellow-100 text-yellow-700 border border-yellow-200"
            }`}
          >
            {ready.noteQuality === "good" ? "Note looks good" : "Gaps to address"}
          </span>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          <div className="h-3 bg-indigo-100 rounded animate-pulse w-3/4" />
          <div className="h-3 bg-indigo-100 rounded animate-pulse w-1/2" />
        </div>
      )}

      {/* No gaps */}
      {!loading && gaps.length === 0 && (
        <p className="text-sm text-indigo-700">
          I didn&apos;t find any documentation gaps. Ready to generate.
        </p>
      )}

      {/* High severity gaps */}
      {!loading && highGaps.length > 0 && (
        <div className="space-y-2 mb-3">
          {highGaps.map((gap, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-red-400 shrink-0" />
              <p className="text-sm text-indigo-800">
                <span className="font-semibold">{gap.section}: </span>
                {gap.issue}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Medium severity gaps */}
      {!loading && medGaps.length > 0 && (
        <div className="space-y-2 mb-3">
          {medGaps.map((gap, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-yellow-400 shrink-0" />
              <p className="text-sm text-indigo-700">
                <span className="font-semibold">{gap.section}: </span>
                {gap.issue}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* E&M assessment */}
      {!loading && emInsight && (
        <div className="mt-2 rounded-md bg-white border border-indigo-100 px-3 py-2">
          <p className="text-xs font-semibold text-indigo-800">
            E&M estimate: {emInsight.emCode}{" "}
            <span className="font-normal text-indigo-600">
              ({emInsight.mdmComplexity} MDM)
            </span>
          </p>
          {emInsight.limitingFactor && (
            <p className="text-xs text-indigo-500 mt-0.5">
              {emInsight.limitingFactor}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
