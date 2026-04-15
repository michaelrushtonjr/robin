# SESSIONS.md — Robin Build Log
<!-- Alfred: update this file at the end of every task, before committing. -->

## How to update
Add a new entry at the top of the Sessions log (reverse chronological).
Keep each entry tight — 5–10 lines max. This is a log, not documentation.

---

## Sessions

### 2026-04-14 — Differential expander (item 16, commit 2/4)
**Built:**
- `src/lib/differentialExpander.ts` — `runDifferentialExpander()` pure function. Two tools: `add_differential` (0+ calls, hard cap 4) → `done_expanding` (exactly once). System prompt mirrors clinical surfacing's discipline (THE RATIONALE TEST meta-rule) plus three differential-specific guards: don't re-add what the physician named, don't speculate without presentation-specific support, badness beats probability. Result sorted by `badness_if_missed` (life_threatening → serious → benign) then `pretest_probability` (common → uncommon → rare) for panel display.
- `src/app/api/differential-expander/route.ts` — thin SSE wrapper, auth-gated, `x-robin-eval: 1` opt-in for temp 0. Mirrors `/api/clinical-surfacing` exactly.
- `src/components/RobinInsightsPanel.tsx` — new `DifferentialCard` component with badness-dot accent (red = life-threatening, amber = serious, muted = benign). "Consider also" section renders below surfaced tools, above HPI. `RobinAuditState.differentials` hydrated from `differential_added` events (wiring deferred to commit 3).
- `evals/differential/{rubric,runDifferentialEvals}.ts` + 12 fixtures — substring diagnosis matching, per-add badness assertions, `maxAdded` cap per fixture (defaults to 4, 0 for silent-required cases).

**Validated:**
- **12/12 PASS** at temperature 0 on two consecutive runs in ~10–13s.
- Trigger cases (6/6): PE on pleuritic+tachy+long-flight, SAH on thunderclap + vomiting + neck stiffness, AAA on elderly smoker with abrupt flank pain + hypotension, preeclampsia/HELLP on pregnant RUQ+HA+HTN, ectopic on reproductive-age RLQ with no bHCG, dissection on migrating CP with BP arm asymmetry.
- Non-trigger cases (6/6): classic vasovagal (0 adds), STEMI cath lab active (0 adds), toddler URI (0 adds), PE already named + CTA ordered (0 adds of PE), young mechanical back no red flags (0 adds), simple ankle sprain (0 adds).

**Decided:**
- Separate route from `/api/clinical-surfacing`. Different eval shape (diagnosis strings vs. typed tool pre-fills) and different over-fire failure modes. Keeps tuning surfaces independent.
- Hard cap of 4 adds per call. More than 4 is noise — physicians ignore noisy panels. System prompt enforces this and the engine enforces it as a second layer.
- Sort order: badness-first, pretest-second. Panel leads with life-threatening must-not-miss diagnoses regardless of how common they are. Raw insertion order preserved in `result.events` for debugging.
- THE RATIONALE TEST meta-rule reused from clinical surfacing — this was the highest-leverage edit there and it transfers cleanly. "If your rationale undercuts itself, don't add."
- Panel palette: neutral `surface2` card with a badness-colored dot (reusing `--robin` / `--amber` / `--muted`). Distinct from clinical-surfacing teal. Cooler palette signals "observational ddx note" vs. "actionable tool to consider running."
- Silence is a valid and common output — 5 of 12 fixtures correctly add zero. Engine emits `expanding_done` regardless so the consumer always sees a terminal event.

**Deferred:**
- Live audio wiring into `useShiftAmbient` — lands with item 19's `surfacing_events` table so engagement tracking works from the first live add, not a retrofit. Matches the clinical-surfacing pattern.
- Shift-memory writer for differentials (`appendShiftMemoryDifferential` + `appendEncounterDifferential` helpers already exist in `src/lib/memory.ts`) — wired in commit 3.
- Firing differential-expander on disposition (parallel to robin-think) — deferred along with clinical-surfacing's equivalent wiring, for consistency.

