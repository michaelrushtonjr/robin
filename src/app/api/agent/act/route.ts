import { createClient } from "@/lib/supabase/server";
import { createEmptyNote } from "@/lib/robinTypes";
import type { EncounterNote } from "@/lib/robinTypes";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ─── Types ──────────────────────────────────────────────────────────────────

type CommandType =
  | "patient_briefing"
  | "disposition"
  | "physical_exam"
  | "ekg_interpretation"
  | "mdm_dictation"
  | "ed_course"
  | "order_log"
  | "lab_results"
  | "radiology"
  | "discharge_instructions"
  | "final_diagnosis"
  | "consult_log"
  | "consult_recommendations"
  | "encounter_update"
  | "voice_undo"
  | "voice_remove";

interface AgentActRequest {
  shiftId: string;
  commandType: CommandType;
  rawText: string;
  encounterId?: string;
  dictationContent?: string; // for dictation sessions — structured content from client
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

// ─── Main handler ───────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: AgentActRequest = await request.json();
  const { shiftId, commandType, rawText, encounterId, dictationContent } = body;

  if (!shiftId || !commandType || !rawText?.trim()) {
    return Response.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
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

  // Resolve encounter if needed
  const resolvedEncounterId = encounterId
    ? encounterId
    : await resolveEncounter(supabase, shiftId, rawText);

  // Route to handler
  const handlers: Record<
    CommandType,
    () => Promise<Response>
  > = {
    patient_briefing: () => handleBriefing(supabase, shiftId, rawText),
    disposition: () =>
      handleDisposition(supabase, shiftId, rawText, resolvedEncounterId),
    physical_exam: () =>
      handleNoteWrite(
        supabase,
        shiftId,
        resolvedEncounterId,
        rawText,
        dictationContent || rawText,
        "physical_exam",
        "physical_exam"
      ),
    ekg_interpretation: () =>
      handleEKG(supabase, shiftId, resolvedEncounterId, rawText),
    mdm_dictation: () =>
      handleNoteWrite(
        supabase,
        shiftId,
        resolvedEncounterId,
        rawText,
        dictationContent || rawText,
        "mdm",
        "mdm_dictation"
      ),
    ed_course: () =>
      handleEDCourse(supabase, shiftId, resolvedEncounterId, rawText, dictationContent),
    order_log: () =>
      handleOrderLog(supabase, shiftId, resolvedEncounterId, rawText),
    lab_results: () =>
      handleNoteWrite(
        supabase,
        shiftId,
        resolvedEncounterId,
        rawText,
        dictationContent || rawText,
        "labs",
        "lab_results"
      ),
    radiology: () =>
      handleRadiology(supabase, shiftId, resolvedEncounterId, rawText, dictationContent),
    discharge_instructions: () =>
      handleDischargeInstructions(supabase, shiftId, resolvedEncounterId),
    final_diagnosis: () =>
      handleFinalDiagnosis(supabase, shiftId, resolvedEncounterId, rawText),
    consult_log: () =>
      handleConsultLog(supabase, shiftId, resolvedEncounterId, rawText),
    consult_recommendations: () =>
      handleConsultRecommendations(
        supabase,
        shiftId,
        resolvedEncounterId,
        rawText,
        dictationContent
      ),
    encounter_update: () =>
      handleEncounterUpdate(supabase, shiftId, rawText),
    voice_undo: () => handleVoiceUndo(supabase, shiftId),
    voice_remove: () =>
      handleVoiceRemove(supabase, shiftId, resolvedEncounterId, rawText),
  };

  const handler = handlers[commandType];
  if (!handler) {
    return Response.json({ error: "Unknown command type" }, { status: 400 });
  }

  return handler();
}

// ─── Encounter resolution ───────────────────────────────────────────────────

async function resolveEncounter(
  supabase: SupabaseClient,
  shiftId: string,
  rawText: string
): Promise<string | undefined> {
  // Try to match by name, room, or number
  const { data: encounters } = await supabase
    .from("encounters")
    .select("id, patient_name, room, chief_complaint")
    .eq("shift_id", shiftId)
    .order("created_at", { ascending: true });

  if (!encounters || encounters.length === 0) return undefined;

  const lower = rawText.toLowerCase();

  // Match by room number
  const roomMatch = lower.match(/room\s+(\d+)/);
  if (roomMatch) {
    const found = encounters.find((e) => e.room === roomMatch[1]);
    if (found) return found.id;
  }

  // Match by encounter number ("encounter one", "patient 2")
  const numWords: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const encNumMatch = lower.match(
    /(?:encounter|patient)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)/
  );
  if (encNumMatch) {
    const num = numWords[encNumMatch[1]] || parseInt(encNumMatch[1], 10);
    if (num > 0 && num <= encounters.length) {
      return encounters[num - 1].id;
    }
  }

