import { NextResponse } from "next/server";
import { llm, resolveModel } from "@/lib/llmClient";

export async function POST(request: Request) {
  const { command } = await request.json();

  if (!command?.trim()) {
    return NextResponse.json({ patients: [] });
  }

  const message = await llm.messages.create({
    model: resolveModel("haiku-4-5"),
    max_tokens: 400,
    system: `Extract a list of patients from a physician's verbal briefing to their AI copilot.

Extract for each patient:
- age: integer (null if not mentioned)
- gender: "M", "F", "X", or null
- chiefComplaint: string — the medical complaint, cleaned up (e.g. "belly pain" → "Abdominal pain", "chest pain" → "Chest pain", "pee problems" → "Urinary symptoms"). Use standard ED chief complaint language.
- room: string or null — if a room number is mentioned

Return JSON array only:
[
  { "age": 74, "gender": "F", "chiefComplaint": "Abdominal pain", "room": null },
  { "age": 23, "gender": "M", "chiefComplaint": "Chest pain", "room": null }
]

Return [] if no patients can be identified.`,
    messages: [
      {
        role: "user",
        content: command,
      },
    ],
  });

  try {
    const text =
      message.content[0].type === "text" ? message.content[0].text : "[]";
    const patients = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || "[]");
    return NextResponse.json({
      patients: Array.isArray(patients) ? patients : [],
    });
  } catch {
    return NextResponse.json({ patients: [] });
  }
}
