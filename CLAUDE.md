# CLAUDE.md — Robin Engineering Reference
<!-- Alfred: read this fully before touching any code. Last updated: 2026-04-03 -->

## What Robin Is

Robin is an **agentic AI shift copilot** for emergency medicine physicians. It is not a scribe.
Notes are a byproduct. Core value: shift-persistent intelligence — proactive MDM scaffolding,
E&M billing reconciliation, mid-shift audits, and post-discharge voice callbacks.

**One-liner:** "The first shift-persistent clinical copilot for independent EM groups."
**Pricing:** $399–499/month per physician.
**Go-to-market:** Independent EM groups at freestanding ERs and community hospitals.

---

## Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend / PWA | Next.js | `output: 'standalone'` required for Docker |
| Deployment | Fly.io | App: `robin-copilot`, region: `dfw` (Dallas), 512mb/shared CPU |
| CI/CD | GitHub Actions | `.github/workflows/deploy.yml` — auto-deploy on push to main |
| Database | Supabase | `robin-health` org, `robin-dev` project, RLS enabled from day one |
| Auth | Supabase GitHub OAuth | `/src/app/auth/callback/route.ts` |
| ASR | Deepgram | `nova-2-medical` model, WebSocket streaming, diarization enabled |
| LLM | Claude via Anthropic API (today) → AWS Bedrock (planned, 2026-04-21 pivot) | `claude-sonnet-4-20250514` throughout. Migration plan: `/docs/bedrock-migration-plan.md` |
| Agentic loop | Claude tool-use via `/api/robin-think` | SSE streaming, 5-tool MDM pipeline |
| Voice callbacks | Twilio + ElevenLabs or Deepgram TTS | Designed, not yet built |

---

## Design System (LOCKED — do not change)

```css
--bg: #FDF6EC          /* warm cream — page background */
--surface: #FFFFFF
--surface2: #F5EDE0
--border: rgba(0,0,0,0.07)
--border2: rgba(0,0,0,0.12)
--robin: #E04B20       /* primary — robin breast orange-red */
--robin-dark: #C73E18
--robin-dim: rgba(224,75,32,0.08)
--teal: #00A896
--teal-dim: rgba(0,168,150,0.08)
--amber: #F5A623       /* dictation, interim states */
--amber-dim: rgba(245,166,35,0.10)
--text: #1A1A1A
--muted: rgba(26,26,26,0.45)
```

**Typography:** Syne (UI, headings, buttons) + Space Mono (data: timer, RVUs, E&M codes, speaker labels)
**Logo:** ROBIN — all caps, Syne 800, letter-spacing 0.18em, `--robin` color
**Robin mark:** 32×32px rounded square (9px radius), `--robin` bg, white "R" in Space Mono bold
**Nav icon:** Raccoon eye mask SVG — angular cutouts, wings narrow at bridge, flare outward. No eyeballs, no pupils, no strings.

**Product rule:** RVUs only mid-shift. Dollar amounts appear only in end-of-shift reconciliation.

---

## Fly.io Deployment

**Why Fly.io over Vercel:** HIPAA-eligible BAAs available at reasonable cost; Vercel's BAA pricing was prohibitive.

**Key files:**
- `fly.toml` — app config (`robin-copilot`, Dallas `dfw`, 512mb/1 shared CPU)
- `Dockerfile` — multi-stage Node.js 22 Alpine build, copies `.next/standalone`
- `.dockerignore` — excludes node_modules, .next, .env files
- `.nvmrc` — Node 22
- `.github/workflows/deploy.yml` — GitHub Actions: auto-deploy to Fly on push to main