  // Match by patient name (fuzzy)
  for (const enc of encounters) {
    if (
      enc.patient_name &&
      lower.includes(enc.patient_name.toLowerCase())
    ) {
      return enc.id;
    }
  }

  // Match "last patient" / "the patient"
  if (
    lower.includes("last patient") ||
    lower.includes("the patient") ||
    lower.includes("this patient")
  ) {
    return encounters[encounters.length - 1].id;
  }

  // Default: most recently created
  return encounters[encounters.length - 1].id;
}

// ─── Note helpers ───────────────────────────────────────────────────────────

async function getOrCreateNote(
  supabase: SupabaseClient,
  encounterId: string
): Promise<{ note: EncounterNote; noteVersion: number } | null> {
  const { data } = await supabase
    .from("encounters")
    .select("note, note_version, created_at")
    .eq("id", encounterId)
    .single();

  if (!data) return null;

  const note: EncounterNote = data.note
    ? (data.note as EncounterNote)
    : { ...createEmptyNote(), created_at: data.created_at };

  return { note, noteVersion: data.note_version || 1 };
}

async function writeNote(
  supabase: SupabaseClient,
  encounterId: string,
  note: EncounterNote,
  newVersion: number
) {
  note.note_version = newVersion;
  return supabase
    .from("encounters")
    .update({ note, note_version: newVersion })
    .eq("id", encounterId);
}

async function logAction(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  actionType: string,
  rawCommand: string,
  parsedPayload: unknown,
  confidence: number,
  previousState: unknown,
  noteSection?: string
) {
  await supabase.from("robin_actions").insert({
    shift_id: shiftId,
    encounter_id: encounterId || null,
    action_type: actionType,
    raw_command: rawCommand,
    parsed_payload: parsedPayload,
    confidence,
    confirmed_by_physician: false,
    previous_state: previousState,
    note_section_affected: noteSection || null,
  });
}

// ─── Layer 1 handlers (preserved) ──────────────────────────────────────────

async function handleBriefing(
  supabase: SupabaseClient,
  shiftId: string,
  rawText: string
) {
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
    return Response.json({
      ok: true,
      actionTaken: `Parsed ${parsed.patients.length} patient(s) — awaiting confirmation`,
      parsedPayload: parsed,
      confidence: parsed.confidence,
      confirmationRequired: true,
    });
  }

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

  for (const enc of created) {
    await logAction(supabase, shiftId, enc.id, "patient_briefing", rawText, null, parsed.confidence, null);
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
  supabase: SupabaseClient,
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
      actionTaken: "Parsed disposition — awaiting confirmation",
      parsedPayload: parsed,
      encounterId,
      confidence: parsed.confidence,
      confirmationRequired: true,
    });
  }

  const updatePayload: Record<string, unknown> = { status: "documenting" };
  if (parsed.disposition) updatePayload.disposition = parsed.disposition;
  if (parsed.acceptingPhysician)
    updatePayload.accepting_physician = parsed.acceptingPhysician;
  if (parsed.diagnosis) {
    updatePayload.mdm_data = {
      ...(currentEnc?.mdm_data as Record<string, unknown> | null),
      pre_fill: { diagnosis: parsed.diagnosis },
    };
  }

  await supabase.from("encounters").update(updatePayload).eq("id", encounterId);
  await logAction(supabase, shiftId, encounterId, "disposition", rawText, parsed, parsed.confidence, currentEnc);

  const parts = [
    parsed.disposition,
    parsed.diagnosis,
    parsed.acceptingPhysician ? `Dr. ${parsed.acceptingPhysician}` : null,
  ].filter(Boolean);

  return Response.json({
    ok: true,
    actionTaken: `Disposition set: ${parts.join(" · ") || "documenting"}`,
    encounterId,
    confidence: parsed.confidence,
    confirmationRequired: false,
  });
}

