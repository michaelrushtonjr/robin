/**
 * Memory architecture helpers (item 16.5).
 *
 * Write-path helpers for the three active memory tiers. Routes stay thin —
 * they call these helpers, not Supabase directly, so the write logic lives
 * in one place and can be tested/evolved independently.
 *
 * See /docs/memory-architecture.md for the full design.
 *
 * Concurrency note: these helpers use `select → modify → update` without
 * optimistic versioning. Safe under single-physician-per-shift concurrency.
 * The worst case is a lost tally increment, which is acceptable.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClinicalToolName,
  ClinicalToolSurfacing,
  DifferentialAddition,
  MDMComplexity,
  RobinLongitudinal,
  ShiftEncounterRollup,
  ShiftMemory,
  ShiftObservedPatterns,
  ShiftTally,
} from "./robinTypes";
import {
  createEmptyLongitudinal,
  createEmptyShiftMemory,
} from "./robinTypes";

// ─── Internal: load + save shift memory ─────────────────────────────────────

async function loadShiftMemory(
  supabase: SupabaseClient,
  shiftId: string
): Promise<ShiftMemory> {
  const { data } = await supabase
    .from("shifts")
    .select("robin_memory")
    .eq("id", shiftId)
    .single();
  const raw = data?.robin_memory as Partial<ShiftMemory> | null | undefined;
  if (!raw || Object.keys(raw).length === 0 || raw.version !== 1) {
    return createEmptyShiftMemory();
  }
  // Fill any missing top-level keys (forward-compat if schema grows).
  const empty = createEmptyShiftMemory();
  return {
    encounters_this_shift:
      raw.encounters_this_shift ?? empty.encounters_this_shift,
    observed_patterns: {
      ...empty.observed_patterns,
      ...(raw.observed_patterns ?? {}),
    },
    tally: {
      gaps_by_type: raw.tally?.gaps_by_type ?? {},
      surfacings_by_tool: raw.tally?.surfacings_by_tool ?? {},
      codes_distribution: raw.tally?.codes_distribution ?? {},
    },
    version: 1,
  };
}

async function saveShiftMemory(
  supabase: SupabaseClient,
  shiftId: string,
  memory: ShiftMemory
): Promise<void> {
  await supabase
    .from("shifts")
    .update({ robin_memory: memory })
    .eq("id", shiftId);
}

// ─── Internal: load + save longitudinal ─────────────────────────────────────

async function loadLongitudinal(
  supabase: SupabaseClient,
  physicianId: string
): Promise<RobinLongitudinal> {
  const { data } = await supabase
    .from("physicians")
    .select("robin_longitudinal")
    .eq("id", physicianId)
    .single();
  const raw = data?.robin_longitudinal as
    | Partial<RobinLongitudinal>
    | null
    | undefined;
  if (!raw || Object.keys(raw).length === 0 || raw.version !== 1) {
    return createEmptyLongitudinal();
  }
  const empty = createEmptyLongitudinal();
  return {
    shifts_observed: raw.shifts_observed ?? 0,
    encounters_observed: raw.encounters_observed ?? 0,
    coding_distribution: {
      counts: raw.coding_distribution?.counts ?? {},
      critical_care_rate: raw.coding_distribution?.critical_care_rate ?? 0,
    },
    chronically_missed_gaps: raw.chronically_missed_gaps ?? [],
    tool_engagement: raw.tool_engagement ?? {},
    differential_engagement: {
      added_count: raw.differential_engagement?.added_count ?? 0,
      engaged_count: raw.differential_engagement?.engaged_count ?? 0,
    },
    agent_act_patterns: {
      batch_pe_shift_count: raw.agent_act_patterns?.batch_pe_shift_count ?? 0,
      per_encounter_shift_count:
        raw.agent_act_patterns?.per_encounter_shift_count ?? 0,
    },
    pending_observations: raw.pending_observations ?? [],
    last_aggregated_at: raw.last_aggregated_at ?? empty.last_aggregated_at,
    version: 1,
  };
}

async function saveLongitudinal(
  supabase: SupabaseClient,
  physicianId: string,
  longitudinal: RobinLongitudinal
): Promise<void> {
  await supabase
    .from("physicians")
    .update({ robin_longitudinal: longitudinal })
    .eq("id", physicianId);
}

// ─── Public: shift memory writers ───────────────────────────────────────────

/**
 * Upsert an encounter rollup into shifts.robin_memory.encounters_this_shift.
 * If the encounter already has a rollup, the new one replaces it (latest
 * wins — robin-think can be re-run on the same encounter).
 */
