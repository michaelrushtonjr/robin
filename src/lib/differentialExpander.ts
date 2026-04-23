import type Anthropic from "@anthropic-ai/sdk";
import { llm, resolveModel } from "@/lib/llmClient";
import type {
  BadnessBucket,
  DifferentialAddition,
  PretestBucket,
} from "./robinTypes";

// ─── Event types ─────────────────────────────────────────────────────────────

export type DifferentialExpanderEvent =
  | { type: "differential_added"; data: DifferentialAddition }
  | { type: "expanding_done"; data: { count: number; iterations: number } }
  | { type: "error"; data: { message: string } };

export interface RunDifferentialExpanderOptions {
  transcript: string;
  chiefComplaint: string;
  /** Prefixed to the user message. Typically from buildRobinContext(). */
  shiftContext?: string;
  /** When true, pin temperature to 0 for deterministic eval runs. */
  evalMode?: boolean;
  /** Called for each differential as it is added. */
  onEvent?: (event: DifferentialExpanderEvent) => void | Promise<void>;
}

export interface RunDifferentialExpanderResult {
  differentials: DifferentialAddition[];
  iterations: number;
  events: DifferentialExpanderEvent[];
  truncated: boolean;
}

// ─── System prompt ───────────────────────────────────────────────────────────

export const DIFFERENTIAL_EXPANDER_SYSTEM = `
You are Robin's differential expander — Loop A (sibling to clinical
decision tool surfacing).

ROLE
Watch the encounter transcript. Silently add diagnoses to the working
differential that the presentation specifically supports AND the
physician has not yet mentioned. Focus on "misses that would hurt the
patient or hurt the physician." Your output is additive — you are
completing the physician's differential, not critiquing it.

OUTPUT
Your only output is tool calls. Call \`add_differential\` 0+ times
(once per diagnosis to add), then call \`done_expanding\` exactly once.

If the physician has already articulated a thorough differential for
this presentation, call \`done_expanding\` immediately with no
\`add_differential\` calls. Silence is a valid and common output.

═══════════════════════════════════════════════════════════════════
THE ABSOLUTE RULES
═══════════════════════════════════════════════════════════════════

1. **DO NOT re-add what the physician already said.** If they've
   mentioned the diagnosis by name anywhere in the transcript — in
   their ddx, workup rationale, or orders — do NOT add it. "Rule out
   PE" from the physician = already on their radar.

2. **DO NOT speculate.** You add a diagnosis only when the
   presentation specifically supports it (a pattern match between
   symptoms/demographics/context and a diagnosis that fits that
   pattern). Not "could theoretically happen" — "the presentation
   points here."

3. **Badness beats probability.** An aortic dissection worth ruling
   out is worth adding even if uncommon. A rare but life-threatening
   miss is the product's whole reason for existing. But still only
   add if the presentation specifically supports it.

4. **CAP at 4 additions per encounter.** More than 4 is noise. If you
   can't decide which 4 matter most, you're reaching — cut harder.

5. **THE RATIONALE TEST.** Before you call \`add_differential\`, write
   the \`rationale\` sentence in your head. If that sentence would
   explain why the diagnosis probably isn't it, or reads as "although
   unlikely…" — do not add it. A differential addition whose rationale
   undercuts itself is worse than no addition.

═══════════════════════════════════════════════════════════════════
WHAT QUALIFIES FOR ADDITION
═══════════════════════════════════════════════════════════════════

Add when ALL of these are true:
  - The diagnosis is on the ED must-not-miss list for this presentation
    (e.g. SAH for thunderclap headache; AAA for flank pain in elderly
    hypotensive; ectopic for RLQ/LLQ pain in reproductive-age women
    without positive bHCG exclusion; HELLP/preeclampsia in pregnant
    woman with RUQ pain + hypertension; aortic dissection for chest/
    back pain with asymmetric pulses or migrating pain)
  - The physician has NOT named the diagnosis in the transcript
  - The presentation specifically supports this diagnosis (not a
    general workup — a specific signal)

DO NOT add when:
  - The physician's workup already addresses it implicitly (e.g.
    ordering D-dimer and CTA chest covers PE without them saying "PE")
  - The diagnosis is too remote ("PE in a 4yo with URI" is not a
    reasonable add)
  - The presentation doesn't actually match ("SAH in gradual-onset
    positional headache")
  - The physician's disposition makes it moot (cath lab active for
    clear STEMI — don't pile on PE/dissection differentials)
  - The encounter is a clear minor complaint that doesn't warrant
    broader differential work (URI, simple laceration, ankle sprain)

A WORKUP-COVERS-IT CHECK:
Before adding, scan the orders/plan in the transcript. If the
physician ordered the key study that would rule in/out your candidate,
don't add — they're already covering it. (D-dimer + CTA = PE covered.
CT abd/pelvis with contrast = AAA covered in many cases. bHCG + TVUS =
ectopic covered.)

═══════════════════════════════════════════════════════════════════
FIELDS
═══════════════════════════════════════════════════════════════════

**diagnosis** — canonical name. Examples:
  - "Pulmonary embolism" (not "blood clot in the lungs")
  - "Subarachnoid hemorrhage" (not "brain bleed")
  - "Ectopic pregnancy" (not "tubal pregnancy")
  - "Abdominal aortic aneurysm" (not "AAA rupture")

**pretest_probability** — how likely in THIS presentation:
  - "common" — plausible given the presentation (e.g. PE in pleuritic
    CP + tachy + immobilization)
  - "uncommon" — possible but not the leading hypothesis
  - "rare" — low probability but must-not-miss

**badness_if_missed**:
  - "life_threatening" — death or severe disability if missed within ED
    timeframe (SAH, PE, MI, dissection, ectopic rupture, sepsis,
    meningitis, SBO with ischemia)
  - "serious" — significant morbidity (missed fracture, cellulitis
    progressing, appendicitis progressing to rupture)
  - "benign" — almost never add these; you are not a differential
    completionist, you're a must-not-miss watchdog

**rationale** — one patient-specific sentence. NOT a textbook
recitation. "Pleuritic CP + tachy + recent 14-hr flight" not "PE is
a consideration in chest pain workup."

**missing_workup** — array of 1–3 specific items needed to rule in/out
(tests, exam maneuvers, history elements). Examples: ["D-dimer",
"CTA chest"], ["bHCG quant", "TVUS"], ["NCCT head", "LP with
xanthochromia if CT negative"]

**surface_id** — format: "surf_" + 8 lowercase hex chars
(e.g. "surf_d9c2110a"). Must be unique across all adds in this call.

═══════════════════════════════════════════════════════════════════
STYLE
═══════════════════════════════════════════════════════════════════

You are a colleague at the elbow, not a medical student reciting a
ddx. Sparingly. Silent when the physician has it covered. Loud
(within cap) when they've missed something that kills patients.
`.trim();

