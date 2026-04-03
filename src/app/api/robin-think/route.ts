import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { buildRobinContext } from "@/lib/robinPersona";
import { deriveOverallMDM } from "@/lib/mdmScoring";
import type { MDMScaffold, HPICompleteness, MDMComplexity } from "@/lib/robinTypes";

const anthropic = new Anthropic();

// ─── System prompt ────────────────────────────────────────────────────────────

const ROBIN_THINK_SYSTEM = `
You are Robin — an agentic AI shift copilot for emergency medicine physicians.
Your job in this call is clinical documentation audit, not conversation.

TOOL CALL ORDER (required)
1. hpi_completeness — always first
2. mdm_complexity_assessment — always second
3. note_gap — once per distinct gap, max 4 calls
4. em_assessment — once, after all note_gap calls
5. ready — last, signals completion

AMA 2021 MDM RULES
MDM = highest 2 of 3 elements (problems, data, risk). Not the average.

Problems:
- Straightforward: 1 self-limited or minor problem
- Low: 1 stable chronic illness; 2+ self-limited problems
- Moderate: new problem requiring workup; undiagnosed new problem; acute illness with systemic symptoms
- High: chronic illness with severe exacerbation; threat to life or bodily function

Data (count distinct reviewed items):
- Minimal: 0–1 items
- Low: 2 items
- Moderate: 3+ items (labs, imaging, records, outside provider discussion each = 1 point)
- High: extensive review including independent interpretation

Risk:
- Minimal: OTC medications only
- Low: minor surgery without risk factors
- Moderate: prescription drug management (initiate, change, or manage) — this alone = moderate
- High: drug therapy requiring intensive monitoring; hospitalization decision; DNR/comfort care

DOCUMENTATION GAP PRIORITY
Flag in this order when present:
1. HPI < 4 elements (brief HPI = E&M downcode risk)
2. Labs/imaging ordered but review not documented
3. Prescription written but drug management risk not documented
4. Disposition rationale absent or vague
5. No ROS beyond chief complaint
6. No return precautions

BILLING
Never mention dollar amounts. RVUs and E&M codes only.
99281=0.48 | 99282=0.93 | 99283=1.60 | 99284=2.60 | 99285=3.80 | 99291=4.50

SHIFT CONTEXT
Use the shift context to personalize feedback. If the physician has been
missing the same gap repeatedly this shift, say so explicitly.

TONE
Clinical colleague, not compliance officer. Brief, direct, encounter-specific.
Never hallucinate clinical details not in the transcript.
`.trim();

// ─── Tools ────────────────────────────────────────────────────────────────────

const ROBIN_THINK_TOOLS: Anthropic.Tool[] = [
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

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  // Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  // Parse body
  const { transcript, chiefComplaint, disposition, encounterId, shiftId } =
    (await req.json()) as {
      transcript: string;
      chiefComplaint: string;
      disposition?: string;
      encounterId: string;
      shiftId: string;
    };

  if (!transcript?.trim()) {
    return new Response('event: error\ndata: {"error":"No transcript"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // Shift memory + physician profile injection
  const { systemPrompt: shiftContext } = await buildRobinContext(
    supabase,
    shiftId,
    encounterId
  );

  // SSE setup
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          )
        );
      };

      try {
        // Accumulated state — written to DB when ready fires
        const mdmData: {
          mdm_scaffold?: MDMScaffold;
          hpi_completeness?: HPICompleteness;
          gaps: Array<{
            gap_type: string;
            description: string;
            severity: string;
            suggested_fix: string;
          }>;
          em_assessment?: {
            code: string;
            rvu: number;
            mdm_level: string;
            rationale: string;
            upgrade_possible: boolean;
            upgrade_requires: string | null;
          };
          summary?: string;
        } = { gaps: [] };

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
        const MAX_ITERATIONS = 8;
        let done = false;

        while (!done && iterations < MAX_ITERATIONS) {
          iterations++;

          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            system: ROBIN_THINK_SYSTEM,
            tools: ROBIN_THINK_TOOLS,
            messages,
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
                brief_or_extended: input.brief_or_extended as
                  | "brief"
                  | "extended",
              };
              mdmData.hpi_completeness = hpi;
              send("hpi_completeness", hpi);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: "Scored.",
              });
            } else if (block.name === "mdm_complexity_assessment") {
              const problems = input.problems_complexity as MDMComplexity;
              const data = input.data_complexity as MDMComplexity;
              const risk = input.risk_complexity as MDMComplexity;
              // Server-side validation — override model's overall_mdm with correct AMA 2021 calculation
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
                one_thing_to_upgrade:
                  input.one_thing_to_upgrade as string | null,
                scored_at: new Date().toISOString(),
              };
              mdmData.mdm_scaffold = scaffold;
              send("mdm_scaffold", scaffold);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: "Assessed.",
              });
            } else if (block.name === "note_gap") {
              const gap = {
                gap_type: input.gap_type as string,
                description: input.description as string,
                severity: input.severity as string,
                suggested_fix: input.suggested_fix as string,
              };
              mdmData.gaps.push(gap);
              send("note_gap", gap);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: "Logged.",
              });
            } else if (block.name === "em_assessment") {
              const em = {
                code: input.code as string,
                rvu: input.rvu as number,
                mdm_level: input.mdm_level as string,
                rationale: input.rationale as string,
                upgrade_possible: input.upgrade_possible as boolean,
                upgrade_requires: input.upgrade_requires as string | null,
              };
              mdmData.em_assessment = em;
              send("em_assessment", em);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: "Assessed.",
              });
            } else if (block.name === "ready") {
              mdmData.summary = input.summary as string;
              send("ready", { summary: input.summary });

              // Persist to encounters.mdm_data
              await supabase
                .from("encounters")
                .update({ mdm_data: mdmData })
                .eq("id", encounterId);

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

        send("done", { iterations });
        controller.close();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
