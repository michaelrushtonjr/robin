import { createClient } from "@/lib/supabase/server";
import { buildRobinContext } from "@/lib/robinPersona";
import { runClinicalSurfacing } from "@/lib/clinicalSurfacing";

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
          onEvent: (e) => send(e.type, e.data),
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
