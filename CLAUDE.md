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
| LLM | Claude via Anthropic API | `claude-sonnet-4-20250514` throughout |
| Agentic loop | Claude tool-use via `/api/robin-think` | POST today, SSE planned |
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
      /robin-think/route.ts       ← Agentic MDM audit loop (tool-use, POST)
      /robin-chat/route.ts        ← Conversational Robin (streaming, auth-gated)
      /generate-note/route.ts     ← ED H&P note generation
      /detect-encounter/route.ts  ← Encounter boundary detection from ambient buffer
      /clarification-questions/   ← Post-encounter gap clarification
      /parse-patients/            ← Patient briefing parser
    /shift/page.tsx               ← Shift dashboard
    /shift/encounter/[id]/page.tsx ← Encounter capture screen (primary screen)
    /login/page.tsx
  /components
    AudioCapture.tsx              ← Encounter-level audio UI (uses useAudio + useDeepgram)
    RobinChat.tsx                 ← Conversational Robin panel (19KB — substantial)
    ClarificationPanel.tsx        ← Post-encounter clarification Q&A
    NoteOutput.tsx                ← Generated note display + copy to EHR
    RobinInsightsPanel.tsx        ← MDM gap + E&M assessment display
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
    robinPersona.ts               ← ROBIN_IDENTITY + buildRobinContext()
    robinSystemPrompt.ts          ← System prompt for note generation
    robinTypes.ts                 ← RobinInsight type
    /supabase
      client.ts                   ← Browser Supabase client
      server.ts                   ← Server Supabase client
  proxy.ts                        ← Supabase auth middleware — session refresh + /shift route protection. Not a Deepgram proxy.
/supabase/migrations
  001_initial_schema.sql          ← physicians, shifts, encounters + RLS
  002_encounter_demographics.sql  ← age, gender columns
  003_robin_chat.sql              ← Chat history table
/docs
  agent-roster.md                 ← Full agent definitions
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

### `robin_chat` (migration 003)
- Chat history per shift — check migration for exact columns

---

## Memory Architecture (4 Layers)

| Layer | Storage | Fed Into |
|---|---|---|
| Working memory | LLM context window | Every API call |
| Shift memory | `shifts.robin_memory` jsonb | `buildRobinContext()` → robin-chat |
| Physician profile | `physicians.robin_preferences` jsonb | `buildRobinContext()` → robin-chat |
| Clinical KB | `robinSystemPrompt.ts` (static) | `generate-note`, `robin-think` |

**Current gap:** `robin-think` does NOT receive shift memory or physician profile. It only gets `transcript`, `chiefComplaint`, `disposition`. This is the primary architecture gap to fix.

---

## API Routes — Current Status

### `/api/robin-think` (POST) — ⚠️ PARTIAL
The MDM audit agentic loop. Functional but incomplete.

**Current tools:** `note_gap`, `em_assessment`, `ready`
**Working:** Flags 2–3 documentation gaps, estimates E&M code, iterates up to 8 rounds
**Missing:**
- SSE streaming (currently blocking POST — insights can't appear progressively)
- MDM scaffold engine (the product moat — see spec below)
- Shift memory context (isolated from `buildRobinContext`)
- AMA 2021 MDM decision logic (complexity of problems, data reviewed, risk)

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

### SSE Migration
Convert `robin-think` from blocking POST to SSE so insights stream to the UI progressively.
Pattern: same as `robin-chat` stream — `ReadableStream` + `text/event-stream` headers.
UI should render each insight card as it arrives, not wait for the full response.

---

## Screens Status

| Screen | Status |
|---|---|
| Login | ✅ Built |
| Shift dashboard | ✅ Built |
| Encounter capture (primary) | ✅ Built |
| Post-encounter note review | 🔲 Spec exists, not built |
| Robin agent panel | 🔲 Spec exists, not built |
| Physician profile / settings | 🔲 Not started |
| Onboarding / shift activation | 🔲 Not started |

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

---

## BAA Status (Required Before Real PHI)

| Vendor | BAA Status |
|---|---|
| Supabase | Available (HIPAA-eligible plan required) |
| Anthropic | Available (Enterprise plan) |
| Deepgram | Available |
| Twilio | Available |
| ElevenLabs | Available |

**None signed yet. Do not process real patient data until all BAAs are in place.**

---

## Build Priority Queue

1. **MDM scaffold engine** — new tools in `robin-think`, AMA 2021 logic, shift memory injection
2. **SSE migration** for `robin-think` — progressive insight streaming
3. **AudioWorklet migration** — replace deprecated `ScriptProcessorNode`
4. **Deepgram proxy** — move key server-side before real PHI
5. **Post-encounter note review screen** — Note/MDM/Billing tabs, E&M badge, copy to EHR
6. **Robin agent panel** — open items, observations feed, RVU snapshot
7. **OpenClaw bots** — Wren, Atlas, Ledger, Echo, Sage via Telegram
8. **BAAs** — all five vendors
9. **Wizard of Oz validation** — Rode mic + Voice Memos + manual Claude run
10. **First trial shift**

---

## What Alfred Must Never Do

- Change design tokens (colors, typography) — locked
- Change the brand tagline
- Add dollar amounts to mid-shift UI — RVUs only until end-of-shift reconciliation
- Process real PHI before BAAs are signed
- Commit to main without running `npm run build` locally first
- Make clinical recommendations in Robin's voice — documentation domain only
