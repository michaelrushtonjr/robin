"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createDeepgramSocket } from "@/lib/deepgram";

export interface ClarificationQuestion {
  question: string;
  why: string;
  category: "data" | "risk" | "decision_tool" | "liability" | "procedure";
  quickAnswers?: Array<{ label: string; value: string | null }>;
}

export interface ClarificationAnswer {
  question: string;
  answer: string;
}

interface ClarificationPanelProps {
  questions: ClarificationQuestion[];
  onComplete: (answers: ClarificationAnswer[]) => void;
  onSkip: () => void;
}

const CATEGORY_LABELS: Record<ClarificationQuestion["category"], string> = {
  data: "MDM Data",
  risk: "MDM Risk",
  decision_tool: "Decision Tool",
  liability: "Liability",
  procedure: "Procedure",
};

const CATEGORY_COLORS: Record<ClarificationQuestion["category"], string> = {
  data: "bg-robin-dim text-robin",
  risk: "bg-orange-100 text-orange-700",
  decision_tool: "bg-amber-100 text-amber-700",
  liability: "bg-red-100 text-red-700",
  procedure: "bg-teal-100 text-teal-700",
};

export default function ClarificationPanel({
  questions,
  onComplete,
  onSkip,
}: ClarificationPanelProps) {
  const [answers, setAnswers] = useState<Record<number, string>>(
    Object.fromEntries(questions.map((_, i) => [i, ""]))
  );
  const [listeningIndex, setListeningIndex] = useState<number | null>(null);

  // Shared voice capture state
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopVoice = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    contextRef.current?.close();
    contextRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      wsRef.current.close();
    }
    wsRef.current = null;
    setListeningIndex(null);
  }, []);

  async function startVoiceForQuestion(index: number) {
    if (listeningIndex !== null) {
      stopVoice();
      return;
    }

    let accessToken: string;
    try {
      const tokenRes = await fetch("/api/deepgram-token");
      if (!tokenRes.ok) return;
      ({ accessToken } = await tokenRes.json());
    } catch {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true },
      });
      streamRef.current = stream;
      setListeningIndex(index);

      const ws = createDeepgramSocket(
        { accessToken, interimResults: true, utteranceEndMs: 1200 },
        (data) => {
          const transcript = data.channel?.alternatives[0]?.transcript || "";
          if (!transcript) return;
          if (data.speech_final) {
            setAnswers((prev) => ({
              ...prev,
              [index]: transcript,
            }));
            stopVoice();
          } else if (!data.is_final) {
            // Show interim in the field
            setAnswers((prev) => ({
              ...prev,
              [index]: transcript,
            }));
          }
        },
        () => stopVoice(),
        () => setListeningIndex(null)
      );

      ws.onopen = () => {
        const audioContext = new AudioContext({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(pcm16.buffer);
        };
        source.connect(processor);
        processor.connect(audioContext.destination);
        processorRef.current = processor;
        contextRef.current = audioContext;
      };

      wsRef.current = ws;
    } catch {
      setListeningIndex(null);
    }
  }

  // Cleanup on unmount
  useEffect(() => () => stopVoice(), [stopVoice]);

  function handleQuickAnswer(index: number, value: string) {
    setAnswers((prev) => ({ ...prev, [index]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const completed: ClarificationAnswer[] = questions.map((q, i) => ({
      question: q.question,
      answer: answers[i] || "Not answered",
    }));
    onComplete(completed);
  }

  const answeredCount = Object.values(answers).filter((a) => a.trim()).length;

  if (questions.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-sm font-semibold text-amber-900">
            Quick questions before I finalize the note.
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            {answeredCount}/{questions.length} answered
          </p>
        </div>
        <button
          onClick={onSkip}
          className="text-xs text-amber-500 hover:text-amber-700"
        >
          Skip all
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {questions.map((q, i) => (
          <div key={i} className="space-y-2">
            {/* Question header */}
            <div className="flex items-start gap-2">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${CATEGORY_COLORS[q.category]}`}
              >
                {CATEGORY_LABELS[q.category]}
              </span>
              <div>
                <p className="text-sm font-semibold font-syne" style={{ color: "var(--text)" }}>{q.question}</p>
                <p className="text-xs font-syne mt-0.5" style={{ color: "var(--muted)" }}>{q.why}</p>
              </div>
            </div>

            {/* Quick answer buttons */}
            {q.quickAnswers && q.quickAnswers.length > 0 && (
              <div className="flex flex-wrap gap-2 pl-0.5">
                {q.quickAnswers.map((qa, qi) =>
                  qa.value !== null ? (
                    <button
                      key={qi}
                      type="button"
                      onClick={() => handleQuickAnswer(i, qa.value!)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        answers[i] === qa.value
                          ? "border-amber-500 bg-amber-500 text-white"
                          : "border-gray-300 text-gray-700 hover:border-amber-400"
                      }`}
                    >
                      {qa.label}
                    </button>
                  ) : null
                )}
              </div>
            )}

            {/* Text + voice input */}
            <div className="flex gap-2">
              <input
                type="text"
                value={answers[i]}
                onChange={(e) =>
                  setAnswers((prev) => ({ ...prev, [i]: e.target.value }))
                }
                placeholder={
                  listeningIndex === i ? "Listening..." : "Or type / speak your answer..."
                }
                className={`flex-1 rounded border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
                  listeningIndex === i
                    ? "border-red-400 focus:ring-red-400 bg-red-50"
                    : "border-gray-300 focus:border-amber-400"
                }`}
              />
              <button
                type="button"
                onMouseDown={() => startVoiceForQuestion(i)}
                onMouseUp={() => listeningIndex === i && stopVoice()}
                onTouchStart={() => startVoiceForQuestion(i)}
                onTouchEnd={() => listeningIndex === i && stopVoice()}
                className={`rounded border px-3 py-2 text-sm transition-colors select-none ${
                  listeningIndex === i
                    ? "border-red-400 bg-red-500 text-white"
                    : "border-gray-300 text-gray-500 hover:border-amber-400 hover:text-amber-600"
                }`}
                title="Hold to speak"
              >
                {listeningIndex === i ? (
                  <span className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                    …
                  </span>
                ) : (
                  "🎤"
                )}
              </button>
            </div>
          </div>
        ))}

        <button
          type="submit"
          className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600"
        >
          Add to Note & Generate
        </button>
      </form>
    </div>
  );
}
