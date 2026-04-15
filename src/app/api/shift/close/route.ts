import { createClient } from "@/lib/supabase/server";
import { aggregateShiftToLongitudinal } from "@/lib/memory";

/**
 * Aggregate a shift's memory into the physician's longitudinal record.
 *
 * Called from the end-shift flow in /shift/page.tsx BEFORE the shift is
 * flipped to `completed`. The client still owns the status flip; this
 * route owns the aggregation + delta detection.
 *
 * Idempotent in practice: calling twice on the same shift double-counts
 * the shift and encounters, which is why the client calls it exactly
 * once in endShift(). If we need strict idempotency later, add a
 * `aggregated_at` guard on the shift row.
 */
export async function POST(req: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { shiftId } = (await req.json()) as { shiftId?: string };
  if (!shiftId) {
    return Response.json({ error: "Missing shiftId" }, { status: 400 });
  }

  // Verify ownership
  const { data: shift } = await supabase
    .from("shifts")
    .select("id, physician_id")
    .eq("id", shiftId)
    .eq("physician_id", user.id)
    .single();

  if (!shift) {
    return Response.json({ error: "Shift not found" }, { status: 404 });
  }

  try {
    const { newObservations } = await aggregateShiftToLongitudinal(
      supabase,
      shiftId,
      user.id
    );
    return Response.json({
      ok: true,
      newObservations,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