// ─── Layer 3 handlers ──────────────────────────────────────────────────────

async function handleNoteWrite(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string,
  content: string,
  section: string,
  actionType: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (!noteData) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  const { note, noteVersion } = noteData;
  const now = new Date().toISOString();

  // For text sections
  const textSections = [
    "chief_complaint", "hpi", "review_of_systems", "physical_exam",
    "mdm", "final_diagnosis", "disposition", "discharge_instructions",
  ];

  if (textSections.includes(section)) {
    const key = section as keyof EncounterNote;
    const sec = note[key] as { content: string | null; last_updated_at: string | null; updated_by: string };
    const prevContent = sec.content;
    sec.content = sec.content ? `${sec.content}\n\n${content}` : content;
    sec.last_updated_at = now;
    sec.updated_by = "robin";

    await writeNote(supabase, encounterId, note, noteVersion + 1);
    await logAction(supabase, shiftId, encounterId, actionType, rawText, { content }, 0.9, { prevContent }, section);

    return Response.json({
      ok: true,
      actionTaken: `${section.replace(/_/g, " ")} updated`,
      encounterId,
      confidence: 0.9,
      confirmationRequired: false,
    });
  }

  // For labs (array of LabResultEntry)
  if (section === "labs") {
    note.labs.push({
      id: crypto.randomUUID(),
      logged_at: now,
      content,
    });
    await writeNote(supabase, encounterId, note, noteVersion + 1);
    await logAction(supabase, shiftId, encounterId, actionType, rawText, { content }, 0.9, null, "labs");

    return Response.json({
      ok: true,
      actionTaken: "Lab results logged",
      encounterId,
      confidence: 0.9,
      confirmationRequired: false,
    });
  }

  return Response.json({ error: "Unknown section" }, { status: 400 });
}

async function handleEKG(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (!noteData) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  const { note, noteVersion } = noteData;
  const now = new Date().toISOString();
  const isNormal = /normal\s+e[ck]g/i.test(rawText);

  const interpretation = isNormal
    ? `EKG — ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}\nRate: Normal sinus rhythm\nAxis: Normal\nIntervals: WNL\nST segments: No acute changes\nImpression: Normal sinus rhythm, no acute ST-T wave changes.`
    : rawText;

  note.diagnostic_results.ekgs.push({
    id: crypto.randomUUID(),
    performed_at: now,
    dictation_raw: rawText,
    interpretation,
    normal_shorthand: isNormal,
  });

  await writeNote(supabase, encounterId, note, noteVersion + 1);
  await logAction(supabase, shiftId, encounterId, "ekg_interpretation", rawText, { isNormal }, 0.9, null, "diagnostic_results.ekgs");

  return Response.json({
    ok: true,
    actionTaken: isNormal ? "Normal EKG logged" : "EKG interpretation logged",
    encounterId,
    confidence: 0.9,
    confirmationRequired: false,
  });
}

async function handleEDCourse(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string,
  dictationContent?: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (!noteData) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  const { note, noteVersion } = noteData;
  const now = new Date().toISOString();

  note.ed_course.push({
    id: crypto.randomUUID(),
    entry_type: "reassessment",
    performed_at: now,
    content: dictationContent || rawText,
  });

  await writeNote(supabase, encounterId, note, noteVersion + 1);
  await logAction(supabase, shiftId, encounterId, "ed_course", rawText, null, 0.9, null, "ed_course");

  return Response.json({
    ok: true,
    actionTaken: "Reassessment logged",
    encounterId,
    confidence: 0.9,
    confirmationRequired: false,
  });
}

