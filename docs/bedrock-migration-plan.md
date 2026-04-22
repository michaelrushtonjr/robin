# AWS Bedrock Migration Plan

> **Owner:** Michael (execution: Alfred)
> **Created:** 2026-04-20
> **Status:** Ready to execute
> **Dependency order:** AWS BAA accepted → Bedrock model access approved → code migration → env flip → eval regression → ship

---

## Why

Anthropic's January 2026 Claude for Healthcare launch explicitly routes healthcare BAAs through AWS Bedrock, Google Cloud, and Microsoft Azure. Two follow-ups to sales@anthropic.com (2026-04-06, 2026-04-14) have gone unanswered. AWS Bedrock is self-serve, BAA-covered, same model versions, same or near-identical per-token pricing, and is Anthropic's stated intended path for healthcare customers. Migrating unblocks the first trial shift without waiting on enterprise sales.

The migration is a **same-provider, different-transport** swap — not a model change. Claude Sonnet 4 and Claude Haiku are both hosted on Bedrock. Same model IDs (with a prefix and version suffix), same prompting, same tool-use schema.

---

## AWS account prerequisites (do these first)

Blocking, order matters:

1. **AWS account.** Create if needed. Use Michael's business email for the root user. Enable MFA on root immediately. Create a named IAM admin user and stop using the root user.
2. **Accept the AWS BAA.** Log in → AWS Artifact → Agreements → AWS Business Associate Addendum → Accept on behalf of the account. Covers all HIPAA-eligible services account-wide, including Bedrock. This is click-through, takes <5 minutes.
3. **Request Bedrock model access.** Bedrock Console → `us-east-1` → Model access → Request access for:
   - `anthropic.claude-sonnet-4-20250514-v1:0`
   - `anthropic.claude-haiku-4-5-20251001-v1:0` (or the latest Haiku on Bedrock)
   - Also request `us-west-2` if you want cross-region inference later (optional, raises rate limits for free)
   Approval is typically 1–3 business days for Claude models.
4. **Create IAM user for Robin.** IAM → Users → Add user `robin-bedrock` → Programmatic access. Attach least-privilege policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": [
         "bedrock:InvokeModel",
         "bedrock:InvokeModelWithResponseStream"
       ],
       "Resource": [
         "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
         "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-*"
       ]
     }]
   }
   ```
   Save the access key + secret. Store in a password manager.
5. **Do NOT enable Bedrock model invocation logging yet.** It's off by default. Leaving it off keeps the PHI trail cleaner for v1. Revisit if we need it for debugging later — must point at a BAA-covered log destination with a documented retention policy.

---

## Engineering approach: unified `llmClient.ts` wrapper

The migration introduces one file, imports from that file across 13 call sites, and is gated behind a single env var so rollback is trivial.

### The wrapper

Create `src/lib/llmClient.ts`. This is the **only** place in the codebase that imports the Anthropic SDK or the AWS Bedrock SDK. Every existing `new Anthropic(...)` / `anthropic.messages.create(...)` / `anthropic.messages.stream(...)` call moves behind this wrapper.

**Shape:**
```ts
// src/lib/llmClient.ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

type Provider = "anthropic" | "bedrock";

const PROVIDER: Provider = (process.env.LLM_PROVIDER as Provider) || "anthropic";

const MODEL_MAP = {
  // Logical name → provider-specific model ID
  "sonnet-4": {
    anthropic: "claude-sonnet-4-20250514",
    bedrock: "anthropic.claude-sonnet-4-20250514-v1:0",
  },
  "haiku-4-5": {
    anthropic: "claude-haiku-4-5-20251001",
    bedrock: "anthropic.claude-haiku-4-5-20251001-v1:0",
  },
} as const;

export type ModelName = keyof typeof MODEL_MAP;
export const resolveModel = (name: ModelName) => MODEL_MAP[name][PROVIDER];

export const llm = PROVIDER === "bedrock"
  ? new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION || "us-east-1",
      awsAccessKey: process.env.AWS_ACCESS_KEY_ID!,
      awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY!,
    })
  : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
```

Why this works: Anthropic ships `@anthropic-ai/bedrock-sdk` which exposes the **same `messages.create` / `messages.stream` API** as the direct SDK. The Bedrock SDK is a drop-in — same method signatures, same tool-use schema, same streaming events. The wrapper's only job is to pick which client to instantiate and to translate the logical model name into the provider-specific model ID.

**What the wrapper does not abstract:** request bodies, tool definitions, message shapes — those are identical across providers. Keep them as-is.

### Model ID reference

| Logical name | Anthropic direct | Bedrock |
|---|---|---|
| Sonnet 4 | `claude-sonnet-4-20250514` | `anthropic.claude-sonnet-4-20250514-v1:0` |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | `anthropic.claude-haiku-4-5-20251001-v1:0` |

Bedrock IDs occasionally change when a model gets a minor revision — verify in the Bedrock Console → Model access before finalizing.

### Environment variables

**Current (direct Anthropic only):**
```
ANTHROPIC_API_KEY=sk-ant-...
```

**After migration (both paths supported, env var selects):**
```
LLM_PROVIDER=bedrock            # or "anthropic"
ANTHROPIC_API_KEY=sk-ant-...    # kept for fallback
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

