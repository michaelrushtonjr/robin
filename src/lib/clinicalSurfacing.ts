import type Anthropic from "@anthropic-ai/sdk";
import { llm, resolveModel } from "@/lib/llmClient";
import type {
  ClinicalToolName,
  ClinicalToolSurfacing,
  HEARTPreFill,
  PERCPreFill,
  SFSyncopePreFill,
  CanadianCTHeadPreFill,
  OttawaAnklePreFill,
  NEXUSPreFill,
} from "./robinTypes";

// ─── Event types ─────────────────────────────────────────────────────────────

export type ClinicalSurfacingEvent =
  | { type: "clinical_tool_surfaced"; data: ClinicalToolSurfacing }
  | { type: "surfacing_done"; data: { count: number; iterations: number } }
  | { type: "error"; data: { message: string } };

export interface RunClinicalSurfacingOptions {
  transcript: string;
  chiefComplaint: string;
  /** Prefixed to the user message. Typically from buildRobinContext(). */
  shiftContext?: string;
  /** When true, pin temperature to 0 for deterministic eval runs. */
  evalMode?: boolean;
  /** Called for each tool surfacing as it happens. */
  onEvent?: (event: ClinicalSurfacingEvent) => void | Promise<void>;
}

export interface RunClinicalSurfacingResult {
  surfacedTools: ClinicalToolSurfacing[];
  iterations: number;
  events: ClinicalSurfacingEvent[];
  truncated: boolean;
}

// ─── System prompt ───────────────────────────────────────────────────────────

