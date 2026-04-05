import { createClient } from "@/lib/supabase/server";
import { computeNoteBadges } from "@/lib/robinTypes";
import type { EncounterNote } from "@/lib/robinTypes";

export async function GET(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const shiftId = searchParams.get("shiftId");

  if (!shiftId) {
    return Response.json({ error: "Missing shiftId" }, { status: 400 });
  }

  // Verify shift ownership
  const { data: shift } = await supabase
    .from("shifts")
    .select("id")
    .eq("id", shiftId)
    .eq("physician_id", user.id)
    .single();

  if (!shift) {
    return Response.json({ error: "Shift not found" }, { status: 404 });
  }

  // Fetch all encounters for this shift
  const { data: encounters } = await supabase
    .from("encounters")
    .select(
      "id, chief_complaint, room, patient_name, age, gender, note, created_at, status"
    )
    .eq("shift_id", shiftId)
    .order("created_at", { ascending: true });

  const results = (encounters || []).map((enc) => {
    const note = enc.note as EncounterNote | null;
    const badges = computeNoteBadges(note, enc.created_at);

    // Count populated sections
    let sectionCount = 0;
    if (note) {
      const textSections = [
        "chief_complaint",
        "hpi",
        "review_of_systems",
        "physical_exam",
        "mdm",
        "final_diagnosis",
        "disposition",
      ] as const;
      for (const s of textSections) {
        if (note[s]?.content) sectionCount++;
      }
      if (note.orders.length > 0) sectionCount++;
      if (note.diagnostic_results.ekgs.length > 0) sectionCount++;
      if (note.diagnostic_results.radiology.length > 0) sectionCount++;
      if (note.labs.length > 0) sectionCount++;
      if (note.procedures.length > 0) sectionCount++;
      if (note.ed_course.length > 0) sectionCount++;
      if (note.consults.length > 0) sectionCount++;
    }

    const demo = [enc.age, enc.gender].filter(Boolean).join("");
    const patientIdentifier =
      enc.patient_name || (demo ? `${demo}` : `Encounter`);

    return {
      encounterId: enc.id,
      patientIdentifier,
      chiefComplaint: enc.chief_complaint,
      room: enc.room,
      status: enc.status,
      badges,
      finalizedAt: note?.finalized_at || null,
      sectionCount,
      createdAt: enc.created_at,
    };
  });

  return Response.json({ encounters: results });
}
