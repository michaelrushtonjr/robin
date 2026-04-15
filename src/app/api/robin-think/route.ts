import { createClient } from "@/lib/supabase/server";
import { buildRobinContext } from "@/lib/robinPersona";
import { runRobinThink } from "@/lib/robinThink";
import {
  buildRollupFromMdmData,
  incrementShiftPatternCount,
  incrementShiftTally,
  upsertEncounterInShiftMemory,
} from "@/lib/memory";

export async function POST(req: Request) {
  // Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  // Parse body
  const { transcript, chiefComplaint, disposition, encounterId, shiftId } =
    (await req.json()) as {
      transcript: string;
      chiefComplaint: string;
      disposition?: string;
      encounterId: string;
      shiftId: string;
    };

  if (!transcript?.trim()) {
    return new Response('event: error\ndata: {"error":"No transcript"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // Shift memory + physician profile injection
  const { systemPrompt: shiftContext } = await buildRobinContext(
    supabase,
    shiftId,
    encounterId
  );

  // Eval mode opt-in via header (used by /evals harness for determinism).
  // Production clients never set this.
  const evalMode = req.headers.get("x-robin-eval") === "1";

  // SSE stream — runRobinThink fires onEvent for each tool call; we forward
  // each event to the client. onReady persists to Supabase exactly once.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        await runRobinThink({
          transcript,
          chiefComplaint,
          disposition,
          shiftContext,
          evalMode,
          onEvent: (e) => send(e.type, e.data),
          onReady: async (mdmData) => {
            // 1. Persist full mdmData payload to encounters (existing)
            await supabase
              .from("encounters")
              .update({ mdm_data: mdmData })
              .eq("id", encounterId);

            // 2. Shift memory — upsert encounter rollup
            await upsertEncounterInShiftMemory(
              supabase,
              shiftId,
              buildRollupFromMdmData(encounterId, chiefComplaint, mdmData)
            );

            // 3. Shift memory — tally increments
            for (const g of mdmData.gaps ?? []) {
              await incrementShiftTally(
                supabase,
                shiftId,
                "gaps_by_type",
                g.gap_type
              );
            }
            if (mdmData.em_assessment?.code) {
              await incrementShiftTally(
                supabase,
                shiftId,
                "codes_distribution",
                mdmData.em_assessment.code
              );
            }

            // 4. Observed patterns
            const vague = (mdmData.gaps ?? []).filter(
              (g) => g.gap_type === "vague_workup_language"
            ).length;
            if (vague > 0) {
              await incrementShiftPatternCount(
                supabase,
                shiftId,
                "vague_workup_language_count",
                vague
              );
            }
            const isCC =
              mdmData.em_assessment?.code === "99291" ||
              mdmData.em_assessment?.code === "99292";
            if (isCC) {
              await incrementShiftPatternCount(
                supabase,
                shiftId,
                "critical_care_count",
                1
              );
            }
          },
        });
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