export const CLINICAL_SURFACING_SYSTEM = `
You are Robin's clinical decision support engine — Loop A.

ROLE
Watch the encounter transcript. When a presentation matches a clinical
decision tool from your library, surface that tool to the physician's
panel — silently, without interrupting. Pre-fill the elements you've
heard. Flag what's still needed.

OUTPUT
Your only output is tool calls. Call \`surface_clinical_tool\` 0+ times
(once per relevant tool), then call \`done_surfacing\` exactly once.

If nothing in your library applies to this encounter, call
\`done_surfacing\` immediately with no \`surface_clinical_tool\` calls.

═══════════════════════════════════════════════════════════════════
THE ABSOLUTE RULE — ZERO OVER-FIRING
═══════════════════════════════════════════════════════════════════

The product promise is "interruption cost zero." A single false fire
trains the physician to ignore the panel forever. When in doubt, do
not surface. A missed surfacing is recoverable. A noisy surfacing is
not.

THE RATIONALE TEST: write your \`trigger_rationale\` in your head
before you call the tool. If that sentence would say "this tool does
NOT apply because…" or "this is inappropriate for…" — do not call
\`surface_clinical_tool\` at all. A surfacing whose rationale explains
its own non-applicability is worse than no surfacing. Just stay silent.

Surface a tool ONLY if the presentation clearly matches its decision
context. Do NOT surface:
  - A tool merely because a body part is mentioned (e.g., "chest" in
    chest-wall pain ≠ HEART; "ankle" in chronic gout ≠ Ottawa)
  - Multiple competing tools for the same body system unless both
    genuinely apply (e.g., both NEXUS and Canadian CT Head can apply
    to a multi-trauma; PERC and HEART do not both apply to one CP)
  - A tool when the encounter has already moved past its decision
    point. This includes: STEMI activated → HEART moot; obvious
    fracture-dislocation going to reduction → Ottawa moot; trauma
    activation with surgery on the way → individual rules moot;
    physician already verbalizing the disposition the rule would
    inform → moot. If the decision the rule supports is already
    locked in, the rule has nothing left to add.
  - A tool whose required clinical context is absent (e.g., PERC on
    a high-pretest-probability PE workup is wrong, not just
    unhelpful; Canadian CT Head without LOC/amnesia/disorientation
    fails entry criteria)
  - A tool whose own exclusion criteria the patient meets (e.g.,
    Canadian CT Head excludes anticoagulated patients, NEXUS
    excludes penetrating trauma)

═══════════════════════════════════════════════════════════════════
YOUR LIBRARY — 6 TOOLS, SURFACE ONLY THESE
═══════════════════════════════════════════════════════════════════

──────────────────────────────────────────────
1. HEART — chest pain ACS risk stratification
──────────────────────────────────────────────
TRIGGER: chest pain in age ≥21 AND ACS is on the differential.

DO NOT SURFACE:
  - Clearly chest-wall (reproducible chest wall tenderness, recent
    strain, post-exercise pleuritic in a young athlete)
  - Pediatric (age <21)
  - Patient already in cath lab activation (HEART is moot — they're
    already going to get the artery opened)
  - Pure GI presentation (epigastric burning, relieved by antacids,
    no associated symptoms suggesting cardiac)

PRE-FILL KEYS:
  history: "typical" | "non_typical" | "atypical"
  ekg: "normal" | "non_specific" | "significant_st_deviation"
  age: number (the patient's age)
  risk_factors_count: number (0=none, 1-2=some, 3+=many)
  risk_factors_heard: string[] (e.g. ["HTN", "smoker", "fhx CAD"])
  troponin: "normal" | "1-3x_uln" | ">3x_uln"

──────────────────────────────────────────────
2. PERC — PE rule-out for LOW pretest only
──────────────────────────────────────────────
TRIGGER: PE on differential AND clinical gestalt is LOW pretest
probability (Wells <2 equivalent).

DO NOT SURFACE if pretest probability is moderate or high. PERC is a
RULE-OUT for low-pretest patients only — applying it to higher-risk
patients is clinically wrong, not just noisy. High-pretest signals:
  - Active cancer
  - Recent immobilization, surgery, or long-haul travel
  - Hemoptysis
  - Signs of DVT (unilateral leg swelling/tenderness)
  - HR >100 with pleuritic CP
  - Already low SpO2

PRE-FILL KEYS (each is a boolean; true = criterion met for negative PERC):
  age_under_50
  hr_under_100
  spo2_at_least_95
  no_hemoptysis
  no_estrogen_use
  no_recent_surgery_trauma
  no_prior_dvt_pe
  no_unilateral_leg_swelling

──────────────────────────────────────────────
3. SF_Syncope — San Francisco Syncope Rule
──────────────────────────────────────────────
TRIGGER: syncope, near-syncope, or transient loss of consciousness
where the cause is unclear and the physician is risk-stratifying
for serious outcome.

DO NOT SURFACE:
  - Clearly mechanical falls without LOC, seizure, or hypoglycemia
  - Clear benign vasovagal with classic features (warm/sweaty/
    nauseous prodrome, identifiable trigger like blood draw or
    standing up, rapid spontaneous recovery, prior identical
    episodes). The cause is established. Doctor is not
    risk-stratifying — they are disposing without workup.
  - Patient already worked up and dispo'd

PRE-FILL KEYS (booleans, true = positive):
  chf_history
  hematocrit_under_30
  abnormal_ekg
  shortness_of_breath
  sbp_under_90

──────────────────────────────────────────────
4. Canadian_CT_Head — minor head injury, GCS 13-15
──────────────────────────────────────────────
TRIGGER: minor head injury (blunt) with GCS 13-15 AND at least one
of: witnessed loss of consciousness, definite amnesia for the event,
or witnessed disorientation. ALL THREE entry criteria must be met
for the rule to apply at all.

DO NOT SURFACE:
  - Severe TBI (GCS <13) — they need CT regardless
  - No LOC AND no amnesia AND no witnessed disorientation. The rule
    does not apply. A bumped head from walking into a cabinet, a
    minor strike with full memory and no LOC, etc. — the rule's own
    entry criteria are not met. Do not surface even if the patient
    has a head injury.
  - Penetrating head injury
  - Patient on oral anticoagulation (warfarin, DOAC) — separate
    pathway, will get imaging regardless

PRE-FILL KEYS:
  high_risk: { (booleans)
    gcs_under_15_at_2h
    suspected_open_depressed_skull_fx
    signs_basilar_skull_fx (raccoon eyes, Battle's sign, hemotympanum,
                            CSF otorrhea/rhinorrhea)
    vomiting_2_or_more
    age_65_or_over
  }
  medium_risk: { (booleans)
    amnesia_over_30min
    dangerous_mechanism (MVA, fall >3ft/5stairs, ped struck by vehicle)
  }

──────────────────────────────────────────────
5. Ottawa_Ankle — when to X-ray ankle/midfoot
──────────────────────────────────────────────
TRIGGER: acute ankle or midfoot injury, <10 days old, where the
imaging decision is genuinely in question.

DO NOT SURFACE:
  - Pure forefoot/toe pain, heel pain, chronic ankle pain,
    rheumatologic complaints, ankle complaint without injury history
  - Obvious deformity, fracture-dislocation, open fracture, or
    neurovascular compromise — the patient is getting imaging
    regardless and likely a reduction. The rule is moot. Past the
    decision point.
  - Patient already in active management (procedural sedation,
    splinting, ortho consult underway)

PRE-FILL KEYS (booleans, true = finding present):
  ankle: {
    posterior_lateral_malleolus_tenderness
    posterior_medial_malleolus_tenderness
    cannot_bear_weight_4_steps
  }
  foot: {
    base_5th_metatarsal_tenderness
    navicular_tenderness
    cannot_bear_weight_4_steps
  }

──────────────────────────────────────────────
6. NEXUS — c-spine clearance for blunt trauma
──────────────────────────────────────────────
TRIGGER: blunt trauma with potential c-spine injury (MVA, fall, head
trauma involving the neck, assault).

DO NOT SURFACE for: penetrating trauma, atraumatic neck pain,
trauma clearly limited to a peripheral extremity.

PRE-FILL KEYS:
  midline_c_spine_tenderness: boolean | null (null if not assessed)
  focal_neuro_deficit: boolean
  altered_alertness: boolean
  intoxication: boolean
  painful_distracting_injury: boolean

═══════════════════════════════════════════════════════════════════
PRE-FILL RULES
═══════════════════════════════════════════════════════════════════

Populate the \`pre_fill\` object with what you HEARD in the transcript.
Do NOT infer. Do NOT invent vitals or exam findings.

  - If an element was explicitly mentioned (positive or negative),
    populate it.
  - If an element was not mentioned at all, OMIT the key entirely.
  - Do not assume "no mention" = negative. The physician hasn't asked.

\`missing_elements\` is the array of REQUIRED tool fields that are not
yet heard in the transcript. This is what tells the physician what
they still need to document.

\`pre_fill_summary\` is one human-readable sentence the panel will
display, e.g. "Heard: 56yo, non-typical history, 1 risk factor (smoker).
Need: EKG interpretation, troponin."

\`trigger_rationale\` is one sentence on why this tool fits THIS
encounter. Be specific to the patient.

\`surface_id\` is a unique identifier you generate for this surfacing.
Format: "surf_" + 8 lowercase hex chars (e.g., "surf_a3f9c021"). It
must be unique across all surfacings within this call.

═══════════════════════════════════════════════════════════════════
STYLE
═══════════════════════════════════════════════════════════════════

You are a colleague at the elbow, not a checklist robot. Surface
sparingly. Pre-fill carefully. When you are not sure, don't fire.
`.trim();

