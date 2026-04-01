import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export async function POST(request: Request) {
  const { buffer } = await request.json();
  if (!buffer?.trim()) {
    return NextResponse.json({ detected: false });
  }

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `You are monitoring an ED ambient audio stream for Robin, an AI shift copilot.

Your job: detect ONLY the very beginning of a brand new clinical encounter — the moment a physician first meets a new patient.

## STRONG TRIGGERS — these almost certainly mark a new encounter:
- Physician introduction: "Hi I'm Dr.", "Hello I'm Dr.", "I'm Dr. [name]", "My name is Dr."
- Opening patient question: "What brings you in today?", "What's bringing you in?", "What brings you to the ER today?", "What's going on today?", "What happened?", "Tell me what's going on", "How can I help you today?", "What can I do for you today?"
- EMS handoff opening: "We have a [age/sex]", "EMS here with", "Brought in by EMS", "So we picked up", "This is [name], [age]-year-old"
- Triage intake opening: "What's your name?", "Date of birth?", "What's the chief complaint?"

## DO NOT TRIGGER on:
- EMS radio calls: incoming radio traffic before the patient arrives ("medic 7 to base", "we're en route", "ETA 5 minutes", "copy that", "over", call signs, unit numbers, radio sign-offs). The patient is not yet present — no encounter has started.
- Mid-encounter clinical talk (ordering labs, reviewing results, exam findings, treatment discussion)
- Consultant phone calls mid-encounter
- Staff-to-staff conversation with no patient introduction
- A physician continuing to talk with the same patient they already introduced themselves to
- Re-evaluations, follow-up checks on same patient
- General background conversation
- Incomplete fragments

## RULE: When in doubt, do NOT trigger. False negatives are better than false positives.

Respond in JSON only:
{ "detected": true/false, "chiefComplaint": "string or null", "confidence": "high/medium/low" }

Only set detected=true if you see a STRONG TRIGGER. Set confidence="high" only for explicit physician introduction or explicit opening question.`,
    messages: [
      {
        role: "user",
        content: `Transcript buffer:\n${buffer}`,
      },
    ],
  });

  try {
    const text =
      message.content[0].type === "text" ? message.content[0].text : "{}";
    const result = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return NextResponse.json({
      detected: result.detected === true,
      chiefComplaint: result.chiefComplaint || null,
      confidence: result.confidence || "low",
    });
  } catch {
    return NextResponse.json({ detected: false });
  }
}