async function handleOrderLog(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (!noteData) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  // Classify order type
  const lower = rawText.toLowerCase();
  let orderType: "labs" | "imaging" | "medication" | "other" = "other";
  if (/\b(lab|cbc|bmp|cmp|troponin|d-dimer|ua|urine|blood)\b/i.test(lower)) orderType = "labs";
  else if (/\b(ct|xr|x-ray|mri|ultrasound|imaging|chest\s*x)/i.test(lower)) orderType = "imaging";
  else if (/\b(mg|dose|administer|give|push|drip|infusion)\b/i.test(lower)) orderType = "medication";

  const { note, noteVersion } = noteData;
  const now = new Date().toISOString();

  note.orders.push({
    id: crypto.randomUUID(),
    ordered_at: now,
    description: rawText,
    order_type: orderType,
    mdm_relevant: orderType === "labs" || orderType === "imaging",
  });

  await writeNote(supabase, encounterId, note, noteVersion + 1);
  await logAction(supabase, shiftId, encounterId, "order_log", rawText, { orderType }, 0.9, null, "orders");

  return Response.json({
    ok: true,
    actionTaken: `Order logged: ${rawText.slice(0, 50)}`,
    encounterId,
    confidence: 0.9,
    confirmationRequired: false,
  });
}

async function handleRadiology(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string,
  dictationContent?: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (!noteData) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  // Extract study type
  const lower = rawText.toLowerCase();
  let studyType = "imaging";
  if (/\bct\b/i.test(lower)) studyType = lower.match(/ct\s+[\w/]+/i)?.[0] || "CT";
  else if (/\b(cxr|chest\s*x)/i.test(lower)) studyType = "CXR";
  else if (/\bxr\b|x-ray/i.test(lower)) studyType = lower.match(/(xr|x-ray)\s+[\w]+/i)?.[0] || "XR";
  else if (/\bmri\b/i.test(lower)) studyType = "MRI";
  else if (/\bultrasound|us\b/i.test(lower)) studyType = "Ultrasound";

  const { note, noteVersion } = noteData;
  const now = new Date().toISOString();

  note.diagnostic_results.radiology.push({
    id: crypto.randomUUID(),
    study_type: studyType,
    ordered_at: now,
    result: dictationContent || null,
    dictated_at: dictationContent ? now : null,
  });

  await writeNote(supabase, encounterId, note, noteVersion + 1);
  await logAction(supabase, shiftId, encounterId, "radiology", rawText, { studyType }, 0.9, null, "diagnostic_results.radiology");

  return Response.json({
    ok: true,
    actionTaken: `Radiology logged: ${studyType}`,
    encounterId,
    confidence: 0.9,
    confirmationRequired: false,
  });
}

async function handleDischargeInstructions(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  const { data: encounter } = await supabase
    .from("encounters")
    .select("chief_complaint, age, gender, note")
    .eq("id", encounterId)
    .single();

  if (!encounter) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  const cc = encounter.chief_complaint || "general";
  const demo = [encounter.age, encounter.gender].filter(Boolean).join("");

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system: `Generate patient-friendly ED discharge instructions. Be clear, concise, and actionable. Include: diagnosis summary, home care, medications if applicable, return precautions (when to come back to the ER), and follow-up recommendations. Use simple language a patient can understand. Do not use medical jargon.`,
    messages: [
      {
        role: "user",
        content: `Patient: ${demo || "adult"}, Chief complaint: ${cc}. Generate discharge instructions.`,
      },
    ],
  });

  const instructions =
    message.content[0].type === "text" ? message.content[0].text : "";

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (noteData) {
    const { note, noteVersion } = noteData;
    note.discharge_instructions = {
      content: instructions,
      last_updated_at: new Date().toISOString(),
      updated_by: "robin_generated",
    };
    await writeNote(supabase, encounterId, note, noteVersion + 1);
  }

  await logAction(supabase, shiftId, encounterId, "discharge_instructions", `Generate DC for ${cc}`, null, 0.9, null, "discharge_instructions");

  return Response.json({
    ok: true,
    actionTaken: "Discharge instructions ready",
    encounterId,
    confidence: 0.9,
    confirmationRequired: false,
  });
}

