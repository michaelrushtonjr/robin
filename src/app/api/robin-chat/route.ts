import { createClient } from "@/lib/supabase/server";
import { buildRobinContext } from "@/lib/robinPersona";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { message, shiftId, encounterId, history } = await request.json();

  if (!message?.trim() || !shiftId) {
    return new Response("Missing message or shiftId", { status: 400 });
  }

  // Build Robin's full shift context
  const { systemPrompt } = await buildRobinContext(
    supabase,
    shiftId,
    encounterId ?? null
  );

  // Build message history for Claude (last 20 exchanges)
  const recentHistory = (history || []).slice(-20) as {
    role: "user" | "assistant";
    content: string;
  }[];

  const claudeMessages: Anthropic.MessageParam[] = [
    ...recentHistory,
    { role: "user", content: message },
  ];

  // Stream response
  const stream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: claudeMessages,
  });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(new TextEncoder().encode(event.delta.text));
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