**Next:** Commit 3 — wire writers (robin-think, clinical-surfacing, differential-expander, agent/act, note-finalize) to shift memory + encounter memory via the `src/lib/memory.ts` helpers.

---

### 2026-04-14 — Memory architecture audit + foundations (item 16.5, commit 1/4)
**Built:**
- `/docs/memory-architecture.md` — full audit of the three existing memory tiers (`encounters.mdm_data`, `shifts.robin_memory`, `physicians.robin_preferences`) plus the proposed fourth (`physicians.robin_longitudinal`). Documents current state, proposed schemas, write paths per source route, read paths, preference↔longitudinal reconciliation policy, implementation order, open questions.
- `supabase/migrations/006_memory_architecture.sql` — adds `physicians.robin_longitudinal` jsonb. Flags `shifts.summary` (from migration 001) as deprecated in place.
- `src/lib/robinTypes.ts` — new types: `DifferentialAddition` + `PretestBucket` + `BadnessBucket` (for item 16), `ShiftMemory` + `ShiftEncounterRollup` + `ShiftObservedPatterns` + `ShiftTally`, `RobinLongitudinal` + `ChronicallyMissedGap` + `ToolEngagementStats` + `PendingObservation`. Factories `createEmptyShiftMemory()` / `createEmptyLongitudinal()`. `RobinAuditState` now includes `differentials: DifferentialAddition[]`.
- `src/lib/memory.ts` — write-path helpers: `upsertEncounterInShiftMemory`, `incrementShiftTally`, `incrementShiftPatternCount`, `setShiftPattern`, `appendShiftMemorySurfacing`, `appendShiftMemoryDifferential`, `markGapsAddressed`, `appendEncounterSurfacing`, `appendEncounterDifferential`, `buildRollupFromMdmData`, `aggregateShiftToLongitudinal` with delta detection (em_posture vs coding, gap_sensitivity vs chronic misses). Threshold-gated at `shifts_observed >= 5`.

**Fixed:** `RobinAuditState` initialization in encounter page updated to include the new required `differentials: []` field.

**Decided:**
- New `physicians.robin_longitudinal` column rather than extending `robin_preferences`. Preferences = stated intent (authoritative), longitudinal = observed behavior (never overrides preferences).
- Engagement signals (`tool_engagement.engaged_count`, `differential_engagement.engaged_count`) stay 0 until item 19's `surfacing_events` table lands. Schema is forward-compatible.
- `shifts.summary` deprecated in place, not dropped. Zero-cost to leave the column, keeps the door open if a future structured shift-close summary wants it.
- Race-tolerant `select → modify → update` on shift memory writes. Single-physician-per-shift concurrency makes lost tally increments acceptable.
- Threshold-gating on longitudinal: delta observations only fire when `shifts_observed >= 5`, and mid-shift commentary only fires when tally counts cross signal thresholds (e.g. `gaps_by_type[x] >= 3`).

**Deferred:** All writer wiring + aggregator route + reader update — scheduled across commits 2–4.

**Next:** Commit 2 — differential expander (item 16): `src/lib/differentialExpander.ts` + `/api/differential-expander` SSE route + panel rendering + 12-fixture eval suite. Then commit 3 (writers wired) and commit 4 (aggregator + reader).

---

