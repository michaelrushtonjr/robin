import type { MDMComplexity } from "./robinTypes";

const COMPLEXITY_RANK: Record<MDMComplexity, number> = {
  straightforward: 0,
  low: 1,
  moderate: 2,
  high: 3,
};

const RANK_TO_COMPLEXITY: MDMComplexity[] = [
  "straightforward",
  "low",
  "moderate",
  "high",
];

// AMA 2021 rule: overall MDM = second-highest of the three elements
export function deriveOverallMDM(
  problems: MDMComplexity,
  data: MDMComplexity,
  risk: MDMComplexity
): MDMComplexity {
  const ranks = [
    COMPLEXITY_RANK[problems],
    COMPLEXITY_RANK[data],
    COMPLEXITY_RANK[risk],
  ].sort((a, b) => b - a);
  return RANK_TO_COMPLEXITY[ranks[1]];
}

export function getNextCode(current: string): string | null {
  const ordered = ["99281", "99282", "99283", "99284", "99285", "99291"];
  const idx = ordered.indexOf(current);
  if (idx === -1 || idx === ordered.length - 1) return null;
  return ordered[idx + 1];
}

export const RVU_MAP: Record<string, number> = {
  "99281": 0.48,
  "99282": 0.93,
  "99283": 1.6,
  "99284": 2.6,
  "99285": 3.8,
  "99291": 4.5,
};