export async function upsertEncounterInShiftMemory(
  supabase: SupabaseClient,
  shiftId: string,
  rollup: ShiftEncounterRollup
): Promise<void> {
  const memory = await loadShiftMemory(supabase, shiftId);
  const idx = memory.encounters_this_shift.findIndex(
    (e) => e.encounter_id === rollup.encounter_id
  );
  if (idx >= 0) {
    // Preserve gaps_addressed / finalized_at / etc. that later writers
    // (note finalize) may have set.
    const existing = memory.encounters_this_shift[idx];
    memory.encounters_this_shift[idx] = {
      ...existing,
      ...rollup,
      gaps_addressed: rollup.gaps_addressed.length
        ? rollup.gaps_addressed
        : existing.gaps_addressed,
      finalized_at: rollup.finalized_at ?? existing.finalized_at,
      surfacings_shown:
        rollup.surfacings_shown.length > 0
          ? rollup.surfacings_shown
          : existing.surfacings_shown,
      differentials_shown:
        rollup.differentials_shown.length > 0
          ? rollup.differentials_shown
          : existing.differentials_shown,
    };
  } else {
    memory.encounters_this_shift.push(rollup);
  }
  await saveShiftMemory(supabase, shiftId, memory);
}

/** Increment a named tally bucket by 1. */
export async function incrementShiftTally(
  supabase: SupabaseClient,
  shiftId: string,
  path: keyof ShiftTally,
  key: string
): Promise<void> {
  const memory = await loadShiftMemory(supabase, shiftId);
  const bucket = memory.tally[path] as Record<string, number>;
  bucket[key] = (bucket[key] ?? 0) + 1;
  await saveShiftMemory(supabase, shiftId, memory);
}

/** Increment a named counter in observed_patterns. */
export async function incrementShiftPatternCount(
  supabase: SupabaseClient,
  shiftId: string,
  key: "vague_workup_language_count" | "critical_care_count",
  delta: number = 1
): Promise<void> {
  if (delta === 0) return;
  const memory = await loadShiftMemory(supabase, shiftId);
  memory.observed_patterns[key] =
    (memory.observed_patterns[key] ?? 0) + delta;
  await saveShiftMemory(supabase, shiftId, memory);
}

/** Set a categorical observed pattern (most-recent-write wins). */
export async function setShiftPattern<K extends keyof ShiftObservedPatterns>(
  supabase: SupabaseClient,
  shiftId: string,
  key: K,
  value: ShiftObservedPatterns[K]
): Promise<void> {
  const memory = await loadShiftMemory(supabase, shiftId);
  memory.observed_patterns[key] = value;
  await saveShiftMemory(supabase, shiftId, memory);
}

/**
 * Append a clinical-surfacing entry to the encounter rollup's
 * surfacings_shown list. Creates a stub rollup if the encounter has not
 * been seen yet (so surfacings can fire before robin-think runs).
 */
export async function appendShiftMemorySurfacing(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string,
  chiefComplaint: string,
  surfacing: ClinicalToolSurfacing
): Promise<void> {
  const memory = await loadShiftMemory(supabase, shiftId);
  let rollup = memory.encounters_this_shift.find(
    (e) => e.encounter_id === encounterId
  );
  if (!rollup) {
    rollup = stubRollup(encounterId, chiefComplaint);
    memory.encounters_this_shift.push(rollup);
  }
  rollup.surfacings_shown.push({
    surface_id: surfacing.surface_id,
    tool_name: surfacing.tool_name as ClinicalToolName,
  });
  rollup.last_updated_at = new Date().toISOString();
  await saveShiftMemory(supabase, shiftId, memory);
}

