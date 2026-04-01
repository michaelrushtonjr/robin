"use client";

import { useEffect, useState, useCallback, use, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import AudioCapture from "@/components/AudioCapture";
import NoteOutput from "@/components/NoteOutput";
import ClarificationPanel, {
  type ClarificationQuestion,
  type ClarificationAnswer,
} from "@/components/ClarificationPanel";
import RobinInsightsPanel from "@/components/RobinInsightsPanel";
import RobinChat from "@/components/RobinChat";
import WaveformVisualizer from "@/components/capture/WaveformVisualizer";
import TranscriptFeed from "@/components/capture/TranscriptFeed";
import ModeToggle from "@/components/capture/ModeToggle";
import ControlBar from "@/components/capture/ControlBar";
import RobinObservation from "@/components/capture/RobinObservation";
import type { TranscriptSegment } from "@/components/TranscriptPanel";
import type { RobinInsight } from "@/lib/robinTypes";
import type { TranscriptLineData } from "@/components/capture/TranscriptLine";

interface Encounter {
  id: string;
  shift_id: string;
  room: string | null;
  chief_complaint: string | null;
  age: number | null;
  gender: string | null;
  status: string;
  transcript: string;
  generated_note: string;
  ehr_mode: "epic" | "cerner";
  mdm_data: Record<string, unknown>;
}

type ClarificationState = "idle" | "loading" | "ready" | "done";
type Phase = "capture" | "documenting";
type CaptureMode = "ambient" | "ptt";

function patientSummary(enc: Encounter): string {
  const demo = [enc.age, enc.gender].filter(Boolean).join("");
  const parts = [demo, enc.chief_complaint, enc.room ? `Room ${enc.room}` : null].filter(Boolean);
  return parts.join(" · ");
}

export default function EncounterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const patientNumber = searchParams.get("patient");
  const revalText = searchParams.get("reval");

  // ── Core state ──────────────────────────────────────────────────────────
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [labeledTranscript, setLabeledTranscript] = useState("");
  const [interimText, setInterimText] = useState("");
  const [note, setNote] = useState("");
  const [ehrMode, setEhrMode] = useState<"epic" | "cerner">("epic");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [disposition, setDisposition] = useState<"discharge" | "admit" | null>(null);
  const [clarificationState, setClarificationState] = useState<ClarificationState>("idle");
  const [clarificationQuestions, setClarificationQuestions] = useState<ClarificationQuestion[]>([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<ClarificationAnswer[]>([]);
  const [robinInsights, setRobinInsights] = useState<RobinInsight[]>([]);
  const [robinLoading, setRobinLoading] = useState(false);
  const [revalAppended, setRevalAppended] = useState(false);

  // ── Capture UI state ────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("capture");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("ambient");
  const [isPaused, setIsPaused] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showEndModal, setShowEndModal] = useState(false);

  // ── Auto-save ────────────────────────────────────────────────────────────
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load encounter ───────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from("encounters")
        .select("*")
        .eq("id", id)
        .single();
      if (data) {
        setEncounter(data);
        if (data.transcript) setLabeledTranscript(data.transcript);
        setNote(data.generated_note || "");
        setEhrMode(data.ehr_mode || "epic");
        if (data.mdm_data?.clarificationAnswers) {
          setClarificationAnswers(data.mdm_data.clarificationAnswers as ClarificationAnswer[]);
          setClarificationState("done");
        }
        if (data.generated_note) setPhase("documenting");
      }
    }
    load();
  }, [id, supabase]);

  // ── EHR mode auto-save ───────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    supabase.from("encounters").update({ ehr_mode: ehrMode }).eq("id", id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ehrMode]);

  // ── Transcript auto-save ─────────────────────────────────────────────────
  useEffect(() => {
    if (!labeledTranscript || !id) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      await supabase
        .from("encounters")
        .update({ transcript: labeledTranscript, updated_at: new Date().toISOString() })
        .eq("id", id);
    }, 8000);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [labeledTranscript, id, supabase]);

  // ── Shift timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600).toString().padStart(2, "0");
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${h}:${m}:${sec}`;
  };

  // ── Transcript handlers ──────────────────────────────────────────────────
  const handleTranscriptUpdate = useCallback(
    (newSegments: TranscriptSegment[], labeled: string, interim: string) => {
      setSegments(newSegments);
      setLabeledTranscript(labeled);
      setInterimText(interim);
      setIsRecording(!!interim);
    },
    []
  );

  // Convert segments to TranscriptLineData for the feed
  const transcriptLines: TranscriptLineData[] = [
    ...segments
      .filter((s) => s.isFinal)
      .map((s) => ({
        id: `${s.timestamp}-${s.speaker}`,
        speaker: (s.speaker === 0 ? "physician" : "patient") as TranscriptLineData["speaker"],
        text: s.text,
      })),
    ...(interimText
      ? [{ id: "interim", speaker: "interim" as const, text: interimText }]
      : []),
  ];

  const wordCount = segments
    .filter((s) => s.isFinal)
    .reduce((acc, s) => acc + s.text.split(/\s+/).filter(Boolean).length, 0);

  // ── Disposition flow ─────────────────────────────────────────────────────
  async function handleDisposition(dispo: "discharge" | "admit") {
    if (!labeledTranscript.trim()) return;
    setShowEndModal(false);
    setDisposition(dispo);
    setPhase("documenting");
    setClarificationState("loading");
    setRobinLoading(true);
    setRobinInsights([]);

    const withTimeout = (p: Promise<Response>, ms: number) =>
      Promise.race([
        p,
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), ms)
        ),
      ]);

    const [clarRes, robinRes] = await Promise.allSettled([
      withTimeout(
        fetch("/api/clarification-questions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: labeledTranscript,
            chiefComplaint: encounter?.chief_complaint,
            disposition: dispo,
          }),
        }),
        25000
      ),
      withTimeout(
        fetch("/api/robin-think", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: labeledTranscript,
            chiefComplaint: encounter?.chief_complaint,
            disposition: dispo,
          }),
        }),
        30000
      ),
    ]);

    if (robinRes.status === "fulfilled" && robinRes.value.ok) {
      const robinData = await robinRes.value.json();
      setRobinInsights(robinData.insights || []);
    }
    setRobinLoading(false);

    if (clarRes.status === "fulfilled" && clarRes.value.ok) {
      try {
        const data = await clarRes.value.json();
        if (data.questions?.length > 0) {
          setClarificationQuestions(data.questions);
          setClarificationState("ready");
        } else {
          setClarificationState("done");
          generateNote([], dispo);
        }
      } catch {
        setClarificationState("idle");
      }
    } else {
      setClarificationState("idle");
    }
  }

  async function handleClarificationComplete(answers: ClarificationAnswer[]) {
    setClarificationAnswers(answers);
    setClarificationState("done");
    await supabase
      .from("encounters")
      .update({
        mdm_data: { ...encounter?.mdm_data, clarificationAnswers: answers },
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    generateNote(answers, disposition ?? undefined);
  }

  function handleClarificationSkip() {
    setClarificationState("done");
    generateNote([], disposition ?? undefined);
  }

  async function generateNote(
    answers: ClarificationAnswer[] = clarificationAnswers,
    dispo?: string
  ) {
    if (!labeledTranscript.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/generate-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: labeledTranscript,
          chiefComplaint: encounter?.chief_complaint,
          ehrMode,
          disposition: dispo,
          clarifications: answers.length > 0 ? answers : undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setNote(data.note);
      await supabase
        .from("encounters")
        .update({
          generated_note: data.note,
          transcript: labeledTranscript,
          status: "documenting",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    } catch (err) {
      console.error(err);
    } finally {
      setGenerating(false);
    }
  }

  async function saveTranscript() {
    setSaving(true);
    await supabase
      .from("encounters")
      .update({
        transcript: labeledTranscript,
        ehr_mode: ehrMode,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    setSaving(false);
  }

  async function completeEncounter() {
    await supabase
      .from("encounters")
      .update({
        transcript: labeledTranscript,
        generated_note: note,
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    router.push("/shift");
  }

  if (!encounter) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ background: "var(--bg)" }}>
        <p className="font-space-mono text-sm" style={{ color: "var(--muted)" }}>
          Loading…
        </p>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      <div className="mx-auto w-full max-w-lg flex flex-col gap-3 px-4 py-4 pb-8">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          {/* Robin logotype */}
          <div className="flex items-center gap-2">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-[9px]"
              style={{ backgroundColor: "var(--robin)" }}
            >
              <span className="text-white font-bold text-sm font-space-mono">R</span>
            </div>
            <span
              className="text-sm font-extrabold tracking-[0.18em] uppercase font-syne"
              style={{ color: "var(--robin)" }}
            >
              ROBIN
            </span>
          </div>

          {/* Shift timer */}
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border"
            style={{ borderColor: "var(--border2)" }}
          >
            <motion.span
              animate={{ opacity: [1, 0.2] }}
              transition={{ duration: 0.9, repeat: Infinity, repeatType: "reverse" }}
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--robin)" }}
            />
            <span className="text-xs font-bold font-space-mono" style={{ color: "var(--text)" }}>
              {formatTime(elapsedSeconds)}
            </span>
          </div>
        </div>

        {/* ── Status bar ──────────────────────────────────────────────── */}
        <div
          className="relative rounded-[16px] overflow-hidden px-4 py-3 flex items-center justify-between"
          style={{ backgroundColor: "var(--robin)" }}
        >
          {/* Decoration circle */}
          <div
            className="absolute -top-6 -right-6 h-24 w-24 rounded-full"
            style={{ backgroundColor: "rgba(255,255,255,0.08)" }}
          />

          <div className="flex items-center gap-3 z-10">
            {/* Icon box */}
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl shrink-0"
              style={{ backgroundColor: "rgba(255,255,255,0.15)" }}
            >
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest font-space-mono" style={{ color: "rgba(255,255,255,0.7)" }}>
                Active Encounter
              </p>
              <p className="text-sm font-bold text-white font-syne">
                {patientSummary(encounter) || "Unknown patient"}
              </p>
            </div>
          </div>

          {patientNumber && (
            <span
              className="text-2xl font-bold font-space-mono z-10"
              style={{ color: "rgba(255,255,255,0.25)" }}
            >
              #{patientNumber}
            </span>
          )}
        </div>

        {/* ── Reval banner ────────────────────────────────────────────── */}
        {revalText && (
          <div
            className="rounded-[14px] border px-4 py-3"
            style={{ borderColor: "rgba(224,75,32,0.3)", backgroundColor: "var(--robin-dim)" }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="text-[9px] font-bold uppercase tracking-widest font-space-mono mb-1" style={{ color: "var(--robin)" }}>
                  Robin · Re-evaluation captured
                </p>
                <p className="text-xs font-syne italic" style={{ color: "var(--text)" }}>
                  &ldquo;{revalText}&rdquo;
                </p>
              </div>
              <button
                disabled={revalAppended}
                onClick={() => {
                  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  setLabeledTranscript((prev) =>
                    prev ? `${prev}\n\n[Re-evaluation ${ts}]\n${revalText}` : `[Re-evaluation ${ts}]\n${revalText}`
                  );
                  setRevalAppended(true);
                }}
                className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold font-syne text-white disabled:opacity-50"
                style={{ backgroundColor: "var(--robin)" }}
              >
                {revalAppended ? "Appended" : "Append"}
              </button>
            </div>
          </div>
        )}

        {/* ── Hidden audio capture ─────────────────────────────────────── */}
        <div className="hidden">
          <AudioCapture onTranscriptUpdate={handleTranscriptUpdate} />
        </div>

        {phase === "capture" ? (
          <>
            {/* ── Mode toggle ───────────────────────────────────────────── */}
            <ModeToggle mode={captureMode} onChange={setCaptureMode} />

            {/* ── Waveform ──────────────────────────────────────────────── */}
            <WaveformVisualizer isActive={isRecording && !isPaused && captureMode === "ambient"} wordCount={wordCount} />

            {/* ── Robin observations ────────────────────────────────────── */}
            <AnimatePresence>
              {robinInsights
                .filter((i) => i.type === "gap")
                .slice(0, 2)
                .map((obs, idx) => (
                  <RobinObservation
                    key={idx}
                    type="mdm_flag"
                    message={obs.issue || ""}
                  />
                ))}
            </AnimatePresence>

            {/* ── Transcript feed ───────────────────────────────────────── */}
            <TranscriptFeed lines={transcriptLines} />

            {/* ── Control bar ───────────────────────────────────────────── */}
            <ControlBar
              isPaused={isPaused}
              onPause={() => setIsPaused((p) => !p)}
              onDashboard={() => router.push("/shift")}
              onEnd={() => setShowEndModal(true)}
            />
          </>
        ) : (
          <>
            {/* ── Documentation phase ───────────────────────────────────── */}
            <div
              className="rounded-[16px] border p-4"
              style={{ backgroundColor: "var(--surface)", borderColor: "var(--border)" }}
            >
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-bold font-space-mono uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                  Documentation
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={saveTranscript}
                    disabled={saving}
                    className="rounded-lg border px-3 py-1.5 text-xs font-syne font-semibold disabled:opacity-50"
                    style={{ borderColor: "var(--border2)", color: "var(--muted)" }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  {clarificationState === "done" && note ? (
                    <button
                      onClick={completeEncounter}
                      className="rounded-lg px-3 py-1.5 text-xs font-bold font-syne text-white"
                      style={{ backgroundColor: "var(--teal)" }}
                    >
                      ✓ Complete
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Robin insights */}
              {(robinLoading || robinInsights.length > 0) && (
                <div className="mb-3">
                  <RobinInsightsPanel insights={robinInsights} loading={robinLoading} />
                </div>
              )}

              {/* Clarifications */}
              {clarificationState === "ready" && (
                <ClarificationPanel
                  questions={clarificationQuestions}
                  onComplete={handleClarificationComplete}
                  onSkip={handleClarificationSkip}
                />
              )}

              {clarificationState === "loading" && (
                <p className="text-xs font-space-mono text-center py-3" style={{ color: "var(--muted)" }}>
                  Robin is reviewing…
                </p>
              )}

              {clarificationState === "done" && clarificationAnswers.length > 0 && (
                <p className="text-xs font-space-mono mb-2" style={{ color: "var(--teal)" }}>
                  {clarificationAnswers.length} clarification{clarificationAnswers.length > 1 ? "s" : ""} added
                </p>
              )}
            </div>

            {/* Note output */}
            {generating && (
              <div
                className="rounded-[16px] border p-6 text-center"
                style={{ backgroundColor: "var(--surface)", borderColor: "var(--border)" }}
              >
                <p className="text-xs font-space-mono" style={{ color: "var(--muted)" }}>
                  Generating note…
                </p>
              </div>
            )}
            {note && <NoteOutput note={note} ehrMode={ehrMode} onEhrModeChange={setEhrMode} />}

            {/* Back to capture */}
            <button
              onClick={() => setPhase("capture")}
              className="text-xs font-space-mono text-center py-2"
              style={{ color: "var(--muted)" }}
            >
              ← Back to capture
            </button>
          </>
        )}
      </div>

      {/* ── End encounter modal ──────────────────────────────────────────── */}
      <AnimatePresence>
        {showEndModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
              onClick={() => setShowEndModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 40 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
              className="fixed bottom-0 inset-x-0 z-50 mx-auto max-w-lg px-4 pb-8"
            >
              <div
                className="rounded-[20px] border p-5"
                style={{ backgroundColor: "var(--surface)", borderColor: "var(--border)" }}
              >
                <p className="text-sm font-bold font-syne mb-1" style={{ color: "var(--text)" }}>
                  End encounter
                </p>
                <p className="text-xs font-syne mb-4" style={{ color: "var(--muted)" }}>
                  How is this patient leaving?
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => handleDisposition("discharge")}
                    disabled={!labeledTranscript.trim()}
                    className="py-3 rounded-[14px] font-bold font-syne text-sm text-white disabled:opacity-40"
                    style={{ backgroundColor: "var(--teal)" }}
                  >
                    Discharge
                  </button>
                  <button
                    onClick={() => handleDisposition("admit")}
                    disabled={!labeledTranscript.trim()}
                    className="py-3 rounded-[14px] font-bold font-syne text-sm text-white disabled:opacity-40"
                    style={{ backgroundColor: "var(--robin)" }}
                  >
                    Admit
                  </button>
                </div>
                <button
                  onClick={() => setShowEndModal(false)}
                  className="mt-3 w-full text-center text-xs font-space-mono py-2"
                  style={{ color: "var(--muted)" }}
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Robin chat ───────────────────────────────────────────────────── */}
      {encounter.shift_id && (
        <RobinChat shiftId={encounter.shift_id} encounterId={id} />
      )}
    </div>
  );
}
