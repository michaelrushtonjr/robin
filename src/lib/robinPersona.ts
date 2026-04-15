import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClinicalToolName,
  RobinLongitudinal,
  ShiftMemory,
} from "./robinTypes";
import { humanizeGapType } from "./memory";

// ─── Robin's core identity ────────────────────────────────────────────────────
export const ROBIN_IDENTITY = `You are Robin, an AI shift copilot built exclusively for emergency medicine physicians.

IDENTITY
You are a plucky, enthusiastic sidekick who genuinely loves helping physicians get through their shift. You're sharp, fast, and a little bit excited about everything — not in an annoying way, but in the way of someone who's really good at their job and happy to be here. You treat the physician like a partner. You're not a subordinate and you're not a consultant — you're the best sidekick they've ever had.

Your expertise is EM documentation, E&M coding, high-liability documentation requirements, and shift logistics. The physician handles the clinical decisions — that's their domain. Your domain is making sure their documentation is bulletproof and their shift runs smoothly.

PERSONALITY
- Warm, quick, and a little playful — but never at the expense of accuracy or the physician's time
- Enthusiastic about helping, even with the unglamorous stuff (especially the unglamorous stuff)
- Confident and direct — you know your stuff and you say it clearly
- Genuinely invested in how the shift is going
- First-person voice, conversational tone, concise unless detail is needed
- You celebrate wins ("That note is solid") and flag problems without being preachy

CORE DIRECTIVE
Make sure every patient encounter is documented completely and accurately. A poorly documented encounter costs the physician money and exposes them to liability. You catch what gets missed when the department is slammed. Beyond documentation, you're the physician's full shift partner — discharge instructions, patient summaries, coding advice, whatever they need.

CAPABILITIES
- Review any encounter's documentation for completeness and E&M coding accuracy
- Generate patient-friendly discharge instructions from encounter data
- Summarize shift status and outstanding documentation
- Flag high-liability gaps (missed return precautions, incomplete MDM, absent risk stratification)
- Answer documentation and coding questions in real time
- Learn and adapt to physician preferences over time

BOUNDARIES
- You do not make clinical recommendations or suggest diagnoses
- You do not question treatment decisions
- You do not provide medical advice to patients
- You cannot directly access the EHR — you work from what's been captured in Robin`;

// ─── Preference translation ───────────────────────────────────────────────────

function translatePreferences(
  prefs: Record<string, unknown> | null | undefined
): string {
  if (!prefs || Object.keys(prefs).length === 0) return "";

  const lines: string[] = [];

  if (prefs.mdm_depth === "scaffold_only") {
    lines.push("- MDM: Build structure only — physician fills in content");
  } else if (prefs.mdm_depth === "full_ap") {
    lines.push("- MDM: Draft full assessment and plan for physician review");
  }

  if (prefs.mdm_dictation_mode === "verbatim") {
    lines.push("- MDM dictation: Transcribe verbatim");
  } else if (prefs.mdm_dictation_mode === "structured") {
    lines.push("- MDM dictation: Integrate into AMA 2021 format");
  }

  if (prefs.hpi_style === "brief") {
    lines.push("- HPI: Brief — location, severity, duration");
  } else if (prefs.hpi_style === "extended") {
    lines.push("- HPI: Extended — all OPQRST elements");
  }

  if (prefs.gap_sensitivity === "high") {
    lines.push("- Gap flagging: Flag all missing elements");
  } else if (prefs.gap_sensitivity === "medium") {
    lines.push("- Gap flagging: Flag high-severity gaps only");
  } else if (prefs.gap_sensitivity === "low") {
    lines.push("- Gap flagging: Only gaps that affect E&M level");
  }

  if (prefs.em_posture === "conservative") {
    lines.push("- E&M coding: Conservative — undercode rather than risk audit");
  } else if (prefs.em_posture === "accurate") {
    lines.push(
      "- E&M coding: Accurate — code exactly what documentation supports"
    );
  } else if (prefs.em_posture === "aggressive") {
    lines.push("- E&M coding: Aggressive — capture everything supportable");
  }

  if (prefs.note_verbosity === "concise") {
    lines.push("- Note style: Concise");
  } else if (prefs.note_verbosity === "standard") {
    lines.push("- Note style: Standard detail");
  } else if (prefs.note_verbosity === "thorough") {
    lines.push("- Note style: Thorough — include pertinent negatives");
  }

  if (prefs.ekg_normal_verbosity === "full") {
    lines.push("- EKG shorthand: Expand to full structured read");
  } else if (prefs.ekg_normal_verbosity === "impression_only") {
    lines.push("- EKG shorthand: Single impression line only");
  }

  if (prefs.copy_mode === "sections") {
    lines.push("- Copy mode: Section by section");
  } else if (prefs.copy_mode === "full") {
    lines.push("- Copy mode: Full note copy");
  }

  const flags = prefs.specialty_flags as
    | Record<string, boolean>
    | undefined;
  if (flags) {
    if (flags.include_ems_narrative)
      lines.push("- Include EMS narrative in HPI");
    if (flags.auto_include_review_of_systems)
      lines.push("- Auto-include review of systems");
    if (flags.document_negative_findings)
      lines.push("- Document pertinent negative findings");
  }

  if (lines.length === 0) return "";
  return `\nPHYSICIAN PREFERENCES:\n${lines.join("\n")}`;
}

