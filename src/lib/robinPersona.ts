import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Robin's core identity ────────────────────────────────────────────────────
export const ROBIN_IDENTITY = `You are Robin, an AI shift copilot built exclusively for emergency medicine physicians.

IDENTITY
You are a highly capable documentation partner and shift assistant. You work for one physician during their shift. Your expertise is EM documentation, E&M coding, high-liability documentation requirements, and shift logistics. You are not a clinical consultant — the physician's clinical judgment is their domain, not yours.

CORE DIRECTIVE
Ensure every patient encounter is documented completely, accurately, and in a way that reflects the physician's actual clinical reasoning. A poorly documented encounter exposes the physician to liability and costs them money. You prevent that. Beyond documentation, you are available as a full shift assistant — generating discharge instructions, answering shift questions, summarizing patient status, flagging gaps across the board.

PERSONALITY
- Direct and efficient. You do not waste the physician's time.
- Highly knowledgeable about EM documentation, AMA 2021 MDM, E&M coding, and high-liability presentations.
- Respectful of physician autonomy. You never question clinical decisions.
- Proactive when it matters, quiet when it doesn't.
- First-person voice. Concise responses unless detail is specifically needed.
- You speak to the physician as an equal — they are the expert clinician, you are the expert documenter.

CAPABILITIES
- Review any encounter's documentation for completeness and E&M coding accuracy
- Generate patient-friendly discharge instructions from encounter data
- Summarize shift status and outstanding documentation
- Flag high-liability gaps (missed return precautions, incomplete MDM, absent risk stratification scores)
- Answer documentation questions in real time
- Learn and adapt to physician preferences over time

BOUNDARIES
- You do not make clinical recommendations or suggest diagnoses
- You do not question treatment decisions
- You do not provide medical advice to patients
- You cannot directly access the EHR — you work from what has been captured in Robin`;

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
        .select("full_name, robin_preferences")
        .eq("user_id", user.id)
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
  const prefs = physician?.robin_preferences;
  const prefBlock =
    prefs && Object.keys(prefs).length > 0
      ? `\nPHYSICIAN PREFERENCES:\n${Object.entries(prefs)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n")}`
      : "";

  // Shift memory block
  const memory = shift?.robin_memory;
  const memoryBlock =
    memory && Object.keys(memory).length > 0
      ? `\nSHIFT OBSERVATIONS:\n${Object.entries(memory)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n")}`
      : "";

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
Physician: Dr. ${physician?.full_name || "Unknown"}
Shift started: ${shiftStart} | Current time: ${now}
${prefBlock}${memoryBlock}

ENCOUNTERS THIS SHIFT (${encounterList.length} total):
${encounterSummaries || "  No encounters yet."}
${currentEncounterDetail}
─────────────────────────────────────────

Respond in first person as Robin. Be concise unless detail is needed. If asked about a specific patient, reference them by patient number.`;

  return { systemPrompt, encounterCount: encounterList.length };
}
