# Robin — Master Agentic Capability Spec
<!-- Status: DRAFT — not approved for implementation -->
<!-- Last updated: 2026-04-05 -->
<!-- Scope: Spec only. Alfred does not touch this until approved. -->
<!-- Consolidates: robin-agentic-spec.md, robin-layer3-spec.md, robin-note-dashboard-spec.md -->

---

## Overview

Three capability layers move Robin from documentation assistant to active shift participant.
Each layer is independent — they ship in sequence without interdependence.

| Layer | Name | Core capability |
|---|---|---|
| 2 | Onboarding Interview | Robin learns physician preferences via conversation |
| 1 | Ambient Command | Physician speaks → Robin writes to DB |
| 3 | Dashboard & Chart Agency | Robin takes write actions on voice command |
| — | Note Dashboard | Living note architecture + review/finalization surface |

**Implementation order:** Layer 2 → Layer 1 → Note Dashboard → Layer 3. Rationale at bottom.

---

## Core Architecture Change: The Living Note

The previous model: encounter happens → physician ends encounter → robin-think fires → note generates.

The new model: **a note is created when the encounter is created and accumulates content
in real time.** Every Robin action that produces clinical content writes to the corresponding
note section as it happens. At encounter end, the physician sees a complete or near-complete
note rather than a blank.

`/api/generate-note` still exists but its role changes: it becomes a **finalize** action
that polishes the accumulated note, fills minor gaps Robin can infer, and produces a
copy-ready document. It is not the moment the note comes into existence.

---

## Note Data Model

One note per encounter. Structured sections in clinical sequence. Stored as `encounters.note` (jsonb).

### Section order

```
1.  Chief Complaint
2.  HPI
3.  Review of Systems
4.  Physical Examination
5.  Orders
6.  Diagnostic Results
    ├── EKGs
    └── Radiology
7.  Labs
8.  MDM
9.  Procedures
10. ED Course  (Re-evaluation / Re-examination / ED Course)
11. Consults
12. Final Diagnosis
13. Disposition
```

Orders precede results because you order first. Results precede MDM because MDM is written
after reviewing data. ED Course captures the full encounter arc. Final Diagnosis and
Disposition close the note. Discharge Instructions exist as a separate tab — not inline.

### TypeScript interface

```typescript
interface EncounterNote {
  // Sections 1-4: Standard opening
  chief_complaint:     NoteSection;
  hpi:                 NoteSection;
  review_of_systems:   NoteSection;
  physical_exam:       NoteSection;

  // Section 5: Orders
  orders: OrderEntry[];
  // Populated by: "Robin, I'm adding labs" / "I ordered imaging for [patient]"

  // Section 6: Diagnostic Results
  diagnostic_results: {
    ekgs:     EKGEntry[];
    radiology: RadiologyEntry[];
  };

  // Section 7: Labs (results - distinct from orders)
  labs: LabResultEntry[];

  // Section 8: MDM
  mdm: NoteSection;

  // Section 9: Procedures
  procedures: ProcedureEntry[];

  // Section 10: ED Course
  ed_course: EDCourseEntry[];

  // Section 11: Consults
  consults: ConsultEntry[];

  // Sections 12-13: Closing
  final_diagnosis: NoteSection;  // includes ICD-10 code
  disposition:     NoteSection;

  // Discharge Instructions - separate tab, not in note scroll
  discharge_instructions: NoteSection;

  // Metadata
  created_at:    string;        // ISO - when encounter started
  finalized_at:  string | null;
  note_version:  number;        // increments on every write - optimistic locking
}

interface NoteSection {
  content:         string | null;
  last_updated_at: string | null;
  updated_by:      'robin' | 'physician' | 'robin_generated';
  // robin          - from physician dictation, structured by Robin
  // physician      - manual edit in UI
  // robin_generated - Robin synthesized from context (e.g. discharge instructions)
}

interface OrderEntry {
  id:           string;
  ordered_at:   string;
  description:  string;       // "CBC, BMP, troponin" | "CT abdomen/pelvis w contrast"
  order_type:   'labs' | 'imaging' | 'medication' | 'other';
  mdm_relevant: boolean;
}

interface EKGEntry {
  id:               string;
  performed_at:     string;
  dictation_raw:    string;
  interpretation:   string;   // Robin-structured output
  normal_shorthand: boolean;  // true if physician used "normal EKG" shorthand
}

interface RadiologyEntry {
  id:          string;
  study_type:  string;        // "CXR" | "CT head" | "XR left wrist"
  ordered_at:  string;
  result:      string | null; // null until physician dictates result
  dictated_at: string | null;
}

interface LabResultEntry {
  id:        string;
  logged_at: string;
  content:   string;          // free-form dictated lab summary or structured results
}

interface ProcedureEntry {
  id:             string;
  procedure_type: string;     // 'sedation_closed_reduction' | 'lac_repair' | 'id' | etc.
  performed_at:   string;
  qa_responses:   Record<string, string>; // question -> answer pairs from Q&A session
  procedure_note: string;     // Robin-assembled note from Q&A responses
}

interface EDCourseEntry {
  id:         string;
  entry_type: 'reassessment' | 'reeval' | 'response_to_treatment' | 'general';
  performed_at: string;
  content:    string;
}

interface ConsultEntry {
  id:                  string;
  consulting_service:  string;        // "Orthopedics" | "Surgery" | "Cardiology"
  consulting_physician: string | null;
  contacted_at:        string;
  recommendations:     string | null; // null until physician dictates
}
```

---

## Note Conflict Resolution

