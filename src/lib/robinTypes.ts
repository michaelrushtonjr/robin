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

// ─── Clinical decision tool surfacing (Loop A) ──────────────────────────────

export type ClinicalToolName =
  | "HEART"
  | "PERC"
  | "SF_Syncope"
  | "Canadian_CT_Head"
  | "Ottawa_Ankle"
  | "NEXUS";

/**
 * Per-tool pre-fill schemas. Each tool surfaces a structured payload with
 * only the fields Robin heard in the transcript. Omitted fields = not heard.
 *
 * The values are intentionally typed (not free-form strings) so the panel
 * can render proper UIs and the eval rubric can assert specific elements.
 */
export interface HEARTPreFill {
  history?: "typical" | "non_typical" | "atypical";
  ekg?: "normal" | "non_specific" | "significant_st_deviation";
  age?: number;
  risk_factors_count?: number;
  risk_factors_heard?: string[];
  troponin?: "normal" | "1-3x_uln" | ">3x_uln";
}

export interface PERCPreFill {
  age_under_50?: boolean;
  hr_under_100?: boolean;
  spo2_at_least_95?: boolean;
  no_hemoptysis?: boolean;
  no_estrogen_use?: boolean;
  no_recent_surgery_trauma?: boolean;
  no_prior_dvt_pe?: boolean;
  no_unilateral_leg_swelling?: boolean;
}

export interface SFSyncopePreFill {
  chf_history?: boolean;
  hematocrit_under_30?: boolean;
  abnormal_ekg?: boolean;
  shortness_of_breath?: boolean;
  sbp_under_90?: boolean;
}

export interface CanadianCTHeadPreFill {
  high_risk?: {
    gcs_under_15_at_2h?: boolean;
    suspected_open_depressed_skull_fx?: boolean;
    signs_basilar_skull_fx?: boolean;
    vomiting_2_or_more?: boolean;
    age_65_or_over?: boolean;
  };
  medium_risk?: {
    amnesia_over_30min?: boolean;
    dangerous_mechanism?: boolean;
  };
}

export interface OttawaAnklePreFill {
  ankle?: {
    posterior_lateral_malleolus_tenderness?: boolean;
    posterior_medial_malleolus_tenderness?: boolean;
    cannot_bear_weight_4_steps?: boolean;
  };
  foot?: {
    base_5th_metatarsal_tenderness?: boolean;
    navicular_tenderness?: boolean;
    cannot_bear_weight_4_steps?: boolean;
  };
}

export interface NEXUSPreFill {
  midline_c_spine_tenderness?: boolean | null;
  focal_neuro_deficit?: boolean;
  altered_alertness?: boolean;
  intoxication?: boolean;
  painful_distracting_injury?: boolean;
}

export type ClinicalToolPreFill =
  | { tool_name: "HEART"; pre_fill: HEARTPreFill }
  | { tool_name: "PERC"; pre_fill: PERCPreFill }
  | { tool_name: "SF_Syncope"; pre_fill: SFSyncopePreFill }
  | { tool_name: "Canadian_CT_Head"; pre_fill: CanadianCTHeadPreFill }
  | { tool_name: "Ottawa_Ankle"; pre_fill: OttawaAnklePreFill }
  | { tool_name: "NEXUS"; pre_fill: NEXUSPreFill };

/**
 * A single surfacing event. The `surface_id` is the stable identifier that
 * item 19's `surfacing_events` table will use to track engaged|ignored.
 * Wired from day one so engagement tracking is not a retrofit.
 */
export type ClinicalToolSurfacing = ClinicalToolPreFill & {
  trigger_rationale: string;
  pre_fill_summary: string;
  missing_elements: string[];
  surface_id: string;
  surfaced_at: string;
};

// ─── Differential expander (Loop A sibling, item 16) ────────────────────────

/**
 * Pretest probability bucket — how likely this diagnosis is in THIS
 * presentation (not general population prevalence).
 */
export type PretestBucket = "common" | "uncommon" | "rare";

/**
 * Badness-if-missed bucket — the downside of failing to consider this
 * diagnosis. "life_threatening" drives surfacing order even when pretest
 * probability is low: an aortic dissection worth ruling out is worth
 * ruling out even if rare.
 */
export type BadnessBucket = "life_threatening" | "serious" | "benign";