/**
 * Append a differential entry to the encounter rollup's differentials_shown list.
 */
export async function appendShiftMemoryDifferential(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string,
  chiefComplaint: string,
  differential: DifferentialAddition
): Promise<void> {
  const memory = await loadShiftMemory(supabase, shiftId);
  let rollup = memory.encounters_this_shift.find(
    (e) => e.encounter_id === encounterId
  );
  if (!rollup) {
    rollup = stubRollup(encounterId, chiefComplaint);
    memory.encounters_this_shift.push(rollup);
  }
  rollup.differentials_shown.push({
    surface_id: differential.surface_id,
    diagnosis: differential.diagnosis,
  });
  rollup.last_updated_at = new Date().toISOString();
  await saveShiftMemory(supabase, shiftId, memory);
}

/** Mark gap_types as addressed on the encounter rollup (finalize step). */
export async function markGapsAddressed(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string,
  addressedTypes: string[]
): Promise<void> {
  if (addressedTypes.length === 0) return;
  const memory = await loadShiftMemory(supabase, shiftId);
  const rollup = memory.encounters_this_shift.find(
    (e) => e.encounter_id === encounterId
  );
  if (!rollup) return;
  const existing = new Set(rollup.gaps_addressed);
  for (const t of addressedTypes) existing.add(t);
  rollup.gaps_addressed = [...existing];
  rollup.finalized_at = new Date().toISOString();
  rollup.last_updated_at = rollup.finalized_at;
  await saveShiftMemory(supabase, shiftId, memory);
}

// ─── Public: encounter memory writers ──────────────────────────────────────

/**
 * Append a surfacing to encounters.mdm_data.surfacings (creates the
 * array if absent). Kept narrow — merges under the `surfacings` key,
 * does not touch other mdm_data fields.
 */
export async function appendEncounterSurfacing(
  supabase: SupabaseClient,
  encounterId: string,
  surfacing: ClinicalToolSurfacing
): Promise<void> {
  const { data } = await supabase
    .from("encounters")
    .select("mdm_data")
    .eq("id", encounterId)
    .single();
  const existing = (data?.mdm_data ?? {}) as Record<string, unknown>;
  const surfacings = Array.isArray(existing.surfacings)
    ? (existing.surfacings as ClinicalToolSurfacing[])
    : [];
  surfacings.push(surfacing);
  await supabase
    .from("encounters")
    .update({ mdm_data: { ...existing, surfacings } })
    .eq("id", encounterId);
}

/**
 * Append a differential to encounters.mdm_data.differentials (creates
 * the array if absent).
 */
export async function appendEncounterDifferential(
  supabase: SupabaseClient,
  encounterId: string,
  differential: DifferentialAddition
): Promise<void> {
  const { data } = await supabase
    .from("encounters")
    .select("mdm_data")
    .eq("id", encounterId)
    .single();
  const existing = (data?.mdm_data ?? {}) as Record<string, unknown>;
  const differentials = Array.isArray(existing.differentials)
    ? (existing.differentials as DifferentialAddition[])
    : [];
  differentials.push(differential);
  await supabase
    .from("encounters")
    .update({ mdm_data: { ...existing, differentials } })
    .eq("id", encounterId);
}

// ─── Public: longitudinal aggregation (shift → longitudinal) ────────────────

export interface DeltaObservation {
  id: string;
  observation: string;
}

/**
 * Aggregate the closed shift's memory into the physician's longitudinal
 * record. Called from /api/shift/close.
 *
 * Returns the list of new delta observations that were minted (if any),
 * so the caller can expose them in the end-of-shift UI.
 */