When Robin attempts to write to a section the physician has manually edited,
`note_version` mismatch is detected. **Physician version is always the authoritative base.**

### Rule: strictly additive, never restorative

Robin has one merge rule: **add what's absent, never restore what was removed.**

If the physician deleted content from Robin's previous draft - even an entire section -
Robin treats it as intentional and does not re-add it. If the physician's version is
completely empty AND Robin has fresh dictation content (not a prior draft), Robin toasts:
"Looks like you cleared this section - I kept your version." and does not write.

Matching is **semantic, not text diff.** "Moves all extremities" and "full ROM in all
four extremities" are equivalent. Robin uses Claude to detect representation - this
prevents re-adding paraphrased content the physician already covered in their own words,
and prevents Robin from restoring a false negative finding the physician intentionally corrected.

### Merge protocol

On `note_version` mismatch:
1. Fetch physician's current version (base) and Robin's candidate output
2. Send both to Claude:
   > "The physician's version is authoritative. Identify clinical information in the Robin
   > version that has zero representation in the physician version - including paraphrased
   > equivalents. Add only that content, appended cleanly. Never restore removed content.
   > If physician's version fully covers Robin's content, return it unchanged."
3. Write merged result with incremented `note_version`
4. Log merge in `robin_actions` - store both pre-merge versions in `previous_state`
5. Toast: "Robin added [section summary] to your note for [patient] - [View]"

If merge produces no additions, write nothing and log a no-op.

---

## Layer 2 — Physician Onboarding Interview

### Why first

Zero risk - no autonomous DB writes. Highest leverage - personalization makes Layers 1
and 3 materially more accurate. `robin_preferences` populated means every robin-think
call gets richer context immediately.

### What it does

Before the physician's first shift, Robin conducts a structured conversational interview.
Not a settings form - a real exchange. Robin asks open questions, listens to natural
answers, and extracts structured preferences. At completion, writes a `robin_preferences`
jsonb object to `physicians.robin_preferences`. `buildRobinContext()` then carries those
preferences into every interaction.

### Trigger condition

```
physicians.robin_preferences IS NULL OR physicians.robin_preferences = '{}'::jsonb
```

Check at shift start. If true, redirect to `/onboarding` before allowing shift to begin.

### Preference schema

```typescript
interface RobinPreferences {
  // MDM & Assessment
  mdm_depth: 'scaffold_only' | 'full_ap';
  // scaffold_only: Robin builds structure, physician fills content
  // full_ap: Robin drafts complete assessment and plan

  // MDM dictation mode
  mdm_dictation_mode: 'verbatim' | 'structured';
  // verbatim: transcribe exactly what physician said
  // structured: integrate into AMA 2021-compliant MDM format, physician reviews

  // HPI
  hpi_style: 'brief' | 'extended';
  // brief: location, severity, duration only
  // extended: all 8 OPQRST elements

  // Gap flagging
  gap_sensitivity: 'high' | 'medium' | 'low';
  // high: flag everything missing
  // medium: flag high-severity gaps only
  // low: flag only gaps that affect E&M level

  // E&M coding posture
  em_posture: 'conservative' | 'accurate' | 'aggressive';

  // Note verbosity
  note_verbosity: 'concise' | 'standard' | 'thorough';

  // Copy mode (for note finalization)
  copy_mode: 'full' | 'sections';
  // full: full note copy button prominent, sections secondary
  // sections: section buttons are primary interface

  // EKG interpretation
  ekg_normal_verbosity: 'full' | 'impression_only';
  // full: complete structured read on "normal EKG" shorthand
  // impression_only: single impression line only

  // Specialty flags
  specialty_flags: {
    include_ems_narrative:          boolean;
    auto_include_review_of_systems: boolean;
    document_negative_findings:     boolean;
  };

  // Metadata
  interview_completed_at: string;
  interview_version:      number;
}
```

### Interview question sequence

Robin conducts the interview through `robin-chat` with an interview-mode system prompt.
Do NOT hard-code Q&A pairs - Robin asks naturally, handles follow-up, extracts from
free-form answers.

