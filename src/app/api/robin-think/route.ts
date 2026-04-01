import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { RobinInsight } from "@/lib/robinTypes";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const ROBIN_TOOLS: Anthropic.Tool[] = [
  {
    name: "note_gap",
    description:
      "Flag a specific documentation gap that will affect note quality or E&M coding. Only call this for genuine gaps — 2 or 3 max. Do not nitpick minor phrasing.",
    input_schema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["HPI", "ROS", "Exam", "MDM", "Assessment/Plan", "Disposition"],
          description: "Which section of the note has the gap",
        },
        issue: {
          type: "string",
          description:
            "Specific gap written as a brief, direct note to the physician. First person: 'I didn't catch...' or 'Missing...'",
        },
        severity: {
          type: "string",
          enum: ["high", "medium"],
          description:
            "high = affects E&M coding or medico-legal liability; medium = improves note completeness",
        },
      },
      required: ["section", "issue", "severity"],
    },
  },
  {
    name: "em_assessment",
    description:
      "Assess the E&M coding level the current documentation will support. Call this once.",
    input_schema: {
      type: "object",
      properties: {
        estimated_code: {
          type: "string",
          description: "e.g. 99284",
        },
        mdm_complexity: {
          type: "string",
          enum: ["straightforward", "low", "moderate", "high"],
        },
        limiting_factor: {
          type: "string",
          description:
            "What single thing, if documented, would support the next level up. Omit if already at maximum or documentation is solid.",
        },
      },
      required: ["estimated_code", "mdm_complexity"],
    },
  },
  {
    name: "ready",
    description: "Signal that Robin's documentation review is complete.",
    input_schema: {
      type: "object",
      properties: {
        note_quality: {
          type: "string",
          enum: ["good", "needs_work"],
          description:
            "good = note will generate cleanly; needs_work = gaps identified above should be addressed first",
        },
      },
      required: ["note_quality"],
    },
  },
];

export async function POST(request: Request) {
  const { transcript, chiefComplaint, disposition } = await request.json();

  if (!transcript?.trim()) {
    return NextResponse.json({ insights: [] });
  }

  const dispositionLabel =
    disposition === "admit"
      ? "Admitted"
      : disposition === "discharge"
        ? "Discharged"
        : "Not specified";

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `You are Robin, an EM documentation assistant. Your only job right now is to review this encounter transcript for documentation completeness — specifically what will affect note quality and E&M coding accuracy.

Be surgical. Flag 2-3 genuine gaps maximum. Do not comment on clinical decisions, treatment choices, or workup — that is the physician's domain. Do not flag things that are probably present but just not captured in the transcript. Focus on what is genuinely missing.

Chief complaint: ${chiefComplaint || "Not specified"}
Disposition: ${dispositionLabel}

TRANSCRIPT:
${transcript}

Review against: HPI completeness (8 elements: onset, location, duration, character, severity, radiation, timing, alleviating/aggravating factors), ROS documentation, exam findings, MDM data points (data reviewed, complexity of problems, risk of complications). Then assess E&M level and call ready() when done.`,
    },
  ];

  const insights: RobinInsight[] = [];
  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      tools: ROBIN_TOOLS,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const toolResults: Anthropic.MessageParam["content"] = [];
    let isDone = false;

    for (const block of toolUses) {
      if (block.type !== "tool_use") continue;

      if (block.name === "note_gap") {
        const input = block.input as {
          section: string;
          issue: string;
          severity: "high" | "medium";
        };
        insights.push({ type: "gap", ...input });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Logged.",
        });
      } else if (block.name === "em_assessment") {
        const input = block.input as {
          estimated_code: string;
          mdm_complexity: string;
          limiting_factor?: string;
        };
        insights.push({
          type: "em",
          emCode: input.estimated_code,
          mdmComplexity: input.mdm_complexity,
          limitingFactor: input.limiting_factor,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Logged.",
        });
      } else if (block.name === "ready") {
        const input = block.input as { note_quality: "good" | "needs_work" };
        insights.push({ type: "ready", noteQuality: input.note_quality });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Done.",
        });
        isDone = true;
      }
    }

    if (response.stop_reason === "end_turn" || isDone || toolUses.length === 0) {
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return NextResponse.json({ insights });
}
