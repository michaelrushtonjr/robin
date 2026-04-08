import Anthropic from "@anthropic-ai/sdk";
import { deriveOverallMDM } from "./mdmScoring";
import type {
  MDMScaffold,
  HPICompleteness,
  MDMComplexity,
} from "./robinTypes";

// ─── Shared types ─────────────────────────────────────────────────────────────

export type NoteGap = {
  gap_type: string;
  description: string;
  severity: string;
  suggested_fix: string;
};

export type EMAssessment = {
  code: string;
  rvu: number;
  mdm_level: string;
  rationale: string;
  upgrade_possible: boolean;
  upgrade_requires: string | null;
};

export type MDMData = {
  mdm_scaffold?: MDMScaffold;
  hpi_completeness?: HPICompleteness;
  gaps: NoteGap[];
  em_assessment?: EMAssessment;
  summary?: string;
};

export type RobinThinkEvent =
  | { type: "hpi_completeness"; data: HPICompleteness }
  | { type: "mdm_scaffold"; data: MDMScaffold }
  | { type: "note_gap"; data: NoteGap }
  | { type: "em_assessment"; data: EMAssessment }
  | { type: "ready"; data: { summary: string } }
  | { type: "done"; data: { iterations: number } }
  | { type: "error"; data: { message: string } };

export interface RunRobinThinkOptions {
  transcript: string;
  chiefComplaint: string;
  disposition?: string;
  /** Prefixed to the user message. Typically from buildRobinContext(). */
  shiftContext?: string;
  /** When true, pin temperature to 0 for deterministic eval runs. */
  evalMode?: boolean;
  /** Called for each SSE event as it happens. */
  onEvent?: (event: RobinThinkEvent) => void | Promise<void>;
  /**
   * Called exactly once, when the model emits `ready`, with the fully
   * accumulated MDMData. The route uses this hook to persist to Supabase.
   */
  onReady?: (mdmData: MDMData) => void | Promise<void>;
}

export interface RunRobinThinkResult {
  mdmData: MDMData;
  iterations: number;
  /** Full event trace, in fire order. Useful for eval asserts. */
  events: RobinThinkEvent[];
  /** True if the loop hit MAX_ITERATIONS without `ready` firing. */
  truncated: boolean;
}

// ─── System prompt ────────────────────────────────────────────────────────────

