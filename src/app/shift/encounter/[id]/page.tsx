"use client";

import { useEffect, useState, useCallback, use, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import AudioCapture from "@/components/AudioCapture";
import TranscriptPanel, { type TranscriptSegment } from "@/components/TranscriptPanel";
import NoteOutput from "@/components/NoteOutput";
import ClarificationPanel, {
  type ClarificationQuestion,
  type ClarificationAnswer,
} from "@/components/ClarificationPanel";
import RobinInsightsPanel from "@/components/RobinInsightsPanel";
import type { RobinInsight } from "@/lib/robinTypes";

interface Encounter {
  id: string;
  room: string | null;
  chief_complaint: string | null;
  status: string;
  transcript: string;
  generated_note: string;
  ehr_mode: "epic" | "cerner";
  mdm_data: Record<string, unknown>;
}

type ClarificationState = "idle" | "loading" | "ready" | "done";

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
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [labeledTranscript, setLabeledTranscript] = useState("");
  const [interimText, setInterimText] = useState("");
  const [note, setNote] = useState("");
  const [ehrMode, setEhrMode] = useState<"epic" | "cerner">("epic");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [disposition, setDisposition] = useState<"discharge" | "admit" | null>(null);
  const [clarificationState, setClarificationState] =
    useState<ClarificationState>("idle");
  const [clarificationQuestions, setClarificationQuestions] = useState<
    ClarificationQuestion[]
  >([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<
    ClarificationAnswer[]
  >([]);
  const [robinInsights, setRobinInsights] = useState<RobinInsight[]>([]);
  const [robinLoading, setRobinLoading] = useState(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        // Restore saved clarification answers if any
        if (data.mdm_data?.clarificationAnswers) {
          setClarificationAnswers(
            data.mdm_data.clarificationAnswers as ClarificationAnswer[]
          );
          setClarificationState("done");
        }
      }
    }
    load();
  }, [id, supabase]);

  // Auto-save transcript 8 seconds after the last change
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

  const handleTranscriptUpdate = useCallback(
    (newSegments: TranscriptSegment[], labeled: string, interim: string) => {
      setSegments(newSegments);
      setLabeledTranscript(labeled);
      setInterimText(interim);
    },
    []
  );

  async function handleDisposition(dispo: "discharge" | "admit") {
    if (!labeledTranscript.trim()) return;
    setDisposition(dispo);
    setClarificationState("loading");
    setRobinLoading(true);
    setRobinInsights([]);

    // Fire clarification questions and Robin's documentation review in parallel
    const [clarRes, robinRes] = await Promise.allSettled([
      fetch("/api/clarification-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: labeledTranscript,
          chiefComplaint: encounter?.chief_complaint,
          disposition: dispo,
        }),
      }),
      fetch("/api/robin-think", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: labeledTranscript,
          chiefComplaint: encounter?.chief_complaint,
          disposition: dispo,
        }),
      }),
    ]);

    // Handle Robin insights
    if (robinRes.status === "fulfilled" && robinRes.value.ok) {
      const robinData = await robinRes.value.json();
      setRobinInsights(robinData.insights || []);
    }
    setRobinLoading(false);

    // Handle clarification questions
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

      if (!res.ok) throw new Error("Failed to generate note");
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
      console.error("Note generation failed:", err);
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

  async function disposeAndComplete(dispo: "discharge" | "admit") {
    // Save transcript first, then start clarification flow
    await supabase
      .from("encounters")
      .update({
        transcript: labeledTranscript,
        ehr_mode: ehrMode,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    handleDisposition(dispo);
  }

  if (!encounter) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500">Loading encounter...</p>
      </div>
    );
  }

  const canGenerate = !!labeledTranscript.trim() && !generating;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/shift")}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            &larr; Back
          </button>
          {patientNumber && (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-sm font-bold text-gray-600">
              {patientNumber}
            </span>
          )}
          {encounter.room && (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700">
              {encounter.room}
            </span>
          )}
          <h2 className="text-lg font-semibold text-gray-900">
            {encounter.chief_complaint || "Encounter"}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={saveTranscript}
            disabled={saving}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {clarificationState === "done" && note ? (
            <button
              onClick={completeEncounter}
              className="rounded-md bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700"
            >
              ✓ Complete
            </button>
          ) : (
            <>
              <button
                onClick={() => disposeAndComplete("discharge")}
                disabled={!labeledTranscript.trim() || clarificationState === "loading"}
                className="rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Discharge
              </button>
              <button
                onClick={() => disposeAndComplete("admit")}
                disabled={!labeledTranscript.trim() || clarificationState === "loading"}
                className="rounded-md bg-purple-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
              >
                Admit
              </button>
            </>
          )}
        </div>
      </div>

      {/* Robin reval banner — when navigated via "patient N" voice command */}
      {revalText && (
        <div className="mb-4 rounded-lg border border-purple-300 bg-purple-50 px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-xs font-semibold text-purple-700 uppercase tracking-wide mb-1">
                Robin captured a re-evaluation
              </p>
              <p className="text-sm text-purple-900 italic">&ldquo;{revalText}&rdquo;</p>
            </div>
            <button
              onClick={() => {
                const ts = new Date().toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                setLabeledTranscript((prev) =>
                  prev
                    ? `${prev}\n\n[Re-evaluation ${ts}]\n${revalText}`
                    : `[Re-evaluation ${ts}]\n${revalText}`
                );
              }}
              className="shrink-0 rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
            >
              Append
            </button>
          </div>
          <p className="text-xs text-purple-500 mt-2">
            Tap Append to add to the transcript, then use voice to continue or regenerate the note.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: Audio + Transcript + Clarification */}
        <div className="space-y-4">
          <AudioCapture onTranscriptUpdate={handleTranscriptUpdate} />
          <TranscriptPanel segments={segments} interimText={interimText} />

          {/* Robin documentation review — shown after disposition */}
          {(robinLoading || robinInsights.length > 0) && (
            <RobinInsightsPanel insights={robinInsights} loading={robinLoading} />
          )}

          {/* Clarification panel */}
          {clarificationState === "ready" && (
            <ClarificationPanel
              questions={clarificationQuestions}
              onComplete={handleClarificationComplete}
              onSkip={handleClarificationSkip}
            />
          )}

          {/* Answered clarifications summary */}
          {clarificationState === "done" && clarificationAnswers.length > 0 && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3">
              <p className="text-xs font-medium text-green-700">
                {clarificationAnswers.length} clarification{clarificationAnswers.length > 1 ? "s" : ""} added to note
              </p>
            </div>
          )}

          {/* Disposition loading state */}
          {clarificationState === "loading" && (
            <div className="w-full rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-center text-sm text-amber-700">
              Robin is reviewing documentation gaps...
            </div>
          )}

          {/* Regenerate after clarification is done */}
          {clarificationState === "done" && (
            <button
              onClick={() => generateNote()}
              disabled={!canGenerate}
              className="w-full rounded-lg border border-purple-300 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50 disabled:opacity-50"
            >
              {generating ? "Regenerating..." : "Regenerate Note"}
            </button>
          )}
        </div>

        {/* Right: Note Output */}
        <div>
          <NoteOutput
            note={note}
            ehrMode={ehrMode}
            onEhrModeChange={setEhrMode}
          />
        </div>
      </div>
    </div>
  );
}
