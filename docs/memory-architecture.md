# Memory Architecture — Audit + Proposed Design

<!-- Alfred: this is the design artifact for build queue item 16.5.
     Review with user before any code lands. Last updated: 2026-04-14. -->

## TL;DR

Robin has three memory tiers today, plus one proposed fourth tier:

| Tier | Storage | Scope | Writers today | Writers proposed |
|---|---|---|---|---|
| 1 | `encounters.mdm_data` (jsonb) | Encounter | robin-think, agent/act, encounter page | + clinical-surfacing, + differential-expander |
| 2 | `shifts.robin_memory` (jsonb) | Shift | **none** | robin-think, clinical-surfacing, differential-expander, agent/act, note-finalize |
| 3a | `physicians.robin_preferences` (jsonb) | Longitudinal — stated intent | onboarding interview | unchanged |
| 3b | `physicians.robin_longitudinal` (jsonb, **new**) | Longitudinal — observed behavior | — | new `/api/shift/close` aggregator |

Two rules govern interaction between the tiers:

1. **Preferences always win for surfacing behavior.** Robin never mid-shift overrides the physician's stated intent based on observed patterns.
2. **Longitudinal informs content, not behavior.** When Robin does fire, longitudinal shapes what it says. Deltas between intent and behavior surface only at explicit reconciliation moments (shift close, settings).

---

## 1. Current state audit

### 1.1 Tier 1 — `encounters.mdm_data` (encounter-level)

**Schema today:** jsonb column, default `{}`. Defined in `001_initial_schema.sql` line 76.

**Writers observed:**

| Source | Write | File:line |
|---|---|---|
| robin-think `onReady` | full MDMData object — `{ hpi, mdm_scaffold, note_gaps[], em_assessment, summary }` | [api/robin-think/route.ts:62](robin/src/app/api/robin-think/route.ts:62) |
| agent/act (disposition handler) | `pre_fill: { diagnosis }` — merged with existing mdm_data | [api/agent/act/route.ts:389](robin/src/app/api/agent/act/route.ts:389) |
| encounter page (client) | `clarificationAnswers` — merged with existing mdm_data | [shift/encounter/[id]/page.tsx:302](robin/src/app/shift/encounter/[id]/page.tsx:302) |

**Readers observed:**

| Source | Read | File:line |
|---|---|---|
| encounter page | `clarificationAnswers` hydration | [shift/encounter/[id]/page.tsx:104](robin/src/app/shift/encounter/[id]/page.tsx:104) |
| notes detail page | raw JSON display | [shift/notes/[id]/page.tsx:619](robin/src/app/shift/notes/[id]/page.tsx:619) |
| agent/act, agent/undo | fetched as part of encounter state | various |

**Audit findings:**
- No typed schema. Writers merge loose keys into jsonb. Risk of silent collisions as more writers land.
- `clinical-surfacing` does not persist anywhere today. `ClinicalToolSurfacing.surface_id` was designed for forward-compat with item 19's `surfacing_events` table, but the encounter-level rollup has no home.
- `differential-expander` (not built yet) has no home planned.

### 1.2 Tier 2 — `shifts.robin_memory` (shift-level)

**Schema today:** jsonb column, default `{}`. Defined in `003_robin_chat.sql` line 28.

**Writers observed:** **zero.** Grep across `src/` finds zero `update` or `insert` calls that touch `robin_memory`.

**Readers observed:**

| Source | Read | File:line |
|---|---|---|
| `buildRobinContext()` | loose `Object.entries` dump into "SHIFT OBSERVATIONS" block of system prompt | [robinPersona.ts:194](robin/src/lib/robinPersona.ts:194) |

**Audit findings:**
- The tier is effectively vestigial. Every shift's `robin_memory` is `{}` in production.
- The reader is structure-free (`Object.entries`) — whatever keys land get printed. This means we can ship a typed schema without breaking the read path, but we should upgrade the reader to a typed translator.
- `buildRobinContext()` is called by robin-think, robin-chat, clinical-surfacing, and onboarding-interview. Any shift memory we write shows up in ALL four contexts. Positive: consistency. Risk: noisy observations bleed into conversational Robin.

