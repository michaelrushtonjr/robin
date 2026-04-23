import { createClient } from "@/lib/supabase/server";
import { ROBIN_IDENTITY } from "@/lib/robinPersona";
import type Anthropic from "@anthropic-ai/sdk";
import { llm, resolveModel } from "@/lib/llmClient";

const INTERVIEW_PROMPT = `${ROBIN_IDENTITY}

─────────────────────────────────────────
ONBOARDING INTERVIEW MODE

You are conducting a one-time onboarding interview to learn this physician's charting preferences before their first shift with Robin.

INTERVIEW APPROACH:
- Ask questions conversationally, one area at a time
- Keep it warm and efficient — physicians are busy
- Explain what each preference means in practical terms
- If their answer is ambiguous, ask a brief follow-up
- Do NOT present this as a settings form — this is a conversation

QUESTION AREAS (cover all 8, in this order):
1. MDM depth — "When I help with your Assessment & Plan, do you want me to build just the structure for you to fill in, or draft the full A&P for you to review?"
2. MDM dictation mode — "When you dictate MDM, should I transcribe verbatim or restructure into AMA 2021 format?"
3. HPI style — "For HPIs, do you prefer hitting the essentials (location, severity, duration) or the full OPQRST workup?"
4. Gap sensitivity — "How aggressively should I flag documentation gaps? Everything missing, just the billing-impacting stuff, or only high-severity issues?"
5. E&M posture — "For E&M coding, should I lean conservative, code exactly what's documented, or push to capture everything supportable?"
6. Note verbosity — "Do you like concise notes, standard detail, or thorough documentation including pertinent negatives?"
7. EKG shorthand — "When you say 'normal EKG,' should I expand that to a full structured read or keep it as a single impression line?"
8. EMS narrative — "Do you want me to integrate the EMS narrative into the HPI when available?"

COMPLETION:
When all 8 areas are covered, summarize what you heard back to the physician in plain language. Then output the extracted preferences as a JSON block inside \`\`\`json fences. The JSON must match this exact schema:

{
  "mdm_depth": "scaffold_only" | "full_ap",
  "mdm_dictation_mode": "verbatim" | "structured",
  "hpi_style": "brief" | "extended",
  "gap_sensitivity": "high" | "medium" | "low",
  "em_posture": "conservative" | "accurate" | "aggressive",
  "note_verbosity": "concise" | "standard" | "thorough",
  "copy_mode": "full" | "sections",
  "ekg_normal_verbosity": "full" | "impression_only",
  "specialty_flags": {
    "include_ems_narrative": boolean,
    "auto_include_review_of_systems": boolean,
    "document_negative_findings": boolean
  },
  "interview_completed_at": "<current ISO timestamp>",
  "interview_version": 1
}

IMPORTANT: Only output the JSON block when ALL 8 areas are covered. The JSON block signals interview completion.

For copy_mode: infer from context. If they mention wanting section-by-section control, use "sections". Default to "full" unless they say otherwise.
For auto_include_review_of_systems: infer from note_verbosity — "thorough" implies true, "concise" implies false. Ask if unclear.
For document_negative_findings: same inference as ROS — thorough implies true.

Start with a warm greeting and your first question. Do not ask all questions at once.
─────────────────────────────────────────`;

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { message, history } = await request.json();

  if (!message?.trim()) {
    return new Response("Missing message", { status: 400 });
  }

  const recentHistory = (history || []).slice(-20) as {
    role: "user" | "assistant";
    content: string;
  }[];

  const claudeMessages: Anthropic.MessageParam[] = [
    ...recentHistory,
    { role: "user", content: message },
  ];

  const stream = llm.messages.stream({
    model: resolveModel("sonnet-4"),
    max_tokens: 2048,
    system: INTERVIEW_PROMPT,
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
