import { NextResponse } from "next/server";
import { llm, resolveModel } from "@/lib/llmClient";
import { ROBIN_SYSTEM_PROMPT } from "@/lib/robinSystemPrompt";

export async function POST(request: Request) {
  const { transcript, chiefComplaint, ehrMode, disposition, clarifications } = await request.json();

  if (!transcript) {
    return NextResponse.json(
      { error: "Transcript is required" },
      { status: 400 }
    );
  }

  const ehrInstruction =
    ehrMode === "cerner"
      ? "Format for Cerner: use pipe-delimited sections, no rich formatting."
      : "Format for Epic: use SmartPhrase-compatible plain text with section headers in ALL CAPS followed by colon.";

  const message = await llm.messages.create({
    model: resolveModel("sonnet-4"),
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
