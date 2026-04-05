import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { actionId } = await request.json();

  if (!actionId) {
    return Response.json({ error: "Missing actionId" }, { status: 400 });
  }

  // Fetch the action to undo
  const { data: action } = await supabase
    .from("robin_actions")
    .select("*")
    .eq("id", actionId)
    .single();

  if (!action) {
    return Response.json({ error: "Action not found" }, { status: 404 });
  }

  // Verify ownership via shift
  const { data: shift } = await supabase
    .from("shifts")
    .select("id")
    .eq("id", action.shift_id)
    .eq("physician_id", user.id)
    .single();

  if (!shift) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Restore previous state
  if (action.previous_state && action.encounter_id) {
    // For note section changes, restore the note
    if (action.note_section_affected) {
      const { data: encounter } = await supabase
        .from("encounters")
        .select("note, note_version")
        .eq("id", action.encounter_id)
        .single();

      if (encounter) {
        // Store current state before undo (for redo)
        const preUndoState = {
          note: encounter.note,
          note_version: encounter.note_version,
        };

        // Restore — previous_state contains the pre-action encounter fields
        await supabase
          .from("encounters")
          .update(action.previous_state)
          .eq("id", action.encounter_id);

        // Log the undo itself
        await supabase.from("robin_actions").insert({
          shift_id: action.shift_id,
          encounter_id: action.encounter_id,
          action_type: "undo",
          raw_command: `Undo: ${action.action_type}`,
          parsed_payload: { undone_action_id: actionId },
          confidence: 1,
          confirmed_by_physician: true,
          previous_state: preUndoState,
          note_section_affected: action.note_section_affected,
        });

        return Response.json({
          ok: true,
          restoredSection: action.note_section_affected,
          actionTaken: `Undid: ${action.action_type}`,
        });
      }
    }

    // For encounter-level changes (disposition, etc.)
    const preUndoState = await supabase
      .from("encounters")
      .select("status, disposition, accepting_physician, mdm_data")
      .eq("id", action.encounter_id)
      .single();

    await supabase
      .from("encounters")
      .update(action.previous_state)
      .eq("id", action.encounter_id);

    await supabase.from("robin_actions").insert({
      shift_id: action.shift_id,
      encounter_id: action.encounter_id,
      action_type: "undo",
      raw_command: `Undo: ${action.action_type}`,
      parsed_payload: { undone_action_id: actionId },
      confidence: 1,
      confirmed_by_physician: true,
      previous_state: preUndoState?.data,
    });

    return Response.json({
      ok: true,
      restoredSection: action.action_type,
      actionTaken: `Undid: ${action.action_type}`,
    });
  }

  // For briefings (encounter creation) — delete the encounter
  if (action.action_type === "patient_briefing" && action.encounter_id) {
    await supabase
      .from("encounters")
      .delete()
      .eq("id", action.encounter_id);

    await supabase.from("robin_actions").insert({
      shift_id: action.shift_id,
      encounter_id: action.encounter_id,
      action_type: "undo",
      raw_command: `Undo: ${action.action_type}`,
      parsed_payload: { undone_action_id: actionId },
      confidence: 1,
      confirmed_by_physician: true,
      previous_state: null,
    });

    return Response.json({
      ok: true,
      restoredSection: "encounter_deleted",
      actionTaken: "Undid encounter creation",
    });
  }

  return Response.json({
    ok: false,
    actionTaken: "Nothing to restore — no previous state recorded",
  });
}