/**
 * A single diagnosis Robin is suggesting the physician also consider.
 * Only added when (a) presentation specifically supports it AND (b) the
 * physician has not already mentioned it in the transcript.
 *
 * The `surface_id` matches the ClinicalToolSurfacing.surface_id format
 * so item 19's surfacing_events table can log engagement for both
 * Loop A surfaces through the same pathway.
 */
export interface DifferentialAddition {
  diagnosis: string;
  pretest_probability: PretestBucket;
  badness_if_missed: BadnessBucket;
  rationale: string;
  missing_workup: string[];
  surface_id: string;
  surfaced_at: string;
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
  /** Clinical decision tools surfaced for this encounter. */
  surfacedTools: ClinicalToolSurfacing[];
  /** Differentials Robin has added (dx the physician didn't mention). */
  differentials: DifferentialAddition[];
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

// ─── Living Note (Note Dashboard) ───────────────────────────────────────────

export interface NoteSection {
  content: string | null;
  last_updated_at: string | null;
  updated_by: "robin" | "physician" | "robin_generated";
}

export interface OrderEntry {
  id: string;
  ordered_at: string;
  description: string;
  order_type: "labs" | "imaging" | "medication" | "other";
  mdm_relevant: boolean;
}

export interface EKGEntry {
  id: string;
  performed_at: string;
  dictation_raw: string;
  interpretation: string;
  normal_shorthand: boolean;
}

export interface RadiologyEntry {
  id: string;
  study_type: string;
  ordered_at: string;
  result: string | null;
  dictated_at: string | null;
}

export interface LabResultEntry {
  id: string;
  logged_at: string;
  content: string;
}

export interface ProcedureEntry {
  id: string;
  procedure_type: string;
  performed_at: string;
  qa_responses: Record<string, string>;
  procedure_note: string;
}

export interface EDCourseEntry {
  id: string;
  entry_type: "reassessment" | "reeval" | "response_to_treatment" | "general";
  performed_at: string;
  content: string;
}

export interface ConsultEntry {
  id: string;
  consulting_service: string;
  consulting_physician: string | null;
  contacted_at: string;
  recommendations: string | null;
}

export interface EncounterNote {
  chief_complaint: NoteSection;
  hpi: NoteSection;
  review_of_systems: NoteSection;
  physical_exam: NoteSection;
  orders: OrderEntry[];
  diagnostic_results: {
    ekgs: EKGEntry[];
    radiology: RadiologyEntry[];
  };
  labs: LabResultEntry[];
  mdm: NoteSection;
  procedures: ProcedureEntry[];
  ed_course: EDCourseEntry[];
  consults: ConsultEntry[];
  final_diagnosis: NoteSection;
  disposition: NoteSection;
  discharge_instructions: NoteSection;
  created_at: string;
  finalized_at: string | null;
  note_version: number;
}

export type NoteBadge =
  | "PE"
  | "MDM"
  | "Dx"
  | "Dispo"
  | "Orders"
  | "Consult"
  | "Complete";

export function computeNoteBadges(
  note: EncounterNote | null,
  encounterCreatedAt: string
): NoteBadge[] {
  if (!note) return ["PE", "MDM", "Dx", "Dispo"];
  const badges: NoteBadge[] = [];
  if (!note.physical_exam?.content) badges.push("PE");
  const ageMinutes =
    (Date.now() - new Date(encounterCreatedAt).getTime()) / 60000;
  if (!note.mdm?.content && ageMinutes > 20) badges.push("MDM");
  if (!note.final_diagnosis?.content) badges.push("Dx");
  if (!note.disposition?.content) badges.push("Dispo");
  if (
    note.orders.length > 0 &&
    note.labs.length === 0 &&
    note.diagnostic_results.radiology.length === 0
  )
    badges.push("Orders");
  if (note.consults.some((c) => !c.recommendations)) badges.push("Consult");

  const required = ["PE", "MDM", "Dx", "Dispo"] as const;
  if (required.every((b) => !badges.includes(b))) badges.push("Complete");

  return badges;
}

export function createEmptyNote(): EncounterNote {
  const emptySection: NoteSection = {
    content: null,
    last_updated_at: null,
    updated_by: "robin",
  };
  return {
    chief_complaint: { ...emptySection },
    hpi: { ...emptySection },
    review_of_systems: { ...emptySection },
    physical_exam: { ...emptySection },
    orders: [],
    diagnostic_results: { ekgs: [], radiology: [] },
    labs: [],
    mdm: { ...emptySection },
    procedures: [],
    ed_course: [],
    consults: [],
    final_diagnosis: { ...emptySection },
    disposition: { ...emptySection },
    discharge_instructions: { ...emptySection },
    created_at: new Date().toISOString(),
    finalized_at: null,
    note_version: 1,
  };
}

// ─── Memory architecture (item 16.5) ────────────────────────────────────────
//
// Three tiers today (+ one proposed). See /docs/memory-architecture.md:
//   Tier 1: encounters.mdm_data           — encounter-level
//   Tier 2: shifts.robin_memory           — shift-level
//   Tier 3a: physicians.robin_preferences — longitudinal, stated intent
//   Tier 3b: physicians.robin_longitudinal — longitudinal, observed behavior

// ─── Tier 2: Shift memory ───────────────────────────────────────────────────

export interface ShiftEncounterRollup {
  encounter_id: string;
  chief_complaint: string;
  code: string | null;
  overall_mdm: MDMComplexity | null;
  /** Gap types flagged by robin-think. */
  gaps_flagged: string[];
  /** Gap types believed addressed at note finalization (heuristic match). */
  gaps_addressed: string[];
  surfacings_shown: Array<{
    surface_id: string;
    tool_name: ClinicalToolName;
  }>;
  differentials_shown: Array<{
    surface_id: string;
    diagnosis: string;
  }>;
  finalized_at: string | null;
  last_updated_at: string;
}

export interface ShiftObservedPatterns {
  dictation_style?: "batch_pe" | "per_encounter";
  vague_workup_language_count: number;
  critical_care_count: number;
}

export interface ShiftTally {
  gaps_by_type: Record<string, number>;
  surfacings_by_tool: Partial<Record<ClinicalToolName, number>>;
  codes_distribution: Record<string, number>;
}

export interface ShiftMemory {
  encounters_this_shift: ShiftEncounterRollup[];
  observed_patterns: ShiftObservedPatterns;
  tally: ShiftTally;
  version: 1;
}

export function createEmptyShiftMemory(): ShiftMemory {
  return {
    encounters_this_shift: [],
    observed_patterns: {
      vague_workup_language_count: 0,
      critical_care_count: 0,
    },
    tally: {
      gaps_by_type: {},
      surfacings_by_tool: {},
      codes_distribution: {},
    },
    version: 1,
  };
}

// ─── Tier 3b: Longitudinal memory (Robin's observations across shifts) ──────

export interface ChronicallyMissedGap {
  gap_type: string;
  /** Flagged-but-not-addressed rate across finalized notes. */
  miss_rate: number;
  encounter_count: number;
  last_seen: string;
}

export interface ToolEngagementStats {
  surfaced_count: number;
  /** Populated once item 19's surfacing_events table ships. Stays 0 until. */
  engaged_count: number;
  engagement_rate: number;
}

/**
 * A delta Robin observed between stated preferences and observed behavior.
 * Surfaces only at reconciliation moments (shift close, settings). Never
 * used to silently override a preference.
 */
export interface PendingObservation {
  id: string;
  observation: string;
  flagged_at: string;
  resolved_at: string | null;
  resolution: "updated_preference" | "dismissed" | null;
}

export interface RobinLongitudinal {
  shifts_observed: number;
  encounters_observed: number;

  coding_distribution: {
    counts: Record<string, number>;
    critical_care_rate: number;
  };

  chronically_missed_gaps: ChronicallyMissedGap[];

  tool_engagement: Partial<Record<ClinicalToolName, ToolEngagementStats>>;

  differential_engagement: {
    added_count: number;
    engaged_count: number;
  };

  agent_act_patterns: {
    batch_pe_shift_count: number;
    per_encounter_shift_count: number;
  };

  pending_observations: PendingObservation[];

  last_aggregated_at: string;
  version: 1;
}

export function createEmptyLongitudinal(): RobinLongitudinal {
  return {
    shifts_observed: 0,
    encounters_observed: 0,
    coding_distribution: {
      counts: {},
      critical_care_rate: 0,
    },
    chronically_missed_gaps: [],
    tool_engagement: {},
    differential_engagement: {
      added_count: 0,
      engaged_count: 0,
    },
    agent_act_patterns: {
      batch_pe_shift_count: 0,
      per_encounter_shift_count: 0,
    },
    pending_observations: [],
    last_aggregated_at: new Date(0).toISOString(),
    version: 1,
  };
}