export async function aggregateShiftToLongitudinal(
  supabase: SupabaseClient,
  shiftId: string,
  physicianId: string
): Promise<{ newObservations: DeltaObservation[] }> {
  const memory = await loadShiftMemory(supabase, shiftId);
  const longitudinal = await loadLongitudinal(supabase, physicianId);

  // ── shift / encounter counts ────────────────────────────────────────────
  longitudinal.shifts_observed += 1;
  longitudinal.encounters_observed += memory.encounters_this_shift.length;

  // ── coding distribution ─────────────────────────────────────────────────
  for (const [code, count] of Object.entries(memory.tally.codes_distribution)) {
    longitudinal.coding_distribution.counts[code] =
      (longitudinal.coding_distribution.counts[code] ?? 0) + count;
  }
  const shiftHadCC = memory.observed_patterns.critical_care_count > 0;
  // running rate: prior_rate * (n-1) + (1 if shiftHadCC else 0), then /n
  const n = longitudinal.shifts_observed;
  const priorRate = longitudinal.coding_distribution.critical_care_rate;
  longitudinal.coding_distribution.critical_care_rate =
    (priorRate * (n - 1) + (shiftHadCC ? 1 : 0)) / n;

  // ── tool engagement (surface counts; engaged_count stays 0 until item 19) ─
  for (const [toolName, count] of Object.entries(memory.tally.surfacings_by_tool)) {
    if (!count) continue;
    const prior = longitudinal.tool_engagement[toolName as ClinicalToolName] ?? {
      surfaced_count: 0,
      engaged_count: 0,
      engagement_rate: 0,
    };
    prior.surfaced_count += count;
    prior.engagement_rate =
      prior.surfaced_count > 0 ? prior.engaged_count / prior.surfaced_count : 0;
    longitudinal.tool_engagement[toolName as ClinicalToolName] = prior;
  }

  // ── chronically missed gaps ─────────────────────────────────────────────
  // For each encounter that was finalized, count flagged-but-not-addressed.
  const byType: Record<string, { flagged: number; unaddressed: number }> = {};
  for (const enc of memory.encounters_this_shift) {
    if (!enc.finalized_at) continue;
    const addressed = new Set(enc.gaps_addressed);
    for (const t of enc.gaps_flagged) {
      byType[t] ??= { flagged: 0, unaddressed: 0 };
      byType[t].flagged += 1;
      if (!addressed.has(t)) byType[t].unaddressed += 1;
    }
  }
  const now = new Date().toISOString();
  for (const [gapType, stats] of Object.entries(byType)) {
    const prior = longitudinal.chronically_missed_gaps.find(
      (g) => g.gap_type === gapType
    );
    if (prior) {
      const newCount = prior.encounter_count + stats.flagged;
      const newMisses =
        prior.miss_rate * prior.encounter_count + stats.unaddressed;
      prior.miss_rate = newCount > 0 ? newMisses / newCount : 0;
      prior.encounter_count = newCount;
      prior.last_seen = now;
    } else {
      longitudinal.chronically_missed_gaps.push({
        gap_type: gapType,
        miss_rate: stats.flagged > 0 ? stats.unaddressed / stats.flagged : 0,
        encounter_count: stats.flagged,
        last_seen: now,
      });
    }
  }

  // ── agent/act patterns ──────────────────────────────────────────────────
  if (memory.observed_patterns.dictation_style === "batch_pe") {
    longitudinal.agent_act_patterns.batch_pe_shift_count += 1;
  } else if (memory.observed_patterns.dictation_style === "per_encounter") {
    longitudinal.agent_act_patterns.per_encounter_shift_count += 1;
  }

  // ── differential engagement (added_count; engaged stays 0 until item 19) ─
  longitudinal.differential_engagement.added_count +=
    memory.encounters_this_shift.reduce(
      (sum, e) => sum + e.differentials_shown.length,
      0
    );

  // ── delta detection (preference ↔ longitudinal) ────────────────────────
  const newObservations = await detectDeltas(
    supabase,
    physicianId,
    longitudinal
  );
  // Append truly new ones (avoid re-surfacing the same delta every shift).
  const existingObservationKeys = new Set(
    longitudinal.pending_observations.map((o) => observationKey(o.observation))
  );
  for (const obs of newObservations) {
    const key = observationKey(obs.observation);
    if (!existingObservationKeys.has(key)) {
      longitudinal.pending_observations.push({
        id: obs.id,
        observation: obs.observation,
        flagged_at: now,
        resolved_at: null,
        resolution: null,
      });
    }
  }

  longitudinal.last_aggregated_at = now;
  await saveLongitudinal(supabase, physicianId, longitudinal);

  return { newObservations };
}

