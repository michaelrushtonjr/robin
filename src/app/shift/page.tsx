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
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {!activeShift ? (
        <div className="text-center">
          <h2 className="text-2xl font-semibold text-gray-900">Robin — Your On-Shift Sidekick</h2>
          <p className="mt-2 text-gray-600">Ready when you are. Start your shift to begin.</p>
          <button
            onClick={startShift}
            className="mt-6 rounded-lg bg-blue-600 px-6 py-3 text-white font-medium hover:bg-blue-700"
          >
            Start Shift
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Shift header */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">
                Shift Active
              </h2>
              <p className="text-sm text-gray-500">
                Started{" "}
                {new Date(activeShift.started_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
            <button
              onClick={endShift}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              End Shift
            </button>
          </div>

          {/* Ambient listening control */}
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  Ambient Listening
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {ambient.isListening
                    ? ambient.isConnected
                      ? "Robin is listening — will auto-detect new encounters"
                      : "Connecting..."
                    : "Robin will automatically detect when you start a new encounter"}
                </p>
              </div>
              <button
                onClick={
                  ambient.isListening
                    ? ambient.stopListening
                    : ambient.startListening
                }
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  ambient.isListening
                    ? "bg-red-50 text-red-600 border border-red-200 hover:bg-red-100"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                {ambient.isListening && (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                )}
                {ambient.isListening ? "Stop Listening" : "Start Listening"}
              </button>
            </div>
            {ambient.error && (
              <p className="mt-2 text-xs text-red-500">{ambient.error}</p>
            )}
          </div>

          {/* Robin detected a new encounter */}
          {ambient.pendingEncounter && (
            <div className="rounded-lg border border-blue-300 bg-blue-50 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-blue-900">
                    Robin detected a new encounter
                  </p>
                  {ambient.pendingEncounter.chiefComplaint && (
                    <p className="text-sm text-blue-700 mt-0.5">
                      {ambient.pendingEncounter.chiefComplaint}
                    </p>
                  )}
                  <p className="text-xs text-blue-500 mt-1">
                    Confidence: {ambient.pendingEncounter.confidence}
                  </p>
                </div>
                <button
                  onClick={ambient.dismissPendingEncounter}
                  className="text-xs text-blue-400 hover:text-blue-600 shrink-0"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Robin wake word — re-evaluation captured */}
          {ambient.pendingReval && (
            <div className="rounded-lg border border-purple-300 bg-purple-50 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-purple-900">
                    Robin heard a re-evaluation
                  </p>
                  <p className="text-sm text-purple-700 mt-1 italic">
                    &ldquo;{ambient.pendingReval.raw}&rdquo;
                  </p>
                  <p className="text-xs text-purple-500 mt-1">
                    Open the relevant encounter to append this update.
                  </p>
                </div>
                <button
                  onClick={ambient.dismissReval}
                  className="text-xs text-purple-400 hover:text-purple-600 shrink-0"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Manual encounter form */}
          <form
            onSubmit={addEncounter}
            className="rounded-lg border border-gray-200 bg-white p-4 space-y-3"
          >
            <div className="flex items-end gap-3">
              <div className="w-20">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Room
                </label>
                <input
                  type="text"
                  value={newRoom}
                  onChange={(e) => setNewRoom(e.target.value)}
                  placeholder="4"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="w-16">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Age
                </label>
                <input
                  type="number"
                  value={newAge}
                  onChange={(e) => setNewAge(e.target.value)}
                  placeholder="74"
                  min="0"
                  max="150"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="w-20">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Gender
                </label>
                <select
                  value={newGender}
                  onChange={(e) => setNewGender(e.target.value)}
                  className="w-full rounded border border-gray-300 px-2 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="">—</option>
                  <option value="M">M</option>
                  <option value="F">F</option>
                  <option value="X">X</option>
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Chief Complaint
                </label>
                <input
                  type="text"
                  value={newCC}
                  onChange={(e) => setNewCC(e.target.value)}
                  placeholder="e.g. Chest pain"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white font-medium hover:bg-blue-700"
              >
                + Encounter
              </button>
            </div>
          </form>

          {/* Encounter list */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
              Encounters ({encounters.length})
            </h3>
            {encounters.length === 0 ? (
              <p className="text-sm text-gray-400 py-4">
                No encounters yet. Start listening or add one manually.
              </p>
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
                    className="w-full flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4 text-left hover:border-blue-300 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center gap-4">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-sm font-bold text-gray-600 shrink-0">
                        {patientNumbers.get(enc.id)}
                      </span>
                      {enc.room && (
                        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700 shrink-0">
                          {enc.room}
                        </span>
                      )}
                      <div>
                        <p className="font-medium text-gray-900">
                          {patientLabel(enc)}
                        </p>
                        <p className="text-xs text-gray-500">
                          {new Date(enc.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          enc.status === "completed"
                            ? "bg-green-100 text-green-700"
                            : enc.status === "documenting"
                              ? "bg-yellow-100 text-yellow-700"
                              : "bg-blue-100 text-blue-700"
                        }`}
                      >
                        {enc.status}
                      </span>
                      <button
                        onClick={(e) => deleteEncounter(enc.id, e)}
                        className="rounded p-1 text-gray-300 hover:text-red-400 hover:bg-red-50 transition-colors"
                        aria-label="Delete encounter"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Robin chat — always present, context-aware once shift is active */}
      <RobinChat shiftId={activeShift?.id} />
    </div>
  );
}
