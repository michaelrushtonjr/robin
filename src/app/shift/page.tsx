"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useShiftAmbient } from "@/hooks/useShiftAmbient";
import RobinChat from "@/components/RobinChat";

interface Shift {
  id: string;
  started_at: string;
  status: string;
}

interface Encounter {
  id: string;
  room: string | null;
  chief_complaint: string | null;
  age: number | null;
  gender: string | null;
  status: string;
  created_at: string;
}

interface ParsedPatient {
  age: number | null;
  gender: string | null;
  chiefComplaint: string | null;
  room: string | null;
}

function patientLabel(enc: Pick<Encounter, "age" | "gender" | "chief_complaint">): string {
  const demo = [enc.age, enc.gender].filter(Boolean).join("");
  const cc = enc.chief_complaint || "No chief complaint";
  return demo ? `${demo} — ${cc}` : cc;
}

function formatShiftDuration(startedAt: string): string {
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; color: string; label: string }> = {
    active: { bg: "var(--robin-dim)", color: "var(--robin)", label: "Active" },
    documenting: { bg: "var(--amber-dim)", color: "var(--amber)", label: "Documenting" },
    completed: { bg: "rgba(0,168,150,0.08)", color: "var(--teal)", label: "Completed" },
  };
  const s = styles[status] ?? styles.active;
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[10px] font-bold font-space-mono uppercase tracking-wider"
      style={{ backgroundColor: s.bg, color: s.color }}
    >
      {s.label}
    </span>
  );
}