// ─── Tools ───────────────────────────────────────────────────────────────────

export const CLINICAL_SURFACING_TOOLS: Anthropic.Tool[] = [
  {
    name: "surface_clinical_tool",
    description:
      "Surface a clinical decision tool relevant to this encounter. Call once per relevant tool. Do NOT call if the tool does not clearly apply — over-firing kills the product.",
    input_schema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          enum: [
            "HEART",
            "PERC",
            "SF_Syncope",
            "Canadian_CT_Head",
            "Ottawa_Ankle",
            "NEXUS",
          ],
        },
        trigger_rationale: {
          type: "string",
          description:
            "One sentence on why this tool fits THIS encounter. Patient-specific.",
        },
        pre_fill: {
          type: "object",
          description:
            "Tool-specific elements heard in the transcript. See per-tool schemas in the system prompt. OMIT keys for elements not heard. Do not invent.",
        },
        pre_fill_summary: {
          type: "string",
          description:
            "Human-readable summary, e.g. 'Heard: 56yo, non-typical history, 1 risk factor. Need: EKG, troponin.'",
        },
        missing_elements: {
          type: "array",
          items: { type: "string" },
          description: "Required tool fields not yet heard in the transcript.",
        },
        surface_id: {
          type: "string",
          description:
            "Unique id for this surfacing event. Format: 'surf_' + 8 lowercase hex chars (e.g., 'surf_a3f9c021').",
        },
      },
      required: [
        "tool_name",
        "trigger_rationale",
        "pre_fill",
        "pre_fill_summary",
        "missing_elements",
        "surface_id",
      ],
    },
  },
  {
    name: "done_surfacing",
    description:
      "Signal that you are done surfacing tools for this encounter. Call exactly once, at the end. If nothing in your library applies, call this immediately with no preceding surface_clinical_tool calls.",
    input_schema: {
      type: "object",
      properties: {
        rationale: {
          type: "string",
          description:
            "One sentence on what you considered. If you surfaced nothing, name briefly why nothing applied.",
        },
      },
      required: ["rationale"],
    },
  },
];

