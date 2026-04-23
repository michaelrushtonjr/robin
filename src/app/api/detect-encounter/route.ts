import { NextResponse } from "next/server";
import { llm, resolveModel } from "@/lib/llmClient";

export async function POST(request: Request) {
  const { buffer } = await request.json();
  if (!buffer?.trim()) {
    return NextResponse.json({ detected: false });
  }

  const message = await llm.messages.create({
    model: resolveModel("haiku-4-5"),
    max_tokens: 200,
    system: `You are monitoring an ED ambient audio stream for Robin, an AI shift copilot.

Your job: detect the beginning of a new clinical encounter — the moment a physician starts interacting with a new patient.

## TRIGGERS — any of these indicate a new encounter has started:
- Physician introduction (explicit): "Hi I'm Dr.", "I'm Dr. [name]", "My name is Dr."
- Physician introduction (informal): "Hey, I'm one of the doctors", "I'm the doc today", "I'll be taking care of you"
- Opening question (formal): "What brings you in today?", "What's going on today?", "What happened?"
- Opening question (informal): "So what's going on?", "Tell me what's happening", "What's up?", "How are you feeling?", "So what brings you in?"
- Patient presenting symptoms unprompted: Patient starts describing a new complaint in a conversational tone
- EMS/triage handoff: "We have a [age/sex]", "EMS here with", "Brought in by EMS", "[age]-year-old with", "chief complaint of"
- Triage intake: "What's your name?", "Date of birth?", "What's the chief complaint?", "What's your pain level?"
- Nurse introducing physician: "The doctor is here to see you", "Dr. [name] will be right with you"

## DO NOT TRIGGER on:
- EMS radio traffic before arrival ("medic 7 to base", "en route", "ETA", "copy that", "over", 10-codes)
- Pure staff-to-staff conversation with no patient present
- Mid-encounter orders, labs, results ("let's get a chest X-ray", "CBC came back")
- Re-evaluation of a patient already seen ("going back to check on", "following up on")
- General hallway/break room conversation

## GUIDELINE: Lean toward triggering. A false positive (missed new encounter detection) is worse than a brief false alarm. If there's a reasonable chance a new patient encounter is starting, trigger it.

Respond in JSON only:
{ "detected": true/false, "chiefComplaint": "string or null", "confidence": "high/medium/low" }

Set confidence="high" for explicit introductions or clear opening questions. Set confidence="medium" for patient presenting symptoms or informal openers.`,
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