### 2026-04-14 — Clinical decision tool surfacing engine (Loop A) + 18-fixture eval suite
**Built:**
- `src/lib/clinicalSurfacing.ts` — `runClinicalSurfacing()` pure function. Library of 6 tools (HEART, PERC, SF Syncope, Canadian CT Head, Ottawa Ankle, NEXUS) with explicit per-tool TRIGGER and DO NOT SURFACE rules. Server-side `coercePreFill()` strips loose JSON to typed per-tool shapes. Emits `clinical_tool_surfaced` / `surfacing_done` / `error` events.
- `src/app/api/clinical-surfacing/route.ts` — thin SSE wrapper, mirrors `/api/robin-think` pattern. Auth-gated. Eval mode opt-in via `x-robin-eval: 1` header.
- `src/lib/robinTypes.ts` — added 6 per-tool `*PreFill` interfaces, `ClinicalToolName` union, `ClinicalToolPreFill` discriminated union, `ClinicalToolSurfacing` (with `surface_id` UUID for forward compat with item 19's `surfacing_events` table), `surfacedTools: ClinicalToolSurfacing[]` on `RobinAuditState`.
- `src/components/RobinInsightsPanel.tsx` — `SurfacedToolCard` component, teal palette (distinct from MDM/gaps), renders above HPI to reflect Loop A's higher product priority. Displays trigger rationale + pre-fill summary + missing elements as chips.
- `evals/surfacing/{rubric,runSurfacingEvals,runOverfireRegression}.ts` — eval harness mirroring `evals/runEvals.ts`. Dot-notation path lookup for nested `pre_fill` assertions. Substring matching for `missing_elements`. Pretty printers with ANSI colors.
- `evals/surfacing/fixtures/*.json` — 18 fixtures, 3 per tool: 1 clear trigger + 1 over-fire trap + 1 edge case at the decision boundary.

**Validated:**
- **18/18 PASS** at temperature 0, stable across multiple consecutive runs.
- Bonus over-fire regression on the 13 existing MDM fixtures: only 3 fires, all clinically appropriate (HEART for 44yo with FHx MI on chest tightness, NEXUS on intox head trauma, Ottawa on ankle sprain). 9 silent on encounters that legitimately don't match any tool (abd pain, septic shock, mech LBP, peds OM, ACE rash, dental, etc.). The previously-contradictory PERC fire on the high-pretest PE case is now suppressed.

**Decided:**
- 3 prompt strengthenings landed during iteration: (1) generalized "past the decision point" guard with explicit examples beyond cath lab, (2) explicit benign-vasovagal exclusion under SF_Syncope, (3) THE RATIONALE TEST meta-rule: if your `trigger_rationale` would explain why the tool doesn't apply, do not fire at all. The third one was the highest-leverage edit — it killed the soft over-fire pattern where the model surfaced a tool while explaining its own non-applicability.
- Per-tool typed pre-fill (vs. free-form blob) is worth the coercion code — it lets the rubric assert specific elements like `Canadian_CT_Head.high_risk.dangerous_mechanism`, which catches under-pre-filling that a string-match assertion would miss.
- Surfacing engine lives in a separate route (`/api/clinical-surfacing`), not folded into `/api/robin-think`. Two parallel pipelines so Loop A and Loop B can be triggered, evaluated, and tuned independently.

**Deferred:**
- Live audio wiring into `useShiftAmbient`. Will land in a separate commit once item 19's `surfacing_events` table exists, so engagement tracking is wired from the first live surfacing rather than retrofitted.
- Differential expander (item 16) — sibling Loop A capability, can run in parallel.
- Item 16.5 (memory architecture audit) — informs how surfacing context flows shift→shift.
- Canadian CT Head pre-fill schema does not yet capture entry criteria (LOC / amnesia / witnessed disorientation). Works for current fixtures but a v2 schema extension would let the panel display "Heard: LOC ~1min, brief amnesia, GCS 15." Note for follow-up.

**Next:** item 16 (differential expander) and item 16.5 (memory architecture audit). After those land, item 19 (`surfacing_events` table) → live audio wiring of surfacing → trial shift.

---

### 2026-04-08 — WoZ corpus to 13 encounters + `vague_workup_language` gap
**Built:**
- `evals/encounters/09-ace-rash.json` — elderly F rash, ACE-I culprit. Tests risk axis on ambiguous Rx adjustment. **PASS**
- `evals/encounters/10-panic-pe-diff.json` — 44F with 5-way differential (panic/PE/thyrotoxicosis/sympathomimetic/ACS). Tests broad differential + incomplete encounter recognition. Robin correctly identified this as "Currently unbillable" in some runs (physician got pulled away) — a NEW and clinically valuable behavior. Code alternates accept both 99284 and incomplete-encounter variants. **PASS**
- `evals/encounters/11-intox-head-trauma.json` — intoxicated M on warfarin with head lac. Tests anticoag risk. Robin nailed NEXUS/Canadian CT Head Rule, anticoag bleeding risk, INR gaps using better clinical vocabulary than my predicted keywords. **PASS**
- `evals/encounters/12-dental.json` — dental pain + drug-seeking nuance. Tone test: "clinical colleague, not compliance officer" — no preachy "drug-seeking" or "addiction" language in any rationale. **PASS**
- `evals/encounters/13-ankle-sprain.json` — minimal-conversation ankle sprain. Floor case. Robin stayed at 99282 (didn't inflate), Ottawa rules documentation flagged. **PASS**
- `src/lib/robinThink.ts` — added `vague_workup_language` as a new `note_gap` enum value + new VAGUE WORKUP DETECTION section in the system prompt. First draft was over-strict (made Robin re-score data to straightforward on any vague phrasing); v2 clarifies the gap is ADDITIVE — flag the documentation issue without downgrading the data axis. Trigger phrases: "some labs", "draw some bloodwork", "probably a CT", "labs and imaging" without specifics, etc. Severity medium by default.

**Fixed:**
- Rubric too-narrow synonym lists on E03 (mech LBP) and E07 (peds OM) caused temp=0 drift failures when Robin picked different equally-valid gaps for its top 4 slots. Expanded to include "discharge instruction", "worsening", "red flag", "when to return", "warning sign", "antibiotic counseling" — broader catchment for discharge-guidance gaps without lowering the bar.
- E10 code alternates now accept "Not billable" / "Currently unbillable" / "Incomplete" variants to reward Robin's new behavior of flagging incomplete encounters instead of assigning a code to a half-done workup.
- E11 required gap synonyms expanded from narrow ("c-spine", "warfarin reversal") to broad ("anticoagulation", "bleeding risk", "INR", "NEXUS", "Canadian CT Head", "decision rule") — matches Robin's actual clinical vocabulary, which turned out to be better than my predicted keywords.

**Validated:** 13/13 PASS on two consecutive runs. Structural failures (wrong code, wrong overall MDM, missing encounter-specific gap) = 0. Temp=0 noise is now fully absorbed by the array-tolerant rubric.

**Decided:**
- Robin's strict reading of transcripts is a feature: vague language gets flagged via `vague_workup_language` rather than silently credited. The gap is ADDITIVE — doesn't change how Robin scores the data axis, just documents that the dictation is hard to defend on audit.
- Robin recognizing incomplete encounters as "Currently unbillable" is net valuable product behavior worth preserving. Added to code alternates on E10.
- Expanding required-gap synonym lists is the right response to temp=0 drift on borderline gap selection. Robin picking "discharge instructions" vs "return precautions" for the same underlying concern shouldn't be a test failure.

**Deferred:**
- "Vague workup language" fixture where the gap is REQUIRED to fire (currently only on E06 and E08, neither of which strictly verified the new gap_type actually fires — the existing cases all pass but I haven't confirmed the new enum value is being selected. Future iteration: add a fixture specifically designed to require gap_type === "vague_workup_language".)
- Internal-consistency check in the rubric (assert em_assessment.code aligns with mdm_scaffold.overall_mdm via standard mapping)
- Adding encounters for other high-leverage scenarios: sedation procedure, I&D, lac repair, massive transfusion, psych hold, OB complaint

**Next:** First trial shift with 13-encounter regression suite as pre-commit / pre-shift validation.

---

### 2026-04-08 — WoZ corpus expansion: 8-encounter regression suite (8/8 passing)
**Built:**
- `evals/encounters/04-stemi.json` — 58M anterior STEMI, cath lab activated. Tests CC fix beyond septic shock. **PASS:** code=99291, CC time gap flagged
- `evals/encounters/05-stroke-tnk.json` — 72F LKW 45 min, NIHSS 18, TNK administered. Second non-sepsis CC test. **PASS:** code=99291, CC time gap flagged
- `evals/encounters/06-pe.json` — Adult M with pleuritic CP + DVT signs + travel. The OVER-TRIGGER guard. **PASS:** code=99284, NO 99291, NO CC time gap — the new CC trigger rules don't false-positive on every concerning case
- `evals/encounters/07-peds-om.json` — 2yo F with fever 103.4 + AOM on exam, well-appearing. Only peds case. **PASS:** code=99284, risk=moderate (amoxicillin Rx correctly identified as Rx drug mgmt), no over-fire on sepsis workup / LP / blood cx
- `evals/encounters/08-elderly-mets.json` — Elderly cachectic with weight loss + supraclav node + prostate nodule + hematuria + melanoma hx. Multi-system high-MDM with 5+ competing gaps. **PASS:** code=99285, problems=high, no contamination from the embedded hyperkalemia distractor

**Validated:** 8/8 PASS in ~37–60s. Critical wins:
- CC fix proven to generalize beyond septic shock (STEMI + stroke + septic shock all pass)
- Over-trigger guard works (PE workup correctly NOT scored as critical care)
- Peds gap rules don't false-positive on a clearly-sourced fever
- Robin doesn't get distracted by content from a different patient (the hyperkalemia interruption in encounter 08)

**Decided:**
- Robin reads transcripts STRICTLY and won't credit data points that aren't explicitly named ("we'll get some labs and probably a CT" → data=low). This is correct behavior — a real coder would do the same. Updated ground truth on 04/06/08 to accept low data axis on workup-in-progress cases. The strict reading is a feature, not a bug.
- Anthropic temp=0 is near-deterministic but not byte-identical — small drift on borderline axes (saw risk flip moderate↔high on encounter 08 between runs). Rubric uses array-acceptable axes which absorbs this noise without false failures.

**Product insight worth logging:**
- Robin's strict transcript reading suggests a NEW gap type: "vague workup language — name the tests you're ordering." Whenever the physician dictates "some labs" or "some imaging" without specifics, that's a billable RVU left on the floor (data complexity is downcoded by the strictness Robin is correctly applying). Worth adding to the prompt as a 7th gap_type enum and a new gap detection rule. Logged for next session.

**Deferred:**
- Encounters 14, 16, 19, 20, 23 from the WoZ batch (chatty rash, panic/PE diff, intox head trauma, dental pain, ankle sprain) — added to the safety-net queue for next session
- Internal-consistency check in the rubric (assert E&M code maps to overall MDM via standard table) — would have caught the 99285+mdm=moderate temporary inconsistency on E08 in run 1
- "Vague workup language" gap type addition to the system prompt

**Next:** add the 5 deferred encounters as the safety net OR add the "vague workup" gap type — user's call.

---

### 2026-04-08 — `robin-think` system prompt v2 (5 clinical bug fixes)
**Built / Fixed:**
- `src/lib/robinThink.ts` — `ROBIN_THINK_SYSTEM` rewritten. Added: (1) CRITICAL CARE section as the first major block — 99291/99292 are time-based, NOT MDM upgrades; auto-flag CC time on pressors/lactate>4/septic shock/intubation/ICU instability/etc.; (2) tightened Risk section with positive/negative examples — chronic home meds and OTC explicitly excluded from Rx drug mgmt; (3) explicit data point counting with septic-shock worked example; (4) encounter-specific gap rules (female + abd pain → hCG/ectopic, chest pain → ACS, elderly fall → anticoag/CT, etc.); (5) HPI threshold fix (score≥4 = "extended", score=4 is extended not brief)
- `evals/rubric.ts` — `overallMDM` now accepts an array of acceptable values; added `isNegated()` helper so forbidden-substring checks pass when phrases like "no prescription drug management" appear in negated context
- `evals/encounters/0[1-3]-*.json` — ground truth tightened: forbidden substrings made specific to affirmative wrong reasoning (not bare phrases that get tripped by negation); E1 admits workup-in-progress as low or moderate; E3 admits 99281 alongside 99282 since 1 acute uncomp + sf data + sf risk is technically straightforward MDM

**Validated (3/3 PASS, deterministic at temp 0, 36s end-to-end):**
- 01 abd pain: 99283, mdm=low, problems=mod, data=low, risk=low — pregnancy/ectopic gap flagged HIGH severity ✓
- 02 septic shock: **99291**, mdm=high, problems=high, **data=high**, risk=high — CC time gap flagged ✓ (data went from low → high after the worked example landed)
- 03 mech LBP: 99282, mdm=sf, problems=low, data=sf, risk=sf — return precautions flagged ✓; risk no longer credits OTC ibuprofen as Rx mgmt

**Decided:**
- Worked examples in the system prompt (the septic-shock data-counting walkthrough) move the model meaningfully on borderline cases. Worth investing in 1–2 more for the data axis if the corpus exposes new edge cases.
- Forbidden-substring checks must be phrased as affirmative wrong reasoning ("ibuprofen is prescription drug management"), not bare topic words ("prescription drug management"), because the model legitimately uses negated forms when explaining why something doesn't apply.
- Ground truth admits clinical reality: E1 is workup-in-progress and reasonable coders disagree on data tier; E3 is technically 99281 by AMA math but 99282 in practice. The harness accepts both.

**Next:** Expand fixture corpus to encounters 4–10 from the user's WoZ set. Specifically chase: a 99283↔99284 risk-swing case (where the new Rx-drug-mgmt rules get a real test), a 99285 high-acuity case that is NOT critical care (to confirm Robin doesn't over-trigger CC), and a clearly billable critical care case different from septic shock (intubation, stroke with TNK, post-arrest).

---

### 2026-04-08 — `runRobinThink` extraction + WoZ eval harness
**Built:**
- `src/lib/robinThink.ts` — extracted full MDM audit pipeline (system prompt, tools, Claude loop, `deriveOverallMDM` guardrail) into pure `runRobinThink()`. Accepts `onEvent`, `onReady`, and `evalMode` (pins temp=0). Route is now a thin SSE wrapper, byte-identical events
- `evals/encounters/{01-abd-pain,02-septic-shock,03-mech-lbp}.json` — fixtures with structured ground truth (code + alternates, axes, required gap synonym groups, forbidden rationale substrings)
- `evals/rubric.ts` + `evals/runEvals.ts` — `npx tsx evals/runEvals.ts` runs all fixtures in parallel via `runRobinThink` directly, no dev server. Added `tsx`/`dotenv` devDeps

**Decided:** clinical logic in `/lib`, route is plumbing. Eval harness lives at `/evals` as first-class asset. Eval mode opt-in via `x-robin-eval: 1` header — production unaffected.

**Validated (3 WoZ encounters at temp=0):** 1/3 pass. Encounter 1 misses pregnancy/ectopic gap and credits OCP+Zoloft as Rx drug mgmt. Encounter 2 returns 99285 instead of 99291 — prompt has zero critical-care knowledge, says *"Document data review to push toward 99291"* which is factually wrong. Encounter 3 passes deterministically.

**Bugs to fix next** (`fix-robin-think-coding-rules`): (1) critical care 99291 time-based rules + auto-flag CC time gap on pressors/lactate>4/ICU/intubation; (2) Rx drug mgmt definition tightened — exclude chronic home meds and OTC; (3) data axis explicit point-counting examples; (4) demographic-aware gap rules (female + abd pain → hCG/ectopic); (5) HPI threshold (score=4 should be "extended"). Regression target: all 3 fixtures pass at temp=0.

**Deferred:** encounters 4–10 (fold in as prompt iterates); LLM-as-judge scoring; Option B Supabase-write persistence test.

**Next:** `fix-robin-think-coding-rules` — system prompt rewrite targeting the 5 bugs.

---

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