// ─── Delta detection ────────────────────────────────────────────────────────
//
// A delta fires only when shifts_observed >= THRESHOLD and the preference
// is in meaningful tension with observed behavior. Each rule produces an
// observation with a stable "key" so we don't re-surface identical deltas.

const DELTA_THRESHOLD_SHIFTS = 5;

function observationKey(observation: string): string {
  // First 60 chars — enough to distinguish observations about different
  // preference fields while tolerating small numeric drift.
  return observation.slice(0, 60).toLowerCase();
}

async function detectDeltas(
  supabase: SupabaseClient,
  physicianId: string,
  longitudinal: RobinLongitudinal
): Promise<DeltaObservation[]> {
  if (longitudinal.shifts_observed < DELTA_THRESHOLD_SHIFTS) return [];

  const { data: physician } = await supabase
    .from("physicians")
    .select("robin_preferences")
    .eq("id", physicianId)
    .single();
  const prefs = (physician?.robin_preferences ?? {}) as Record<string, unknown>;

  const out: DeltaObservation[] = [];

  // Rule 1: em_posture vs observed coding distribution
  if (prefs.em_posture && typeof prefs.em_posture === "string") {
    const avgCode = weightedAverageCode(longitudinal.coding_distribution.counts);
    if (avgCode !== null) {
      if (prefs.em_posture === "conservative" && avgCode >= 3.3) {
        out.push({
          id: `delta_em_posture_${Date.now()}`,
          observation: `You set E&M posture to conservative, but your average code is ${codeForAvg(avgCode)} across ${sumValues(longitudinal.coding_distribution.counts)} encounters. Your documentation may support a less conservative posture.`,
        });
      } else if (prefs.em_posture === "aggressive" && avgCode <= 2.5) {
        out.push({
          id: `delta_em_posture_${Date.now()}`,
          observation: `You set E&M posture to aggressive, but your average code is ${codeForAvg(avgCode)}. Documentation doesn't yet support aggressive coding — consider adjusting or tightening documentation.`,
        });
      }
    }
  }

  // Rule 2: gap_sensitivity=low with high chronic miss rate on audit-risk gaps
  if (prefs.gap_sensitivity === "low") {
    const highRiskTypes = [
      "return_precautions",
      "rx_drug_management",
      "vague_workup_language",
    ];
    const worst = longitudinal.chronically_missed_gaps
      .filter(
        (g) =>
          highRiskTypes.includes(g.gap_type) &&
          g.miss_rate > 0.3 &&
          g.encounter_count >= 5
      )
      .sort((a, b) => b.miss_rate - a.miss_rate)[0];
    if (worst) {
      out.push({
        id: `delta_gap_sens_${worst.gap_type}_${Date.now()}`,
        observation: `You set gap sensitivity to low, but ${humanizeGapType(worst.gap_type)} is missing on ${Math.round(worst.miss_rate * 100)}% of your encounters. This is audit exposure.`,
      });
    }
  }

  return out;
}

// ─── Small formatters / helpers ─────────────────────────────────────────────

const CODE_WEIGHT: Record<string, number> = {
  "99281": 1,
  "99282": 2,
  "99283": 3,
  "99284": 4,
  "99285": 5,
  "99291": 6,
  "99292": 6,
};

function weightedAverageCode(counts: Record<string, number>): number | null {
  let total = 0;
  let weight = 0;
  for (const [code, count] of Object.entries(counts)) {
    const w = CODE_WEIGHT[code];
    if (w === undefined) continue;
    weight += w * count;
    total += count;
  }
  return total > 0 ? weight / total : null;
}