**System prompt addition:**
> You are conducting a one-time onboarding interview to learn this physician's charting
> preferences. Ask each question area conversationally. At the end, when all areas are
> covered, respond with a JSON block (inside \`\`\`json fences) containing the extracted
> robin_preferences object. Only output the JSON block when complete.

**Question areas:**
1. MDM depth - scaffold or full A&P?
2. MDM dictation - verbatim or structured integration?
3. HPI style - essentials or full OPQRST?
4. Gap sensitivity - flag everything or billing-impacting only?
5. E&M posture - conservative, accurate, or aggressive?
6. Note verbosity - concise or thorough with negative findings?
7. EKG shorthand - full structured read or impression only on "normal EKG"?
8. EMS narrative - bake into HPI?

### Preference extraction

After interview, Robin outputs JSON block. Onboarding screen client:
1. Detects JSON block in streaming response
2. Parses it
3. POSTs to `/api/physician/preferences`
4. Route writes to `physicians.robin_preferences`
5. Redirects to `/shift` after 2-second confirmation

### `buildRobinContext()` update

Translates preferences into natural language directives included in every context build:

```
Physician preferences:
- MDM: Draft full assessment and plan
- MDM dictation: Integrate into AMA 2021 format, show preview before saving
- HPI: Extended - all OPQRST elements
- Gap sensitivity: High - flag all missing elements
- E&M: Accurate - code exactly what documentation supports
- Note style: Thorough - document negative findings
- EKG shorthand: Full structured read
- Copy mode: Section by section
```

### New route: `/api/physician/preferences` (POST)

Auth-gated. Body: `{ preferences: RobinPreferences }`. Single Supabase upsert to
`physicians.robin_preferences`. Returns `{ ok: true }`. No streaming, no tool use.

### New screen: `/app/onboarding/page.tsx`

- robin-chat UI in standalone layout (not shift chrome)
- Interview-mode system prompt at conversation start
- Listens for JSON block in assistant stream
- On detection: "Got it - your preferences are saved." -> auto-redirect to `/shift`

### Re-interview

Physician can re-trigger from `/settings` (not yet built). Until then: clear
`robin_preferences` to `{}` in Supabase console to re-trigger on next shift start.

### Layer 2 deliverables

1. Update `RobinPreferences` interface in `robinTypes.ts` (full schema above)
2. `/api/physician/preferences` route (POST, auth-gated)
3. `/app/onboarding/page.tsx` - interview screen
4. `buildRobinContext()` update - translate preferences to natural language directives
5. Shift start redirect logic - check `robin_preferences`, redirect if empty

---

## Layer 1 — Ambient Command → Database Action

### What it does

Physician speaks naturally. Robin acts without UI interaction.

**Command class A - Patient briefing:**
> "About to see Johnson - 56 male, belly pain."

Robin creates an encounter record: `room`, `chief_complaint`, `age`, `gender`, `status: 'active'`.

**Command class B - Disposition:**
> "Get Mr. Smith ready to go. Diverticulitis, query sepsis. Dr. Spock accepted to the ICU."

Robin updates encounter: `status: 'documenting'`, pre-populates diagnoses in `mdm_data`,
sets `disposition` and `accepting_physician`.

### What already exists

- `useShiftAmbient.ts` - detects patient briefings, sets `pendingBriefing` state
- `/api/parse-patients` - parses briefing text into structured patient data
- **Gap:** `pendingBriefing` surfaces to UI for human action. Layer 1 closes this by
  having Robin act directly.

### Architecture: `/api/agent/act`

All Layer 1 (and Layer 3) writes go through a single server-side route. No client-side
Supabase writes for Robin actions.

```typescript
interface AgentActRequest {
  shiftId:        string;
  commandType:    'patient_briefing' | 'disposition' | 'dashboard_action' | 'chart_action';
  rawText:        string;
  parsedPayload?: PatientBriefing | DispositionCommand;
  encounterId?:   string; // required for disposition and chart commands
}

interface AgentActResponse {
  ok:                   boolean;
  actionTaken:          string;    // "Created encounter for Johnson (Room 4)"
  encounterId?:         string;
  confidence:           number;    // 0-1
  confirmationRequired: boolean;
}
```

### Action tiers (Layer 1)

| Command | Tier | Behavior |
|---|---|---|
| Patient briefing -> create encounter | Auto | Robin acts, inline toast |
| Briefing with uncertain parse | Confirm | Show interpretation, wait for tap |
| Disposition -> pre-fill MDM scaffold | Auto | Robin acts, inline toast |
| Disposition with uncertain diagnosis | Confirm | Show what Robin heard, wait for tap |
| Any command confidence < 0.70 | Confirm | Always confirm below threshold |

**Toast (auto):** "Robin created an encounter for Johnson - 56M, belly pain. Room 4."

**Confirm card:** "Robin heard: *Johnson, 56M, belly pain, Room 4* - Is this right? [Confirm] [Edit]"

### `useShiftAmbient.ts` changes

Minimal. Replace:
```
detect briefing -> set pendingBriefing state
```
With:
```
detect briefing -> POST to /api/agent/act
               -> if confirmationRequired: set pendingConfirmation state
               -> if auto: show toast, update encounter list
```

### Encounter record write - patient briefing

```sql
INSERT INTO encounters (shift_id, chief_complaint, status, age, gender, room, created_by_robin)
VALUES ($shiftId, $chiefComplaint, 'active', $age, $gender, $room, true)
RETURNING id;
```

### Encounter update - disposition

```sql
UPDATE encounters
SET status = 'documenting',
    mdm_data = jsonb_set(mdm_data, '{pre_fill}', $preFillPayload),
    disposition = $disposition,
    accepting_physician = $acceptingPhysician
WHERE id = $encounterId AND shift_id = $shiftId;
```

### Audit log: `robin_actions` table

Every `/api/agent/act` call writes to this table. Required before any real PHI.

```sql
CREATE TABLE robin_actions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id             uuid REFERENCES shifts(id),
  encounter_id         uuid REFERENCES encounters(id),
  action_type          text NOT NULL,
  raw_command          text NOT NULL,
  parsed_payload       jsonb,
  confidence           float,
  confirmed_by_physician boolean,
  previous_state       jsonb,       -- for undo; populated on every write
  note_section_affected text,       -- which note section was written to
  created_at           timestamptz DEFAULT now()
);
```

### Layer 1 DB migrations

1. `created_by_robin boolean DEFAULT false` on `encounters`
2. `disposition text` on `encounters`
3. `accepting_physician text` on `encounters`
4. `patient_name text` on `encounters`
5. Create `robin_actions` table (above)

### Layer 1 deliverables

1. DB migrations (above)
2. `/api/agent/act` route - command classification, Claude parse, confidence scoring, DB write
3. `useShiftAmbient.ts` - replace `pendingBriefing` with `/api/agent/act` call
4. Toast component - inline action confirmation UI
5. Confirm card component - uncertain parse UI

---

## Note Dashboard

### Purpose

The physician's primary surface for reviewing, editing, and finalizing encounter notes.
Separate screen from encounter capture and shift dashboard.

| Screen | Route | Purpose |
|---|---|---|
| Shift dashboard | `/shift` | All active encounters, shift-level controls |
| Encounter capture | `/shift/encounter/[id]` | Live audio, transcript, Robin insights |
| **Note dashboard** | `/shift/notes` | All encounter notes, live status, finalization |
| **Single note view** | `/shift/notes/[id]` | Full note for one encounter, edit + copy |

### Navigation model

**`/shift/notes` - encounter list view**

Scrollable list of all encounters in the current shift. Each card shows:
- Patient identifier (name or "Encounter [N]")
- Chief complaint and room
- Note completion badges (see below)
- Time since encounter created
- Finalization status: `Draft` | `Finalized`

**`/shift/notes/[id]` - single note view**

Full-screen note for one encounter. All 13 sections in scroll order. Back -> list.
Tablet: split-pane (list left, note right). Mobile: list -> tap -> full-screen.

### Access points

1. Bottom nav - persistent across all shift screens
2. Shift dashboard encounter card - "Note" button
3. Encounter capture screen - "Note" button in header
4. Robin toasts - "[View Note]" tap navigates to `/shift/notes/[id]`
5. Voice - "Robin, show me [patient]'s note"

### Single note view layout

**Header:**
```
[<- Notes]        JOHNSON - RM 4                   [Edit]  [Finalize]
                 Belly pain - 56M - 1h 22m
