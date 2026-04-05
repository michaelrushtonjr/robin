"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useParams } from "next/navigation";
import type {
  EncounterNote,
  NoteSection,
  NoteBadge,
} from "@/lib/robinTypes";
import { computeNoteBadges } from "@/lib/robinTypes";

type Tab = "note" | "billing" | "discharge";

function BadgePill({ badge }: { badge: NoteBadge }) {
  const isComplete = badge === "Complete";
  const isMuted = badge === "Orders" || badge === "Consult";
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-bold font-space-mono uppercase tracking-wider"
      style={{
        backgroundColor: isComplete
          ? "var(--teal-dim)"
          : isMuted
            ? "var(--surface2)"
            : "var(--amber-dim)",
        color: isComplete
          ? "var(--teal)"
          : isMuted
            ? "var(--muted)"
            : "var(--amber)",
      }}
    >
      {badge}
    </span>
  );
}

function SectionCard({
  label,
  section,
  onEdit,
}: {
  label: string;
  section: NoteSection | null;
  onEdit: () => void;
}) {
  const hasContent = section?.content;
  const updatedBy = section?.updated_by;
  const lastUpdated = section?.last_updated_at;

  return (
    <div
      className="rounded-[14px] p-3"
      style={{
        backgroundColor: "var(--surface)",
        border: `1px solid ${hasContent ? "var(--border)" : "var(--border2)"}`,
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <p
          className="text-[10px] font-bold font-space-mono uppercase tracking-widest"
          style={{ color: hasContent ? "var(--text)" : "var(--muted)" }}
        >
          {label}
        </p>
        <button
          onClick={onEdit}
          className="text-[10px] font-syne font-semibold"
          style={{ color: "var(--robin)" }}
        >
          Edit
        </button>
      </div>
      {hasContent ? (
        <>
          <p
            className="text-sm font-syne whitespace-pre-wrap leading-relaxed"
            style={{ color: "var(--text)" }}
          >
            {section!.content}
          </p>
          {lastUpdated && (
            <p
              className="text-[10px] font-space-mono mt-2 text-right"
              style={{ color: "var(--muted)" }}
            >
              {updatedBy === "physician" ? "You" : "Robin"} &middot;{" "}
              {timeAgo(lastUpdated)}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm font-syne italic" style={{ color: "var(--muted)" }}>
          Not documented yet
        </p>
      )}
    </div>
  );
}

function ArraySectionCard({
  label,
  items,
  renderItem,
}: {
  label: string;
  items: unknown[];
  renderItem: (item: unknown, i: number) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div
      className="rounded-[14px] p-3"
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      <p
        className="text-[10px] font-bold font-space-mono uppercase tracking-widest mb-2"
        style={{ color: "var(--text)" }}
      >
        {label}
      </p>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i}>{renderItem(item, i)}</div>
        ))}
      </div>
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const mins = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 60000
  );
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

interface Encounter {
  id: string;
  chief_complaint: string | null;
  room: string | null;
  patient_name: string | null;
  age: number | null;
  gender: string | null;
  note: EncounterNote | null;
  created_at: string;
  status: string;
  mdm_data: Record<string, unknown> | null;
  generated_note: string | null;
}

export default function SingleNoteView() {
  const supabase = createClient();
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("note");
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const loadEncounter = useCallback(async () => {
    const { data } = await supabase
      .from("encounters")
      .select("*")
      .eq("id", id)
      .single();

    if (data) setEncounter(data as Encounter);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    loadEncounter();
  }, [loadEncounter]);

  const note = encounter?.note as EncounterNote | null;
  const badges = encounter
    ? computeNoteBadges(note, encounter.created_at)
    : [];

  async function handleSaveSection() {
    if (!editingSection || !encounter) return;
    setSaving(true);

    await fetch("/api/note/section", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encounterId: encounter.id,
        section: editingSection,
        content: editContent,
        operation: "set",
        updatedBy: "physician",
        noteVersion: note?.note_version,
      }),
    });

    setEditingSection(null);
    setEditContent("");
    setSaving(false);
    await loadEncounter();
  }

  async function handleFinalize() {
    if (!encounter) return;
    setFinalizing(true);

    const res = await fetch("/api/note/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encounterId: encounter.id }),
    });

    if (res.ok) {
      await loadEncounter();
    }
    setFinalizing(false);
  }

  async function copyToClipboard(text: string) {
    await navigator.clipboard.writeText(text);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  }

  function startEdit(section: string, currentContent: string | null) {
    setEditingSection(section);
    setEditContent(currentContent || "");
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div
          className="h-8 w-8 rounded-full animate-pulse"
          style={{ backgroundColor: "var(--robin-dim)" }}
        />
      </div>
    );
  }

  if (!encounter) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <p className="text-sm font-syne" style={{ color: "var(--muted)" }}>
          Encounter not found.
        </p>
      </div>
    );
  }

  const demo = [encounter.age, encounter.gender].filter(Boolean).join("");
  const headerLabel =
    encounter.patient_name ||
    (demo ? `${demo}` : `Encounter`);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 pb-28 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/shift/notes")}
            className="text-sm font-syne"
            style={{ color: "var(--muted)" }}
          >
            &larr; Notes
          </button>
        </div>
        <div className="flex items-center gap-2">
          {note?.finalized_at ? (
            <span
              className="text-[10px] font-bold font-space-mono uppercase"
              style={{ color: "var(--teal)" }}
            >
              Finalized
            </span>
          ) : (
            <button
              onClick={handleFinalize}
              disabled={finalizing}
              className="px-3 py-1.5 rounded-[10px] font-syne font-bold text-xs text-white transition-all active:scale-95 disabled:opacity-50"
              style={{ backgroundColor: "var(--robin)" }}
            >
              {finalizing ? "Finalizing..." : "Finalize"}
            </button>
          )}
        </div>
      </div>

      {/* Patient info */}
      <div
        className="rounded-[18px] p-4"
        style={{
          backgroundColor: "var(--surface)",
          border: "1px solid var(--border)",
        }}
      >
        <p
          className="font-syne font-bold text-base"
          style={{ color: "var(--text)" }}
        >
          {headerLabel}
          {encounter.room ? ` — Rm ${encounter.room}` : ""}
        </p>
        <p
          className="text-xs font-syne mt-0.5"
          style={{ color: "var(--muted)" }}
        >
          {encounter.chief_complaint || "No chief complaint"} &middot;{" "}
          {timeAgo(encounter.created_at)}
        </p>
        <div className="flex flex-wrap gap-1 mt-2">
          {badges.map((b) => (
            <BadgePill key={b} badge={b} />
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {(["note", "billing", "discharge"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-4 py-2 rounded-[10px] text-xs font-syne font-semibold capitalize transition-all"
            style={{
              backgroundColor:
                tab === t ? "var(--robin-dim)" : "var(--surface2)",
              color: tab === t ? "var(--robin)" : "var(--muted)",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Edit modal */}
      {editingSection && (
        <div
          className="rounded-[14px] p-4 space-y-3"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border2)",
          }}
        >
          <p
            className="text-[10px] font-bold font-space-mono uppercase tracking-widest"
            style={{ color: "var(--text)" }}
          >
            {editingSection.replace(/_/g, " ")}
          </p>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={6}
            className="w-full rounded-[10px] border px-3 py-2.5 text-sm font-syne focus:outline-none resize-none"
            style={{
              borderColor: "var(--border2)",
              backgroundColor: "var(--surface2)",
              color: "var(--text)",
            }}
          />
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => setEditingSection(null)}
              className="px-3 py-1.5 rounded-[10px] border text-xs font-syne font-semibold"
              style={{ borderColor: "var(--border2)", color: "var(--muted)" }}
            >
              Cancel
            </button>
            <button
              onClick={handleSaveSection}
              disabled={saving}
              className="px-3 py-1.5 rounded-[10px] text-xs font-syne font-bold text-white disabled:opacity-50"
              style={{ backgroundColor: "var(--robin)" }}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Tab: Note */}
      {tab === "note" && (
        <div className="space-y-2">
          <SectionCard
            label="Chief Complaint"
            section={note?.chief_complaint ?? null}
            onEdit={() =>
              startEdit("chief_complaint", note?.chief_complaint?.content ?? null)
            }
          />
          <SectionCard
            label="HPI"
            section={note?.hpi ?? null}
            onEdit={() => startEdit("hpi", note?.hpi?.content ?? null)}
          />
          <SectionCard
            label="Review of Systems"
            section={note?.review_of_systems ?? null}
            onEdit={() =>
              startEdit(
                "review_of_systems",
                note?.review_of_systems?.content ?? null
              )
            }
          />
          <SectionCard
            label="Physical Examination"
            section={note?.physical_exam ?? null}
            onEdit={() =>
              startEdit("physical_exam", note?.physical_exam?.content ?? null)
            }
          />

          <ArraySectionCard
            label="Orders"
            items={note?.orders ?? []}
            renderItem={(item) => {
              const o = item as { description: string; order_type: string };
              return (
                <p className="text-sm font-syne" style={{ color: "var(--text)" }}>
                  {o.description}{" "}
                  <span
                    className="text-[10px] font-space-mono"
                    style={{ color: "var(--muted)" }}
                  >
                    {o.order_type}
                  </span>
                </p>
              );
            }}
          />

          <ArraySectionCard
            label="EKGs"
            items={note?.diagnostic_results?.ekgs ?? []}
            renderItem={(item) => {
              const e = item as { interpretation: string };
              return (
                <p
                  className="text-sm font-syne whitespace-pre-wrap"
                  style={{ color: "var(--text)" }}
                >
                  {e.interpretation}
                </p>
              );
            }}
          />

          <ArraySectionCard
            label="Radiology"
            items={note?.diagnostic_results?.radiology ?? []}
            renderItem={(item) => {
              const r = item as {
                study_type: string;
                result: string | null;
              };
              return (
                <p className="text-sm font-syne" style={{ color: "var(--text)" }}>
                  <span className="font-semibold">{r.study_type}:</span>{" "}
                  {r.result || "pending"}
                </p>
              );
            }}
          />

          <ArraySectionCard
            label="Labs"
            items={note?.labs ?? []}
            renderItem={(item) => {
              const l = item as { content: string };
              return (
                <p className="text-sm font-syne" style={{ color: "var(--text)" }}>
                  {l.content}
                </p>
              );
            }}
          />

          <SectionCard
            label="MDM"
            section={note?.mdm ?? null}
            onEdit={() => startEdit("mdm", note?.mdm?.content ?? null)}
          />

          <ArraySectionCard
            label="Procedures"
            items={note?.procedures ?? []}
            renderItem={(item) => {
              const p = item as {
                procedure_type: string;
                procedure_note: string;
              };
              return (
                <div>
                  <p
                    className="text-[10px] font-bold font-space-mono uppercase"
                    style={{ color: "var(--muted)" }}
                  >
                    {p.procedure_type}
                  </p>
                  <p
                    className="text-sm font-syne whitespace-pre-wrap"
                    style={{ color: "var(--text)" }}
                  >
                    {p.procedure_note}
                  </p>
                </div>
              );
            }}
          />

          <ArraySectionCard
            label="ED Course"
            items={note?.ed_course ?? []}
            renderItem={(item) => {
              const e = item as { content: string; entry_type: string };
              return (
                <p className="text-sm font-syne" style={{ color: "var(--text)" }}>
                  <span
                    className="text-[10px] font-space-mono uppercase"
                    style={{ color: "var(--muted)" }}
                  >
                    {e.entry_type}
                  </span>{" "}
                  {e.content}
                </p>
              );
            }}
          />

          <ArraySectionCard
            label="Consults"
            items={note?.consults ?? []}
            renderItem={(item) => {
              const c = item as {
                consulting_service: string;
                consulting_physician: string | null;
                recommendations: string | null;
              };
              return (
                <div>
                  <p
                    className="text-sm font-syne font-semibold"
                    style={{ color: "var(--text)" }}
                  >
                    {c.consulting_service}
                    {c.consulting_physician
                      ? ` — ${c.consulting_physician}`
                      : ""}
                  </p>
                  <p
                    className="text-sm font-syne"
                    style={{ color: "var(--muted)" }}
                  >
                    {c.recommendations || "Recommendations pending"}
                  </p>
                </div>
              );
            }}
          />

          <SectionCard
            label="Final Diagnosis"
            section={note?.final_diagnosis ?? null}
            onEdit={() =>
              startEdit(
                "final_diagnosis",
                note?.final_diagnosis?.content ?? null
              )
            }
          />
          <SectionCard
            label="Disposition"
            section={note?.disposition ?? null}
            onEdit={() =>
              startEdit("disposition", note?.disposition?.content ?? null)
            }
          />
        </div>
      )}

      {/* Tab: Billing */}
      {tab === "billing" && (
        <div className="space-y-3">
          {encounter.mdm_data ? (
            <div
              className="rounded-[14px] p-4"
              style={{
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
              }}
            >
              <p
                className="text-[10px] font-bold font-space-mono uppercase tracking-widest mb-2"
                style={{ color: "var(--text)" }}
              >
                MDM Scaffold
              </p>
              <pre
                className="text-xs font-space-mono whitespace-pre-wrap"
                style={{ color: "var(--muted)" }}
              >
                {JSON.stringify(encounter.mdm_data, null, 2)}
              </pre>
            </div>
          ) : (
            <div
              className="rounded-[14px] p-8 text-center"
              style={{
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
              }}
            >
              <p
                className="text-sm font-syne"
                style={{ color: "var(--muted)" }}
              >
                No billing data yet. Complete the encounter disposition to
                generate MDM analysis.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Tab: Discharge */}
      {tab === "discharge" && (
        <div className="space-y-3">
          <SectionCard
            label="Discharge Instructions"
            section={note?.discharge_instructions ?? null}
            onEdit={() =>
              startEdit(
                "discharge_instructions",
                note?.discharge_instructions?.content ?? null
              )
            }
          />
        </div>
      )}

      {/* Copy modal — appears after finalization */}
      {note?.finalized_at && encounter.generated_note && (
        <div
          className="rounded-[14px] p-4"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          <p
            className="text-[10px] font-bold font-space-mono uppercase tracking-widest mb-2"
            style={{ color: "var(--text)" }}
          >
            Finalized Note
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() =>
                copyToClipboard(encounter.generated_note!)
              }
              className="px-4 py-2 rounded-[10px] font-syne font-bold text-sm text-white transition-all active:scale-95"
              style={{
                backgroundColor: "var(--robin)",
                boxShadow: "0 2px 8px rgba(224,75,32,0.25)",
              }}
            >
              {copySuccess ? "Copied!" : "Copy Full Note"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
