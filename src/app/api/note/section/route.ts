import { createClient } from "@/lib/supabase/server";
import { createEmptyNote } from "@/lib/robinTypes";
import type { EncounterNote, NoteSection } from "@/lib/robinTypes";

export async function PATCH(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const {
    encounterId,
    section,
    content,
    operation = "set",
    updatedBy = "physician",
    noteVersion,
  } = await request.json();

  if (!encounterId || !section) {
    return Response.json(
      { error: "Missing encounterId or section" },
      { status: 400 }
    );
  }

  // Fetch current encounter with note
  const { data: encounter, error: fetchError } = await supabase
    .from("encounters")
    .select("note, note_version, shift_id, created_at")
    .eq("id", encounterId)
    .single();

  if (fetchError || !encounter) {
    return Response.json({ error: "Encounter not found" }, { status: 404 });
  }

  // Verify ownership via shift
  const { data: shift } = await supabase
    .from("shifts")
    .select("id")
    .eq("id", encounter.shift_id)
    .eq("physician_id", user.id)
    .single();

  if (!shift) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Initialize note if null
  const note: EncounterNote = encounter.note
    ? (encounter.note as EncounterNote)
    : { ...createEmptyNote(), created_at: encounter.created_at };

  // Optimistic locking — check version if provided
  if (noteVersion !== undefined && noteVersion !== encounter.note_version) {
    return Response.json(
      {
        error: "Version conflict",
        currentVersion: encounter.note_version,
        yourVersion: noteVersion,
      },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();

  // Handle NoteSection fields (string content sections)
  const noteSections = [
    "chief_complaint",
    "hpi",
    "review_of_systems",
    "physical_exam",
    "mdm",
    "final_diagnosis",
    "disposition",
    "discharge_instructions",
  ] as const;

  if (noteSections.includes(section as (typeof noteSections)[number])) {
    const sectionKey = section as keyof Pick<
      EncounterNote,
      (typeof noteSections)[number]
    >;
    const current = note[sectionKey] as NoteSection;

    if (operation === "append" && current.content) {
      current.content = `${current.content}\n\n${content}`;
    } else {
      current.content = content;
    }
    current.last_updated_at = now;
    current.updated_by = updatedBy;
  }

  // Handle array sections
  const arraySections = [
    "orders",
    "labs",
    "procedures",
    "ed_course",
    "consults",
  ] as const;

  if (arraySections.includes(section as (typeof arraySections)[number])) {
    const sectionKey = section as keyof Pick<
      EncounterNote,
      (typeof arraySections)[number]
    >;
    if (operation === "append" && content) {
      (note[sectionKey] as unknown[]).push(content);
    } else if (operation === "set") {
      (note[sectionKey] as unknown) = content;
    }
  }

  // Handle nested diagnostic_results
  if (section === "diagnostic_results.ekgs") {
    if (operation === "append" && content) {
      note.diagnostic_results.ekgs.push(content);
    } else if (operation === "set") {
      note.diagnostic_results.ekgs = content;
    }
  }
  if (section === "diagnostic_results.radiology") {
    if (operation === "append" && content) {
      note.diagnostic_results.radiology.push(content);
    } else if (operation === "set") {
      note.diagnostic_results.radiology = content;
    }
  }

  // Increment version and write
  note.note_version = (encounter.note_version || 1) + 1;

  const { error: updateError } = await supabase
    .from("encounters")
    .update({
      note,
      note_version: note.note_version,
    })
    .eq("id", encounterId);

  if (updateError) {
    return Response.json(
      { error: "Failed to update note" },
      { status: 500 }
    );
  }

  return Response.json({
    ok: true,
    noteVersion: note.note_version,
    section,
  });
}
