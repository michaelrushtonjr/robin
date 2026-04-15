import { createClient } from "@/lib/supabase/server";
import { buildRobinContext } from "@/lib/robinPersona";
import { runClinicalSurfacing } from "@/lib/clinicalSurfacing";
import {
  appendEncounterSurfacing,
  appendShiftMemorySurfacing,
  incrementShiftTally,
} from "@/lib/memory";
import type { ClinicalToolSurfacing } from "@/lib/robinTypes";

export async function POST(req: Request) {
  // Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  // Parse body
  const { transcript, chiefComplaint, encounterId, shiftId } =
    (await req.json()) as {
      transcript: string;
      chiefComplaint: string;
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
  const evalMode = req.headers.get("x-robin-eval") === "1";

  // SSE stream — runClinicalSurfacing fires onEvent for each surfacing.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        await runClinicalSurfacing({
          transcript,
          chiefComplaint,
          shiftContext,
          evalMode,
          onEvent: async (e) => {
            // Forward SSE event to client first — UI responsiveness wins.
            send(e.type, e.data);
            // Then persist. encounterId + shiftId are required for
            // persistence; eval-harness calls don't pass them, so skip.
            if (
              e.type === "clinical_tool_surfaced" &&
              encounterId &&
              shiftId
            ) {
              const s = e.data as ClinicalToolSurfacing;
              try {
                await appendEncounterSurfacing(supabase, encounterId, s);
                await appendShiftMemorySurfacing(
                  supabase,
                  shiftId,
                  encounterId,
                  chiefComplaint,
                  s
                );
                await incrementShiftTally(
                  supabase,
                  shiftId,
                  "surfacings_by_tool",
                  s.tool_name
                );
              } catch {
                // Memory-write failure is non-fatal — SSE has already gone
                // to the client. Silently swallow so the stream stays clean.
              }
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
