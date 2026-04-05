import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

interface AgentActRequest {
  shiftId: string;
  commandType: "patient_briefing" | "disposition";
  rawText: string;
  encounterId?: string;
}

interface ParsedBriefing {
  patients: Array<{
    age: number | null;
    gender: string | null;
    chiefComplaint: string | null;
    room: string | null;
    name: string | null;
  }>;
  confidence: number;
}

interface ParsedDisposition {
  diagnosis: string | null;
  disposition: string | null;
  acceptingPhysician: string | null;
  confidence: number;
}

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: AgentActRequest = await request.json();
  const { shiftId, commandType, rawText, encounterId } = body;

  if (!shiftId || !commandType || !rawText?.trim()) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Verify shift belongs to this physician
  const { data: shift } = await supabase
    .from("shifts")
    .select("id")
    .eq("id", shiftId)
    .eq("physician_id", user.id)
    .single();

  if (!shift) {
    return Response.json({ error: "Shift not found" }, { status: 404 });
  }

  if (commandType === "patient_briefing") {
    return handleBriefing(supabase, shiftId, rawText);
  } else if (commandType === "disposition") {
    return handleDisposition(supabase, shiftId, rawText, encounterId);
  }

  return Response.json({ error: "Unknown command type" }, { status: 400 });
}

async function handleBriefing(
  supabase: Awaited<ReturnType<typeof createClient>>,
  shiftId: string,
  rawText: string
) {
  // Parse the briefing using Claude
  const parsed = await parseBriefing(rawText);

  if (parsed.patients.length === 0) {
    return Response.json({
      ok: false,
      actionTaken: "Could not parse any patients from briefing",
      confidence: 0,
      confirmationRequired: false,
    });
  }

  const confirmationRequired = parsed.confidence < 0.7;

  if (confirmationRequired) {
    // Return parsed data for confirmation — don't write yet
    return Response.json({
      ok: true,
      actionTaken: `Parsed ${parsed.patients.length} patient(s) — awaiting confirmation`,
      parsedPayload: parsed,
      confidence: parsed.confidence,
      confirmationRequired: true,
    });
  }

  // Auto-tier: create encounters directly
  const inserts = parsed.patients.map((p) => ({
    shift_id: shiftId,
    chief_complaint: p.chiefComplaint,
    age: p.age,
    gender: p.gender,
    room: p.room,
    patient_name: p.name,
    status: "active",
    created_by_robin: true,
  }));

  const { data: created, error } = await supabase
    .from("encounters")
    .insert(inserts)
    .select();

  if (error || !created) {
    return Response.json(
      { error: "Failed to create encounters" },
      { status: 500 }
    );
  }

  // Log each action
  for (const enc of created) {
    await supabase.from("robin_actions").insert({
      shift_id: shiftId,
      encounter_id: enc.id,
      action_type: "patient_briefing",
      raw_command: rawText,
      parsed_payload: inserts.find(
        (i) => i.chief_complaint === enc.chief_complaint && i.room === enc.room
      ),
      confidence: parsed.confidence,
      confirmed_by_physician: false,
      previous_state: null,
    });
  }

  const summary = created
    .map((enc) => {
      const demo = [enc.age, enc.gender].filter(Boolean).join("");
      const label = demo
        ? `${demo}, ${enc.chief_complaint || "unknown"}`
        : enc.chief_complaint || "new patient";
      const room = enc.room ? ` Room ${enc.room}` : "";
      return `${enc.patient_name || label}${room}`;
    })
    .join(" · ");

  return Response.json({
    ok: true,
    actionTaken: `Created ${created.length} encounter${created.length > 1 ? "s" : ""}: ${summary}`,
    encounters: created,
    confidence: parsed.confidence,
    confirmationRequired: false,
  });
}

