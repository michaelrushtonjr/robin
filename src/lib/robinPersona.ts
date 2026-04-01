import type { SupabaseClient } from "@supabase/supabase-js";

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
        .select("display_name, robin_preferences")
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
Physician: Dr. ${physician?.display_name || "Unknown"}
Shift started: ${shiftStart} | Current time: ${now}
${prefBlock}${memoryBlock}

ENCOUNTERS THIS SHIFT (${encounterList.length} total):
${encounterSummaries || "  No encounters yet."}
${currentEncounterDetail}
─────────────────────────────────────────

Respond in first person as Robin. Be concise unless detail is needed. If asked about a specific patient, reference them by patient number.`;

  return { systemPrompt, encounterCount: encounterList.length };
}