// ─── Tools ───────────────────────────────────────────────────────────────────

export const DIFFERENTIAL_EXPANDER_TOOLS: Anthropic.Tool[] = [
  {
    name: "add_differential",
    description:
      "Add a diagnosis the physician should also consider. Only add if the presentation specifically supports it AND the physician has not already mentioned it in the transcript. Cap at 4 additions total.",
    input_schema: {
      type: "object",
      properties: {
        diagnosis: {
          type: "string",
          description: "Canonical diagnosis name (e.g. 'Pulmonary embolism').",
        },
        pretest_probability: {
          type: "string",
          enum: ["common", "uncommon", "rare"],
          description:
            "Likelihood in THIS presentation (not general population prevalence).",
        },
        badness_if_missed: {
          type: "string",
          enum: ["life_threatening", "serious", "benign"],
          description:
            "Downside of failing to consider this diagnosis. Panel orders by badness first.",
        },
        rationale: {
          type: "string",
          description:
            "One patient-specific sentence on why this fits THIS encounter. Not a textbook recitation.",
        },
        missing_workup: {
          type: "array",
          items: { type: "string" },
          description:
            "1–3 specific items needed to rule in/out (tests, exam, history).",
        },
        surface_id: {
          type: "string",
          description:
            "Unique id for this addition. Format: 'surf_' + 8 lowercase hex chars.",
        },
      },
      required: [
        "diagnosis",
        "pretest_probability",
        "badness_if_missed",
        "rationale",
        "missing_workup",
        "surface_id",
      ],
    },
  },
  {
    name: "done_expanding",
    description:
      "Signal that you are done adding differentials. Call exactly once, at the end. If the physician's differential is already thorough, call this immediately with no preceding add_differential calls.",
    input_schema: {
      type: "object",
      properties: {
        rationale: {
          type: "string",
          description:
            "One sentence on what you considered. If you added nothing, name briefly why (e.g. 'Physician already named PE, ectopic, and ovarian torsion').",
        },
      },
      required: ["rationale"],
    },
  },
];

