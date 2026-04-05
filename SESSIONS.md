# SESSIONS.md — Robin Build Log
<!-- Alfred: update this file at the end of every task, before committing. -->

## How to update
Add a new entry at the top of the Sessions log (reverse chronological).
Keep each entry tight — 5–10 lines max. This is a log, not documentation.

---

## Sessions

### 2026-04-05 — Layer 3: Dashboard & Chart Agency
**Built:**
- `/src/app/api/agent/act/route.ts` — full rewrite: expanded from 2 to 16 command types (PE, EKG, MDM, ED course, orders, labs, radiology, discharge instructions, final diagnosis w/ ICD-10, consults, encounter update, voice undo, voice remove). Encounter resolution logic (name/room/number/recency fuzzy match). All writes go through living note + robin_actions audit
- `/src/app/api/agent/undo/route.ts` — restores previous_state from robin_actions; supports note section, encounter field, and encounter deletion undos; redo = undo the undo
- `/src/app/api/agent/procedure-qa/route.ts` — KB-driven Q&A for 5 procedures (sedation, lac repair, I&D, intubation, splinting); assembles procedure note via Claude on completion
- `/src/hooks/useShiftAmbient.ts` — state machine (ambient/dictating/qa_session), 15+ voice command pattern matchers, passive consult detection, dictation buffer, endDictation/endQASession callbacks
- `/src/components/DisambiguationCard.tsx` — "Which encounter?" push-button card
- `/src/components/BatchPECard.tsx` — multi-patient PE dictation card with done states

**Decided:**
- All Layer 3 commands route through single `/api/agent/act` gateway — no per-command routes
- Encounter resolution defaults to most recently created if no match found
- Passive consult detection runs on every final transcript segment (no wake word)
- Dictation buffer is separate from ambient transcript buffer (spec requirement: prevents MDM re-analysis)
- Dual Deepgram connection deferred to WoZ testing — state machine transitions are ready, actual second WebSocket needs real audio validation

**Deferred:**
- Dual Deepgram dictation connection — framework ready, actual WebSocket open/close needs WoZ
- Silence timeout tuning (6s proposed) — WoZ before hardcoding
- Procedure Q&A voice-only vs hybrid — WoZ decision
- Structured MDM preview card render location — WoZ decision

**Next:**
- WoZ validation — full pipeline: Voice Memos → transcript → voice commands → note output
- AudioWorklet migration (TD-001)
- BAA conversations

### 2026-04-05 — Note Dashboard: Living Note Architecture
**Built:**
- `/src/lib/robinTypes.ts` — added EncounterNote, NoteSection, OrderEntry, EKGEntry, RadiologyEntry, LabResultEntry, ProcedureEntry, EDCourseEntry, ConsultEntry, NoteBadge, computeNoteBadges(), createEmptyNote()
- `/supabase/migrations/005_note_dashboard.sql` — `note` jsonb + `note_version` integer on encounters
- `/src/app/api/note/section/route.ts` — PATCH: update any note section (text set/append, array push, nested diagnostic_results), optimistic locking via note_version
- `/src/app/api/note/finalize/route.ts` — POST: assembles all sections, Claude Sonnet polish, writes finalized_at + generated_note
- `/src/app/api/note/status/route.ts` — GET: badge state for all shift encounters (PE, MDM, Dx, Dispo, Orders, Consult, Complete)
- `/src/app/shift/notes/page.tsx` — encounter list with completion badges, time-ago, draft/finalized status, section counts
- `/src/app/shift/notes/[id]/page.tsx` — single note view: 13 sections in scroll, 3 tabs (note/billing/discharge), per-section edit, finalize button, copy-to-clipboard

**Decided:**
- Note initialized lazily on first section write (not on encounter create) — avoids empty jsonb bloat
- computeNoteBadges() is a pure function in robinTypes.ts — shared by API and client
- Finalization writes to both note.finalized_at AND encounters.generated_note for backward compat with existing NoteOutput component

**Next:**
- Layer 3: state machine, dictation sessions, voice command taxonomy

### 2026-04-05 — Layer 1: Ambient Command
**Built:**
- `/supabase/migrations/004_layer1_ambient_command.sql` — robin_actions audit table + encounter columns (created_by_robin, disposition, accepting_physician, patient_name)
- `/src/app/api/agent/act/route.ts` — command gateway for patient_briefing + disposition; Claude Haiku parse, confidence scoring, auto/confirm tier (0.7 threshold), DB write + audit log
- `/src/components/RobinToast.tsx` — inline action confirmation toast with auto-dismiss, fade animation
- `/src/components/ConfirmCard.tsx` — uncertain parse confirmation card (amber styling, confirm/dismiss buttons)
- `/src/hooks/useShiftAmbient.ts` — extended with agent/act integration: fires POST on briefing detection, exposes pendingAction/pendingConfirmation state, setShiftId, confirmAction
- `/src/app/shift/page.tsx` — wired toast + confirm card, auto-refresh encounter list on agent action, shiftId sync to ambient hook

