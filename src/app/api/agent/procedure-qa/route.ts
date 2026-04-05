import { createClient } from "@/lib/supabase/server";
import { createEmptyNote } from "@/lib/robinTypes";
import type { EncounterNote } from "@/lib/robinTypes";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ─── Procedure KB — question sequences ──────────────────────────────────────

const PROCEDURE_KB: Record<string, { name: string; questions: string[] }> = {
  sedation_closed_reduction: {
    name: "Procedural Sedation + Closed Reduction",
    questions: [
      "Which extremity and what type of injury?",
      "What sedation agent and dose did you use?",
      "What were the pre-procedure vitals?",
      "Any complications during the procedure?",
      "Was the reduction successful?",
      "Post-reduction neurovascular status?",
      "Post-reduction X-ray findings?",
      "Time to baseline mental status?",
    ],
  },
  lac_repair: {
    name: "Laceration Repair",
    questions: [
      "Location and approximate length of the laceration?",
      "How did you irrigate?",
      "Closure method — sutures, staples, or adhesive?",
      "Suture type and count (if applicable)?",
      "Wound appearance after closure?",
      "Tetanus status — up to date?",
      "Wound care and follow-up instructions given?",
    ],
  },
  incision_drainage: {
    name: "Incision & Drainage",
    questions: [
      "Location and size of the abscess?",
      "What anesthesia did you use?",
      "Incision size and orientation?",
      "Approximate drainage volume and character?",
      "Any loculations broken up?",
      "Was the wound packed?",
      "Culture sent?",
      "Any complications?",
    ],
  },
  intubation: {
    name: "Intubation / RSI",
    questions: [
      "Indication for intubation?",
      "Pre-oxygenation method?",
      "RSI agents and doses?",
      "Blade type/size and ET tube size?",
      "Grade of view?",
      "Number of attempts?",
      "Confirmation method — end-tidal CO2, auscultation?",
      "Initial vent settings?",
      "Any complications?",
    ],
  },
  splinting: {
    name: "Splinting",
    questions: [
      "Location and type of splint applied?",
      "Pre-splint neurovascular status?",
      "Post-splint neurovascular status?",
      "X-ray findings?",
    ],
  },
};

// Map trigger words to procedure types
function matchProcedure(rawText: string): string | null {
  const lower = rawText.toLowerCase();
  if (/\b(sedation|procedural sedation|conscious sedation|closed reduction)\b/.test(lower))
    return "sedation_closed_reduction";
  if (/\b(lac repair|laceration|sutures?|staples?|wound closure)\b/.test(lower))
    return "lac_repair";
  if (/\b(i&d|i and d|incision and drainage|abscess|drained)\b/.test(lower))
    return "incision_drainage";
  if (/\b(intubat|rsi|rapid sequence)\b/.test(lower)) return "intubation";
  if (/\b(splint|splinted|applied a splint)\b/.test(lower)) return "splinting";
  return null;
}

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const {
    encounterId,
    procedureType,
    questionIndex,
    answer,
    previousAnswers,
    shiftId,
  } = await request.json();

  if (!encounterId || !shiftId) {
    return Response.json(
      { error: "Missing encounterId or shiftId" },
      { status: 400 }
    );
  }

  // Detect procedure type if not provided
  const resolvedType = procedureType || matchProcedure(answer || "");
  if (!resolvedType || !PROCEDURE_KB[resolvedType]) {
    return Response.json({
      error: "Unknown procedure type",
      availableTypes: Object.keys(PROCEDURE_KB),
    }, { status: 400 });
  }

  const procedure = PROCEDURE_KB[resolvedType];
  const currentIndex = questionIndex ?? 0;
  const answers = previousAnswers || {};

  // If we have an answer, record it
  if (answer && currentIndex < procedure.questions.length) {
    answers[procedure.questions[currentIndex]] = answer;
  }

  // Check if complete
  const nextIndex = currentIndex + (answer ? 1 : 0);
  const complete = nextIndex >= procedure.questions.length;

  if (complete) {
    // Generate procedure note from Q&A answers
    const procedureNote = await assembleProcedureNote(
      procedure.name,
      answers
    );

    // Write to encounter note
    const { data: encounter } = await supabase
      .from("encounters")
      .select("note, note_version, created_at")
      .eq("id", encounterId)
      .single();

    if (encounter) {
      const note: EncounterNote = encounter.note
        ? (encounter.note as EncounterNote)
        : { ...createEmptyNote(), created_at: encounter.created_at };

      note.procedures.push({
        id: crypto.randomUUID(),
        procedure_type: resolvedType,
        performed_at: new Date().toISOString(),
        qa_responses: answers,
        procedure_note: procedureNote,
      });

      note.note_version = (encounter.note_version || 1) + 1;

      await supabase
        .from("encounters")
        .update({ note, note_version: note.note_version })
        .eq("id", encounterId);
    }

    // Log action
    await supabase.from("robin_actions").insert({
      shift_id: shiftId,
      encounter_id: encounterId,
      action_type: "procedure_note",
      raw_command: `Procedure: ${procedure.name}`,
      parsed_payload: answers,
      confidence: 1,
      confirmed_by_physician: true,
      previous_state: null,
      note_section_affected: "procedures",
    });

    return Response.json({
      nextQuestion: null,
      complete: true,
      procedureNote,
      procedureType: resolvedType,
    });
  }

  // Return next question
  return Response.json({
    nextQuestion: procedure.questions[nextIndex],
    questionIndex: nextIndex,
    complete: false,
    procedureType: resolvedType,
    procedureName: procedure.name,
    totalQuestions: procedure.questions.length,
  });
}

async function assembleProcedureNote(
  procedureName: string,
  answers: Record<string, string>
): Promise<string> {
  try {
    const qaText = Object.entries(answers)
      .map(([q, a]) => `Q: ${q}\nA: ${a}`)
      .join("\n\n");

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: `Assemble a structured procedure note from Q&A responses. Use this format:

PROCEDURE: [type]
Date/Time: [current timestamp]
Indication: [from context]
Anesthesia: [if applicable]
Procedure:
  [narrative assembled from answers]
Complications: [none | listed]
Patient tolerated procedure [well | with noted complications].

Be concise, professional, clinical. Do not invent details not in the answers.`,
      messages: [
        {
          role: "user",
          content: `Procedure: ${procedureName}\n\n${qaText}\n\nAssemble the procedure note.`,
        },
      ],
    });

    return message.content[0].type === "text"
      ? message.content[0].text
      : `PROCEDURE: ${procedureName}\n[Assembly failed]`;
  } catch {
    // Fallback: simple concatenation
    const lines = Object.entries(answers).map(
      ([q, a]) => `${q.replace(/\?$/, "")}: ${a}`
    );
    return `PROCEDURE: ${procedureName}\nDate/Time: ${new Date().toISOString()}\n\n${lines.join("\n")}`;
  }
}
