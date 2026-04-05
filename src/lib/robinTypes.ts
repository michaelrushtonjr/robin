export interface RobinInsight {
  type: "gap" | "em" | "ready" | "mdm_scaffold" | "hpi_completeness";
  // gap (legacy fields preserved for backward compat)
  section?: string;
  issue?: string;
  severity?: "high" | "medium";
  // em (legacy)
  emCode?: string;
  mdmComplexity?: string;
  limitingFactor?: string;
  // ready (legacy)
  noteQuality?: "good" | "needs_work";
}

// ─── MDM Scaffold types ───────────────────────────────────────────────────────

export type MDMComplexity = "straightforward" | "low" | "moderate" | "high";

export type HPIElement =
  | "location"
  | "quality"
  | "severity"
  | "duration"
  | "timing"
  | "context"
  | "modifying_factors"
  | "associated_signs_and_symptoms";

export interface MDMElementScore {
  complexity: MDMComplexity;
  rationale: string;
}

export interface MDMScaffold {
  problems: MDMElementScore;
  data: MDMElementScore;
  risk: MDMElementScore;
  overall_mdm: MDMComplexity;
  supported_code: string;
  next_code: string | null;
  one_thing_to_upgrade: string | null;
  scored_at: string;
}

export interface HPICompleteness {
  present: HPIElement[];
  missing: HPIElement[];
  score: number;
  brief_or_extended: "brief" | "extended";
}

// ─── Robin Audit state (consumed by RobinInsightsPanel) ──────────────────────

export interface RobinAuditState {
  hpi?: HPICompleteness;
  mdm?: MDMScaffold;
  gaps: Array<{
    gap_type: string;
    description: string;
    severity: string;
    suggested_fix: string;
  }>;
  em?: {
    code: string;
    rvu: number;
    mdm_level: string;
    rationale: string;
    upgrade_possible: boolean;
    upgrade_requires: string | null;
  };
  summary?: string;
  loading: boolean;
}

// ─── Physician Preferences (populated by Layer 2 onboarding interview) ──────

export interface RobinPreferences {
  mdm_depth: "scaffold_only" | "full_ap";
  mdm_dictation_mode: "verbatim" | "structured";
  hpi_style: "brief" | "extended";
  gap_sensitivity: "high" | "medium" | "low";
  em_posture: "conservative" | "accurate" | "aggressive";
  note_verbosity: "concise" | "standard" | "thorough";
  copy_mode: "full" | "sections";
  ekg_normal_verbosity: "full" | "impression_only";
  specialty_flags: {
    include_ems_narrative: boolean;
    auto_include_review_of_systems: boolean;
    document_negative_findings: boolean;
  };
  interview_completed_at: string;
  interview_version: number;
}
