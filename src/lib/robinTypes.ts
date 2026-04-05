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
