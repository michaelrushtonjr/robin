"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import type { NoteBadge } from "@/lib/robinTypes";

interface NoteStatusEntry {
  encounterId: string;
  patientIdentifier: string;
  chiefComplaint: string | null;
  room: string | null;
  status: string;
  badges: NoteBadge[];
  finalizedAt: string | null;
  sectionCount: number;
  createdAt: string;
}

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

function timeAgo(dateStr: string): string {
  const mins = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 60000
  );
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

export default function NotesListPage() {
  const supabase = createClient();
  const router = useRouter();
  const [entries, setEntries] = useState<NoteStatusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [shiftId, setShiftId] = useState<string | null>(null);

  const loadNotes = useCallback(async () => {
    // Get active shift
    const { data: shifts } = await supabase
      .from("shifts")
      .select("id")
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1);

    if (!shifts || shifts.length === 0) {
      setLoading(false);
      return;
    }

    setShiftId(shifts[0].id);

    const res = await fetch(`/api/note/status?shiftId=${shifts[0].id}`);
    if (res.ok) {
      const data = await res.json();
      setEntries(data.encounters || []);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-8 w-8 rounded-full animate-pulse"
            style={{ backgroundColor: "var(--robin-dim)" }}
          />
          <p
            className="text-xs font-space-mono"
            style={{ color: "var(--muted)" }}
          >
            Loading notes...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-3xl px-4 py-6 pb-28 space-y-4"
      style={{ minHeight: "100dvh" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/shift")}
            className="text-sm font-syne"
            style={{ color: "var(--muted)" }}
          >
            &larr; Shift
          </button>
          <h1
            className="text-lg font-bold font-syne"
            style={{ color: "var(--text)" }}
          >
            Notes
          </h1>
        </div>
        <p
          className="text-xs font-space-mono"
          style={{ color: "var(--muted)" }}
        >
          {entries.length} encounter{entries.length !== 1 ? "s" : ""}
        </p>
      </div>

      {entries.length === 0 ? (
        <div
          className="rounded-[18px] p-8 text-center"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          <p className="text-sm font-syne" style={{ color: "var(--muted)" }}>
            No encounters yet. Start your shift and see patients.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, i) => (
            <button
              key={entry.encounterId}
              onClick={() =>
                router.push(`/shift/notes/${entry.encounterId}`)
              }
              className="w-full text-left rounded-[18px] p-4 transition-all active:scale-[0.99]"
              style={{
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  {/* Patient number */}
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] font-bold font-space-mono text-sm"
                    style={{
                      backgroundColor: "var(--robin-dim)",
                      color: "var(--robin)",
                    }}
                  >
                    {i + 1}
                  </div>
                  <div className="min-w-0">
                    <p
                      className="font-syne font-semibold text-sm truncate"
                      style={{ color: "var(--text)" }}
                    >
                      {entry.patientIdentifier}
                      {entry.room ? ` — Rm ${entry.room}` : ""}
                    </p>
                    <p
                      className="text-xs font-syne mt-0.5 truncate"
                      style={{ color: "var(--muted)" }}
                    >
                      {entry.chiefComplaint || "No chief complaint"}
                    </p>
                    {/* Badges */}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {entry.badges.map((b) => (
                        <BadgePill key={b} badge={b} />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  <p
                    className="text-[10px] font-space-mono"
                    style={{ color: "var(--muted)" }}
                  >
                    {timeAgo(entry.createdAt)}
                  </p>
                  <p
                    className="text-[10px] font-space-mono mt-1"
                    style={{
                      color: entry.finalizedAt
                        ? "var(--teal)"
                        : "var(--muted)",
                    }}
                  >
                    {entry.finalizedAt ? "Finalized" : "Draft"}
                  </p>
                  <p
                    className="text-[10px] font-space-mono mt-0.5"
                    style={{ color: "var(--muted)" }}
                  >
                    {entry.sectionCount} section
                    {entry.sectionCount !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