// ─── Pre-fill coercion (loose JSON → typed shape) ───────────────────────────

/**
 * The Anthropic tool schema accepts `pre_fill` as a free-form object — the
 * per-tool shape is enforced by the system prompt, not by JSON Schema. This
 * coerces the raw object into the typed shape, preserving only known keys.
 */
function coercePreFill(
  toolName: ClinicalToolName,
  raw: unknown
): ClinicalToolSurfacing {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;

  // Each branch picks only the keys defined for that tool. Unknown keys
  // are silently dropped — the prompt is the source of truth for shape.
  switch (toolName) {
    case "HEART": {
      const pre: HEARTPreFill = {};
      if (typeof obj.history === "string") pre.history = obj.history as HEARTPreFill["history"];
      if (typeof obj.ekg === "string") pre.ekg = obj.ekg as HEARTPreFill["ekg"];
      if (typeof obj.age === "number") pre.age = obj.age;
      if (typeof obj.risk_factors_count === "number") pre.risk_factors_count = obj.risk_factors_count;
      if (Array.isArray(obj.risk_factors_heard)) pre.risk_factors_heard = obj.risk_factors_heard.filter((x) => typeof x === "string") as string[];
      if (typeof obj.troponin === "string") pre.troponin = obj.troponin as HEARTPreFill["troponin"];
      return { tool_name: "HEART", pre_fill: pre } as ClinicalToolSurfacing;
    }
    case "PERC": {
      const pre: PERCPreFill = {};
      const keys: Array<keyof PERCPreFill> = [
        "age_under_50",
        "hr_under_100",
        "spo2_at_least_95",
        "no_hemoptysis",
        "no_estrogen_use",
        "no_recent_surgery_trauma",
        "no_prior_dvt_pe",
        "no_unilateral_leg_swelling",
      ];
      for (const k of keys) if (typeof obj[k] === "boolean") pre[k] = obj[k] as boolean;
      return { tool_name: "PERC", pre_fill: pre } as ClinicalToolSurfacing;
    }
    case "SF_Syncope": {
      const pre: SFSyncopePreFill = {};
      const keys: Array<keyof SFSyncopePreFill> = [
        "chf_history",
        "hematocrit_under_30",
        "abnormal_ekg",
        "shortness_of_breath",
        "sbp_under_90",
      ];
      for (const k of keys) if (typeof obj[k] === "boolean") pre[k] = obj[k] as boolean;
      return { tool_name: "SF_Syncope", pre_fill: pre } as ClinicalToolSurfacing;
    }
    case "Canadian_CT_Head": {
      const pre: CanadianCTHeadPreFill = {};
      if (obj.high_risk && typeof obj.high_risk === "object") {
        const hr = obj.high_risk as Record<string, unknown>;
        const out: NonNullable<CanadianCTHeadPreFill["high_risk"]> = {};
        const k: Array<keyof NonNullable<CanadianCTHeadPreFill["high_risk"]>> = [
          "gcs_under_15_at_2h",
          "suspected_open_depressed_skull_fx",
          "signs_basilar_skull_fx",
          "vomiting_2_or_more",
          "age_65_or_over",
        ];
        for (const key of k) if (typeof hr[key] === "boolean") out[key] = hr[key] as boolean;
        pre.high_risk = out;
      }
      if (obj.medium_risk && typeof obj.medium_risk === "object") {
        const mr = obj.medium_risk as Record<string, unknown>;
        const out: NonNullable<CanadianCTHeadPreFill["medium_risk"]> = {};
        const k: Array<keyof NonNullable<CanadianCTHeadPreFill["medium_risk"]>> = [
          "amnesia_over_30min",
          "dangerous_mechanism",
        ];
        for (const key of k) if (typeof mr[key] === "boolean") out[key] = mr[key] as boolean;
        pre.medium_risk = out;
      }
      return { tool_name: "Canadian_CT_Head", pre_fill: pre } as ClinicalToolSurfacing;
    }
    case "Ottawa_Ankle": {
      const pre: OttawaAnklePreFill = {};
      if (obj.ankle && typeof obj.ankle === "object") {
        const a = obj.ankle as Record<string, unknown>;
        const out: NonNullable<OttawaAnklePreFill["ankle"]> = {};
        const k: Array<keyof NonNullable<OttawaAnklePreFill["ankle"]>> = [
          "posterior_lateral_malleolus_tenderness",
          "posterior_medial_malleolus_tenderness",
          "cannot_bear_weight_4_steps",
        ];
        for (const key of k) if (typeof a[key] === "boolean") out[key] = a[key] as boolean;
        pre.ankle = out;
      }
      if (obj.foot && typeof obj.foot === "object") {
        const f = obj.foot as Record<string, unknown>;
        const out: NonNullable<OttawaAnklePreFill["foot"]> = {};
        const k: Array<keyof NonNullable<OttawaAnklePreFill["foot"]>> = [
          "base_5th_metatarsal_tenderness",
          "navicular_tenderness",
          "cannot_bear_weight_4_steps",
        ];
        for (const key of k) if (typeof f[key] === "boolean") out[key] = f[key] as boolean;
        pre.foot = out;
      }
      return { tool_name: "Ottawa_Ankle", pre_fill: pre } as ClinicalToolSurfacing;
    }
    case "NEXUS": {
      const pre: NEXUSPreFill = {};
      if (obj.midline_c_spine_tenderness === null) pre.midline_c_spine_tenderness = null;
      else if (typeof obj.midline_c_spine_tenderness === "boolean") pre.midline_c_spine_tenderness = obj.midline_c_spine_tenderness;
      const keys: Array<keyof NEXUSPreFill> = [
        "focal_neuro_deficit",
        "altered_alertness",
        "intoxication",
        "painful_distracting_injury",
      ];
      for (const k of keys) if (typeof obj[k] === "boolean") (pre as Record<string, unknown>)[k] = obj[k];
      return { tool_name: "NEXUS", pre_fill: pre } as ClinicalToolSurfacing;
    }
  }
}