export const ROBIN_THINK_SYSTEM = `
You are Robin — an agentic AI shift copilot for emergency medicine physicians.
Your job in this call is clinical documentation audit, not conversation.

TOOL CALL ORDER (required)
1. hpi_completeness — always first
2. mdm_complexity_assessment — always second
3. note_gap — once per distinct gap, max 4 calls
4. em_assessment — once, after all note_gap calls
5. ready — last, signals completion

═══════════════════════════════════════════════════════════════════
CRITICAL CARE (99291 / 99292) — READ FIRST, BEFORE ANYTHING ELSE
═══════════════════════════════════════════════════════════════════

99291 is a TIME-BASED code, not an MDM upgrade. It is NOT "the next code
above 99285." It exists on a separate axis and replaces 99285 entirely
when the criteria are met.

99291 criteria (BOTH required):
  (a) High probability of imminent or life-threatening deterioration AND
      treatment to prevent it, AND
  (b) ≥30 minutes of total critical care time (excluding separately
      billable procedures: central line, intubation, CPR, etc.)

99292 = each additional 30 minutes beyond the first 74 minutes.

When ANY of the following appear in the transcript, you MUST evaluate
for critical care, recommend 99291 as the supported code (not 99285),
and flag "Critical care time not documented" as a HIGH-severity gap:
  - Vasopressor initiation (norepi, epi, vaso, phenylephrine, dopamine)
  - Lactate >4 with organ dysfunction or hypotension
  - Septic shock (sepsis + hypotension or lactate >4)
  - Intubation / RSI / emergent airway
  - Massive transfusion or active hemorrhagic shock
  - Acute stroke with tPA/TNK decision
  - STEMI with cath lab activation while patient in ED
  - Status epilepticus
  - Cardiac arrest / post-arrest care
  - Decision for emergent surgery with active resuscitation
  - ICU admission for hemodynamic instability or respiratory failure

CRITICAL CARE OUTPUT RULES:
  - supported_code = "99291" (not "99285")
  - mdm_level = "high"
  - In em_assessment.upgrade_requires: NEVER write "document data review
    to reach 99291" or any variant. The path to 99291 is documenting CC
    TIME, not MDM data.
  - The required gap is: "Critical care time not documented — document
    total minutes of critical care provided, excluding separately
    billable procedures."

═══════════════════════════════════════════════════════════════════
AMA 2021 MDM RULES (for non-critical-care visits)
═══════════════════════════════════════════════════════════════════

MDM = highest 2 of 3 elements (problems, data, risk). Not the average.

PROBLEMS
- Straightforward: 1 self-limited or minor problem
- Low: 1 stable chronic illness; 1 acute uncomplicated illness/injury;
  2+ self-limited problems
- Moderate: new problem requiring workup; undiagnosed new problem with
  uncertain prognosis; 1 acute illness with systemic symptoms;
  exacerbation of chronic illness
- High: 1 chronic illness with severe exacerbation; 1 acute or chronic
  illness or injury that poses a threat to life or bodily function

DATA — count distinct reviewable elements (Cat 1, 2, or 3)

  Category 1 — tests, documents, independent historian
    Each unique lab panel = 1 point (CBC, BMP, lipase, troponin, lactate,
      UA, hCG, etc. — each separately)
    Each unique imaging study = 1 point (CXR, CT, US, ECG)
    Review of prior external records = 1 point
    Independent historian (family/EMS/nursing home staff) = 1 point

  Category 2 — independent interpretation of imaging/tracing
    ED physician interpreting CXR, CT, ECG, FAST, POCUS independently
      (i.e. before formal radiology read) = 1 point per study

  Category 3 — discussion of management with external physician
    Calling consultant, accepting hospitalist, ICU intensivist, etc. =
      1 point per discussion

  Tier rules:
    Minimal/None: 0–1 elements total
    Low: 2 elements total (any combination)
    Moderate: 3+ elements OR any 1 Category 2 element with other data
    High: extensive review across multiple categories, including
      independent interpretation AND external discussion AND multiple
      Category 1 elements

WORKED EXAMPLE — septic shock case typically scores HIGH on data:
  CBC, BMP, lactate, blood cultures, UA, troponin (6 Cat 1)
  + CXR with independent interp (1 Cat 2)
  + history from spouse (1 Cat 1, independent historian)
  + discussion with accepting ICU (1 Cat 3)
  → 9+ data elements across all 3 categories → HIGH

RISK — what counts and what doesn't

  Minimal:
    - OTC medications only (recommended or prescribed at OTC dose)
    - Reassurance, no intervention
    - EXAMPLE: discharge with ibuprofen 400–600 mg OTC = MINIMAL, not moderate

  Low:
    - Minor surgery without risk factors
    - Physical therapy, occupational therapy
    - IV fluids without additives

  Moderate — prescription drug management means the ED physician is:
    - Initiating a new prescription medication for the presenting complaint
    - Adjusting dose of an existing prescription
    - Decision to start or stop a prescription drug
    - Examples: starting antibiotics, opioid Rx, antiemetic Rx, steroids,
      benzodiazepine, antihypertensive

  Moderate does NOT include:
    - Continuing the patient's chronic home medications without change
      (e.g. patient takes lisinopril at home → not Rx mgmt)
    - Recommending OTC medications (ibuprofen, acetaminophen, loratadine)
    - Mentioning the patient's home med list for reconciliation only

  High:
    - Drug therapy requiring intensive monitoring for toxicity
    - Decision regarding emergency major surgery
    - Decision regarding hospitalization for high-acuity condition
    - DNR/comfort care decision
    - Parenteral controlled substance for pain crisis

═══════════════════════════════════════════════════════════════════
HPI SCORING
═══════════════════════════════════════════════════════════════════

8 elements: location, quality, severity, duration, timing, context,
modifying factors, associated signs/symptoms.

Score = count of elements present.
brief_or_extended: score < 4 → "brief"; score ≥ 4 → "extended".
A score of exactly 4 is "extended", not "brief".

═══════════════════════════════════════════════════════════════════
GAP DETECTION
═══════════════════════════════════════════════════════════════════

Flag the most CLINICALLY IMPORTANT gaps first, not the generic ones.
Robin's value is encounter-specific gaps, not a checklist.

GENERIC GAP PRIORITY (use when no encounter-specific gap applies)
1. HPI < 4 elements
2. Vague workup language (see VAGUE WORKUP DETECTION below)
3. Labs/imaging ordered but review/interpretation not documented
4. Disposition rationale absent or vague
5. No return precautions on a discharge

VAGUE WORKUP DETECTION (gap_type: "vague_workup_language")

This is a DOCUMENTATION gap, not a data-axis re-scoring rule. Score
the data axis as you normally would based on what is implied to be
ordered. Then ALSO flag this gap if the dictation is non-specific.

Trigger phrases (flag the gap when these appear):
  - "some labs", "draw some bloodwork", "get some labs"
  - "some imaging", "probably a CT", "maybe an X-ray"
  - "let's get a workup going", "the usual workup"
  - "labs and imaging" without specifics
  - "we'll order what we need"

Suggested fix language:
  "You said 'some labs' — name them in your dictation. Each specific
  test (CBC, BMP, lactate, CT abdomen, etc.) is a Category 1 data
  point that auditors can credit. Vague phrasing is harder to defend
  on chart review even if the tests were actually ordered."

Severity: MEDIUM. Do NOT downgrade the data axis just because the
dictation is vague — the workup is still happening. Flag the
documentation issue and let the physician fix the dictation.

ENCOUNTER-SPECIFIC GAP PRIORITY (use these FIRST when applicable)

  Critical care indicators present (see list above):
    → "Critical care time not documented" (HIGH severity)
    → Sepsis bundle timestamps if septic shock (antibiotic time, fluid
      time, repeat lactate time)

  Female of childbearing age + abdominal pain / pelvic pain / vaginal
  bleeding / syncope:
    → "Pregnancy status / hCG result not documented; ectopic should
      appear on differential"

  Adult with chest pain:
    → "ACS workup pathway and cardiac risk factors not documented"
    → "ECG interpretation not documented"

  Elderly fall or head strike:
    → "Anticoagulation status not documented"
    → "Head CT decision rule (NEXUS / Canadian CT Head) not documented"

  Altered mental status in elderly:
    → "Glucose, infection workup, medication review not documented"

  Pediatric fever:
    → Age-specific workup expectations not documented

If a clinically specific gap applies, it MUST be one of your 4 gap
slots — do not waste all 4 on generic items.

═══════════════════════════════════════════════════════════════════
BILLING
═══════════════════════════════════════════════════════════════════

Never mention dollar amounts. RVUs and E&M codes only.
99281=0.48 | 99282=0.93 | 99283=1.60 | 99284=2.60 | 99285=3.80 | 99291=4.50

═══════════════════════════════════════════════════════════════════
SHIFT CONTEXT
═══════════════════════════════════════════════════════════════════

Use the shift context to personalize feedback. If the physician has
been missing the same gap repeatedly this shift, say so explicitly.

═══════════════════════════════════════════════════════════════════
TONE
═══════════════════════════════════════════════════════════════════

Clinical colleague, not compliance officer. Brief, direct,
encounter-specific. Never hallucinate clinical details not in the
transcript.
`.trim();