// ─── Core loop ───────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 8;
const MAX_ADDS = 4;

export async function runDifferentialExpander(
  opts: RunDifferentialExpanderOptions
): Promise<RunDifferentialExpanderResult> {
  const {
    transcript,
    chiefComplaint,
    shiftContext = "",
    evalMode = false,
    onEvent,
  } = opts;

  if (!transcript?.trim()) {
    throw new Error("No transcript");
  }

  const events: DifferentialExpanderEvent[] = [];
  const differentials: DifferentialAddition[] = [];

  const emit = async (event: DifferentialExpanderEvent) => {
    events.push(event);
    if (onEvent) await onEvent(event);
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `
${shiftContext}

---
ENCOUNTER

Chief complaint: ${chiefComplaint || "Not specified"}

Transcript:
${transcript}

Silently expand the working differential. Add only diagnoses the
physician has not mentioned and the presentation specifically supports.
Then call done_expanding.
      `.trim(),
    },
  ];

  let iterations = 0;
  let done = false;

  while (!done && iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await llm.messages.create({
      model: resolveModel("sonnet-4"),
      max_tokens: 2048,
      system: DIFFERENTIAL_EXPANDER_SYSTEM,
      tools: DIFFERENTIAL_EXPANDER_TOOLS,
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

      if (block.name === "add_differential") {
        if (differentials.length >= MAX_ADDS) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Cap reached (max ${MAX_ADDS}). Ignored.`,
          });
          continue;
        }

        const missing = Array.isArray(input.missing_workup)
          ? (input.missing_workup as string[]).filter(
              (x) => typeof x === "string"
            )
          : [];

        const addition: DifferentialAddition = {
          diagnosis: (input.diagnosis as string) ?? "",
          pretest_probability:
            (input.pretest_probability as PretestBucket) ?? "uncommon",
          badness_if_missed:
            (input.badness_if_missed as BadnessBucket) ?? "serious",
          rationale: (input.rationale as string) ?? "",
          missing_workup: missing,
          surface_id:
            (input.surface_id as string) ??
            `surf_${Math.random().toString(16).slice(2, 10)}`,
          surfaced_at: new Date().toISOString(),
        };

        differentials.push(addition);
        await emit({ type: "differential_added", data: addition });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Added.",
        });
      } else if (block.name === "done_expanding") {
        await emit({
          type: "expanding_done",
          data: { count: differentials.length, iterations },
        });
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

  if (!done) {
    await emit({
      type: "expanding_done",
      data: { count: differentials.length, iterations },
    });
  }

  // Sort: life_threatening first, then serious, then benign. Within a
  // badness bucket, "common" beats "uncommon" beats "rare" for display.
  // Note: this is purely a display convenience — the raw order Robin
  // added them in is preserved in the `events` array for debugging.
  const BAD_ORDER: Record<BadnessBucket, number> = {
    life_threatening: 0,
    serious: 1,
    benign: 2,
  };
  const PROB_ORDER: Record<PretestBucket, number> = {
    common: 0,
    uncommon: 1,
    rare: 2,
  };
  const sorted = [...differentials].sort((a, b) => {
    const badDelta =
      BAD_ORDER[a.badness_if_missed] - BAD_ORDER[b.badness_if_missed];
    if (badDelta !== 0) return badDelta;
    return (
      PROB_ORDER[a.pretest_probability] - PROB_ORDER[b.pretest_probability]
    );
  });

  return {
    differentials: sorted,
    iterations,
    events,
    truncated: !done && iterations >= MAX_ITERATIONS,
  };
}
