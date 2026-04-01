import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { ROBIN_SYSTEM_PROMPT } from "@/lib/robinSystemPrompt";

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic API key not configured" },
      { status: 500 }
    );
  }

  const { transcript, chiefComplaint, ehrMode, disposition, clarifications } = await request.json();

  if (!transcript) {
    return NextResponse.json(
      { error: "Transcript is required" },
      { status: 400 }
    );
  }

  const client = new Anthropic({ apiKey });

  const ehrInstruction =
    ehrMode === "cerner"
      ? "Format for Cerner: use pipe-delimited sections, no rich formatting."
      : "Format for Epic: use SmartPhrase-compatible plain text with section headers in ALL CAPS followed by colon.";

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: ROBIN_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Generate an ED H&P note from this encounter transcript.

Chief complaint: ${chiefComplaint || "[Not specified]"}
Disposition: ${disposition === "admit" ? "Admitted" : disposition === "discharge" ? "Discharged" : "[Not specified]"}

${ehrInstruction}
${
  clarifications?.length
    ? `\nPHYSICIAN CLARIFICATIONS (incorporate these into the note — they fill documentation gaps identified after the encounter):\n${clarifications.map((c: { question: string; answer: string }) => `Q: ${c.question}\nA: ${c.answer}`).join("\n\n")}\n`
    : ""
}
TRANSCRIPT:
${transcript}`,
      },
    ],
  });

  const noteContent = message.content
    .filter((block) => block.type === "text")
    .map((block) => {
      if (block.type === "text") return block.text;
      return "";
    })
    .join("\n");

  return NextResponse.json({ note: noteContent });
}