// ─── Tools ────────────────────────────────────────────────────────────────────

export const ROBIN_THINK_TOOLS: Anthropic.Tool[] = [
  {
    name: "hpi_completeness",
    description:
      "Score the HPI against the 8 standard elements. Call this first.",
    input_schema: {
      type: "object",
      properties: {
        present: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "location",
              "quality",
              "severity",
              "duration",
              "timing",
              "context",
              "modifying_factors",
              "associated_signs_and_symptoms",
            ],
          },
        },
        missing: { type: "array", items: { type: "string" } },
        score: { type: "number" },
        brief_or_extended: { type: "string", enum: ["brief", "extended"] },
      },
      required: ["present", "missing", "score", "brief_or_extended"],
    },
  },
  {
    name: "mdm_complexity_assessment",
    description:
      "Score all 3 MDM elements independently, derive overall using highest-2-of-3. Call after hpi_completeness.",
    input_schema: {
      type: "object",
      properties: {
        problems_complexity: {
          type: "string",
          enum: ["straightforward", "low", "moderate", "high"],
        },
        problems_rationale: { type: "string" },
        data_complexity: {
          type: "string",
          enum: ["straightforward", "low", "moderate", "high"],
        },
        data_rationale: { type: "string" },
        data_points: { type: "number" },
        risk_complexity: {
          type: "string",
          enum: ["straightforward", "low", "moderate", "high"],
        },
        risk_rationale: { type: "string" },
        overall_mdm: {
          type: "string",
          enum: ["straightforward", "low", "moderate", "high"],
        },
        supported_code: { type: "string" },
        next_code: { type: "string", nullable: true },
        one_thing_to_upgrade: { type: "string", nullable: true },
      },
      required: [
        "problems_complexity",
        "problems_rationale",
        "data_complexity",
        "data_rationale",
        "data_points",
        "risk_complexity",
        "risk_rationale",
        "overall_mdm",
        "supported_code",
        "next_code",
        "one_thing_to_upgrade",
      ],
    },
  },
  {
    name: "note_gap",
    description:
      "Flag a single documentation gap. Call once per gap, max 4 times.",
    input_schema: {
      type: "object",
      properties: {
        gap_type: {
          type: "string",
          enum: [
            "hpi_incomplete",
            "ros_missing",
            "data_not_documented",
            "vague_workup_language",
            "risk_not_documented",
            "disposition_rationale_absent",
            "return_precautions_missing",
            "other",
          ],
        },
        description: { type: "string" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        suggested_fix: { type: "string" },
      },
      required: ["gap_type", "description", "severity", "suggested_fix"],
    },
  },
  {
    name: "em_assessment",
    description:
      "Final E&M code and RVU. Call once, after all note_gap calls.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string" },
        rvu: { type: "number" },
        mdm_level: {
          type: "string",
          enum: ["straightforward", "low", "moderate", "high"],
        },
        rationale: { type: "string" },
        upgrade_possible: { type: "boolean" },
        upgrade_requires: { type: "string", nullable: true },
      },
      required: [
        "code",
        "rvu",
        "mdm_level",
        "rationale",
        "upgrade_possible",
        "upgrade_requires",
      ],
    },
  },
  {
    name: "ready",
    description: "Signal completion. Call last after all other tools.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
    },
  },
];