async function handleDisposition(
  supabase: Awaited<ReturnType<typeof createClient>>,
  shiftId: string,
  rawText: string,
  encounterId?: string
) {
  if (!encounterId) {
    return Response.json(
      { error: "encounterId required for disposition" },
      { status: 400 }
    );
  }

  // Get current encounter state for undo
  const { data: currentEnc } = await supabase
    .from("encounters")
    .select("status, disposition, accepting_physician, mdm_data")
    .eq("id", encounterId)
    .single();

  const parsed = await parseDisposition(rawText);
  const confirmationRequired = parsed.confidence < 0.7;

  if (confirmationRequired) {
    return Response.json({
      ok: true,
      actionTaken: `Parsed disposition — awaiting confirmation`,
      parsedPayload: parsed,
      encounterId,
      confidence: parsed.confidence,
      confirmationRequired: true,
    });
  }

  // Auto-tier: update encounter
  const updatePayload: Record<string, unknown> = {
    status: "documenting",
  };
  if (parsed.disposition) updatePayload.disposition = parsed.disposition;
  if (parsed.acceptingPhysician)
    updatePayload.accepting_physician = parsed.acceptingPhysician;
  if (parsed.diagnosis) {
    updatePayload.mdm_data = {
      ...(currentEnc?.mdm_data as Record<string, unknown> | null),
      pre_fill: { diagnosis: parsed.diagnosis },
    };
  }

  const { error } = await supabase
    .from("encounters")
    .update(updatePayload)
    .eq("id", encounterId);

  if (error) {
    return Response.json(
      { error: "Failed to update encounter" },
      { status: 500 }
    );
  }

  // Log action with previous state for undo
  await supabase.from("robin_actions").insert({
    shift_id: shiftId,
    encounter_id: encounterId,
    action_type: "disposition",
    raw_command: rawText,
    parsed_payload: parsed,
    confidence: parsed.confidence,
    confirmed_by_physician: false,
    previous_state: currentEnc,
  });

  const parts = [
    parsed.disposition,
    parsed.diagnosis,
    parsed.acceptingPhysician
      ? `Dr. ${parsed.acceptingPhysician}`
      : null,
  ].filter(Boolean);

  return Response.json({
    ok: true,
    actionTaken: `Disposition set: ${parts.join(" · ") || "documenting"}`,
    encounterId,
    confidence: parsed.confidence,
    confirmationRequired: false,
  });
}

async function parseBriefing(rawText: string): Promise<ParsedBriefing> {
  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: `Extract patients from a physician's verbal briefing. Return JSON only.

Format:
{
  "patients": [
    { "age": 74, "gender": "F", "chiefComplaint": "Abdominal pain", "room": "4", "name": "Johnson" }
  ],
  "confidence": 0.85
}

Rules:
- age: integer or null
- gender: "M", "F", "X", or null
- chiefComplaint: standardized ED language (e.g. "belly pain" → "Abdominal pain")
- room: string or null
- name: last name if mentioned, null otherwise
- confidence: 0-1 based on how clear the briefing was. Below 0.7 if ambiguous.
- Return empty patients array if nothing identifiable.`,
      messages: [{ role: "user", content: rawText }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return {
      patients: Array.isArray(parsed.patients) ? parsed.patients : [],
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return { patients: [], confidence: 0 };
  }
}

async function parseDisposition(rawText: string): Promise<ParsedDisposition> {
  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `Extract disposition information from a physician's verbal command. Return JSON only.

Format:
{
  "diagnosis": "Diverticulitis" or null,
  "disposition": "admitted" | "discharged" | "transferred" | "AMA" | "observation" or null,
  "acceptingPhysician": "Spock" or null,
  "confidence": 0.85
}

Rules:
- diagnosis: primary diagnosis if stated, null if not
- disposition: normalize to one of the standard options, null if unclear
- acceptingPhysician: last name only if mentioned, null otherwise
- confidence: 0-1. Below 0.7 if ambiguous about patient identity or disposition type.
- "ready to go" / "discharge" → "discharged"
- "accepted to [unit]" / "admitted" → "admitted"
- "going home" → "discharged"
- "AMA" / "left against medical advice" → "AMA"`,
      messages: [{ role: "user", content: rawText }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return {
      diagnosis: parsed.diagnosis || null,
      disposition: parsed.disposition || null,
      acceptingPhysician: parsed.acceptingPhysician || null,
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return {
      diagnosis: null,
      disposition: null,
      acceptingPhysician: null,
      confidence: 0,
    };
  }
}