// ─── Shift memory translation (typed, threshold-gated) ──────────────────────

// Signal thresholds. Below these, observations are stored but silent —
// prevents mid-shift noise (one random vague gap doesn't become commentary).
const SHIFT_GAP_TALLY_THRESHOLD = 3;
const SHIFT_SURFACING_TALLY_THRESHOLD = 2;

const TOOL_SHORT_NAME: Record<ClinicalToolName, string> = {
  HEART: "HEART",
  PERC: "PERC",
  SF_Syncope: "SF Syncope",
  Canadian_CT_Head: "Canadian CT Head",
  Ottawa_Ankle: "Ottawa Ankle/Foot",
  NEXUS: "NEXUS",
};

function translateShiftMemory(
  memory: Partial<ShiftMemory> | null | undefined
): string {
  if (!memory || Object.keys(memory).length === 0) return "";

  const lines: string[] = [];

  // Rolling gap tallies — only above signal threshold.
  for (const [gapType, count] of Object.entries(memory.tally?.gaps_by_type ?? {})) {
    if (count >= SHIFT_GAP_TALLY_THRESHOLD) {
      lines.push(
        `- Flagged ${humanizeGapType(gapType)} ${count}× this shift`
      );
    }
  }

  // Rolling surfacing tallies — above threshold.
  for (const [toolName, count] of Object.entries(
    memory.tally?.surfacings_by_tool ?? {}
  )) {
    if ((count ?? 0) >= SHIFT_SURFACING_TALLY_THRESHOLD) {
      const nice =
        TOOL_SHORT_NAME[toolName as ClinicalToolName] ?? toolName;
      lines.push(`- Surfaced ${nice} ${count}× this shift`);
    }
  }

  // Dictation style (fires at first detection; doesn't require threshold).
  if (memory.observed_patterns?.dictation_style === "batch_pe") {
    lines.push("- Dictation style this shift: batch PE (multiple patients)");
  }

  // Critical care count — surface any fire; CC is rare and high-signal.
  const cc = memory.observed_patterns?.critical_care_count ?? 0;
  if (cc >= 1) {
    lines.push(`- ${cc} critical care encounter(s) this shift`);
  }

  // Code distribution summary when shift is meaningfully underway (5+ codes).
  const codeTotal = Object.values(memory.tally?.codes_distribution ?? {}).reduce(
    (a, b) => a + b,
    0
  );
  if (codeTotal >= 5) {
    const sorted = Object.entries(memory.tally?.codes_distribution ?? {}).sort(
      (a, b) => b[1] - a[1]
    );
    const top = sorted
      .slice(0, 3)
      .map(([code, n]) => `${code}×${n}`)
      .join(", ");
    lines.push(`- Shift code distribution: ${top}`);
  }

  if (lines.length === 0) return "";
  return `\nSHIFT OBSERVATIONS:\n${lines.join("\n")}`;
}

// ─── Longitudinal translation (threshold-gated at 5 shifts) ─────────────────

const LONGITUDINAL_THRESHOLD_SHIFTS = 5;
const CHRONIC_MISS_RATE_THRESHOLD = 0.3;

function translateLongitudinal(
  longitudinal: Partial<RobinLongitudinal> | null | undefined
): string {
  if (!longitudinal || Object.keys(longitudinal).length === 0) return "";
  const shifts = longitudinal.shifts_observed ?? 0;
  if (shifts < LONGITUDINAL_THRESHOLD_SHIFTS) return "";

  const lines: string[] = [];

  // Chronically missed gaps.
  for (const gap of longitudinal.chronically_missed_gaps ?? []) {
    if (
      gap.miss_rate >= CHRONIC_MISS_RATE_THRESHOLD &&
      gap.encounter_count >= 5
    ) {
      lines.push(
        `- Chronic miss: ${humanizeGapType(gap.gap_type)} (${Math.round(
          gap.miss_rate * 100
        )}% across ${gap.encounter_count} encounters)`
      );
    }
  }

  // Critical care rate (informational, not a delta).
  const ccRate = longitudinal.coding_distribution?.critical_care_rate ?? 0;
  if (ccRate >= 0.1) {
    lines.push(
      `- ${Math.round(ccRate * 100)}% of shifts have ≥1 critical care encounter`
    );
  }

  // Tool engagement (once item 19 ships this becomes meaningful; for now
  // surfaced_count alone is a weak signal — skip it unless high).
  for (const [toolName, stats] of Object.entries(
    longitudinal.tool_engagement ?? {}
  )) {
    if (!stats) continue;
    if (stats.surfaced_count >= 10) {
      const nice = TOOL_SHORT_NAME[toolName as ClinicalToolName] ?? toolName;
      lines.push(
        `- ${nice} surfaced ${stats.surfaced_count}× across ${shifts} shifts`
      );
    }
  }

  if (lines.length === 0) return "";
  return `\nLONGITUDINAL OBSERVATIONS (across ${shifts} shifts):\n${lines.join(
    "\n"
  )}`;
}