// ─── Core loop ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 8;
const MODEL = "claude-sonnet-4-20250514";

const anthropic = new Anthropic();

export async function runRobinThink(
  opts: RunRobinThinkOptions
): Promise<RunRobinThinkResult> {
  const {
    transcript,
    chiefComplaint,
    disposition,
    shiftContext = "",
    evalMode = false,
    onEvent,
    onReady,
  } = opts;

  if (!transcript?.trim()) {
    throw new Error("No transcript");
  }

  const events: RobinThinkEvent[] = [];
  const emit = async (event: RobinThinkEvent) => {
    events.push(event);
    if (onEvent) await onEvent(event);
  };

  const mdmData: MDMData = { gaps: [] };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `
${shiftContext}

---
ENCOUNTER TO AUDIT

Chief complaint: ${chiefComplaint || "Not specified"}
Disposition: ${disposition ?? "Not documented"}

Transcript:
${transcript}

Run your full MDM audit now. Call tools in order.
      `.trim(),
    },
  ];

  let iterations = 0;
  let done = false;

  while (!done && iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: ROBIN_THINK_SYSTEM,
      tools: ROBIN_THINK_TOOLS,
      messages,
      ...(evalMode ? { temperature: 0 } : {}),
    });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      const input = block.input as Record<string, unknown>;

      if (block.name === "hpi_completeness") {
        const hpi: HPICompleteness = {
          present: input.present as HPICompleteness["present"],
          missing: input.missing as HPICompleteness["missing"],
          score: input.score as number,
          brief_or_extended: input.brief_or_extended as "brief" | "extended",
        };
        mdmData.hpi_completeness = hpi;
        await emit({ type: "hpi_completeness", data: hpi });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Scored.",
        });
      } else if (block.name === "mdm_complexity_assessment") {
        const problems = input.problems_complexity as MDMComplexity;
        const data = input.data_complexity as MDMComplexity;
        const risk = input.risk_complexity as MDMComplexity;
        // Server-side validation — override model's overall_mdm with
        // correct AMA 2021 calculation.
        const overall = deriveOverallMDM(problems, data, risk);

        const scaffold: MDMScaffold = {
          problems: {
            complexity: problems,
            rationale: input.problems_rationale as string,
          },
          data: {
            complexity: data,
            rationale: input.data_rationale as string,
          },
          risk: {
            complexity: risk,
            rationale: input.risk_rationale as string,
          },
          overall_mdm: overall,
          supported_code: input.supported_code as string,
          next_code: input.next_code as string | null,
          one_thing_to_upgrade: input.one_thing_to_upgrade as string | null,
          scored_at: new Date().toISOString(),
        };
        mdmData.mdm_scaffold = scaffold;
        await emit({ type: "mdm_scaffold", data: scaffold });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Assessed.",
        });
      } else if (block.name === "note_gap") {
        const gap: NoteGap = {
          gap_type: input.gap_type as string,
          description: input.description as string,
          severity: input.severity as string,
          suggested_fix: input.suggested_fix as string,
        };
        mdmData.gaps.push(gap);
        await emit({ type: "note_gap", data: gap });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Logged.",
        });
      } else if (block.name === "em_assessment") {
        const em: EMAssessment = {
          code: input.code as string,
          rvu: input.rvu as number,
          mdm_level: input.mdm_level as string,
          rationale: input.rationale as string,
          upgrade_possible: input.upgrade_possible as boolean,
          upgrade_requires: input.upgrade_requires as string | null,
        };
        mdmData.em_assessment = em;
        await emit({ type: "em_assessment", data: em });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Assessed.",
        });
      } else if (block.name === "ready") {
        mdmData.summary = input.summary as string;
        await emit({ type: "ready", data: { summary: mdmData.summary } });

        if (onReady) await onReady(mdmData);

        done = true;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Done.",
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    if (response.stop_reason === "end_turn") break;
  }

  await emit({ type: "done", data: { iterations } });

  return {
    mdmData,
    iterations,
    events,
    truncated: !done && iterations >= MAX_ITERATIONS,
  };
}
