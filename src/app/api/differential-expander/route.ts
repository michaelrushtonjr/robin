import { createClient } from "@/lib/supabase/server";
import { buildRobinContext } from "@/lib/robinPersona";
import { runDifferentialExpander } from "@/lib/differentialExpander";
import {
  appendEncounterDifferential,
  appendShiftMemoryDifferential,
} from "@/lib/memory";
import type { DifferentialAddition } from "@/lib/robinTypes";

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

  // SSE stream — runDifferentialExpander fires onEvent for each addition.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        await runDifferentialExpander({
          transcript,
          chiefComplaint,
          shiftContext,
          evalMode,
          onEvent: async (e) => {
            send(e.type, e.data);
            if (
              e.type === "differential_added" &&
              encounterId &&
              shiftId
            ) {
              const d = e.data as DifferentialAddition;
              try {
                await appendEncounterDifferential(supabase, encounterId, d);
                await appendShiftMemoryDifferential(
                  supabase,
                  shiftId,
                  encounterId,
                  chiefComplaint,
                  d
                );
              } catch {
                // Non-fatal — see clinical-surfacing comment.
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