```

**Section card:**
```
+--------------------------------------------------+
| PHYSICAL EXAMINATION                    [Edit]   |
| ------------------------------------------------ |
| General: Alert and oriented, no acute distress.  |
| Abdomen: Soft, tender to palpation RLQ...        |
|                                       Robin - 2m |
+--------------------------------------------------+
```

Attribution line (bottom right): `Robin - 2m ago` | `You - 5m ago`
Empty sections: muted placeholder text + amber badge if flagged.

**Tabs:**
| Tab | Content |
|---|---|
| Note | Full structured note, all 13 sections |
| Billing | E&M assessment, MDM scaffold, RVU display |
| Discharge | Discharge instructions - separate from note body |

### Edit mode

Tapping [Edit] on any section opens a per-section editor:
```
+--------------------------------------------------+
| PHYSICAL EXAMINATION                             |
| +--------------------------------------------+  |
| | General: Alert and oriented, no acute...   |  |
| +--------------------------------------------+  |
| [Ask Robin]                  [Cancel]  [Save]   |
+--------------------------------------------------+
```

- **[Ask Robin]** - opens Robin chat inline, pre-contexted to this section and encounter.
  Robin edits within the session. Physician sees a diff preview before applying.
- [Save] triggers conflict resolution check and writes via `/api/note/section`
- Conflict resolution runs on every physician save (see Note Conflict Resolution above)

### Final Diagnosis - ICD-10 integration

Free-text dictation mapped to ICD-10 automatically.

**Section display:**
```
+--------------------------------------------------+
| FINAL DIAGNOSIS                         [Edit]   |
| Acute appendicitis with perforation              |
| ICD-10: K35.2                          Robin - 4m|
+--------------------------------------------------+
```

**High confidence (>= 0.85):** Auto-write. Toast: "Coded K35.2 - Acute appendicitis with
perforation. [Change]"

**Low confidence (< 0.85):** ICD-10 selection card - max 5 options, one-tap:
```
+----------------------------------------------------+
| ICD-10 for Johnson - which fits best?              |
| K35.2   Acute appendicitis with perforation        |
| K35.89  Acute appendicitis without abscess         |
| K37     Unspecified appendicitis                   |
|                                            [Other] |
+----------------------------------------------------+
```

[Other] opens free-text field. [Recode] button in edit mode re-runs mapping after physician amends.

No ICD-10 match: write free-text only, amber `Dx` badge, "Tap to add code manually."

### Consult section display

```
+--------------------------------------------------+
| CONSULTS                                [+Add]   |
| Orthopedic Surgery                               |
| Logged 14:32 - Recommendations pending           |
|                                                  |
| Hospitalist - Dr. Spock                          |
| Accepted 15:10                                   |
| Non-operative management, follow-up in 5 days.  |
+--------------------------------------------------+
```

[+Add] for manual entry. "Recommendations pending" clears when physician dictates recommendations.

### Note completion badges

Visible on encounter list cards and as a summary strip at top of single note view.

| Badge | Condition | Color |
|---|---|---|
| `PE` | Physical exam empty | Amber |
| `MDM` | MDM empty, encounter > 20 min | Amber |
| `Dx` | Final diagnosis empty | Amber |
| `Dispo` | Disposition empty | Amber |
| `Orders` | Orders logged, no results | Muted |
| `Consult` | Consult logged, no recommendations | Muted |
| `Complete` | All required sections populated | Teal |

Required for `Complete`: CC, HPI, PE, MDM, Final Diagnosis, Disposition.
ROS, Procedures, ED Course, Consults, Labs are additive - absence doesn't block `Complete`.

### Finalization flow

**Step 1 - Physician taps [Finalize]**

`/api/note/finalize`:
- Reads all populated sections
- Fills minor inferable gaps (CC from chief_complaint field, etc.)
- Polishes prose for consistency - does not invent clinical content
- Returns polished full note string
- Writes `finalized_at` timestamp

**Step 2 - Copy modal:**
```
+--------------------------------------------------+
| Note Ready                                        |
| [Copy Full Note]                                  |
|                                                   |
| Or copy by section:                               |
| [CC + HPI]  [PE]  [MDM]  [Procedures]  [Dispo]  |
|                    [Done]  [Back to Edit]         |
+--------------------------------------------------+
```

Copy mode (full vs. sections) controlled by `robin_preferences.copy_mode`. Physician
pastes directly into their EHR - no EHR integration required.

Post-finalization: sections read-only. Robin can still write if physician asks - requires
re-finalization for updated copy.

### New routes: Note Dashboard

**`/api/note/section` (PATCH)** - Auth-gated. Updates a specific note section.
```typescript
{
  encounterId:  string;
  section:      keyof EncounterNote;
  content:      string | object;
  operation:    'set' | 'append';
  updatedBy:    'robin' | 'physician';
  noteVersion:  number;             // conflict detection
}
```

**`/api/note/finalize` (POST)** - Auth-gated. Polishes accumulated note. Returns copy-ready string.

**`/api/note/status` (GET)** - Auth-gated. Returns badge state for all shift encounters
without fetching full note content.
```typescript
// ?shiftId=xxx
{
  encounters: [{
    encounterId:      string;
    patientIdentifier: string;
    badges:           ('PE' | 'MDM' | 'Dx' | 'Dispo' | 'Orders' | 'Consult' | 'Complete')[];
    finalizedAt:      string | null;
    sectionCount:     number;
  }]
}
```

### Note Dashboard DB migrations

1. `note` jsonb column on `encounters`
2. `note_version` integer on `encounters`
3. `note_section_affected text` on `robin_actions` (extend Layer 1 table)

### Note Dashboard deliverables

1. Update `EncounterNote` + all entry interfaces in `robinTypes.ts`
2. DB migrations (above)
3. `/api/note/status` route
4. `/api/note/section` route (with conflict detection + Claude-based merge)
5. `/api/note/finalize` route
6. `/shift/notes` - encounter list view with completion badges
7. `/shift/notes/[id]` - single note view, tabbed layout
8. Edit mode - per-section editor + [Ask Robin] inline
9. [Ask Robin] panel - Robin chat pre-contexted to open section + encounter
10. Finalization flow - [Finalize] button -> polished copy -> copy modal
11. Section-by-section copy buttons
12. `copy_mode` options toggle
13. Note completion badges - list view + summary strip
14. Navigation: bottom nav tab, encounter card "Note" button, capture screen "Note" button
15. ICD-10 selection card component (max 5 options, [Other] escape hatch)
16. [Recode] button in Final Diagnosis edit mode
17. Consult section display + [+Add] manual entry
18. Voice navigation: "show me [patient]'s note" routing

---

## Layer 3 — Dashboard and Chart Agency

### Ambient Listening State Machine

`useShiftAmbient.ts` requires a formal state machine replacing single continuous mode:

```
ambient     - default; full command detection active
dictating   - physician dictating a note section; input -> dictation buffer
qa_session  - Robin running structured Q&A; input -> Q&A handler
```

**Transitions:**
```
ambient   -> dictating   : Robin detects dictation trigger
dictating -> ambient     : Done signal or silence timeout
ambient   -> qa_session  : Robin detects procedure trigger
qa_session -> ambient    : Q&A complete or physician says "cancel"
dictating <-> qa_session  : NOT permitted - finish current session first
```

### Dictation session - two Deepgram connections

**Architecture decision:** Middle path - ambient stream stays open for the full shift.
A second short-lived Deepgram connection opens at dictation session start with
dictation-optimized parameters (diarization off, higher `utterance_end_ms`, lower
`endpointing` aggressiveness), then closes when the session ends.

Ambient stream continues in background during dictation - listens for done-signal and
emergency commands only. Two simultaneous WebSockets avoided since dictation sessions
are brief (30-90 seconds).

**Accepted tradeoff:** ~300-500ms handshake latency at dictation open. Trigger phrase
("MDM for Johnson is as follows") provides natural cover time. Validate in WoZ testing.

**Dictation close signals (any):**
1. Physician says "done", "that's it", "okay Robin", "end dictation"
2. 6 consecutive seconds silence after >=1 sentence (tuning required - WoZ before coding)
3. UI tap on "Done" button

**Critical:** Dictation buffer is separate from ambient transcript buffer. Dictation content
does not appear in encounter transcript as physician speech - goes directly to note section.
Prevents MDM re-analysis treating physician narration as encounter content.

### Q&A session close signals

1. All required questions answered
2. Physician says "cancel" or "never mind"
3. No response for 15 seconds on any question (Robin re-asks once, then exits with partial data)

---

### Voice Command Taxonomy

#### Physical Exam - `physical_exam`

**Patterns:**
- "Physical exam for [patient] is [findings]"
- "Exam for [patient]: [findings]"
- "Robin, I have some physical exams for you" -> batch mode

**Patient identification priority:**
1. Named patient -> fuzzy match active encounters
2. Room -> exact match
3. No patient specified -> most recently created encounter
4. Ambiguity -> push button disambiguation card

**Normal flow:** Robin opens dictation session -> physician dictates -> Robin structures
into PE template -> writes to `physical_exam` section.

**Batch mode - "Robin, I have some physical exams for you":**

Robin surfaces a multi-PE card - not a voice prompt:
```
+-------------------------------------------------+
|  Physical Exams Needed                           |
|  [Johnson - Rm 4]  [Rivas - Rm 6]  [Smith - Rm 2]|
|  Tap a patient to dictate.                       |
+-------------------------------------------------+
```
Physician taps -> Robin: "Go ahead." -> Dictation opens -> On close, returns to multi-PE card.
After all tapped or 10 seconds idle -> card dismisses -> ambient resumes.

**Dashboard indicator:** Encounter cards with no PE show amber `PE` badge.

**Disambiguation card:**
```
+-------------------------------------------------+
|  Which encounter?                                |
|  [New encounter]  [Johnson - Rm 4]  [Smith - Rm 2]|
+-------------------------------------------------+
```

---

#### EKG Interpretation - `ekg_interpretation`

**Patterns:**
- "Normal EKG for [patient]" -> shorthand flow
- "Add EKG for [patient]" -> dictation flow
- "[Patient]'s EKG shows [findings]" -> inline capture

**Normal shorthand:** Robin generates standard normal EKG from KB template (verbosity
controlled by `robin_preferences.ekg_normal_verbosity`). Timestamps, writes to
`diagnostic_results.ekgs`. Toast: "Normal EKG logged for Johnson at [time]."

**Dictation flow:** Robin opens brief session -> physician reads findings -> Robin structures
into EKG template -> writes entry.

**EKG template (KB-defined):**
```
EKG - [time]
Rate:        [X] bpm
Rhythm:      [sinus rhythm | afib | flutter | other]
Axis:        [normal | left | right | extreme]
Intervals:   PR [X]ms | QRS [X]ms | QTc [X]ms
ST segments: [no changes | elevation | depression] - [leads if abnormal]
T-waves:     [upright | inversions] - [leads if abnormal]
Conduction:  [no BBB | LBBB | RBBB | hemiblock]
Comparison:  [no prior | unchanged | new changes vs prior]
Impression:  [summary]
```

---

#### MDM Dictation - `mdm_dictation`

**Patterns:**
- "MDM for [patient] is as follows"
- "Update MDM for [patient]"

Robin opens dictation. Physician dictates freely.

**Behavior by `robin_preferences.mdm_dictation_mode`:**
- `verbatim`: transcribe as-is -> write directly to `mdm` section
- `structured`: integrate into AMA 2021-compliant format -> show preview card before writing

**Preview card (structured mode):**
> "Here's your MDM - [1-line summary]. Looks good? [Confirm] [Edit]"

---

#### Reassessment / ED Course - `ed_course`

**Patterns:**
- "Add a reassessment for [patient]"
- "Reassessment for [patient]"

Robin opens dictation -> physician dictates interval findings -> Robin timestamps and
appends to `ed_course` array as `entry_type: 'reassessment'`. MDM note: timestamped
reassessment logged as a data point (supports complexity for re-evaluation encounters).

---

#### Orders / Labs - `order_log`

**Patterns:**
- "Robin, I'm adding labs for [patient]"
- "I ordered [test] for [patient]"
- "Imaging for [patient]"

Auto-tier. Robin writes timestamped `OrderEntry` to `orders` array. Flags MDM-relevant.
Toast: "Labs logged for Johnson."

No dictation session - log entry only. Detail captured during MDM dictation or explicitly.

---

#### Lab Results - `lab_results`

**Patterns:**
- "Labs back for [patient]: [dictated results]"
- "Robin, lab results for [patient]"

Robin opens brief dictation -> physician reads results -> writes `LabResultEntry` to `labs`.

---

#### Radiology - `radiology`

**Patterns:**
- "Radiology for [patient]: [dictated result]"
- "CT read for [patient]: [dictated result]"
- "XR for [patient] shows [dictated result]"
- "Robin, radiology for [patient]" -> opens dictation

Robin opens brief dictation -> structures into `RadiologyEntry` -> writes to
`diagnostic_results.radiology`. `study_type` extracted from command phrase.

---

#### Discharge Instructions - `discharge_instructions`

**Patterns:**
- "Prepare discharge instructions for [patient]"
- "DC instructions for [patient]"

Robin generates from encounter context (diagnosis, demographics) using KB-backed
condition-specific return precautions templates. No dictation. Preview toast:
"Discharge instructions ready for Johnson. [View]"

Common EM templates in KB: abdominal pain, chest pain, headache, extremity injury,
urinary complaints, soft tissue infections, and others. Robin selects by chief complaint
/ diagnosis, customizes with patient-specific details.

---

#### Procedure Notes - `procedure_note`

**Patterns:**
- "I just did a [procedure] for [patient]"
- "I performed a [procedure] on [patient]"

Robin opens Q&A session. KB-defined question sequence per procedure type.
Assembles structured procedure note from answers. Writes to `procedures` array.

**Procedure library - minimum viable set (KB-defined):**

**Procedural Sedation + Closed Reduction**
Triggers: "sedation", "procedural sedation", "conscious sedation", "closed reduction"
Questions: extremity/injury type -> sedation agent/dose -> pre-procedure vitals ->
complications -> successful reduction -> post-reduction neurovascular check ->
post-procedure XR -> time to baseline mental status -> disposition

**Laceration Repair**
Triggers: "lac repair", "laceration", "sutures", "staples", "wound closure"
Questions: location/length -> irrigation -> closure method -> suture type/count ->
wound appearance -> tetanus status -> wound care/follow-up instructions

**I&D**
Triggers: "I&D", "incision and drainage", "abscess", "drained"
Questions: location/size -> anesthesia -> incision size/orientation -> drainage volume ->
loculations -> wound packed -> culture sent -> complications

**Intubation / RSI**
Triggers: "intubated", "RSI", "rapid sequence", "intubation"
Questions: indication -> pre-oxygenation -> RSI agents/doses -> blade/tube size ->
grade of view -> attempts -> confirmation method -> vent settings -> complications

**Splinting**
Triggers: "splinted", "splint applied", "applied a splint"
Questions: location/type -> pre-splint neurovascular status -> post-splint neurovascular
status -> XR findings

**Procedure note format:**
```
PROCEDURE: [type]
Date/Time: [timestamp]
Indication: [from context or Q&A]
Anesthesia: [if applicable]
Procedure:
  [Q&A answers assembled into narrative prose]
