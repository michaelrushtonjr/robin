import { createClient } from "@/lib/supabase/server";
import { buildRobinContext } from "@/lib/robinPersona";
import type { EncounterNote } from "@/lib/robinTypes";
import { detectAddressedGaps, markGapsAddressed } from "@/lib/memory";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { encounterId } = await request.json();

  if (!encounterId) {
    return Response.json(
      { error: "Missing encounterId" },
      { status: 400 }
    );
  }

  // Fetch encounter with note + mdm_data (for gaps-addressed detection)
  const { data: encounter } = await supabase
    .from("encounters")
    .select(
      "id, shift_id, chief_complaint, note, note_version, transcript, age, gender, mdm_data"
    )
    .eq("id", encounterId)
    .single();

  if (!encounter) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  // Verify ownership
  const { data: shift } = await supabase
    .from("shifts")
    .select("id")
    .eq("id", encounter.shift_id)
    .eq("physician_id", user.id)
    .single();

  if (!shift) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  const note = encounter.note as EncounterNote | null;
  if (!note) {
    return Response.json({ error: "No note to finalize" }, { status: 400 });
  }

  // Build context for Robin
  const { systemPrompt } = await buildRobinContext(
    supabase,
    encounter.shift_id,
    encounterId
  );

  // Assemble current note content for Claude
  const sections: string[] = [];
  const addSection = (label: string, content: string | null) => {
    if (content) sections.push(`## ${label}\n${content}`);
  };

  addSection("Chief Complaint", note.chief_complaint?.content);
  addSection("HPI", note.hpi?.content);
  addSection("Review of Systems", note.review_of_systems?.content);
  addSection("Physical Examination", note.physical_exam?.content);

  if (note.orders.length > 0) {
    sections.push(
      `## Orders\n${note.orders.map((o) => `- ${o.description} (${o.order_type})`).join("\n")}`
    );
  }

  if (note.diagnostic_results.ekgs.length > 0) {
    sections.push(
      `## EKGs\n${note.diagnostic_results.ekgs.map((e) => e.interpretation).join("\n\n")}`
    );
  }

  if (note.diagnostic_results.radiology.length > 0) {
    sections.push(
      `## Radiology\n${note.diagnostic_results.radiology.map((r) => `${r.study_type}: ${r.result || "pending"}`).join("\n")}`
    );
  }

  if (note.labs.length > 0) {
    sections.push(
      `## Labs\n${note.labs.map((l) => l.content).join("\n")}`
    );
  }

  addSection("MDM", note.mdm?.content);

  if (note.procedures.length > 0) {
    sections.push(
      `## Procedures\n${note.procedures.map((p) => p.procedure_note).join("\n\n")}`
    );
  }

  if (note.ed_course.length > 0) {
    sections.push(
      `## ED Course\n${note.ed_course.map((e) => e.content).join("\n\n")}`
    );
  }

  if (note.consults.length > 0) {
    sections.push(
      `## Consults\n${note.consults.map((c) => `${c.consulting_service}${c.consulting_physician ? ` (${c.consulting_physician})` : ""}: ${c.recommendations || "pending"}`).join("\n")}`
    );
  }

  addSection("Final Diagnosis", note.final_diagnosis?.content);
  addSection("Disposition", note.disposition?.content);

  const noteText = sections.join("\n\n");

  const demo = [encounter.age, encounter.gender].filter(Boolean).join("");
  const patientContext = `Patient: ${demo || "Unknown"}, Chief complaint: ${encounter.chief_complaint || "Unknown"}`;

  // Ask Claude to polish
  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: `${systemPrompt}

You are finalizing a clinical note for copy-paste into the EHR. Polish the accumulated note sections into a coherent, professional ED H&P document.

Rules:
- Do NOT invent clinical content. Only polish what exists.
- Fill minor inferable gaps (e.g., CC from chief_complaint field if section is empty)
- Maintain clinical accuracy — do not change findings, diagnoses, or plans
- Use standard ED documentation format
- Be concise but complete
- Output the full polished note as plain text, ready to paste into an EHR`,
    messages: [
      {
        role: "user",
        content: `${patientContext}\n\nAccumulated note sections:\n\n${noteText}\n\nPlease finalize this into a polished, copy-ready ED note.`,
      },
    ],
  });

  const finalizedText =
    message.content[0].type === "text"
      ? message.content[0].text
      : "Finalization failed";

  // Update note with finalized timestamp
  const now = new Date().toISOString();
  note.finalized_at = now;
  note.note_version = (encounter.note_version || 1) + 1;

  await supabase
    .from("encounters")
    .update({
      note,
      note_version: note.note_version,
      generated_note: finalizedText,
    })
    .eq("id", encounterId);

  // Shift memory — mark gaps that the finalized note addressed. Non-fatal
  // on failure (the note save is what matters; memory is advisory).
  try {
    const mdmData = encounter.mdm_data as
      | { gaps?: Array<{ gap_type: string }> }
      | null;
    const flaggedTypes = (mdmData?.gaps ?? []).map((g) => g.gap_type);
    if (flaggedTypes.length > 0) {
      const addressed = detectAddressedGaps(flaggedTypes, finalizedText);
      await markGapsAddressed(
        supabase,
        encounter.shift_id,
        encounterId,
        addressed
      );
    }
  } catch {
    // Swallow — memory layer is never allowed to fail a finalization.
  }

  return Response.json({
    ok: true,
    finalizedNote: finalizedText,
    finalizedAt: now,
    noteVersion: note.note_version,
  });
}
