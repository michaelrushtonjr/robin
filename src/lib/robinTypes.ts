export interface RobinInsight {
  type: "gap" | "em" | "ready";
  // gap
  section?: string;
  issue?: string;
  severity?: "high" | "medium";
  // em
  emCode?: string;
  mdmComplexity?: string;
  limitingFactor?: string;
  // ready
  noteQuality?: "good" | "needs_work";
}