Complications: [none | listed]
Patient tolerated procedure [well | with noted complications].
Disposition: [from Q&A]
```

---

#### Consult Detection - `consult_log` (passive ambient)

**Critical distinction:** Consult commands are passively detected - physician is narrating
something that already happened, not issuing an explicit Robin command. No wake word.

Robin maintains a medical service vocabulary and watches for: **[service] + [action verb] +
[optional patient reference]** in the ambient stream.

**Detection patterns:**
- "[Service] called for [patient]" - "Ortho surgery called for Johnson"
- "[Service] accepted [patient]" - "Hospitalist accepted Mr. Smith"
- "[Physician] from [service] accepted [patient]"
- "[Service] is coming to see [patient]"
- "Spoke with [service] about [patient]"
- "[Service] on board for [patient]"

**On detection (confidence >= 0.75):** Auto-log. Creates `ConsultEntry` with service,
physician (if named), timestamp. `recommendations` null until dictated separately.
Toast: "Consult logged - Ortho Surgery for Johnson. [View Note]"

**Recommendations dictation:**
Pattern: "[service] recommendations for [patient]: [dictated text]"
Robin writes to `consults[n].recommendations` for matching consult entry.

---

#### Final Diagnosis - `final_diagnosis`

**Patterns:**
- "Final diagnosis for [patient] is [text]" -> single-breath capture
- "Diagnosis for [patient]: [text]"
- "Robin, final diagnosis for [patient]" -> opens brief dictation (3s silence close)

Robin maps to ICD-10 via Claude. High confidence -> auto-write + [Change] toast.
Low confidence -> ICD-10 selection card (see Note Dashboard section).

---

#### Name / Demographics - `encounter_update`

**Patterns:**
- "Change encounter one's name to Gonzalez"
- "Add the last name Gonzalez to encounter one"

"Encounter one/two/three" = chronological order within the shift.

Tier: Confirm. "Update encounter 1's name to Gonzalez? [Confirm] [Cancel]"

---

#### Scratch That / Undo - `voice_undo`

**Patterns:** "Robin, scratch that" | "Robin, undo that" | "Undo"

Reverts last Robin action for current shift. Pulls `previous_state` from most recent
`robin_actions` entry. Calls `/api/agent/undo`.

Auto-tier - immediate. Toast includes [Redo] with 10-second window.
Scope: last Robin action only, regardless of patient. For earlier actions -> use Remove.
Physician manual edits are not undoable via voice.

---

#### Remove - `voice_remove`

**Patterns:**
- "Robin, remove the last EKG for [patient]"
- "Remove the last reassessment for [patient]"
- "Clear the PE for [patient]"

| Target | Tier | Action |
|---|---|---|
| Array entry (EKG, procedure, ED course) | Auto | Remove most recent + [Undo] toast |
| Static section (PE, MDM, HPI, etc.) | Confirm | "Clear PE for Johnson? [Confirm] [Cancel]" |

All removals logged to `robin_actions` with `previous_state` - undoable via "scratch that."

---

### `/api/agent/undo` Route

POST. Auth-gated. Body: `{ actionId: string }`

1. Fetch `robin_actions` row
2. Verify `shift_id` belongs to authenticated physician
3. Restore `previous_state` to affected section or encounter field
4. Increment `note_version`
5. Write new `robin_actions` row: `action_type: 'undo'`, `previous_state` = pre-undo state
6. Return `{ ok: true, restoredSection: string }`

Redo: call `/api/agent/undo` on the undo action row itself. No separate redo route.

---

### `/api/agent/procedure-qa` Route

POST. Auth-gated. Streaming.
Runs one Q&A turn. Client sends question index + answer; server returns next question
or signals complete.

```typescript
// Body
{
  encounterId:     string;
  procedureType:   string;
  questionIndex:   number;
  answer:          string;
  previousAnswers: Record<string, string>;
}
// Response
{ nextQuestion: string | null, complete: boolean, procedureNote?: string }
```

`procedureNote` returned on final turn. Written to `procedures` array by client.

---

### Encounter Identification

All Layer 3 commands identify encounters by:
1. Name -> fuzzy match active encounters
2. Room -> exact match
3. Number ("encounter one") -> chronological order in shift
4. Recency ("the last patient") -> most recently created encounter
5. Ambiguous -> force Confirm-tier regardless of action tier (confidence < 0.85 on ID)

Two encounters with same last name: always Confirm-tier.
"Which Johnson - Room 4 or Room 7?" shown in disambiguation card.

---

### Action Tier Summary

| Command | Tier | Session |
|---|---|---|
| Patient briefing (high confidence) | Auto | - |
| Patient briefing (uncertain) | Confirm | Confirm card |
| Disposition (high confidence) | Auto | - |
| Disposition (uncertain) | Confirm | Confirm card |
| "Add EKG" - normal shorthand | Auto | - |
| "Add EKG" - dictated | Auto | Dictation |
| "Robin, I'm adding labs" | Auto | - |
| "Lab results for [patient]" | Auto | Dictation |
| "Radiology for [patient]" | Auto | Dictation |
| "Add reassessment" | Auto | Dictation |
| "Physical exam for [patient]" | Auto | Dictation |
| "Robin, I have physical exams" | Auto | Batch UI + dictation |
| "MDM for patient is as follows" (verbatim) | Auto | Dictation |
| "MDM for patient is as follows" (structured) | Confirm | Dictation -> preview card |
| "Prepare discharge instructions" | Auto | - (generated) |
| "I just did [procedure]" | Auto | Q&A session |
| Consult detected (high confidence) | Auto | - (passive) |
| Consult detected (ambiguous patient) | Confirm | Disambiguation card |
| Consult recommendations | Auto | Dictation |
| "Final diagnosis for [patient]" (high confidence ICD-10) | Auto | - |
| "Final diagnosis for [patient]" (low confidence ICD-10) | Auto | Selection card |
| "Change encounter name to X" | Confirm | - |
| "Scratch that" / "Undo" | Auto | - (immediate + [Redo] toast) |
| "Remove last [array entry]" | Auto | - (immediate + [Undo] toast) |
| "Clear [static section]" | Confirm | Confirm card |
| Any command - ambiguous patient | Confirm | Disambiguation card |
| Any command - confidence < 0.75 | Confirm | Confirm card |
| Any unrecognized command | - | Robin chat fallback |

---

### Dashboard Indicators (Shift Dashboard)

| Indicator | Condition | Style |
|---|---|---|
| `PE` badge | No physical exam | Amber |
| `MDM` badge | MDM empty, encounter > 20min | Amber |
| `Dx` badge | Final diagnosis empty | Amber |
| `Dispo` badge | Disposition empty | Amber |
| `EKG` badge | EKG logged, not fully interpreted | Amber |
| `Consult` | Consult logged, recommendations pending | Muted |
| Section count | e.g., "6 sections" | Muted - always visible |
| Procedure flag | Procedure logged | Teal |

---

### Layer 3 DB Migrations

*(Layer 1 and Note Dashboard migrations are prerequisites)*

All required columns and tables are covered by Layer 1 and Note Dashboard migrations.
No new migrations unique to Layer 3 - it extends existing tables and routes only.

### Layer 3 deliverables

1. `useShiftAmbient.ts` - state machine refactor: `ambient | dictating | qa_session`
2. Dictation session: two-connection pattern, open/close logic, silence timeout
3. `/api/agent/act` - expand with `dashboard_action`, `chart_action` command types
4. `/api/agent/undo` route
5. `/api/agent/procedure-qa` route + procedure KB (5 procedures minimum)
6. Encounter identification logic - name/room/number/recency fuzzy match
7. Tier classification - server-side, all command types
8. Physical exam batch mode card component
9. Disambiguation push-button card component
10. EKG interpretation handler (normal shorthand + dictation)
11. MDM dictation handler (verbatim + structured modes + preview card)
12. ED Course / reassessment handler
13. Order log handler
14. Lab results dictation handler
15. Radiology dictation handler
16. Discharge instructions generator (KB-backed templates)
17. Procedure Q&A session manager
18. Consult passive detection - service vocabulary + action verb matching
19. Consult recommendations dictation handler
20. Final diagnosis handler + ICD-10 mapping via Claude
21. Name/demographics update handler
22. Voice undo handler ("scratch that") + [Redo] toast
23. Voice remove handler (array entry auto / static section confirm)

---

## Implementation Order Rationale

### Layer 2 first
Zero risk. Personalization makes Layers 1 and 3 materially more accurate from day one.
Builds physician trust in Robin's conversational mode before Robin writes autonomously.

### Layer 1 second
Extends existing detection infrastructure minimally. `robin_actions` audit table is a
prerequisite for Layer 3. Closes the most visible gap. Lower blast radius than Layer 3.

### Note Dashboard third
The living note architecture must exist before Layer 3 voice commands have anywhere to
write. The note dashboard is the write target for the majority of Layer 3 commands.
Building it before Layer 3 also gives the physician a surface to verify Robin's output
during early Layer 3 use - critical for trust calibration.

### Layer 3 last
Highest blast radius. Requires Layer 1 audit table and Note Dashboard write target.
Requires undo capability. Benefits most from physician having used Layers 1 and 2 first.

---

## Open Questions

### Layer 2
- [ ] Does the interview re-trigger if `interview_version` bumps (schema change)? Or do existing physicians get a targeted "new preference" prompt instead of a full re-interview?
- [ ] Where does "redo my preferences" live before `/settings` is built?

### Layer 1
- [ ] Multi-patient briefings ("About to see Johnson and Rivas"): single parse call or split into separate requests?
- [ ] If Robin creates an encounter and physician never opens it - auto-archive after how long?
- [ ] Should `created_by_robin` encounters display with a visual distinction on the shift dashboard?

### Layer 3
- [ ] Silence timeout - 6 seconds proposed for dictation close. Validate in WoZ before coding.
- [ ] Procedure Q&A - voice-only answers or hybrid voice + tap shortcuts?
- [ ] Structured MDM preview card - render inline in note view or as overlay on capture screen?
- [x] Dictation audio - RESOLVED: middle path (ambient stream stays open; second short-lived connection for dictation sessions)
- [x] Note conflict resolution - RESOLVED: physician version is base, Claude-based semantic merge, strictly additive
- [x] Note UI placement - RESOLVED: separate note dashboard at `/shift/notes`
