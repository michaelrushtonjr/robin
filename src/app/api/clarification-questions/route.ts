import { NextResponse } from "next/server";
import { llm, resolveModel } from "@/lib/llmClient";

export async function POST(request: Request) {
  const { transcript, chiefComplaint, disposition } = await request.json();

  if (!transcript?.trim()) {
    return NextResponse.json({ questions: [] });
  }

  const message = await llm.messages.create({
    model: resolveModel("haiku-4-5"),
    max_tokens: 800,
    system: `You are Robin, an AI shift copilot for emergency medicine. A physician has just dispo'd a patient (discharged or admitted). Ask 2–3 targeted clarification questions to fill specific documentation gaps before the note is finalized.

## RULES
- Only ask about things NOT already documented in the transcript
- Tied to a specific MDM gap, billing element, or liability requirement
- Maximum 3 questions — highest-value gaps first
- For each question, provide quickAnswers (button options) wherever possible — these save typing
- quickAnswers should be specific pre-written documentation phrases, not just "yes/no"
- Include a null option when the physician needs to provide free-text detail
- Return [] if no significant gaps found

## QUESTION PRIORITY
1. Data column gaps — EKG not interpreted, labs not reviewed, consultant not documented
2. Risk column gaps — drug risk counseling, hospitalization decision rationale
3. Decision tool gaps — HEART component missing, ABCD2 duration, PERC estrogen
4. Liability gaps — driving restriction, serial troponin interval, cauda equina assessment
5. Procedure gaps — waveform capnography, post-reduction neuro exam

## OUTPUT FORMAT — JSON array only, no other text:
[
  {
    "question": "Specific question text",
    "why": "One sentence — MDM/billing/liability reason",
    "category": "data|risk|decision_tool|liability|procedure",
    "quickAnswers": [
      { "label": "Button label (short)", "value": "Full documentation phrase to insert into note" },
      { "label": "Another option", "value": "Full documentation phrase" },
      { "label": "Other (speak or type)", "value": null }
    ]
  }
]

Example quickAnswers for EKG interpretation:
[
  { "label": "Normal — no acute changes", "value": "EKG interpreted: normal sinus rhythm, no acute ST or T-wave changes, no ischemic changes, no conduction abnormality." },
  { "label": "LBBB / known prior", "value": "EKG interpreted: left bundle branch block, appears similar to prior per patient report." },
  { "label": "Abnormal — describe", "value": null }
]

Example quickAnswers for hospitalization decision:
[
  { "label": "Admitted — documented", "value": "After evaluation and review of results, decision made to admit patient for further management and monitoring." },
  { "label": "Discharged with follow-up", "value": "After risk-benefit discussion, decision made to discharge with strict return precautions and follow-up arranged." },
  { "label": "Other — describe", "value": null }
]`,
    messages: [
      {
        role: "user",
        content: `Chief complaint: ${chiefComplaint || "not specified"}
Disposition: ${disposition || "not specified"}

TRANSCRIPT:
${transcript}

What 2–3 clarification questions should I ask?`,
      },
    ],
  });

  try {
    const text =
      message.content[0].type === "text" ? message.content[0].text : "[]";
    const questions = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || "[]");
    return NextResponse.json({
      questions: Array.isArray(questions) ? questions : [],
    });
  } catch {
    return NextResponse.json({ questions: [] });
  }
}