### 1.3 Tier 3a — `physicians.robin_preferences` (longitudinal, stated intent)

**Schema today:** `RobinPreferences` interface, 11 fields + `specialty_flags`, in [robinTypes.ts:180](robin/src/lib/robinTypes.ts:180). Column defined in `003_robin_chat.sql` line 24.

**Writers observed:**

| Source | Write | File:line |
|---|---|---|
| `/api/physician/preferences` | full object overwrite on onboarding save | [api/physician/preferences/route.ts:29](robin/src/app/api/physician/preferences/route.ts:29) |

**Readers observed:**

| Source | Read | File:line |
|---|---|---|
| `buildRobinContext()` via `translatePreferences()` | converts to natural-language directives | [robinPersona.ts:191](robin/src/lib/robinPersona.ts:191) |
| `/shift/page.tsx` | empty-check for onboarding redirect | [shift/page.tsx:95](robin/src/app/shift/page.tsx:95) |

**Audit findings:**
- Working as designed. Stated-intent tier with a single write point is the right shape.
- No changes proposed. All delta-driven updates go through the **reconciliation** flow described in §5, not by silently mutating this column.

### 1.4 Tier 3b — `physicians.robin_longitudinal` (longitudinal, observed behavior)

**Does not exist yet. This is the proposed new column.**

Rationale for separating from `robin_preferences`:
- Preferences are stated intent from the onboarding interview. They should never be overwritten by Robin's observations, or the reader can't trust what the physician originally said.
- Longitudinal is Robin's observation log. It's append-mostly and grows over time.
- Mixing them puts the onboarding re-interview at risk of overwriting behavior history.

### 1.5 Orphan: `shifts.summary`

`shifts.summary` (jsonb) exists from `001_initial_schema.sql` line 50. Zero writers, zero readers.

**Proposal:** leave in place (no migration cost), document as deprecated in this doc, do not use. If a future shift-close summary feature wants a structured object distinct from `ShiftMemory`, we can revive it. For now, `ShiftMemory.encounters_this_shift[]` serves the purpose.

---

## 2. Proposed schemas

All types land in `src/lib/robinTypes.ts`. Each tier gets a `version` field to enable forward migration without a SQL column change.

### 2.1 Tier 1 — encounter-level

```typescript
export interface EncounterMemory {
  // From robin-think onReady (existing)
  hpi?: HPICompleteness;
  mdm_scaffold?: MDMScaffold;
  note_gaps?: NoteGap[];
  em_assessment?: EMAssessment;
  summary?: string;

  // From clinical-surfacing (NEW — currently not persisted)
  surfacings?: ClinicalToolSurfacing[];

  // From differential-expander (NEW, item 16)
  differentials?: DifferentialAddition[];

  // From agent/act disposition handler (existing)
  pre_fill?: { diagnosis?: string };

  // From encounter page (existing)
  clarificationAnswers?: ClarificationAnswer[];

  version: 1;
}
```

**Migration note:** existing `mdm_data` rows in production (if any) don't have a `version` field. Readers tolerate absence and treat as `version: 1`. No backfill needed.

**Engagement signals are NOT stored here.** They belong in item 19's `surfacing_events` append-only table. Encounter-level memory is what Robin thinks *about* the encounter, not user interactions with the panel.

### 2.2 Tier 2 — shift-level

```typescript
export interface ShiftMemory {
  // Per-encounter rollups (upsert on each robin-think ready)
  encounters_this_shift: Array<{
    encounter_id: string;
    chief_complaint: string;
    code: string | null;
    overall_mdm: MDMComplexity | null;
    gaps_flagged: string[];       // gap_types
    gaps_addressed: string[];     // gap_types (populated on note finalize)
    surfacings_shown: Array<{ surface_id: string; tool_name: ClinicalToolName }>;
    differentials_shown: Array<{ surface_id: string; diagnosis: string }>;
    finalized_at: string | null;
    last_updated_at: string;
  }>;

  // Observed patterns (updated as detected)
  observed_patterns: {
    dictation_style?: "batch_pe" | "per_encounter";
    vague_workup_language_count: number;
    critical_care_count: number;
  };

  // Rolling tallies — power mid-shift commentary
  tally: {
    gaps_by_type: Record<string, number>;
    surfacings_by_tool: Partial<Record<ClinicalToolName, number>>;
    codes_distribution: Record<string, number>;
  };

  version: 1;
}
```