**SSE note:** Fly.io has no streaming timeout constraints (unlike Vercel's edge 10s limit). `robin-think` SSE migration is a standard Node.js `ReadableStream` — same pattern as `robin-chat`.

---

## File Map

```
/src
  /app
    /api
      /robin-think/route.ts       ← MDM audit engine (SSE, 5-tool pipeline, AMA 2021 scoring)
      /robin-chat/route.ts        ← Conversational Robin (streaming, auth-gated)
      /generate-note/route.ts     ← ED H&P note generation
      /detect-encounter/route.ts  ← Encounter boundary detection from ambient buffer
      /clarification-questions/   ← Post-encounter gap clarification
      /parse-patients/            ← Patient briefing parser
      /deepgram-token/            ← Auth-gated short-lived Deepgram token (30s JWT, server-side only)
      /agent/act/                 ← Ambient command gateway (Layer 1+3: 16 command types, encounter resolution, tier classification)
      /agent/undo/                ← Voice undo — restores previous_state from robin_actions
      /agent/procedure-qa/        ← Procedure Q&A — 5 procedure types, KB-driven question sequences
      /clinical-surfacing/route.ts ← Loop A — clinical decision tool surfacing (SSE, 6 tools, typed per-tool pre-fill)
      /differential-expander/route.ts ← Loop A — differential expander (SSE, badness × pretest ranking)
      /shift/close/route.ts         ← Aggregates closed shift's memory → physician longitudinal (item 16.5)
      /onboarding-interview/      ← Streaming interview chat for physician onboarding (Layer 2)
      /physician/preferences/     ← Save physician preferences (POST, auth-gated)
      /note/section/              ← PATCH — update a specific note section (conflict detection)
      /note/finalize/             ← POST — polish accumulated note, produce copy-ready document
      /note/status/               ← GET — badge state for all shift encounters
    /shift/page.tsx               ← Shift dashboard (redirects to /onboarding if preferences empty)
    /shift/encounter/[id]/page.tsx ← Encounter capture screen (primary screen)
    /shift/notes/page.tsx         ← Note dashboard — encounter list with completion badges
    /shift/notes/[id]/page.tsx    ← Single note view — 13 sections, tabs (note/billing/discharge), edit + finalize
    /onboarding/page.tsx          ← Physician onboarding interview screen (Layer 2)
    /login/page.tsx
  /components
    AudioCapture.tsx              ← Encounter-level audio UI (uses useAudio + useDeepgram)
    RobinChat.tsx                 ← Conversational Robin panel (19KB — substantial)
    ClarificationPanel.tsx        ← Post-encounter clarification Q&A
    NoteOutput.tsx                ← Generated note display + copy to EHR
    RobinInsightsPanel.tsx        ← MDM audit panel (SSE-driven, progressive: HPI → MDM → gaps → E&M)
    RobinToast.tsx                ← Inline action confirmation toasts (Layer 1)
    ConfirmCard.tsx               ← Uncertain parse confirmation UI (Layer 1+3)
    DisambiguationCard.tsx        ← "Which encounter?" push-button card (Layer 3)
    BatchPECard.tsx               ← Multi-patient PE dictation card (Layer 3)
    TranscriptPanel.tsx           ← Full transcript view
    /capture
      ControlBar.tsx              ← Pause / dictate / end controls
      ModeToggle.tsx              ← Ambient / PTT toggle
      RobinObservation.tsx        ← Inline observation card
      TranscriptFeed.tsx          ← Live transcript with speaker labels
      TranscriptLine.tsx          ← Individual line (physician/patient/interim)
      WaveformVisualizer.tsx      ← 32-bar animated waveform
  /hooks
    useAudio.ts                   ← Mic access, MediaStream management
    useDeepgram.ts                ← WebSocket to Deepgram, segment management
    useShiftAmbient.ts            ← Full shift-level ambient intelligence (see below)
    useWakeLock.ts                ← Screen wake lock for shift mode
  /lib
    deepgram.ts                   ← WebSocket factory, config, types
    robinPersona.ts               ← ROBIN_IDENTITY + buildRobinContext() + translatePreferences()
    robinSystemPrompt.ts          ← System prompt for note generation
    robinThink.ts                 ← runRobinThink() — pure function, full MDM audit pipeline (system prompt, tools, Claude loop, deriveOverallMDM guardrail). Imported by /api/robin-think and /evals.
    clinicalSurfacing.ts          ← runClinicalSurfacing() — Loop A pure function. 6-tool library with TRIGGER + DO NOT SURFACE rules per tool, typed per-tool pre-fill via coercePreFill(). Imported by /api/clinical-surfacing and /evals/surfacing.
    differentialExpander.ts       ← runDifferentialExpander() — Loop A sibling (item 16). add_differential (cap 4) → done_expanding. Sorts by badness_if_missed then pretest_probability. THE RATIONALE TEST meta-rule. Imported by /api/differential-expander and /evals/differential.
    memory.ts                     ← Memory architecture helpers (item 16.5) — shift memory + longitudinal writers, aggregateShiftToLongitudinal, delta detection
    robinTypes.ts                 ← RobinInsight, RobinAuditState, RobinPreferences, EncounterNote, MDM types, ClinicalToolName, ClinicalToolSurfacing, DifferentialAddition, ShiftMemory, RobinLongitudinal
    mdmScoring.ts                 ← Pure MDM scoring functions: deriveOverallMDM, getNextCode, RVU_MAP
    /supabase
      client.ts                   ← Browser Supabase client
      server.ts                   ← Server Supabase client
  proxy.ts                        ← Supabase auth middleware — session refresh + /shift route protection. Not a Deepgram proxy.
/supabase/migrations
  001_initial_schema.sql          ← physicians, shifts, encounters + RLS
  002_encounter_demographics.sql  ← age, gender columns
  003_robin_chat.sql              ← Chat history table + robin_preferences + robin_memory
  004_layer1_ambient_command.sql  ← robin_actions table + encounter columns (Layer 1)
  005_note_dashboard.sql          ← note jsonb + note_version columns on encounters
  006_memory_architecture.sql     ← physicians.robin_longitudinal jsonb (item 16.5)
/docs
  agent-roster.md                 ← Full agent definitions
  robin-agentic-spec.md           ← Master agentic capability spec (Layers 1–3, Note Dashboard, Living Note)
/evals
  /encounters/*.json              ← Encounter fixtures with ground truth (code, axes, required gaps, forbidden rationales)
  rubric.ts                       ← scoreEncounter() — assertion engine + pretty printer
  runEvals.ts                     ← `npx tsx evals/runEvals.ts [filter]` — runs runRobinThink() directly with temperature: 0
  /surfacing/
    /fixtures/*.json              ← 18 surfacing fixtures (3 per tool: trigger + over-fire trap + edge case)
    rubric.ts                     ← scoreSurfacing() — dot-notation pre_fill assertions, substring missing_elements
    runSurfacingEvals.ts          ← `npx tsx evals/surfacing/runSurfacingEvals.ts [filter]` — 18/18 deterministic at temp 0
    runOverfireRegression.ts      ← Bonus regression: runs surfacing engine on 13 MDM fixtures, eyeball over-firing
  /differential/
    /fixtures/*.json              ← 12 fixtures (6 trigger: PE, SAH, AAA, HELLP, ectopic, dissection; 6 non-trigger: vasovagal, STEMI cath, URI, PE-covered, mech back, ankle)
    rubric.ts                     ← scoreDifferential() — substring diagnosis matching, per-add badness assertions, maxAdded cap
    runDifferentialEvals.ts       ← `npx tsx evals/differential/runDifferentialEvals.ts [filter]` — 12/12 deterministic at temp 0
```

---

## Audio Architecture — TWO PARALLEL STACKS

**Do not confuse them. They serve different purposes.**

### Stack A — Encounter-level capture
`useAudio` → `useDeepgram` → `AudioCapture.tsx`
- Simple chain: mic → Deepgram WebSocket → transcript segments
- Handles ambient/PTT toggle, diarization, interim/final results
- Float32 → Int16 PCM conversion via `ScriptProcessorNode`
- Used inside the encounter capture screen

### Stack B — Shift-level ambient (primary / production hook)
`useShiftAmbient.ts` — significantly more sophisticated:
- **Wake word detection:** "hey robin", "ok robin", "robin,"
- **Encounter boundary detection:** polls `/api/detect-encounter` after 6+ words
- **EMS radio chatter filtering:** 10-codes, "en route", "copy that", etc.
- **Re-eval command routing:** "patient 3", "room 7", "re-eval"
- **Patient briefing detection:** "about to see", "next patients"
- **Deepgram keepalive:** every 8 seconds (prevents silent-room disconnects)
- **iOS AudioContext resume:** on `visibilitychange` — production mobile fix
- **Wake lock management**
- **Pause/resume mic handoff** when Robin chat takes over (`pauseForRobin` / `resumeFromRobin`)

---

## Database Schema Summary

### `physicians`
- `id` (uuid, FK → auth.users)
- `display_name`, `specialty`
- `settings` (jsonb)
- `robin_preferences` (jsonb — loaded into shift context for personalization)

### `shifts`
- `id`, `physician_id`, `started_at`, `ended_at`, `status` (active/completed)
- `robin_memory` (jsonb — shift-level observations, fed into robin-chat system prompt)

### `encounters`
- `id`, `shift_id`, `room`, `chief_complaint`, `status` (active/documenting/completed)
- `transcript` (text), `generated_note` (text)
- `mdm_data` (jsonb — **currently empty, MDM scaffold writes here**)
- `ehr_mode` (epic/cerner)
- `note` (jsonb — living note, EncounterNote structure)
- `note_version` (integer, default 1 — optimistic locking)
- `created_by_robin` (boolean, default false)
- `disposition` (text)
- `accepting_physician` (text)
- `patient_name` (text)

### `robin_chat` (migration 003)
- Chat history per shift — check migration for exact columns

### `robin_actions` (migration 004)
- `id`, `shift_id`, `encounter_id`, `action_type`, `raw_command`
- `parsed_payload` (jsonb), `confidence` (float), `confirmed_by_physician` (boolean)
- `previous_state` (jsonb — for undo), `note_section_affected` (text)

---

## Memory Architecture (item 16.5 — see `/docs/memory-architecture.md` for the full design)

| Tier | Storage | Scope | Writers |
|---|---|---|---|
| 1 — Encounter | `encounters.mdm_data` jsonb | Per encounter | robin-think, clinical-surfacing, differential-expander, agent/act |
| 2 — Shift | `shifts.robin_memory` jsonb | Per shift | robin-think, clinical-surfacing, differential-expander, agent/act, note/finalize |
| 3a — Stated intent | `physicians.robin_preferences` jsonb | Longitudinal | onboarding interview (once) |
| 3b — Observed behavior | `physicians.robin_longitudinal` jsonb | Longitudinal | `/api/shift/close` aggregator |
| Clinical KB | `robinSystemPrompt.ts` (static) | Global | — |

**Reconciliation policy:** Preferences always win for Robin's behavior (what to surface, how aggressive). Longitudinal informs content only in moments Robin already fires. Deltas (observed behavior diverging from stated intent) surface only at reconciliation moments (shift close, settings) as `pending_observations` — never silently overriding preferences. Threshold: `shifts_observed >= 5` before longitudinal affects content.

Helpers live in `src/lib/memory.ts`. Write-path pattern: routes stay thin and call helpers, not Supabase directly.

---

## API Routes — Current Status

### `/api/differential-expander` (SSE POST) — ✅ COMPLETE (engine + UI; live audio wiring deferred)
Thin SSE wrapper around `runDifferentialExpander()` (in `src/lib/differentialExpander.ts`). Loop A sibling to clinical surfacing (item 16). Silently adds diagnoses the physician hasn't named but the presentation specifically supports. Cap of 4 adds per call. Sorts by `badness_if_missed` (life_threatening → serious → benign) then `pretest_probability` (common → uncommon → rare).

**Tools:** `add_differential` (0+ calls, capped at 4) → `done_expanding` (exactly once)
**SSE events:** `differential_added` | `expanding_done` | `error`
**Body:** `{ transcript, chiefComplaint, encounterId?, shiftId? }`
**Output payload per addition:** `{ diagnosis, pretest_probability, badness_if_missed, rationale, missing_workup[], surface_id, surfaced_at }`
**Status:** engine 12/12 deterministic at temp 0 (6 trigger + 6 non-trigger fixtures). Over-fire discipline enforced via THE RATIONALE TEST meta-rule. Silence is a valid and common output — 5/12 fixtures correctly add zero differentials.

### `/api/clinical-surfacing` (SSE POST) — ✅ COMPLETE (engine + UI; live audio wiring deferred)
Thin SSE wrapper around `runClinicalSurfacing()` (in `src/lib/clinicalSurfacing.ts`). Loop A — clinical decision tool surfacing. Library of 6 tools (HEART, PERC, SF Syncope, Canadian CT Head, Ottawa Ankle, NEXUS). Auth-gated. Per-tool typed pre-fill via server-side `coercePreFill()`. Eval mode opt-in via `x-robin-eval: 1` header.

**Tools:** `surface_clinical_tool` (called 0+ times) → `done_surfacing` (exactly once)
**SSE events:** `clinical_tool_surfaced` | `surfacing_done` | `error`
**Body:** `{ transcript, chiefComplaint, encounterId?, shiftId? }`
**Output payload per surfacing:** `{ tool_name, pre_fill (typed), trigger_rationale, pre_fill_summary, missing_elements[], surface_id (forward-compat with item 19's surfacing_events table), surfaced_at }`
**Status:** engine 18/18 deterministic at temp 0; over-fire regression on 13 MDM fixtures shows clean discrimination; UI panel renders. Live wiring into `useShiftAmbient` deferred to a separate commit alongside item 19's `surfacing_events` write path.

### `/api/robin-think` (SSE POST) — ✅ COMPLETE
Thin SSE wrapper around `runRobinThink()` (in `src/lib/robinThink.ts`). The route handles auth, body parsing, `buildRobinContext()`, SSE encoding, and the `encounters.mdm_data` persist on `ready`. All clinical logic — system prompt, tool definitions, Claude tool-use loop, `deriveOverallMDM` guardrail — lives in the lib so it can also be called directly by `/evals/runEvals.ts`. **Memory writes on ready:** upserts shift-memory encounter rollup, increments `gaps_by_type` + `codes_distribution` tallies, bumps `vague_workup_language_count` and `critical_care_count` observed patterns.

**Tools (in order):** `hpi_completeness` → `mdm_complexity_assessment` → `note_gap` (0–4×) → `em_assessment` → `ready`
**SSE events:** `hpi_completeness` | `mdm_scaffold` | `note_gap` | `em_assessment` | `ready` | `done` | `error`
**AMA 2021:** Server-side `deriveOverallMDM()` validates model's MDM scoring (2-of-3 rule, cannot be overridden)
**Context:** Full shift memory + physician profile via `buildRobinContext()`
**Persists:** `encounters.mdm_data` written on `ready`
**Eval mode:** Set request header `x-robin-eval: 1` (or pass `evalMode: true` directly to `runRobinThink`) to pin Anthropic temperature to 0 for deterministic eval runs.
**Body:** `{ transcript, chiefComplaint, disposition?, encounterId, shiftId }`

### `/api/robin-chat` (streaming POST) — ✅ COMPLETE
Conversational Robin. Auth-gated. Streams Claude. Uses `buildRobinContext()` for full shift awareness. Last 20 history messages included.

### `/api/generate-note` (POST) — ✅ COMPLETE
Generates full ED H&P. Epic/Cerner EHR mode. Incorporates post-encounter clarifications. Uses `ROBIN_SYSTEM_PROMPT`.

### `/api/detect-encounter` (POST) — ✅ COMPLETE
Detects encounter boundaries from ambient transcript buffer. Called by `useShiftAmbient` after 6+ words with cooldown logic.

### `/api/clarification-questions` (POST) — ✅ COMPLETE
Post-encounter gap Q&A panel.

### `/api/parse-patients` (POST) — ✅ COMPLETE
Parses patient briefing commands from ambient audio.

### `/api/onboarding-interview` (streaming POST) — ✅ COMPLETE
Layer 2 interview chat. Streams Robin's conversational preference discovery. Uses `ROBIN_IDENTITY` + interview system prompt. Outputs `RobinPreferences` JSON block when all 8 areas covered.

### `/api/physician/preferences` (POST) — ✅ COMPLETE
Saves `RobinPreferences` to `physicians.robin_preferences`. Auth-gated. No streaming.

### `/api/agent/act` (POST) — ✅ COMPLETE
Full ambient command gateway (Layers 1+3). 16 command types: briefing, disposition, PE, EKG, MDM, ED course, orders, labs, radiology, discharge instructions, final diagnosis (ICD-10), consults, encounter update, voice undo, voice remove. Encounter resolution (name/room/number/recency). Confidence tiers. Claude Haiku parse. Writes to living note + `robin_actions` audit table.

### `/api/agent/undo` (POST) — ✅ COMPLETE
Restores `previous_state` from `robin_actions`. Supports note section, encounter field, and encounter deletion undos. Redo = undo the undo action.

### `/api/agent/procedure-qa` (POST) — ✅ COMPLETE
KB-driven procedure Q&A. 5 procedures: sedation/closed reduction, lac repair, I&D, intubation/RSI, splinting. Returns next question or assembles procedure note via Claude on completion. Writes to `note.procedures`.

### `/api/note/section` (PATCH) — ✅ COMPLETE
Updates a specific note section. Supports `set` and `append` operations. Optimistic locking via `note_version`. Handles text sections, array sections, and nested diagnostic_results. Auth-gated.

### `/api/note/finalize` (POST) — ✅ COMPLETE
Polishes accumulated note via Claude Sonnet. Assembles all populated sections, sends to Claude for cleanup, writes `finalized_at` + `generated_note`. Auth-gated.

### `/api/note/status` (GET) — ✅ COMPLETE
Returns badge state (PE, MDM, Dx, Dispo, Orders, Consult, Complete) for all shift encounters without fetching full note content. Auth-gated.

### `/api/shift/close` (POST) — ✅ COMPLETE
Aggregates the shift's memory into the physician's longitudinal record. Called from `endShift()` in `/shift/page.tsx` before flipping shift status to completed. Non-fatal if aggregation fails (the shift still closes). Returns `{ ok, newObservations[] }` — `newObservations` is the list of deltas Robin detected between stated preferences and observed behavior, reserved for a future shift-close reconciliation UI. Auth-gated; ownership-verified.

---

## Tech Debt (TECH_DEBT.md to be created)

### TD-001 — `ScriptProcessorNode` deprecated ⚠️
**Files:** `useDeepgram.ts`, `useShiftAmbient.ts`
**Issue:** `createScriptProcessor(4096, 1, 1)` is deprecated in all major browsers. Works today but is a ticking clock.
**Fix:** Migrate to `AudioWorkletNode`. Requires a separate worklet file registered via `audioContext.audioWorklet.addModule()`.
**Priority:** Medium — before launch, not before MVP.

### TD-003 — Fly.io auto_stop_machines = "stop" ⚠️
**File:** `fly.toml`
**Issue:** `auto_stop_machines = "stop"` can cause cold starts of several seconds mid-shift. For a physician using Robin during an active shift, a cold start is unacceptable.
**Fix:** Change to `auto_stop_machines = "suspend"` — resumes in ~150ms vs. full cold start.
**Priority:** Low for now (min_machines_running = 1 keeps one warm), revisit before multi-physician use.

### TD-002 — Deepgram API key is client-side ✅ RESOLVED
**Fix applied:** `/api/deepgram-token` route generates a 30-second JWT server-side using `DEEPGRAM_API_KEY`.
Client fetches the token before each WebSocket connection; uses `["bearer", token]` subprotocol.
Master API key is now server-side only. Token expires in 30s and carries `usage:write` scope only.

---

## MDM Scaffold Engine — Spec (NEXT BUILD TARGET)

This is Robin's product moat. The goal: proactively tell the physician what MDM complexity their documentation currently supports, what's missing, and what one addition would push them to the next billing tier.

### AMA 2021 E&M Framework (99281–99285)

MDM complexity is determined by the **highest 2 of 3 elements:**

| Element | Straightforward | Low | Moderate | High |
|---|---|---|---|---|
| Problems | 1 self-limited | 1 stable chronic | 1+ new/undiag, 1 acute illness | 1 threat to life/function |
| Data | Minimal/none | Limited | Moderate (3+ data points) | Extensive |
| Risk | Minimal | Low | Moderate (Rx drug mgmt) | High (hospitalization) |

**Target codes:**
- 99283 = Moderate MDM (most common ED visit)
- 99284 = Moderate-High
- 99285 = High MDM (highest ED code)
- 99291 = Critical care (≥30 min)

### Six Most Common Documentation Gaps (from Clinical KB)
1. Missing ROS beyond chief complaint
2. HPI incomplete (<8 elements documented)
3. MDM data: no explicit mention of labs/imaging reviewed
4. Risk not documented (prescription drug management = moderate risk)
5. Absent or vague disposition rationale
6. Missing return precautions

### New Tools to Add to `/api/robin-think`

```typescript
// mdm_complexity_assessment
// Called once. Scores all 3 MDM elements independently.
{
  name: "mdm_complexity_assessment",
  input_schema: {
    problems_complexity: "straightforward" | "low" | "moderate" | "high",
    problems_rationale: string,       // what drove this rating
    data_complexity: "straightforward" | "low" | "moderate" | "high",
    data_rationale: string,
    risk_complexity: "straightforward" | "low" | "moderate" | "high",
    risk_rationale: string,
    overall_mdm: "straightforward" | "low" | "moderate" | "high",  // highest 2-of-3
    supported_code: string,           // e.g. "99284"
    next_code: string | null,         // e.g. "99285" — null if already at max
    one_thing_to_upgrade: string | null  // single most impactful missing element
  }
}

// hpi_completeness
// Scores HPI against the 8 standard elements.
{
  name: "hpi_completeness",
  input_schema: {
    present: string[],    // which of 8 elements are documented
    missing: string[],    // which are absent
    score: number,        // 0–8
    brief_or_extended: "brief" | "extended"  // <4 = brief, 4+ = extended
  }
}
```

### Shift Memory Integration
Pass shift context into `robin-think` by calling `buildRobinContext()` and injecting:
- Physician's coding preferences (from `robin_preferences`)
- Prior encounters this shift and their complexity
- Patterns Robin has observed (from `robin_memory`)

This allows robin-think to say: "You've been documenting your ROS as 'reviewed and negative' all shift — that's not going to fly on audit."

### SSE Migration ✅ COMPLETE (API + UI)
`robin-think` streams SSE events. `encounter/[id]/page.tsx` consumes via `ReadableStream.getReader()` as a concurrent async IIFE (does not block clarification fetch). `RobinInsightsPanel` renders each section progressively as events arrive. State managed via `RobinAuditState` in `robinTypes.ts`.

---

## Product Direction (updated 2026-04-13)

**Headline reframe:** Robin is "the resident on your shoulder" — an attending-level second brain that watches every patient, surfaces relevant clinical frameworks at the right moment, and writes notes as a byproduct. Notes are the price of entry. The product is the second brain.

**Two parallel agentic loops define the product:**

### Loop A — Clinical Decision Support (proactive, panel-only, never voice)
Watch the live transcript. When presentation patterns match clinical rules in the KB, surface the relevant decision tool or differential addition silently in the insights panel. Physician glances over and engages or ignores at will. Interruption cost: zero. Value: high. Moat: structural — only an agentic system with a clinical KB and live transcript awareness can do this, and it requires zero EMR integration. Scribes architecturally cannot follow.

**Two sub-features:**
- **Clinical decision tool surfacing** — pattern-match transcript to KB tools (HEART, PERC, SF Syncope, Canadian CT Head, Ottawa Ankle, NEXUS to start), pre-fill with elements already heard, surface in panel
- **Differential expander** — maintain working differential as encounter unfolds, silently add diagnoses physician hasn't mentioned but should consider, ranked by pretest probability + badness-if-missed

### Loop B — Documentation Completeness (preference-gated, contextual)
Track which required documentation elements exist for each encounter (PE, EKG interpretation, MDM rationale, return precautions, dispo rationale, ROS). Surface what's missing only at natural documentation moments (MDM-dictation-start or end-encounter), never mid-encounter, never as time-based staleness nudges. Preference-gated per category — physicians can disable any reminder type they don't want.

**Killed:** "Pending items as clinical staleness tracker" and the "what am I waiting on" voice query. EM physicians run the board with their eyes; verbalizing pending clinical actions to Robin would be a burden, not a feature. The pending-items construct survives only as a documentation-completeness mechanism, which is a smaller but honest claim.

**Design constraint locked:** Robin's clinical contributions live in the insights panel, not the voice channel. Voice interruptions are reserved for rare can't-miss moments and default off in v1. Visual surfacing in the panel is unlimited because the physician chooses to look or not.

**Pure passive for v1.** No attention cues, no soft pulses, no tones. Log every surfacing event with `engaged | ignored` signal so we can tune v2 from real trial data instead of guessing.

---

## Screens Status

| Screen | Status |
|---|---|
| Login | ✅ Built |
| Shift dashboard | ✅ Built |
| Encounter capture (primary) | ✅ Built |
| Onboarding interview | ✅ Built — Layer 2 |
| Note dashboard (`/shift/notes`) | ✅ Built |
| Single note view (`/shift/notes/[id]`) | ✅ Built — tabs, edit, finalize, copy |
| Physician profile / settings | 🔲 Not started |

---

## Agent Roster

Six agents defined in `/docs/agent-roster.md`. OpenClaw bots not yet created.

| Agent | Role | Runs |
|---|---|---|
| 🎩 Alfred | Claude Code engineering (you) | On-demand |
| 🪶 Wren | Build health monitor | Daily 8am via Telegram |
| 📚 Atlas | Clinical KB currency | Mondays 9am |
| 🧭 Sage | Product velocity | Fridays 5pm |
| ⚖️ Ledger | Compliance & safety | Mondays 9:30am |
| 📣 Echo | Competitor scan | Wednesdays 9am |

**Alfred invocation prompt:**
> "You are Alfred — Robin's Claude Code engineering assistant. Read CLAUDE.md fully before touching anything. Tell me what you plan to change before changing anything."

**Alfred end-of-task protocol (required before every commit):**

After completing any task, before running `git commit`, Alfred must:

1. **Update CLAUDE.md** — reflect any changes to the file map, API route
   status, tech debt register, build priority queue, or database schema.
   Do not rewrite sections that didn't change. Surgical edits only.

2. **Update SESSIONS.md** — add a new entry at the top of the Sessions log.
   Use this format exactly:

   ### YYYY-MM-DD — [short task name]
   **Built:** list of files created or rewritten with one-line description each
   **Fixed:** bugs or tech debt items resolved
   **Decided:** architecture or design decisions made during the task
   **Deferred:** anything explicitly punted and why
   **Next:** what should be done next based on the current build queue

3. **Run `npm run build`** — must pass clean before committing.

4. **Commit message format:**
   `[task-name]: brief description — see SESSIONS.md`

Alfred never skips this protocol. If a task is small (a single line change),
the SESSIONS.md entry is short — but it still exists.

---

## BAA Status (Required Before Real PHI)

| Vendor | BAA Status | Notes |
|---|---|---|
| Fly.io | Outreach in progress | Scale plan required; primary infra BAA |
| **AWS Bedrock** | **Outreach in progress** | **Primary Claude path — Artifact BAA, Sonnet 4 + Haiku 4.5 in us-east-1. See `/docs/bedrock-migration-plan.md`** |
| Supabase | Outreach in progress | Team plan + HIPAA add-on required |
| Deepgram | Reply received 2026-04-14 | Available on paid plan |
| Anthropic (direct) | **Deprioritized** | Two unanswered outreach attempts. Claude for Healthcare routes healthcare BAAs via AWS/GCP/Azure. Kept as parallel track but not blocking. |
| Twilio | Not yet contacted | For voice-callback feature (post-design-partner) |
| ElevenLabs | Not yet contacted | For voice-callback feature (post-design-partner) |

**None signed yet. Do not process real patient data until the minimum set (Fly.io + Bedrock + Supabase + Deepgram) is in place.**

**Strategic shift (2026-04-21):** AWS Bedrock is now the primary Claude path for Robin, not Anthropic direct. Full rationale and migration plan in `/docs/bedrock-migration-plan.md`. Current `@anthropic-ai/sdk` calls will move behind a `src/lib/llmClient.ts` wrapper with an `LLM_PROVIDER` env var so rollback is a single `fly secrets set` away.

---

## Build Priority Queue (updated 2026-04-13)

**Agentic roadmap:** Layer 2 → Layer 1 → Note Dashboard → Layer 3 (see `/docs/robin-agentic-spec.md`)

1. ~~**MDM scaffold engine**~~ ✅ Done — 5-tool SSE pipeline, AMA 2021 scoring, shift memory
2. ~~**SSE migration** for `robin-think`~~ ✅ Done — API streams events; UI consumes via SSE consumer + RobinInsightsPanel rewrite
3. ~~**Deepgram proxy**~~ ✅ Done — key is server-side via `/api/deepgram-token`
4. ~~**Layer 2 — Physician Onboarding Interview**~~ ✅ Done — conversational interview, preferences save, shift redirect, natural language context injection
5. ~~**Layer 1 — Ambient Command**~~ ✅ Done — `/api/agent/act`, `robin_actions` audit table, toast + confirm card, useShiftAmbient wiring
6. ~~**Note Dashboard**~~ ✅ Done — EncounterNote types, 3 API routes, `/shift/notes` + `/shift/notes/[id]`, badges, edit, finalize, copy
7. ~~**Layer 3 — Dashboard & Chart Agency**~~ ✅ Done — state machine, 16 command types, procedure Q&A, undo, passive consult detection, disambiguation + batch PE cards
8. ~~**`runRobinThink` extraction + eval harness**~~ ✅ Done — pure function in `src/lib/robinThink.ts`, `/evals` harness with 3 fixtures, temperature: 0 deterministic mode
9. ~~**Fix `robin-think` clinical coding rules**~~ ✅ Done — added critical care (99291/99292) section, tightened Rx drug mgmt definition (excludes chronic home meds, excludes OTC), added explicit data point counting with worked example, added encounter-specific gap rules (pregnancy/ectopic on female + abd pain, ACS on chest pain, etc.), fixed HPI threshold (score≥4 = extended). Regression: 3/3 fixtures pass deterministically at temp 0.
10. **AudioWorklet migration** — replace deprecated `ScriptProcessorNode` (TD-001)
11. **BAAs** — minimum set (Fly.io + AWS Bedrock + Supabase + Deepgram). Anthropic direct deprioritized per 2026-04-21 pivot.
11a. **AWS Bedrock migration** — `src/lib/llmClient.ts` wrapper + `LLM_PROVIDER` env var + refactor 13 Claude call sites + Bedrock eval parity run (13/13 MDM + 18/18 surfacing + 12/12 differential at temp 0). Gated on AWS model access + Artifact BAA. Full scoping in `/docs/bedrock-migration-plan.md`.
12. ~~**Expand WoZ corpus**~~ ✅ Done — full 13-encounter regression suite, all passing deterministic-with-drift-tolerance at temp 0. Covers: abd pain workup, septic shock, mech LBP, STEMI, stroke+TNK, PE (over-trigger guard), peds OM, elderly mets, ACE-I rash, panic/PE differential, intoxicated head trauma, dental, ankle sprain
13. ~~**Wizard of Oz validation**~~ ✅ Rounds 1–3 done — 13/13 passing; CC fix proven on STEMI + stroke + septic shock; over-trigger guard proven on PE; peds rules don't over-fire; tone test passed on dental drug-seeking nuance; `vague_workup_language` gap added
14. ~~**First trial shift**~~ → see item 22

**Engineering notes for the active sprint:**
- The clinical surfacing engine needs eval fixtures the same way `robinThink` does — trigger cases and non-trigger cases for each tool. Budget a half-day during the sprint. The 13-fixture MDM regression suite was the right investment; the surfacing engine deserves the same treatment from day one, not as a retrofit.
- The `surfacing_events` table is the quiet hero of the trial. It turns the trial shift from a vibes check into a data artifact you can show a medical director. Wire the logging from the very first surfacing event, not as an afterthought — retroactive logging is how you end up with a great trial and no metrics to point at.

**Active sprint — week of April 13:**

15. ~~**Clinical decision tool surfacing engine**~~ ✅ Engine + UI complete (live audio wiring deferred). `src/lib/clinicalSurfacing.ts`, `/api/clinical-surfacing` SSE route, 6 tools with typed per-tool pre-fill, `RobinInsightsPanel` renders surfacings, 18-fixture eval suite at 18/18 PASS deterministic at temp 0, bonus over-fire regression on 13 MDM fixtures shows clean discrimination. Live audio wiring into `useShiftAmbient` lands with item 19 so engagement tracking is wired from day one.
16. ~~**Differential expander**~~ ✅ Engine + UI complete (live audio wiring deferred). `src/lib/differentialExpander.ts`, `/api/differential-expander` SSE route, badness × pretest ranking, cap of 4 adds per call, 12-fixture eval at 12/12 deterministic at temp 0 (6 trigger: PE, SAH, AAA, HELLP, ectopic, dissection; 6 non-trigger: vasovagal, STEMI cath, URI, PE-already-covered, mech back, ankle). `RobinInsightsPanel` renders "Consider also" section below surfaced tools, with badness dot accent per entry.
16.5. ~~**Memory architecture audit + write paths**~~ ✅ Full build shipped across 4 commits. `/docs/memory-architecture.md` + migration 006 + types + `src/lib/memory.ts` helpers + writers in 5 routes + `/api/shift/close` aggregator + typed `translateShiftMemory` / `translateLongitudinal` readers (threshold-gated: `gaps_by_type[x] >= 3` mid-shift, `shifts_observed >= 5` for longitudinal). Preference-vs-longitudinal reconciliation policy documented + delta detection live (em_posture vs coding, gap_sensitivity vs chronic misses). Engagement signals stay 0 until item 19's surfacing_events table — schema forward-compat.
17. **Documentation completeness tracker** — `src/lib/documentationCompleteness.ts`, per-encounter checklist (PE, EKG, MDM, return precautions, dispo, ROS), surfaces at MDM-dictation-start or end-encounter only.
18. **Preferences expansion** — per-category documentation reminder toggles + clinical surfacing aggressiveness toggles. Update `RobinPreferences` interface and `translatePreferences()`. Update onboarding interview to ask the new questions.
19. **Surfacing event logging** — every surfacing event written to a new `surfacing_events` table with `timestamp`, `encounter_id`, `surface_type`, `tool_name | diagnosis_name`, `engaged_at`, `dismissed_at`. Powers v2 tuning + design partner pitch material.

**Week of April 20:**

20. **Sign-out generator** — one-tap, reads from shift state, structured handoff document. Highest-leverage sticky feature, demos in 30 seconds.
21. **Interruption budget / `interruptionPolicy.ts`** — explicit rules for the rare voice-channel interruptions. Default off in v1.
22. **Self-recorded trial shift** — 9-hour, 15–20 encounters, mixed presentations to exercise the surfacing engine. End-to-end pipeline validation. Honest feedback mechanism, not a demo run.
23. **HeyGen founder demo video** — 3–5 min, lead with clinical surfacing + sign-out.
24. **One-pager + sharpened pitch** — reframe around "resident on your shoulder."
25. **Target list of 15–25 independent EM groups.**

**Week of April 27:**

26. **Outbound wave 1.**
27. **First design partner conversation — hard date April 22.**

**BAA paperwork — start today, runs in parallel:**
- Supabase BAA email sent
- Deepgram BAA email sent
- Anthropic Enterprise conversation initiated

**Deferred until post-trial or post-design-partner:**
- AudioWorklet migration (TD-001)
- Post-discharge callback POC (Twilio + ElevenLabs) — moved from "next sprint" to "after design partner signs"; was the wrong call to pull it forward before the surfacing engine
- Mid-shift audit feature
- Voice-channel interruption tier
- Attention cues / soft pulses on the panel
- Physician profile / settings screen polish
- Fly.io suspend mode (TD-003)

---

## What Alfred Must Never Do

- Change design tokens (colors, typography) — locked
- Change the brand tagline
- Add dollar amounts to mid-shift UI — RVUs only until end-of-shift reconciliation
- Process real PHI before BAAs are signed
- Commit to main without running `npm run build` locally first
- Make clinical recommendations in Robin's voice — documentation domain only
- Surface clinical decision tools or differential additions via the voice channel. Panel only. Voice is reserved for rare, preference-gated, can't-miss interruptions and is off by default in v1.
- Add time-based staleness nudges for clinical actions. Robin does not track clinical pending items because EM physicians run the board with their eyes. Documentation completeness only.
- Build documentation reminders that fire mid-encounter. Reminders ride along with natural documentation moments (MDM-dictation-start, end-encounter), never as standalone interruptions.
- Make any documentation reminder non-disableable. Every category must be physician-configurable via preferences.