**Fly.io secrets:**
```bash
fly secrets set LLM_PROVIDER=bedrock \
  AWS_REGION=us-east-1 \
  AWS_ACCESS_KEY_ID=AKIA... \
  AWS_SECRET_ACCESS_KEY=... \
  --app robin-copilot
```

Keep `ANTHROPIC_API_KEY` set even after cutover — flipping `LLM_PROVIDER=anthropic` rolls back instantly without a redeploy.

---

## Call sites that need updating

Every file below currently instantiates Anthropic directly and hardcodes a model name. Each one changes in the same way: import `llm` and `resolveModel` from `src/lib/llmClient.ts`, replace the model string with `resolveModel("sonnet-4")` or `resolveModel("haiku-4-5")`, remove the direct `new Anthropic({...})` instantiation.

### Pure clinical-logic libs (edit these first — they are the engines)

| File | Model used | Notes |
|---|---|---|
| `src/lib/robinThink.ts` | Sonnet 4 | Core MDM audit engine. Tool use + streaming. Highest-traffic Claude path. |
| `src/lib/clinicalSurfacing.ts` | Sonnet 4 | Loop A clinical decision tool surfacing. Tool use + streaming. |
| `src/lib/differentialExpander.ts` | Sonnet 4 | Loop A differential expander. Tool use + streaming. |

These three files are the eval-covered core. If Bedrock works here, it works everywhere — the rest is plumbing.

### API routes (13 total)

| Route | Model | Notes |
|---|---|---|
| `src/app/api/robin-think/route.ts` | Sonnet 4 | Thin SSE wrapper around `runRobinThink()` — change flows via the lib |
| `src/app/api/clinical-surfacing/route.ts` | Sonnet 4 | Thin SSE wrapper — change flows via the lib |
| `src/app/api/differential-expander/route.ts` | Sonnet 4 | Thin SSE wrapper — change flows via the lib |
| `src/app/api/robin-chat/route.ts` | Sonnet 4 | Conversational Robin, streaming |
| `src/app/api/generate-note/route.ts` | Sonnet 4 | Full ED H&P generation |
| `src/app/api/detect-encounter/route.ts` | Sonnet 4 | Encounter boundary detection |
| `src/app/api/clarification-questions/route.ts` | Sonnet 4 | Post-encounter Q&A |
| `src/app/api/parse-patients/route.ts` | Sonnet 4 | Patient briefing parser |
| `src/app/api/onboarding-interview/route.ts` | Sonnet 4 | Streaming interview |
| `src/app/api/agent/act/route.ts` | **Haiku** | Low-latency ambient command parser — keep on Haiku |
| `src/app/api/agent/procedure-qa/route.ts` | Sonnet 4 | Procedure Q&A assembler |
| `src/app/api/note/finalize/route.ts` | Sonnet 4 | Note polish |
| `src/app/api/agent/undo/route.ts` | (no Claude call) | Database-only, no change needed |

Per-route change is ~4 lines: remove SDK import, remove `new Anthropic(...)`, import from `llmClient.ts`, swap the model string.

### Migration checklist per call site

For each file:

1. Remove `import Anthropic from "@anthropic-ai/sdk"` (unless used for types — keep `import type { MessageStreamEvent } ...` etc.)
2. Remove `const anthropic = new Anthropic({ apiKey: ... })`
3. Add `import { llm, resolveModel } from "@/lib/llmClient"`
4. Replace `anthropic.messages.create({ model: "claude-sonnet-4-20250514", ... })` with `llm.messages.create({ model: resolveModel("sonnet-4"), ... })`
5. Same for `.stream(...)` calls
6. Nothing else changes — tool definitions, system prompts, request bodies, streaming event handling are all identical across providers

---

## Cross-region inference (optional, low-risk performance upgrade)

Bedrock supports cross-region inference profiles that automatically route requests across `us-east-1`, `us-east-2`, `us-west-2` to dodge regional capacity limits. Free to enable, no data residency gotchas since all three are US regions (same BAA coverage).

