# SESSIONS.md — Robin Build Log
<!-- Alfred: update this file at the end of every task, before committing. -->

## How to update
Add a new entry at the top of the Sessions log (reverse chronological).
Keep each entry tight — 5–10 lines max. This is a log, not documentation.

---

## Sessions

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