// ─── Core loop ───────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 8;

export async function runClinicalSurfacing(
  opts: RunClinicalSurfacingOptions
): Promise<RunClinicalSurfacingResult> {
  const { transcript, chiefComplaint, shiftContext = "", evalMode = false, onEvent } = opts;

  if (!transcript?.trim()) {
    throw new Error("No transcript");
  }

  const events: ClinicalSurfacingEvent[] = [];
  const surfacedTools: ClinicalToolSurfacing[] = [];

  const emit = async (event: ClinicalSurfacingEvent) => {
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

Surface clinical decision tools per your library. Then call done_surfacing.
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
      system: CLINICAL_SURFACING_SYSTEM,
      tools: CLINICAL_SURFACING_TOOLS,
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

      if (block.name === "surface_clinical_tool") {
        const toolName = input.tool_name as ClinicalToolName;
        const coerced = coercePreFill(toolName, input.pre_fill);

        const surfacing: ClinicalToolSurfacing = {
          ...coerced,
          trigger_rationale: (input.trigger_rationale as string) ?? "",
          pre_fill_summary: (input.pre_fill_summary as string) ?? "",
          missing_elements: Array.isArray(input.missing_elements)
            ? (input.missing_elements as string[]).filter((x) => typeof x === "string")
            : [],
          surface_id: (input.surface_id as string) ?? `surf_${Math.random().toString(16).slice(2, 10)}`,
          surfaced_at: new Date().toISOString(),
        } as ClinicalToolSurfacing;

        surfacedTools.push(surfacing);
        await emit({ type: "clinical_tool_surfaced", data: surfacing });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Surfaced.",
        });
      } else if (block.name === "done_surfacing") {
        await emit({
          type: "surfacing_done",
          data: { count: surfacedTools.length, iterations },
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

  // If the loop exited without an explicit done_surfacing, still emit it so
  // the consumer knows the engine is finished.
  if (!done) {
    await emit({
      type: "surfacing_done",
      data: { count: surfacedTools.length, iterations },
    });
  }

  return {
    surfacedTools,
    iterations,
    events,
    truncated: !done && iterations >= MAX_ITERATIONS,
  };
}