async function handleFinalDiagnosis(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  // Map to ICD-10 via Claude
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Map a clinical diagnosis to ICD-10 codes. Return JSON only.
Format: { "diagnosis": "cleaned diagnosis text", "icd10": "K35.2", "icd10_description": "Acute appendicitis with perforation", "confidence": 0.92, "alternatives": [{"code": "K35.89", "description": "..."}] }
If no confident match: confidence below 0.85, include up to 4 alternatives.`,
    messages: [{ role: "user", content: rawText }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "{}";
  let parsed;
  try {
    parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    parsed = { diagnosis: rawText, confidence: 0.5 };
  }

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (noteData) {
    const { note, noteVersion } = noteData;
    const diagText = parsed.icd10
      ? `${parsed.diagnosis}\nICD-10: ${parsed.icd10} — ${parsed.icd10_description}`
      : parsed.diagnosis || rawText;
    note.final_diagnosis = {
      content: diagText,
      last_updated_at: new Date().toISOString(),
      updated_by: "robin",
    };
    await writeNote(supabase, encounterId, note, noteVersion + 1);
  }

  await logAction(supabase, shiftId, encounterId, "final_diagnosis", rawText, parsed, parsed.confidence || 0.5, null, "final_diagnosis");

  const highConfidence = (parsed.confidence || 0) >= 0.85;

  return Response.json({
    ok: true,
    actionTaken: parsed.icd10
      ? `Dx: ${parsed.diagnosis} (${parsed.icd10})`
      : `Dx: ${parsed.diagnosis || rawText}`,
    encounterId,
    confidence: parsed.confidence || 0.5,
    confirmationRequired: !highConfidence,
    parsedPayload: parsed,
  });
}

async function handleConsultLog(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  // Parse consult from natural language
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `Extract consult information from a physician's statement. Return JSON only.
Format: { "service": "Orthopedic Surgery", "physician": "Spock" or null, "confidence": 0.9 }`,
    messages: [{ role: "user", content: rawText }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "{}";
  let parsed;
  try {
    parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    parsed = { service: rawText, confidence: 0.5 };
  }

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (noteData) {
    const { note, noteVersion } = noteData;
    note.consults.push({
      id: crypto.randomUUID(),
      consulting_service: parsed.service || rawText,
      consulting_physician: parsed.physician || null,
      contacted_at: new Date().toISOString(),
      recommendations: null,
    });
    await writeNote(supabase, encounterId, note, noteVersion + 1);
  }

  await logAction(supabase, shiftId, encounterId, "consult_log", rawText, parsed, parsed.confidence || 0.75, null, "consults");

  return Response.json({
    ok: true,
    actionTaken: `Consult logged: ${parsed.service || rawText}`,
    encounterId,
    confidence: parsed.confidence || 0.75,
    confirmationRequired: false,
  });
}

async function handleConsultRecommendations(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string,
  dictationContent?: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  const noteData = await getOrCreateNote(supabase, encounterId);
  if (!noteData) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  const { note, noteVersion } = noteData;
  // Find most recent consult without recommendations
  const pendingConsult = [...note.consults].reverse().find((c) => !c.recommendations);

  if (pendingConsult) {
    pendingConsult.recommendations = dictationContent || rawText;
    await writeNote(supabase, encounterId, note, noteVersion + 1);
    await logAction(supabase, shiftId, encounterId, "consult_recommendations", rawText, null, 0.9, null, "consults");

    return Response.json({
      ok: true,
      actionTaken: `Recommendations added for ${pendingConsult.consulting_service}`,
      encounterId,
      confidence: 0.9,
      confirmationRequired: false,
    });
  }

  return Response.json({
    ok: true,
    actionTaken: "No pending consult found to add recommendations to",
    confidence: 0.5,
    confirmationRequired: false,
  });
}

async function handleEncounterUpdate(
  supabase: SupabaseClient,
  shiftId: string,
  rawText: string
) {
  // Parse the update command
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `Extract encounter update from a physician's command. Return JSON only.
Format: { "encounterNumber": 1, "field": "patient_name", "value": "Gonzalez", "confidence": 0.85 }
"encounter one/two/three" = chronological order. Field can be: patient_name, room, chief_complaint, age, gender.`,
    messages: [{ role: "user", content: rawText }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "{}";
  let parsed;
  try {
    parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    parsed = { confidence: 0.3 };
  }

  if (!parsed.encounterNumber || !parsed.field || !parsed.value) {
    return Response.json({
      ok: false,
      actionTaken: "Could not parse update command",
      confidence: 0,
      confirmationRequired: false,
    });
  }

  // Always confirm for encounter updates
  return Response.json({
    ok: true,
    actionTaken: `Update encounter ${parsed.encounterNumber}: ${parsed.field} → ${parsed.value}`,
    parsedPayload: parsed,
    confidence: parsed.confidence || 0.7,
    confirmationRequired: true,
  });
}

async function handleVoiceUndo(
  supabase: SupabaseClient,
  shiftId: string
) {
  // Find most recent robin action for this shift
  const { data: lastAction } = await supabase
    .from("robin_actions")
    .select("*")
    .eq("shift_id", shiftId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!lastAction || !lastAction.previous_state) {
    return Response.json({
      ok: false,
      actionTaken: "Nothing to undo",
      confidence: 1,
      confirmationRequired: false,
    });
  }

  // Delegate to /api/agent/undo
  return Response.json({
    ok: true,
    actionTaken: `Undo: ${lastAction.action_type}`,
    parsedPayload: { actionId: lastAction.id },
    confidence: 1,
    confirmationRequired: false,
    undoActionId: lastAction.id,
  });
}

async function handleVoiceRemove(
  supabase: SupabaseClient,
  shiftId: string,
  encounterId: string | undefined,
  rawText: string
) {
  if (!encounterId) {
    return Response.json({ error: "No encounter identified" }, { status: 400 });
  }

  // Determine what to remove
  const lower = rawText.toLowerCase();
  const isArrayTarget =
    /\b(ekg|procedure|reassessment|ed course|consult|order|lab)\b/i.test(lower);

  if (isArrayTarget) {
    // Auto-tier for array entries
    return Response.json({
      ok: true,
      actionTaken: `Remove last entry — processing`,
      encounterId,
      confidence: 0.85,
      confirmationRequired: false,
      parsedPayload: { removeTarget: rawText, encounterId },
    });
  }

  // Confirm-tier for static sections (PE, MDM, HPI, etc.)
  return Response.json({
    ok: true,
    actionTaken: `Clear section for this encounter?`,
    encounterId,
    confidence: 0.8,
    confirmationRequired: true,
    parsedPayload: { removeTarget: rawText, encounterId },
  });
}

// ─── Parse helpers ──────────────────────────────────────────────────────────

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

async function parseBriefing(rawText: string): Promise<ParsedBriefing> {
  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: `Extract patients from a physician's verbal briefing. Return JSON only.
Format: { "patients": [{ "age": 74, "gender": "F", "chiefComplaint": "Abdominal pain", "room": "4", "name": "Johnson" }], "confidence": 0.85 }
Rules: age integer or null, gender "M"/"F"/"X"/null, chiefComplaint standardized ED language, room string or null, name last name or null, confidence 0-1 (below 0.7 if ambiguous).`,
      messages: [{ role: "user", content: rawText }],
    });
    const text = message.content[0].type === "text" ? message.content[0].text : "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return {
      patients: Array.isArray(parsed.patients) ? parsed.patients : [],
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
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
      system: `Extract disposition from a physician's command. Return JSON only.
Format: { "diagnosis": string|null, "disposition": "admitted"|"discharged"|"transferred"|"AMA"|"observation"|null, "acceptingPhysician": string|null, "confidence": 0.85 }`,
      messages: [{ role: "user", content: rawText }],
    });
    const text = message.content[0].type === "text" ? message.content[0].text : "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return {
      diagnosis: parsed.diagnosis || null,
      disposition: parsed.disposition || null,
      acceptingPhysician: parsed.acceptingPhysician || null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return { diagnosis: null, disposition: null, acceptingPhysician: null, confidence: 0 };
  }
}