To enable: in the Bedrock Console, request access in the extra regions, then replace the model ID with the inference profile ARN:
```
us.anthropic.claude-sonnet-4-20250514-v1:0
```
(Note the `us.` prefix — that's the inference profile.)

Recommend enabling this only after the straightforward migration is green in evals. One variable at a time.

---

## Provisioned throughput (future, not v1)

At hundreds of concurrent physicians, on-demand Bedrock has throughput ceilings. The answer at scale is **Provisioned Throughput** — you commit to N model units ($/hour per unit) in exchange for guaranteed TPS. Not relevant at single-physician trial volumes. Flag this for the scaling work, not v1.

---

## Migration sequence (execution order)

Day 0 (today):

1. Create/confirm AWS account + MFA on root + IAM admin user
2. Accept AWS BAA in AWS Artifact
3. Request Bedrock model access for Claude Sonnet 4 + Haiku in `us-east-1`
4. Create `robin-bedrock` IAM user with the least-privilege policy above
5. Sign Fly.io BAA in parallel (unrelated but cheap win)

Day 1 (wait on model-access approval, do prep work):

6. Install SDK: `npm install @anthropic-ai/bedrock-sdk`
7. Land `src/lib/llmClient.ts` wrapper with `LLM_PROVIDER` defaulting to `"anthropic"` — zero behavior change
8. Migrate `robinThink.ts` → run eval harness (`npx tsx evals/runEvals.ts`) → must still pass 13/13
9. Migrate `clinicalSurfacing.ts` → run surfacing evals → must still pass 18/18
10. Migrate `differentialExpander.ts` → run differential evals → must still pass 12/12
11. Migrate the 9 remaining API routes
12. `npm run build` — must pass
13. Commit all of the above behind the default `LLM_PROVIDER=anthropic` — no prod behavior change yet

Day 2–3 (once Bedrock model access is approved):

14. Set Fly.io secrets for AWS + `LLM_PROVIDER=bedrock`
15. Deploy to Fly.io
16. Run the eval harness against the deployed staging config if available, or run it locally with `LLM_PROVIDER=bedrock` set
17. Smoke test: live encounter capture through robin-think via Bedrock, verify SSE events stream identically, verify tool use works
18. Watch latency and token costs for the first few real calls. Bedrock latency is typically within ~10% of direct.
19. If anything breaks, flip `LLM_PROVIDER=anthropic` via `fly secrets set` — instant rollback without redeploy.

---

## What could go wrong

**Model access denied/delayed.** AWS occasionally rejects Claude model access requests on the first try, especially for brand-new AWS accounts. If rejected, the form lets you reapply with more context — mention healthcare/clinical use case and that you've accepted the BAA.

**SDK version drift.** The Bedrock SDK sometimes lags the direct Anthropic SDK by a version or two — usually the lag is a week, not months. Double-check that the tool-use / streaming features you need are actually in the published Bedrock SDK version. The three lib files (`robinThink`, `clinicalSurfacing`, `differentialExpander`) all use tool use + streaming, which has been supported in the Bedrock SDK since day one.

**Rate limits.** On-demand Bedrock rate limits are per-account-per-region. Should be more than enough for trial-shift volume. If you hit them during evals (running 43 fixtures back-to-back), add a 200ms sleep between runs or switch to cross-region inference.

**Tool use parameter quirks.** Both providers accept the same tool-use schema, but Bedrock is stricter about message ordering (e.g., `tool_use` must be immediately followed by `tool_result`). Robin's code already does this correctly — this is called out only in case a future refactor introduces a bug that worked on direct but not Bedrock.

**Prompt caching.** Both paths support prompt caching via `cache_control` blocks. Semantics are the same. No code change needed.

**Cost surprise.** Bedrock invoices monthly via AWS, not via Anthropic. You lose the nice per-call dashboard at console.anthropic.com. AWS Cost Explorer is the equivalent — less pretty, more accurate.

---

## Validation plan

The eval harness is the contract. Migration is green only if:

- `npx tsx evals/runEvals.ts` → 13/13 pass deterministically at temp 0 on Bedrock
- `npx tsx evals/surfacing/runSurfacingEvals.ts` → 18/18 pass
- `npx tsx evals/differential/runDifferentialEvals.ts` → 12/12 pass
- A single live encounter capture run end-to-end through the UI with Bedrock enabled

If any eval fixture drifts (e.g., one of the 13 MDM fixtures now picks a different E&M code), dig in. Don't paper over it. The fixtures are the ground truth.

---

## Rollback plan

One command:
```bash
fly secrets set LLM_PROVIDER=anthropic --app robin-copilot
```
Fly.io automatically restarts the app with the new secret. No redeploy needed. Since `ANTHROPIC_API_KEY` is still set, direct Anthropic takes over on the next request. Rollback time: <30 seconds.

This is why keeping both paths live behind an env flag matters. The wrapper is cheap insurance.

---

## Open follow-ups (not blocking)

- Verify whether Claude for Healthcare extras (healthcare-trained models, CMS Coverage DB, ICD-10 lookups, PubMed, FHIR Agent Skill) are available via Bedrock or direct-only. If Bedrock-exposed, evaluate for Robin's E&M and future EHR integration work.
- Revisit Bedrock model invocation logging once there's a BAA-covered log destination and a documented retention policy. For v1, keep it off.
- Evaluate cross-region inference once base migration is green.
- Evaluate Provisioned Throughput when concurrent-physician count justifies it (not v1).