**Noise control:** `buildRobinContext()` only surfaces shift-memory observations to the prompt when they cross a signal threshold (e.g. `gaps_by_type[x] >= 3`). Low-count observations are stored but silent. Thresholds live in a single module so they're tunable.

### 2.3 Tier 3b — longitudinal (new column)

```typescript
export interface RobinLongitudinal {
  shifts_observed: number;
  encounters_observed: number;

  coding_distribution: {
    counts: Record<string, number>;
    critical_care_rate: number;    // pct of shifts with ≥1 CC encounter
  };

  chronically_missed_gaps: Array<{
    gap_type: string;
    miss_rate: number;             // flagged-but-not-addressed rate across finalized notes
    encounter_count: number;
    last_seen: string;
  }>;

  tool_engagement: Partial<Record<ClinicalToolName, {
    surfaced_count: number;
    engaged_count: number;         // sourced from item 19's surfacing_events when it lands
    engagement_rate: number;
  }>>;

  differential_engagement: {
    added_count: number;
    engaged_count: number;         // physician subsequently mentions the added dx in transcript
  };

  agent_act_patterns: {
    batch_pe_shift_count: number;
    per_encounter_shift_count: number;
  };

  // Pending delta observations — surface at shift close or settings
  pending_observations: Array<{
    id: string;
    observation: string;           // "You set ekg_normal_verbosity=full but dictated impression_only 8/10 times."
    flagged_at: string;
    resolved_at: string | null;
    resolution: "updated_preference" | "dismissed" | null;
  }>;

  last_aggregated_at: string;
  version: 1;
}
```

**Aggregation threshold:** tool engagement rates and chronic gap miss rates only surface to behavior/content when `shifts_observed >= 5`. Below that, the data is stored but silent. Prevents early-shift noise from shaping the product before Robin has real signal.

---

## 3. Write paths

Each write path lands in a helper module `src/lib/memory.ts` so routes stay thin. Signature sketch:

```typescript
// src/lib/memory.ts
export async function upsertEncounterInShiftMemory(
  supabase, shiftId, encounterRollup: ShiftMemory["encounters_this_shift"][0]
): Promise<void>;

export async function incrementShiftTally(
  supabase, shiftId, path: "gaps_by_type" | "surfacings_by_tool" | "codes_distribution", key: string
): Promise<void>;

export async function setShiftPattern(
  supabase, shiftId, key: keyof ShiftMemory["observed_patterns"], value: unknown
): Promise<void>;

export async function aggregateShiftToLongitudinal(
  supabase, shiftId, physicianId
): Promise<void>;
```

All helpers use `select → modify → update` (race-tolerant — one physician per shift, concurrency is sub-human). No optimistic versioning on shift memory — the worst case is losing a tally increment, which is acceptable.

### 3.1 `robin-think` — onReady callback

Extend existing `onReady` in [api/robin-think/route.ts:59](robin/src/app/api/robin-think/route.ts:59):

```typescript
onReady: async (mdmData) => {
  // existing:
  await supabase.from("encounters").update({ mdm_data: mdmData }).eq("id", encounterId);
  // new:
  await upsertEncounterInShiftMemory(supabase, shiftId, {
    encounter_id: encounterId,
    chief_complaint: chiefComplaint,
    code: mdmData.em_assessment?.code ?? null,
    overall_mdm: mdmData.mdm_scaffold?.overall_mdm ?? null,
    gaps_flagged: (mdmData.note_gaps ?? []).map(g => g.gap_type),
    gaps_addressed: [],
    surfacings_shown: [],
    differentials_shown: [],
    finalized_at: null,
    last_updated_at: new Date().toISOString(),
  });
  for (const g of mdmData.note_gaps ?? []) {
    await incrementShiftTally(supabase, shiftId, "gaps_by_type", g.gap_type);
  }
  if (mdmData.em_assessment?.code) {
    await incrementShiftTally(supabase, shiftId, "codes_distribution", mdmData.em_assessment.code);
  }
  // observed_patterns
  const vague = (mdmData.note_gaps ?? []).filter(g => g.gap_type === "vague_workup_language").length;
  if (vague > 0) {
    // increment observed_patterns.vague_workup_language_count by `vague`
  }
};
```