function codeForAvg(avg: number): string {
  // Nearest bucket for display
  const rounded = Math.round(avg);
  const entry = Object.entries(CODE_WEIGHT).find(([, w]) => w === rounded);
  return entry?.[0] ?? `~${avg.toFixed(1)}`;
}

function sumValues(o: Record<string, number>): number {
  return Object.values(o).reduce((a, b) => a + b, 0);
}

export function humanizeGapType(t: string): string {
  return t.replace(/_/g, " ");
}

// ─── Gap-addressed heuristic detection (used by note/finalize) ─────────────

/**
 * Phrases that, if present in the finalized note, indicate the named gap
 * type has been addressed. Purpose-built for longitudinal signal, not
 * clinical accuracy — we want to know if the physician meaningfully
 * addressed the thing Robin flagged at audit time.
 *
 * gap_types without heuristic entries (hpi_incomplete, vague_workup_language,
 * other) are always considered NOT addressed by this function. That's
 * conservative and keeps longitudinal's miss_rate signal honest.
 */
const GAP_ADDRESSED_PHRASES: Record<string, string[]> = {
  ros_missing: [
    "review of systems",
    "ros:",
    "ros —",
    "denies fever",
    "denies chest pain",
    "otherwise negative",
  ],
  data_not_documented: [
    "reviewed",
    "results show",
    "labs show",
    "lab results",
    "ct shows",
    "ekg shows",
    "interpretation:",
    "wbc",
    "lactate",
    "troponin",
  ],
  risk_not_documented: [
    "moderate risk",
    "high risk",
    "low risk",
    "prescription drug management",
    "decision regarding hospitalization",
    "admitted",
    "admission",
  ],
  disposition_rationale_absent: [
    "disposition:",
    "dispo:",
    "discharged home",
    "admitted to",
    "appropriate for discharge",
    "given that",
    "reason for admission",
    "discharge criteria met",
  ],
  return_precautions_missing: [
    "return for",
    "return if",
    "worsening",
    "come back if",
    "red flag",
    "warning sign",
    "seek immediate care",
    "when to return",
  ],
};

export function detectAddressedGaps(
  flaggedTypes: string[],
  finalizedText: string
): string[] {
  const hay = finalizedText.toLowerCase();
  const addressed: string[] = [];
  for (const gap_type of flaggedTypes) {
    const phrases = GAP_ADDRESSED_PHRASES[gap_type];
    if (!phrases || phrases.length === 0) continue;
    if (phrases.some((p) => hay.includes(p))) {
      addressed.push(gap_type);
    }
  }
  return addressed;
}

// ─── Small helper used by multiple writers ─────────────────────────────────

function stubRollup(
  encounterId: string,
  chiefComplaint: string
): ShiftEncounterRollup {
  const now = new Date().toISOString();
  return {
    encounter_id: encounterId,
    chief_complaint: chiefComplaint,
    code: null,
    overall_mdm: null,
    gaps_flagged: [],
    gaps_addressed: [],
    surfacings_shown: [],
    differentials_shown: [],
    finalized_at: null,
    last_updated_at: now,
  };
}

// ─── Rollup construction from robin-think mdmData ──────────────────────────

export function buildRollupFromMdmData(
  encounterId: string,
  chiefComplaint: string,
  mdmData: {
    mdm_scaffold?: { overall_mdm?: MDMComplexity };
    gaps?: Array<{ gap_type: string }>;
    em_assessment?: { code?: string };
  }
): ShiftEncounterRollup {
  const now = new Date().toISOString();
  return {
    encounter_id: encounterId,
    chief_complaint: chiefComplaint,
    code: mdmData.em_assessment?.code ?? null,
    overall_mdm: mdmData.mdm_scaffold?.overall_mdm ?? null,
    gaps_flagged: (mdmData.gaps ?? []).map((g) => g.gap_type),
    gaps_addressed: [],
    surfacings_shown: [],
    differentials_shown: [],
    finalized_at: null,
    last_updated_at: now,
  };
}