// ─── Context builder ──────────────────────────────────────────────────────────
export interface RobinContext {
  systemPrompt: string;
  encounterCount: number;
}

export async function buildRobinContext(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId?: string | null
): Promise<RobinContext> {
  // Load physician
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: physician } = user
    ? await supabase
        .from("physicians")
        .select("display_name, robin_preferences, robin_longitudinal")
        .eq("id", user.id)
        .single()
    : { data: null };

  // Load shift
  const { data: shift } = await supabase
    .from("shifts")
    .select("started_at, robin_memory")
    .eq("id", shiftId)
    .single();

  // Load all encounters for this shift
  const { data: encounters } = await supabase
    .from("encounters")
    .select(
      "id, room, age, gender, chief_complaint, status, generated_note, transcript, created_at"
    )
    .eq("shift_id", shiftId)
    .order("created_at", { ascending: true });

  const encounterList = encounters || [];

  // Build encounter summaries
  const encounterSummaries = encounterList
    .map((enc, i) => {
      const demo = [enc.age, enc.gender].filter(Boolean).join("");
      const label = demo
        ? `${demo} — ${enc.chief_complaint || "Unknown CC"}`
        : enc.chief_complaint || "Unknown CC";
      const hasNote = enc.generated_note ? " | Note generated" : "";
      const hasTranscript = enc.transcript ? " | Transcript captured" : "";
      const isCurrent = enc.id === encounterId ? " ◄ CURRENTLY VIEWING" : "";
      return `  Patient ${i + 1}: ${label} | Room ${enc.room || "?"} | ${enc.status}${hasTranscript}${hasNote}${isCurrent}`;
    })
    .join("\n");

  // Load full detail of current encounter if applicable
  let currentEncounterDetail = "";
  if (encounterId) {
    const currentEnc = encounterList.find((e) => e.id === encounterId);
    if (currentEnc) {
      const patientNum =
        encounterList.findIndex((e) => e.id === encounterId) + 1;
      currentEncounterDetail = `
CURRENT ENCOUNTER IN VIEW — Patient ${patientNum}
Demographics: ${[currentEnc.age, currentEnc.gender].filter(Boolean).join("") || "Unknown"}
Chief complaint: ${currentEnc.chief_complaint || "Unknown"}
Status: ${currentEnc.status}
${currentEnc.transcript ? `\nTranscript:\n${currentEnc.transcript.slice(0, 3000)}${currentEnc.transcript.length > 3000 ? "\n[...transcript continues]" : ""}` : "No transcript captured yet."}
${currentEnc.generated_note ? `\nGenerated note:\n${currentEnc.generated_note.slice(0, 2000)}${currentEnc.generated_note.length > 2000 ? "\n[...note continues]" : ""}` : "No note generated yet."}`;
    }
  }

  // Build preferences block
  const prefBlock = translatePreferences(physician?.robin_preferences);

  // Shift memory block (typed, threshold-gated)
  const memoryBlock = translateShiftMemory(
    shift?.robin_memory as Partial<ShiftMemory> | null
  );

  // Longitudinal memory block (threshold-gated at 5+ shifts)
  const longitudinalBlock = translateLongitudinal(
    physician?.robin_longitudinal as Partial<RobinLongitudinal> | null
  );

  const shiftStart = shift?.started_at
    ? new Date(shift.started_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Unknown";

  const now = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const systemPrompt = `${ROBIN_IDENTITY}

─────────────────────────────────────────
SHIFT CONTEXT
Physician: Dr. ${physician?.display_name || "Unknown"}
Shift started: ${shiftStart} | Current time: ${now}
${prefBlock}${memoryBlock}${longitudinalBlock}

ENCOUNTERS THIS SHIFT (${encounterList.length} total):
${encounterSummaries || "  No encounters yet."}
${currentEncounterDetail}
─────────────────────────────────────────

Respond in first person as Robin. Be concise unless detail is needed. If asked about a specific patient, reference them by patient number.`;

  return { systemPrompt, encounterCount: encounterList.length };
}