**Decided:**
- Haiku for parse (fast, cheap) — briefing + disposition parsing don't need Sonnet
- pendingBriefing kept for backward compat; agent/act fires in parallel
- Confirm threshold at 0.7 — below that, physician must tap Confirm
- robin_actions logs previous_state on every write for undo capability (Layer 3)

**Deferred:**
- Disposition detection from ambient (no wake word trigger yet — requires Layer 3 state machine)
- Undo route (/api/agent/undo) — Layer 3 deliverable

**Next:**
- Note Dashboard — living note architecture, /shift/notes routes
- Layer 3 — state machine, dictation sessions, voice command taxonomy

### 2026-04-05 — Layer 2: Physician Onboarding Interview
**Built:**
- `/src/lib/robinTypes.ts` — added `RobinPreferences` interface (11 fields + specialty_flags + metadata)
- `/src/app/api/onboarding-interview/route.ts` — streaming interview chat, ROBIN_IDENTITY + interview system prompt, 8 question areas, JSON block output on completion
- `/src/app/api/physician/preferences/route.ts` — auth-gated POST, saves preferences to `physicians.robin_preferences`
- `/src/app/onboarding/page.tsx` — full-screen interview UI, streaming chat, JSON block detection, auto-redirect to /shift after save
- `/src/app/shift/page.tsx` — added onboarding redirect check on mount (empty preferences → /onboarding)
- `/src/lib/robinPersona.ts` — added `translatePreferences()`, replaces raw key:value dump with natural language directives in buildRobinContext()

**Decided:**
- New dedicated onboarding component (~230 lines) instead of reusing RobinChat (530 lines of shift-specific complexity)
- Client-side redirect in shift page, not middleware (proxy.ts not wired as active Next.js middleware)
- No new migration needed — `robin_preferences` JSONB column already exists from migration 003
- JSON block stripped from displayed chat text, replaced with teal "Preferences saved" confirmation card

**Deferred:**
- Re-interview from /settings — clear `robin_preferences` in Supabase console to re-trigger for now
- Voice input during onboarding — text-only for v1
- interview_version bump re-trigger logic — open question in spec

**Next:**
- Browser test the full 8-question interview flow
- Layer 1: Ambient Command → /api/agent/act + robin_actions audit table

### 2026-04-03 — MDM Scaffold Engine + UI Wiring
**Built:**
- `/src/app/api/robin-think/route.ts` — full rewrite: blocking POST → SSE,
  5 tools (hpi_completeness, mdm_complexity_assessment, note_gap, em_assessment, ready),
  shift memory injection via buildRobinContext(), server-side AMA 2021 MDM validation,
  DB persist to encounters.mdm_data on ready
- `/src/lib/mdmScoring.ts` — new file, pure AMA 2021 scoring functions
- `/src/lib/robinTypes.ts` — added MDMComplexity, MDMScaffold, HPICompleteness,
  HPIElement, MDMElementScore, RobinAuditState
- `/src/components/RobinInsightsPanel.tsx` — full rewrite, progressive SSE rendering,
  Robin design tokens, 5 sections: Header, HPI, MDM, Gaps, E&M
- `/src/app/shift/encounter/[id]/page.tsx` — replaced blocking robin-think fetch
  with SSE consumer IIFE, added encounterId + shiftId to request body,
  replaced robinInsights state with robinAudit: RobinAuditState

**Fixed:**
- TD-002 resolved: Deepgram API key moved server-side via /api/deepgram-token
  using Deepgram /v1/auth/grant (30s TTL), both audio hooks updated
- proxy.ts correctly identified as Supabase auth middleware, not a Deepgram proxy

**Decided:**
- RobinAuditState defined in robinTypes.ts, not inline in page component
- deriveOverallMDM() runs server-side to validate Claude's MDM output independently
- SSE runs concurrently with clarification-questions fetch, not inside Promise.allSettled

**Deferred:**
- Wizard of Oz validation — run one real encounter through robin-think before
  building more UI
- TD-001 AudioWorklet migration — before launch, not before MVP
- TD-003 fly.toml suspend mode — before multi-physician use
- Post-encounter note review screen (#5 in queue)
- BAA conversations — Supabase and Deepgram first, Anthropic Enterprise takes longer

**Next:**
- Wizard of Oz test — Voice Memos → transcript → curl robin-think → read output
- Post-encounter note review screen once WoZ confirms MDM accuracy