### 3.2 `clinical-surfacing` — new persistence

Currently [api/clinical-surfacing/route.ts](robin/src/app/api/clinical-surfacing/route.ts) does not write to Supabase at all. Add a `surfacing_done` side-effect:

```typescript
// In route.ts, wrap onEvent:
onEvent: async (e) => {
  send(e.type, e.data);
  if (e.type === "clinical_tool_surfaced") {
    const s = e.data as ClinicalToolSurfacing;
    await appendEncounterSurfacing(supabase, encounterId, s);   // writes to encounters.mdm_data.surfacings
    await appendShiftMemorySurfacing(supabase, shiftId, encounterId, s);
    await incrementShiftTally(supabase, shiftId, "surfacings_by_tool", s.tool_name);
  }
}
```

`runClinicalSurfacing()` stays pure — the route owns persistence. This matches the existing robin-think pattern.

### 3.3 `differential-expander` (item 16) — new persistence

Same pattern as clinical-surfacing. Build differential-expander first with no persistence (to let the engine stabilize on fixtures), then wire these calls in the same commit that wires clinical-surfacing persistence.

### 3.4 `agent/act` — pattern detection

Add a single `setShiftPattern` call in the batch-PE and sequential-PE handlers:

```typescript
// In physical_exam handler, after successful write:
await setShiftPattern(supabase, shiftId, "dictation_style",
  isBatchPE ? "batch_pe" : "per_encounter"
);
```

Most recent write wins (physician behavior can shift within a shift). Longitudinal aggregator at shift close tracks the distribution.

### 3.5 `/api/note/finalize` — gaps_addressed backfill

When a note is finalized, scan the finalized text for each `gaps_flagged` gap_type and mark it addressed if the relevant content is now present. Keeps the flagged → addressed picture honest for longitudinal chronic-gap tracking.

Lightweight impl: heuristic string match on gap-specific phrases (e.g. `gap_type === "return_precautions"` → look for "return for" / "worsening" / "when to return"). Good enough for longitudinal signal; not clinical.

### 3.6 `/api/shift/close` — new route, shift→longitudinal aggregator

New route: `src/app/api/shift/close/route.ts`. POST-only. Auth-gated.

Called from `endShift()` at [shift/page.tsx:303](robin/src/app/shift/page.tsx:303):

```typescript
async function endShift() {
  if (!activeShift) return;
  ambient.stopListening();
  await fetch("/api/shift/close", { method: "POST", body: JSON.stringify({ shiftId: activeShift.id }) });
  // existing status+ended_at update stays — route does the aggregation, UI does the flag flip
  ...
}
```

Route body: `aggregateShiftToLongitudinal(supabase, shiftId, physicianId)`. The helper:
1. Reads the full `shifts.robin_memory`
2. Reads current `physicians.robin_longitudinal` (or initializes if null)
3. Increments `shifts_observed`, `encounters_observed`
4. Merges code distribution, tool engagement, gap miss rates
5. Detects new pending observations (intent/behavior deltas — see §5)
6. Writes back to `physicians.robin_longitudinal`

No engagement signals yet — those land when item 19's `surfacing_events` table ships. `tool_engagement.engaged_count` stays 0 until then; the schema is forward-compat.

---

## 4. Read paths

### 4.1 Existing — no changes to entry point

All four consumers of shift context continue to call `buildRobinContext()`. The function itself gets extended.

### 4.2 `buildRobinContext()` extensions

Replace the current `Object.entries(memory)` dump in [robinPersona.ts:194-200](robin/src/lib/robinPersona.ts:194) with a typed translator:

```typescript
// src/lib/robinPersona.ts
function translateShiftMemory(memory: ShiftMemory | null): string {
  if (!memory) return "";
  const lines: string[] = [];

  // Only surface observations above signal threshold
  for (const [gapType, count] of Object.entries(memory.tally.gaps_by_type)) {
    if (count >= 3) lines.push(`- You've flagged ${humanize(gapType)} ${count}x this shift`);
  }
  if (memory.observed_patterns.dictation_style === "batch_pe") {
    lines.push("- Dictation style this shift: batch PE (multiple patients at once)");
  }
  if (memory.observed_patterns.critical_care_count >= 1) {
    lines.push(`- ${memory.observed_patterns.critical_care_count} critical care encounter(s) this shift`);
  }
  // ... etc

  if (lines.length === 0) return "";
  return `\nSHIFT OBSERVATIONS:\n${lines.join("\n")}`;
}

function translateLongitudinal(l: RobinLongitudinal | null, prefs: RobinPreferences | null): string {
  if (!l || l.shifts_observed < 5) return "";  // threshold gate
  const lines: string[] = [];
  for (const gap of l.chronically_missed_gaps) {
    if (gap.miss_rate > 0.3) lines.push(`- Chronic miss: ${humanize(gap.gap_type)} (${Math.round(gap.miss_rate * 100)}% of encounters)`);
  }
  // ... tool engagement patterns, etc.
  if (lines.length === 0) return "";
  return `\nLONGITUDINAL OBSERVATIONS (across ${l.shifts_observed} shifts):\n${lines.join("\n")}`;
}
```

Add `robin_longitudinal` to the physician select in [robinPersona.ts:136](robin/src/lib/robinPersona.ts:136).

### 4.3 Panel surfacing (mid-shift read)

Insights panel does not need direct access to shift memory. All signal flows through Robin's prompt. If item 17 (doc completeness tracker) wants direct access later, it can `select` the column; that's a per-feature decision.

---

## 5. Preference ↔ Longitudinal reconciliation

### 5.1 Rules

| Category | Rule |
|---|---|
| Behavior (what Robin surfaces) | Preference always wins. Longitudinal never overrides. |
| Content (what Robin says when it does fire) | Longitudinal informs content in the moment. Preference shapes tone/verbosity. |
| Mid-shift | No delta surfacing. Reconciliation moments only. |
| Reconciliation moments | Shift close screen; physician-opened settings screen. |
| Delta detection threshold | `shifts_observed >= 5` AND delta magnitude meaningful (see §5.3). |

### 5.2 Four interaction categories

**Complementary.** Prefs: conservative E&M. Longitudinal: average 4/8 HPI elements. These compose — preference sets posture, longitudinal informs detail. No conflict. No UI surface.

**Soft delta.** Prefs: `gap_sensitivity: low`. Longitudinal: return precautions missed on 40% of discharges. Stored as a `pending_observation` on next shift close. Never overrides the preference mid-shift. Physician decides at close whether to update.

**Hard contradiction.** Prefs: `ekg_normal_verbosity: impression_only`. Longitudinal: physician dictates full structured reads 8/10 times. Handled identically to soft delta — shift-close `pending_observation`. Preference continues to govern Robin's behavior until physician resolves.

**Observation without counterpart.** "You dictate PE batch-style for 3+ patients at a time." No preferences field for this. Stored in longitudinal; informs Robin's receptivity to batch patterns without physician action needed. No delta, no UI surface.

### 5.3 Delta detection

Hardcoded mapping (one entry per `RobinPreferences` field that has an observable behavior counterpart):

```typescript
// src/lib/memory.ts
const DELTA_RULES: DeltaRule[] = [
  {
    pref_field: "ekg_normal_verbosity",
    observed_path: "<derived from note.diagnostic_results.ekgs stats>",
    comparator: (pref, observed) => /* returns observation string if delta else null */,
  },
  // em_posture (conservative vs aggressive) compared to coding_distribution
  // gap_sensitivity compared to chronically_missed_gaps (low + high miss rate = real risk)
  // note_verbosity compared to average generated_note length
];
```

Rules fire only when `shifts_observed >= 5`. Observations are minted with unique IDs so we don't re-surface the same delta on subsequent shift closes until the physician dismisses or resolves.

### 5.4 Reconciliation UI (deferred — not in this build)

End-of-shift screen lists any new unresolved `pending_observations`. Each has: observation text, three buttons (Update preference / Dismiss / Remind me later), and a learn-more expander. Settings screen (whenever it ships) has the full list.

This doc covers the data layer only. UI work is a separate task and can land whenever the shift-close screen gets built.

---

## 6. Implementation order

1. **Migration 006** — `physicians.robin_longitudinal` jsonb column, `default '{}'`. No indexes needed yet.
2. **Types** — `ShiftMemory`, `RobinLongitudinal`, `DifferentialAddition`, `EncounterMemory` (optional — the other writers don't strictly need the type yet, but helpful) in `src/lib/robinTypes.ts`.
3. **Helpers** — `src/lib/memory.ts` with the five helper functions.
4. **Wire robin-think** — extend `onReady` to upsert shift memory + increment tallies.
5. **Wire clinical-surfacing** — persist surfacings to encounter + shift memory.
6. **Wire differential-expander** — done as part of item 16's build, not retrofitted.
7. **Wire agent/act** — single `setShiftPattern` call in PE handler.
8. **Wire note-finalize** — `gaps_addressed` backfill on finalize.
9. **New `/api/shift/close` route** — aggregation + delta detection.
10. **Update `endShift()`** — call the new route before the existing status flip.
11. **Update `buildRobinContext()`** — typed translators + threshold gates.
12. **Smoke test** — eval harness doesn't cover this; plan a manual browser test with seed data, and write a small Node script that exercises `aggregateShiftToLongitudinal` against a fixture shift.

Items 1–3 can land in one commit (schema). Items 4–8 can each land independently as writer patches. Items 9–11 land together (aggregator + reader). Recommend **three commits**:
- C1: migration + types + helpers
- C2: all writers (4–8)
- C3: aggregator + reader wiring

Differential expander (item 16) lands **between C1 and C2** so it can be wired into the writer pass in C2.

---

## 7. Open questions

1. **`shifts.summary`** — deprecate in this doc? Keep the column, just never use it. Nothing to do.
2. **Race tolerance.** Current plan is race-tolerant (lost-write on tally increments = acceptable). Any reason to tighten? I don't see one for single-physician-per-shift concurrency, but flagging.
3. **Heuristic gap-addressed detection** in note finalize — is heuristic string match acceptable for longitudinal signal, or do we want a Claude call? Heuristic is cheap and good enough for "did this gap get mentioned in the finalized note"; upgrading to Claude is easy later.
4. **Delta detection rules for `em_posture`** — need a clean mapping from coding distribution to "conservative vs aggressive" actual behavior. Propose: compute `avg_code` weighted (99281=1, 99282=2, …, 99285=5, 99291=6) and compare to prefs bucket. Can refine once we have real data.
5. **Preference re-interview flow** — not in scope for 16.5, but note: the current onboarding redirect in [shift/page.tsx:95](robin/src/app/shift/page.tsx:95) checks for empty prefs. If a physician dismisses a delta at shift close, we need somewhere durable to record "they were asked and declined." `pending_observations.resolution` captures this at the individual-observation level.

---

## 8. What this audit does NOT cover

- **Item 19 — `surfacing_events` table.** Append-only event log for every surfaced tool/ddx with engagement signal. Separate table, separate build. The schemas in this doc include forward-compat hooks (`surface_id`, `engaged_count`) so engagement wiring is a slot-in, not a retrofit.
- **Item 17 — Documentation completeness tracker.** Reads from `encounters.note` directly. The shift memory from this design can feed it (e.g. per-encounter gap status), but the tracker's own surface is a separate spec.
- **Item 18 — Preferences expansion.** When new preference fields are added, each needs a delta rule in `DELTA_RULES` if it has an observable counterpart. Trivial to extend.
- **Reconciliation UI.** Data layer only here. End-of-shift screen and settings screen are separate builds.