export default function ShiftDashboard() {
  const supabase = createClient();
  const router = useRouter();
  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRoom, setNewRoom] = useState("");
  const [newCC, setNewCC] = useState("");
  const [newAge, setNewAge] = useState("");
  const [newGender, setNewGender] = useState("");
  const [shiftTimer, setShiftTimer] = useState("00:00:00");

  const ambient = useShiftAmbient();

  const loadShift = useCallback(async () => {
    const { data: shifts } = await supabase
      .from("shifts")
      .select("*")
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1);

    if (shifts && shifts.length > 0) {
      setActiveShift(shifts[0]);
      const { data: enc } = await supabase
        .from("encounters")
        .select("*")
        .eq("shift_id", shifts[0].id)
        .order("created_at", { ascending: false });
      setEncounters(enc || []);
    } else {
      setActiveShift(null);
      setEncounters([]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadShift();
  }, [loadShift]);

  // Shift timer
  useEffect(() => {
    if (!activeShift) return;
    const id = setInterval(() => {
      setShiftTimer(formatShiftDuration(activeShift.started_at));
    }, 1000);
    setShiftTimer(formatShiftDuration(activeShift.started_at));
    return () => clearInterval(id);
  }, [activeShift]);

  // Patient numbers: 1-indexed by creation order within the shift
  const patientNumbers = useMemo(() => {
    const sorted = [...encounters].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    return new Map(sorted.map((enc, i) => [enc.id, i + 1]));
  }, [encounters]);

  // Route "patient N" reval commands directly to the right encounter
  useEffect(() => {
    if (!ambient.pendingReval) return;
    const match = ambient.pendingReval.raw.match(/patient\s+(\d+)/i);
    if (!match) return;
    const num = parseInt(match[1], 10);
    const sorted = [...encounters].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const target = sorted[num - 1];
    if (target) {
      ambient.dismissReval();
      router.push(
        `/shift/encounter/${target.id}?patient=${num}&reval=${encodeURIComponent(ambient.pendingReval.raw)}`
      );
    }
  }, [ambient.pendingReval, encounters, router, ambient]);

  // Auto-create encounter when Robin detects one from ambient
  useEffect(() => {
    if (!ambient.pendingEncounter || !activeShift) return;

    async function autoCreate() {
      const pending = ambient.confirmPendingEncounter();
      if (!pending) return;

      const { data } = await supabase
        .from("encounters")
        .insert({
          shift_id: activeShift!.id,
          chief_complaint: pending.chiefComplaint,
          transcript: pending.transcript,
          status: "active",
        })
        .select()
        .single();

      if (data) setEncounters((prev) => [data, ...prev]);
    }

    autoCreate();
  }, [ambient.pendingEncounter, activeShift, supabase, ambient]);

  // Handle patient briefing — parse and bulk-create encounters
  useEffect(() => {
    if (!ambient.pendingBriefing || !activeShift) return;

    const briefing = ambient.pendingBriefing;
    ambient.dismissBriefing();

    async function parseBriefing() {
      const res = await fetch("/api/parse-patients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: briefing.raw }),
      });
      const data = await res.json();
      const patients: ParsedPatient[] = data.patients || [];
      if (patients.length === 0) return;

      const inserts = patients.map((p) => ({
        shift_id: activeShift!.id,
        chief_complaint: p.chiefComplaint,
        age: p.age,
        gender: p.gender,
        room: p.room,
        status: "active",
      }));

      const { data: created } = await supabase
        .from("encounters")
        .insert(inserts)
        .select();

      if (created) {
        setEncounters((prev) => [...created.reverse(), ...prev]);
      }
    }

    parseBriefing();
  }, [ambient.pendingBriefing, activeShift, supabase, ambient]);

  async function startShift() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("shifts")
      .insert({ physician_id: user.id })
      .select()
      .single();

    if (data) {
      setActiveShift(data);
      setEncounters([]);
    }
  }

  async function endShift() {
    if (!activeShift) return;
    ambient.stopListening();
    await supabase
      .from("shifts")
      .update({ status: "completed", ended_at: new Date().toISOString() })
      .eq("id", activeShift.id);
    setActiveShift(null);
    setEncounters([]);
  }

  async function deleteEncounter(encId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Remove this encounter?")) return;
    await supabase.from("encounters").delete().eq("id", encId);
    setEncounters((prev) => prev.filter((enc) => enc.id !== encId));
  }

  async function addEncounter(e: React.FormEvent) {
    e.preventDefault();
    if (!activeShift) return;

    const { data } = await supabase
      .from("encounters")
      .insert({
        shift_id: activeShift.id,
        room: newRoom || null,
        chief_complaint: newCC || null,
        age: newAge ? parseInt(newAge, 10) : null,
        gender: newGender || null,
      })
      .select()
      .single();

    if (data) {
      setEncounters([data, ...encounters]);
      setNewRoom("");
      setNewCC("");
      setNewAge("");
      setNewGender("");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-8 w-8 rounded-full animate-pulse"
            style={{ backgroundColor: "var(--robin-dim)" }}
          />
          <p className="text-xs font-space-mono" style={{ color: "var(--muted)" }}>
            Loading...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 pb-28 space-y-5">
      {!activeShift ? (
        /* ── No active shift ─────────────────────────────────────────────── */
        <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
          {/* Robin logo mark */}
          <div
            className="flex h-16 w-16 items-center justify-center rounded-2xl text-white font-bold font-syne text-2xl shadow-lg"
            style={{
              backgroundColor: "var(--robin)",
              boxShadow: "0 8px 24px rgba(224,75,32,0.25)",
            }}
          >
            R
          </div>

          <div>
            <h2
              className="text-2xl font-bold font-syne"
              style={{ color: "var(--text)" }}
            >
              Ready when you are.
            </h2>
            <p
              className="mt-1.5 text-sm font-syne"
              style={{ color: "var(--muted)" }}
            >
              Start your shift and Robin will help you stay on top of every patient.
            </p>
          </div>

          <button
            onClick={startShift}
            className="mt-2 px-8 py-3.5 rounded-[14px] font-syne font-bold text-white text-sm transition-all active:scale-95"
            style={{
              backgroundColor: "var(--robin)",
              boxShadow: "0 4px 16px rgba(224,75,32,0.30)",
            }}
          >
            Start Shift
          </button>
        </div>
      ) : (
        /* ── Active shift ────────────────────────────────────────────────── */
        <>
          {/* Shift header */}
          <div
            className="rounded-[18px] p-4"
            style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <div className="flex items-center justify-between">
              <div>
                <p
                  className="text-[9px] font-bold font-space-mono uppercase tracking-widest mb-1"
                  style={{ color: "var(--muted)" }}
                >
                  Shift Active
                </p>
                <p
                  className="text-2xl font-bold font-space-mono"
                  style={{ color: "var(--text)" }}
                >
                  {shiftTimer}
                </p>
                <p
                  className="text-xs font-syne mt-0.5"
                  style={{ color: "var(--muted)" }}
                >
                  Started{" "}
                  {new Date(activeShift.started_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {/* Encounter count badge */}
                <div
                  className="flex flex-col items-center px-3 py-2 rounded-[10px]"
                  style={{ backgroundColor: "var(--surface2)" }}
                >
                  <span
                    className="text-lg font-bold font-space-mono"
                    style={{ color: "var(--text)" }}
                  >
                    {encounters.length}
                  </span>
                  <span
                    className="text-[9px] font-space-mono uppercase tracking-wider"
                    style={{ color: "var(--muted)" }}
                  >
                    Pts
                  </span>
                </div>

                <button
                  onClick={endShift}
                  className="px-4 py-2.5 rounded-[12px] border font-syne font-semibold text-sm transition-all active:scale-95"
                  style={{
                    borderColor: "rgba(224,75,32,0.25)",
                    color: "var(--robin)",
                    backgroundColor: "var(--robin-dim)",
                  }}
                >
                  End Shift
                </button>
              </div>
            </div>
          </div>

          {/* Ambient listening */}
          <div
            className="rounded-[18px] p-4"
            style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {/* Status dot */}
                <div
                  className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                  style={{
                    backgroundColor: ambient.isListening
                      ? "var(--robin-dim)"
                      : "var(--surface2)",
                  }}
                >
                  {ambient.isListening && (
                    <span
                      className="absolute inset-0 rounded-full animate-ping opacity-20"
                      style={{ backgroundColor: "var(--robin)" }}
                    />
                  )}
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor: ambient.isListening
                        ? "var(--robin)"
                        : "var(--muted)",
                    }}
                  />
                </div>

                <div>
                  <p
                    className="text-sm font-bold font-syne"
                    style={{ color: "var(--text)" }}
                  >
                    Ambient Listening
                  </p>
                  <p
                    className="text-xs font-syne mt-0.5"
                    style={{ color: "var(--muted)" }}
                  >
                    {ambient.isListening
                      ? ambient.isConnected
                        ? "Robin is listening — auto-detecting new encounters"
                        : "Connecting..."
                      : "Robin will detect encounters and re-evals automatically"}
                  </p>
                </div>
              </div>

              <button
                onClick={ambient.isListening ? ambient.stopListening : ambient.startListening}
                className="shrink-0 px-4 py-2 rounded-[12px] border font-syne font-semibold text-sm transition-all active:scale-95"
                style={
                  ambient.isListening
                    ? {
                        borderColor: "rgba(224,75,32,0.25)",
                        color: "var(--robin)",
                        backgroundColor: "var(--robin-dim)",
                      }
                    : {
                        borderColor: "var(--border2)",
                        color: "var(--text)",
                        backgroundColor: "var(--surface2)",
                      }
                }
              >
                {ambient.isListening ? "Stop" : "Listen"}
              </button>
            </div>

            {ambient.error && (
              <p
                className="mt-3 text-xs font-syne px-3 py-2 rounded-lg"
                style={{
                  color: "var(--robin)",
                  backgroundColor: "var(--robin-dim)",
                }}
              >
                {ambient.error}
              </p>
            )}
          </div>

          {/* Robin detected a new encounter */}
          {ambient.pendingEncounter && (
            <div
              className="rounded-[18px] p-4"
              style={{
                backgroundColor: "var(--robin-dim)",
                border: "1px solid rgba(224,75,32,0.20)",
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white font-bold font-syne text-xs mt-0.5"
                    style={{ backgroundColor: "var(--robin)" }}
                  >
                    R
                  </div>
                  <div>
                    <p
                      className="text-sm font-bold font-syne"
                      style={{ color: "var(--robin)" }}
                    >
                      Robin detected a new encounter
                    </p>
                    {ambient.pendingEncounter.chiefComplaint && (
                      <p
                        className="text-sm font-syne mt-0.5"
                        style={{ color: "var(--text)" }}
                      >
                        {ambient.pendingEncounter.chiefComplaint}
                      </p>
                    )}
                    <p
                      className="text-[10px] font-space-mono mt-1 uppercase tracking-wider"
                      style={{ color: "rgba(224,75,32,0.60)" }}
                    >
                      Confidence: {ambient.pendingEncounter.confidence}
                    </p>
                  </div>
                </div>
                <button
                  onClick={ambient.dismissPendingEncounter}
                  className="text-xs font-syne shrink-0 mt-0.5"
                  style={{ color: "rgba(224,75,32,0.50)" }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Robin re-evaluation captured */}
          {ambient.pendingReval && (
            <div
              className="rounded-[18px] p-4"
              style={{
                backgroundColor: "var(--amber-dim)",
                border: "1px solid rgba(245,166,35,0.20)",
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white font-bold font-syne text-xs mt-0.5"
                    style={{ backgroundColor: "var(--amber)" }}
                  >
                    R
                  </div>
                  <div>
                    <p
                      className="text-sm font-bold font-syne"
                      style={{ color: "var(--amber)" }}
                    >
                      Re-evaluation captured
                    </p>
                    <p
                      className="text-sm font-syne mt-0.5 italic"
                      style={{ color: "var(--text)" }}
                    >
                      &ldquo;{ambient.pendingReval.raw}&rdquo;
                    </p>
                    <p
                      className="text-[10px] font-space-mono mt-1"
                      style={{ color: "rgba(245,166,35,0.70)" }}
                    >
                      Open the relevant encounter to append this update.
                    </p>
                  </div>
                </div>
                <button
                  onClick={ambient.dismissReval}
                  className="text-xs font-syne shrink-0 mt-0.5"
                  style={{ color: "rgba(245,166,35,0.60)" }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Add encounter form */}
          <form
            onSubmit={addEncounter}
            className="rounded-[18px] p-4 space-y-3"
            style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <p
              className="text-[9px] font-bold font-space-mono uppercase tracking-widest"
              style={{ color: "var(--muted)" }}
            >
              Add Encounter
            </p>

            <div className="flex items-end gap-2">
              {/* Room */}
              <div className="w-16">
                <label
                  className="block text-[10px] font-space-mono uppercase tracking-wider mb-1"
                  style={{ color: "var(--muted)" }}
                >
                  Room
                </label>
                <input
                  type="text"
                  value={newRoom}
                  onChange={(e) => setNewRoom(e.target.value)}
                  placeholder="4"
                  className="w-full rounded-[10px] border px-2.5 py-2 text-sm font-syne focus:outline-none focus:ring-1"
                  style={{
                    borderColor: "var(--border2)",
                    backgroundColor: "var(--surface2)",
                    color: "var(--text)",
                  }}
                />
              </div>

              {/* Age */}
              <div className="w-14">
                <label
                  className="block text-[10px] font-space-mono uppercase tracking-wider mb-1"
                  style={{ color: "var(--muted)" }}
                >
                  Age
                </label>
                <input
                  type="number"
                  value={newAge}
                  onChange={(e) => setNewAge(e.target.value)}
                  placeholder="74"
                  min="0"
                  max="150"
                  className="w-full rounded-[10px] border px-2.5 py-2 text-sm font-syne focus:outline-none"
                  style={{
                    borderColor: "var(--border2)",
                    backgroundColor: "var(--surface2)",
                    color: "var(--text)",
                  }}
                />
              </div>

              {/* Gender */}
              <div className="w-16">
                <label
                  className="block text-[10px] font-space-mono uppercase tracking-wider mb-1"
                  style={{ color: "var(--muted)" }}
                >
                  Sex
                </label>
                <select
                  value={newGender}
                  onChange={(e) => setNewGender(e.target.value)}
                  className="w-full rounded-[10px] border px-2 py-2 text-sm font-syne focus:outline-none"
                  style={{
                    borderColor: "var(--border2)",
                    backgroundColor: "var(--surface2)",
                    color: "var(--text)",
                  }}
                >
                  <option value="">—</option>
                  <option value="M">M</option>
                  <option value="F">F</option>
                  <option value="X">X</option>
                </select>
              </div>

              {/* Chief complaint */}
              <div className="flex-1">
                <label
                  className="block text-[10px] font-space-mono uppercase tracking-wider mb-1"
                  style={{ color: "var(--muted)" }}
                >
                  Chief Complaint
                </label>
                <input
                  type="text"
                  value={newCC}
                  onChange={(e) => setNewCC(e.target.value)}
                  placeholder="e.g. Chest pain"
                  className="w-full rounded-[10px] border px-2.5 py-2 text-sm font-syne focus:outline-none"
                  style={{
                    borderColor: "var(--border2)",
                    backgroundColor: "var(--surface2)",
                    color: "var(--text)",
                  }}
                />
              </div>

              {/* Submit */}
              <button
                type="submit"
                className="shrink-0 px-4 py-2 rounded-[10px] font-syne font-bold text-sm text-white transition-all active:scale-95"
                style={{
                  backgroundColor: "var(--robin)",
                  boxShadow: "0 2px 8px rgba(224,75,32,0.25)",
                }}
              >
                + Add
              </button>
            </div>
          </form>

          {/* Encounter list */}
          <div className="space-y-2">
            <p
              className="text-[9px] font-bold font-space-mono uppercase tracking-widest px-1"
              style={{ color: "var(--muted)" }}
            >
              Encounters ({encounters.length})
            </p>

            {encounters.length === 0 ? (
              <div
                className="rounded-[18px] p-8 text-center"
                style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
              >
                <p
                  className="text-sm font-syne"
                  style={{ color: "var(--muted)" }}
                >
                  No encounters yet. Start listening or add one manually.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {encounters.map((enc) => (
                  <button
                    key={enc.id}
                    onClick={() =>
                      router.push(
                        `/shift/encounter/${enc.id}?patient=${patientNumbers.get(enc.id)}`
                      )
                    }
                    className="w-full flex items-center justify-between rounded-[18px] p-4 text-left transition-all active:scale-[0.99]"
                    style={{
                      backgroundColor: "var(--surface)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <div className="flex items-center gap-3">
                      {/* Patient number badge */}
                      <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] font-bold font-space-mono text-sm"
                        style={{
                          backgroundColor: "var(--robin-dim)",
                          color: "var(--robin)",
                        }}
                      >
                        {patientNumbers.get(enc.id)}
                      </div>

                      {/* Room badge */}
                      {enc.room && (
                        <div
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] font-bold font-space-mono text-sm"
                          style={{
                            backgroundColor: "var(--surface2)",
                            color: "var(--muted)",
                            border: "1px solid var(--border2)",
                          }}
                        >
                          {enc.room}
                        </div>
                      )}

                      {/* Patient label + time */}
                      <div className="min-w-0">
                        <p
                          className="font-syne font-semibold text-sm truncate"
                          style={{ color: "var(--text)" }}
                        >
                          {patientLabel(enc)}
                        </p>
                        <p
                          className="text-[10px] font-space-mono mt-0.5"
                          style={{ color: "var(--muted)" }}
                        >
                          {new Date(enc.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <StatusBadge status={enc.status} />

                      {/* Delete */}
                      <button
                        onClick={(e) => deleteEncounter(enc.id, e)}
                        className="rounded-lg p-1.5 transition-colors"
                        style={{ color: "var(--muted)" }}
                        aria-label="Remove encounter"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-3.5 w-3.5"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </button>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Robin chat — always present */}
      <RobinChat
        shiftId={activeShift?.id}
        pendingRobinQuery={ambient.pendingRobinQuery}
        onRobinQueryHandled={ambient.clearRobinQuery}
        robinActivated={ambient.robinActivated}
        onRobinActivatedHandled={ambient.clearRobinActivated}
        isAmbientListening={ambient.isListening && !ambient.isPausedForRobin}
        onVoiceStart={ambient.pauseForRobin}
        onVoiceEnd={ambient.resumeFromRobin}
      />
    </div>
  );
}
