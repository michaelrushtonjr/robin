"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { createDeepgramSocket } from "@/lib/deepgram";
import { useWakeLock } from "@/hooks/useWakeLock";

export interface DetectedEncounter {
  id: string;
  chiefComplaint: string | null;
  transcript: string;
  detectedAt: number;
  confidence: "high" | "medium" | "low";
}

export interface RevalCommand {
  raw: string;
  detectedAt: number;
}

export interface PatientBriefing {
  raw: string;
  detectedAt: number;
}

export type AmbientMode = "ambient" | "dictating" | "qa_session";

export type AgentCommandType =
  | "patient_briefing"
  | "disposition"
  | "physical_exam"
  | "ekg_interpretation"
  | "mdm_dictation"
  | "ed_course"
  | "order_log"
  | "lab_results"
  | "radiology"
  | "discharge_instructions"
  | "final_diagnosis"
  | "consult_log"
  | "consult_recommendations"
  | "encounter_update"
  | "voice_undo"
  | "voice_remove";

export interface AgentActionResult {
  id: string;
  ok: boolean;
  actionTaken: string;
  confidence: number;
  confirmationRequired: boolean;
  commandType: AgentCommandType;
  parsedPayload?: unknown;
  encounters?: Array<{
    id: string;
    chief_complaint: string | null;
    age: number | null;
    gender: string | null;
    room: string | null;
    patient_name: string | null;
    status: string;
    created_at: string;
  }>;
  encounterId?: string;
  shiftId?: string;
  undoActionId?: string;
  // For dictation/QA sessions
  requiresDictation?: boolean;
  requiresQA?: string; // procedure type
}

// ─── Layer 3 voice command patterns ─────────────────────────────────────────

const COMMAND_PATTERNS: Array<{
  type: AgentCommandType;
  patterns: RegExp[];
  requiresDictation?: boolean;
}> = [
  {
    type: "physical_exam",
    patterns: [
      /\b(physical\s+exam|exam\s+for|PE\s+for)\b/i,
      /\bphysical\s+exams?\s+for\s+you\b/i,
    ],
    requiresDictation: true,
  },
  {
    type: "ekg_interpretation",
    patterns: [
      /\bnormal\s+e[ck]g\b/i,
      /\badd\s+e[ck]g\b/i,
      /\be[ck]g\s+(for|shows)\b/i,
    ],
  },
  {
    type: "mdm_dictation",
    patterns: [
      /\bmdm\s+(for|is\s+as\s+follows)\b/i,
      /\bupdate\s+mdm\b/i,
    ],
    requiresDictation: true,
  },
  {
    type: "ed_course",
    patterns: [
      /\b(add\s+a\s+)?reassessment\b/i,
      /\bre-?eval(uation)?\s+for\b/i,
    ],
    requiresDictation: true,
  },
  {
    type: "order_log",
    patterns: [
      /\b(adding|ordered?|i('m|\s+am)\s+adding)\s+(labs?|imaging|medication)\b/i,
      /\bordered?\s+(a\s+)?(ct|cxr|xr|x-ray|mri|cbc|bmp|troponin)\b/i,
    ],
  },
  {
    type: "lab_results",
    patterns: [
      /\blabs?\s+(back|results?)\b/i,
      /\blab\s+results?\s+for\b/i,
    ],
    requiresDictation: true,
  },
  {
    type: "radiology",
    patterns: [
      /\b(radiology|ct\s+read|xr|x-ray)\s+(for|shows)\b/i,
      /\bradiology\s+for\b/i,
    ],
    requiresDictation: true,
  },
  {
    type: "discharge_instructions",
    patterns: [
      /\b(prepare|generate)?\s*discharge\s+instructions\b/i,
      /\bdc\s+instructions\b/i,
    ],
  },
  {
    type: "final_diagnosis",
    patterns: [
      /\b(final\s+)?diagnosis\s+(for|is)\b/i,
      /\bfinal\s+diagnosis\b/i,
    ],
  },
  {
    type: "consult_recommendations",
    patterns: [/\brecommendations?\s+for\b/i],
    requiresDictation: true,
  },
  {
    type: "encounter_update",
    patterns: [
      /\b(change|update|add)\s+encounter\b/i,
      /\b(change|add)\s+(the\s+)?(last\s+)?name\b/i,
    ],
  },
  {
    type: "voice_undo",
    patterns: [/\bscratch\s+that\b/i, /\bundo\s+(that|it)?\b/i],
  },
  {
    type: "voice_remove",
    patterns: [
      /\bremove\s+(the\s+)?(last\s+)?/i,
      /\bclear\s+(the\s+)?/i,
    ],
  },
  {
    type: "disposition",
    patterns: [
      /\b(ready\s+to\s+go|discharge|admitted|going\s+home|ama)\b/i,
      /\baccepted\s+(to|by)\b/i,
    ],
  },
];

// Passive consult detection — no wake word needed
const CONSULT_PATTERNS = [
  /\b(ortho|surgery|cardiology|hospitalist|neurology|urology|GI|ENT|ophthalmology|psychiatry|OB|nephrology)\b.*\b(called|accepted|coming|spoke|on board)\b/i,
  /\b(called|accepted|coming|spoke|on board)\b.*\b(ortho|surgery|cardiology|hospitalist|neurology|urology|GI|ENT|ophthalmology|psychiatry|OB|nephrology)\b/i,
  /\bDr\.\s+\w+\s+(from|with)\s+\w+\s+(accepted|called)\b/i,
];

function classifyCommand(
  command: string
): { type: AgentCommandType; requiresDictation: boolean } | null {
  for (const { type, patterns, requiresDictation } of COMMAND_PATTERNS) {
    if (patterns.some((p) => p.test(command))) {
      return { type, requiresDictation: requiresDictation || false };
    }
  }
  return null;
}

function isConsultDetection(transcript: string): boolean {
  return CONSULT_PATTERNS.some((p) => p.test(transcript));
}

// Patient briefing patterns — distinguish from re-eval
const BRIEFING_PATTERNS = [
  /\b(about to|going to|going in to|heading to|heading in to)\s+(go\s+)?see\b/i,
  /\b(i have|i've got|we have|we've got|got)\s+\d+\s+patients?\b/i,
  /\bnext\s+patients?\b/i,
  /\bqueue(d)?\b/i,
  /\bwaiting\s+room\b/i,
  /\btriage\b.*\bpatients?\b/i,
];

function isPatientBriefing(command: string): boolean {
  return BRIEFING_PATTERNS.some((p) => p.test(command));
}

interface UseShiftAmbientReturn {
  isListening: boolean;
  isConnected: boolean;
  isPausedForRobin: boolean;
  ambientMode: AmbientMode;
  error: string | null;
  currentTranscript: string;
  pendingEncounter: DetectedEncounter | null;
  pendingReval: RevalCommand | null;
  pendingBriefing: PatientBriefing | null;
  pendingAction: AgentActionResult | null;
  pendingConfirmation: AgentActionResult | null;
  pendingRobinQuery: string | null;
  robinActivated: boolean;
  setShiftId: (id: string | null) => void;
  startListening: () => Promise<void>;
  stopListening: () => void;
  pauseForRobin: () => void;
  resumeFromRobin: () => void;
  endDictation: () => void;          // signal dictation session complete
  endQASession: () => void;          // signal QA session complete
  dismissPendingEncounter: () => void;
  confirmPendingEncounter: () => DetectedEncounter | null;
  dismissReval: () => void;
  dismissBriefing: () => void;
  dismissAction: () => void;
  dismissConfirmation: () => void;
  confirmAction: (card: AgentActionResult) => void;
  clearRobinQuery: () => void;
  clearRobinActivated: () => void;
}

// Words to accumulate before running encounter detection
const DETECTION_WORD_THRESHOLD = 6;
// Cooldown after a SUCCESSFUL detection — encounters can't happen faster than 60s
const DETECTION_SUCCESS_COOLDOWN_MS = 60_000;
// Cooldown after a FAILED detection — retry sooner
const DETECTION_FAIL_COOLDOWN_MS = 8_000;

// EMS radio patterns — skip detection buffer entirely for these segments
const RADIO_PATTERNS = [
  /\ben route\b/i,
  /\beta\s+\d+/i,
  /\bcopy that\b/i,
  /\bmedic\s+\d+/i,
  /\bunit\s+\d+/i,
  /\bbase\s+to\b/i,
  /\bto base\b/i,
  /\bover\s*$/i,
  /\bover and out\b/i,
  /\bstanding by\b/i,
  /\bclear\s*$/i,
  /\b10-\d+\b/i,   // 10-codes
];

function isRadioChatter(transcript: string): boolean {
  return RADIO_PATTERNS.some((p) => p.test(transcript));
}

// Robin wake word patterns (case-insensitive)
const ROBIN_WAKE_PATTERNS = [
  /\bhey robin[,\s]*/i,
  /\bok robin[,\s]*/i,
  /\brobin[,\s]+/i,
];

// Re-evaluation patterns — "patient N" style commands
const REVAL_PATTERNS = [
  /\bpatient\s+\d+\b/i,
  /\broom\s+\d+\b/i,
  /\bre-?eval\b/i,
  /\bcheck\s+(back\s+)?on\b/i,
  /\bfollow[\s-]up\b/i,
];

function isRevalCommand(command: string): boolean {
  return REVAL_PATTERNS.some((p) => p.test(command));
}

function extractWakeCommand(transcript: string): string | null {
  for (const pattern of ROBIN_WAKE_PATTERNS) {
    const match = transcript.match(pattern);
    if (match) {
      const afterWake = transcript.slice(
        transcript.indexOf(match[0]) + match[0].length
      ).trim();
      if (afterWake.length > 3) return afterWake;
    }
  }
  return null;
}

export function useShiftAmbient(): UseShiftAmbientReturn {
  const [isListening, setIsListening] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isPausedForRobin, setIsPausedForRobin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [pendingEncounter, setPendingEncounter] =
    useState<DetectedEncounter | null>(null);
  const [pendingReval, setPendingReval] = useState<RevalCommand | null>(null);
  const [pendingBriefing, setPendingBriefing] = useState<PatientBriefing | null>(null);
  const [pendingRobinQuery, setPendingRobinQuery] = useState<string | null>(null);
  const [robinActivated, setRobinActivated] = useState(false);
  const [pendingAction, setPendingAction] = useState<AgentActionResult | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<AgentActionResult | null>(null);
  const [ambientMode, setAmbientMode] = useState<AmbientMode>("ambient");
  const isPausedRef = useRef(false);
  const shiftIdRef = useRef<string | null>(null);
  const dictationBufferContentRef = useRef("");

  const { request: requestWakeLock, release: releaseWakeLock } = useWakeLock();

  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isListeningRef = useRef(false);

  const detectionBufferRef = useRef("");
  const lastSuccessDetectionRef = useRef(0);
  const lastAttemptRef = useRef(0);
  const detectingRef = useRef(false);

  const runDetection = useCallback(async (buffer: string) => {
    if (detectingRef.current) return;
    detectingRef.current = true;
    lastAttemptRef.current = Date.now();
    detectionBufferRef.current = "";

    try {
      const res = await fetch("/api/detect-encounter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buffer }),
      });
      const data = await res.json();
      if (data.detected) {
        lastSuccessDetectionRef.current = Date.now();
        setPendingEncounter({
          id: crypto.randomUUID(),
          chiefComplaint: data.chiefComplaint,
          transcript: buffer,
          detectedAt: Date.now(),
          confidence: data.confidence,
        });
      }
    } catch {
      // Detection failure is non-fatal
    } finally {
      detectingRef.current = false;
    }
  }, []);

  const handleTranscript = useCallback(
    (transcript: string, isFinal: boolean) => {
      if (!transcript) return;

      // Always check for Robin wake word on every final segment
      if (isFinal) {
        // Robin wake word — classify and route immediately
        const wakeCommand = extractWakeCommand(transcript);
        if (wakeCommand) {
          const wordCount = wakeCommand.trim().split(/\s+/).length;
          // Layer 3: classify all voice commands
          const classified = classifyCommand(wakeCommand);

          if (classified && shiftIdRef.current) {
            if (classified.requiresDictation) {
              // Enter dictation mode — client captures content, sends on endDictation
              setAmbientMode("dictating");
              dictationBufferContentRef.current = "";
              setPendingAction({
                id: crypto.randomUUID(),
                ok: true,
                actionTaken: `Dictating: ${classified.type.replace(/_/g, " ")}`,
                confidence: 1,
                confirmationRequired: false,
                commandType: classified.type,
                requiresDictation: true,
              });
            } else {
              // Fire immediately
              fireAgentAct(shiftIdRef.current, classified.type, wakeCommand);
            }
          } else if (isPatientBriefing(wakeCommand)) {
            setPendingBriefing({ raw: wakeCommand, detectedAt: Date.now() });
            if (shiftIdRef.current) {
              fireAgentAct(shiftIdRef.current, "patient_briefing", wakeCommand);
            }
          } else if (isRevalCommand(wakeCommand)) {
            setPendingReval({ raw: wakeCommand, detectedAt: Date.now() });
          } else if (wordCount >= 4) {
            setPendingRobinQuery(wakeCommand);
          } else {
            setRobinActivated(true);
          }
          return;
        }

        // EMS radio chatter — skip encounter detection entirely
        if (isRadioChatter(transcript)) {
          return;
        }

        // Dictation mode — accumulate to dictation buffer, not ambient
        if (ambientMode === "dictating") {
          dictationBufferContentRef.current += ` ${transcript}`;
          setCurrentTranscript(dictationBufferContentRef.current.trim());
          return;
        }

        // Passive consult detection — no wake word needed
        if (isConsultDetection(transcript) && shiftIdRef.current) {
          fireAgentAct(shiftIdRef.current, "consult_log", transcript);
        }

        setCurrentTranscript((prev) =>
          prev ? `${prev} ${transcript}` : transcript
        );
        detectionBufferRef.current += ` ${transcript}`;

        const wordCount = detectionBufferRef.current.trim().split(/\s+/).length;
        const successCooldownElapsed =
          Date.now() - lastSuccessDetectionRef.current > DETECTION_SUCCESS_COOLDOWN_MS;
        const failCooldownElapsed =
          Date.now() - lastAttemptRef.current > DETECTION_FAIL_COOLDOWN_MS;
        const cooldownOk = successCooldownElapsed && failCooldownElapsed;

        if (wordCount >= DETECTION_WORD_THRESHOLD && cooldownOk && !pendingEncounter) {
          runDetection(detectionBufferRef.current.trim());
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingEncounter, runDetection, ambientMode]
  );

  const fetchDeepgramToken = async (): Promise<string> => {
    const res = await fetch("/api/deepgram-token");
    if (!res.ok) throw new Error("Failed to get Deepgram token");
    const { accessToken } = await res.json();
    return accessToken;
  };

  const startListening = useCallback(async () => {
    let accessToken: string;
    try {
      accessToken = await fetchDeepgramToken();
    } catch {
      setError("Failed to get Deepgram token");
      return;
    }

    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const ws = createDeepgramSocket(
        { accessToken },
        (data) => {
          const transcript = data.channel?.alternatives[0]?.transcript || "";
          handleTranscript(transcript, data.is_final ?? false);
        },
        (err) => {
          setError(err instanceof Event ? "Connection error" : String(err));
        },
        () => {
          setIsConnected(false);
          // Auto-reconnect on unexpected close
          if (isListeningRef.current) {
            setTimeout(() => startListening(), 3000);
          }
        }
      );

      ws.onopen = () => {
        setIsConnected(true);
        setIsListening(true);
        isListeningRef.current = true;
        requestWakeLock();

        const audioContext = new AudioContext({ sampleRate: 16000 });

        // iOS Safari suspends AudioContext when the page is hidden.
        // Resume it whenever the page becomes visible again.
        const resumeAudio = () => {
          if (
            document.visibilityState === "visible" &&
            audioContext.state === "suspended"
          ) {
            audioContext.resume().catch(() => {});
          }
        };
        document.addEventListener("visibilitychange", resumeAudio);
        // Store cleanup on the context so stopListening can remove it
        (audioContext as AudioContext & { _cleanup?: () => void })._cleanup =
          () => document.removeEventListener("visibilitychange", resumeAudio);
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const inputData = e.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(pcm16.buffer);
        };

        source.connect(processor);
        processor.connect(audioContext.destination);
        processorRef.current = processor;
        contextRef.current = audioContext;

        // Keepalive — prevents Deepgram closing on silence
        keepaliveRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "KeepAlive" }));
          }
        }, 8000);
      };

      wsRef.current = ws;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Microphone access denied";
      setError(message);
    }
  }, [handleTranscript]);

  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    if (keepaliveRef.current) {
      clearInterval(keepaliveRef.current);
      keepaliveRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (contextRef.current) {
      (contextRef.current as AudioContext & { _cleanup?: () => void })._cleanup?.();
      contextRef.current.close();
      contextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsListening(false);
    setIsConnected(false);
    releaseWakeLock();
  }, [releaseWakeLock]);

  const dismissPendingEncounter = useCallback(() => {
    setPendingEncounter(null);
    lastSuccessDetectionRef.current = Date.now();
  }, []);

  const confirmPendingEncounter = useCallback(() => {
    const enc = pendingEncounter;
    setPendingEncounter(null);
    lastSuccessDetectionRef.current = Date.now();
    return enc;
  }, [pendingEncounter]);

  const dismissReval = useCallback(() => {
    setPendingReval(null);
  }, []);

  const dismissBriefing = useCallback(() => {
    setPendingBriefing(null);
  }, []);

  const dismissAction = useCallback(() => {
    setPendingAction(null);
  }, []);

  const dismissConfirmation = useCallback(() => {
    setPendingConfirmation(null);
  }, []);

  const setShiftId = useCallback((id: string | null) => {
    shiftIdRef.current = id;
  }, []);

  const fireAgentAct = useCallback(
    async (
      shiftId: string,
      commandType: AgentCommandType,
      rawText: string,
      encounterId?: string
    ) => {
      try {
        const res = await fetch("/api/agent/act", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shiftId, commandType, rawText, encounterId }),
        });
        const data = await res.json();
        if (!data.ok) return;

        const result: AgentActionResult = {
          id: crypto.randomUUID(),
          ok: data.ok,
          actionTaken: data.actionTaken,
          confidence: data.confidence,
          confirmationRequired: data.confirmationRequired,
          commandType,
          parsedPayload: data.parsedPayload,
          encounters: data.encounters,
          encounterId: data.encounterId,
          shiftId,
        };

        if (data.confirmationRequired) {
          setPendingConfirmation(result);
        } else {
          setPendingAction(result);
        }
      } catch {
        // Agent act failure is non-fatal
      }
    },
    []
  );

  const confirmAction = useCallback(
    async (card: AgentActionResult) => {
      setPendingConfirmation(null);
      if (!card.shiftId || !card.parsedPayload) return;

      // Re-send with forced confirmation — the server will create the records
      // For now, handle client-side by calling agent/act again
      // This is a simplified confirm: we trust the parsed payload
      try {
        const res = await fetch("/api/agent/act", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shiftId: card.shiftId,
            commandType: card.commandType,
            rawText: `CONFIRMED: ${card.actionTaken}`,
            encounterId: card.encounterId,
          }),
        });
        const data = await res.json();
        if (data.ok && !data.confirmationRequired) {
          setPendingAction({
            ...card,
            actionTaken: data.actionTaken,
            confirmationRequired: false,
            encounters: data.encounters,
          });
        }
      } catch {
        // Confirmation failure is non-fatal
      }
    },
    []
  );

  // End dictation — send accumulated content to agent/act
  const endDictation = useCallback(() => {
    if (ambientMode !== "dictating") return;
    const content = dictationBufferContentRef.current.trim();
    setAmbientMode("ambient");
    dictationBufferContentRef.current = "";

    if (content && shiftIdRef.current && pendingAction?.commandType) {
      fireAgentAct(
        shiftIdRef.current,
        pendingAction.commandType,
        content,
        undefined
      );
    }
  }, [ambientMode, pendingAction, fireAgentAct]);

  // End Q&A session
  const endQASession = useCallback(() => {
    setAmbientMode("ambient");
  }, []);

  const clearRobinQuery = useCallback(() => {
    setPendingRobinQuery(null);
  }, []);

  const clearRobinActivated = useCallback(() => {
    setRobinActivated(false);
  }, []);

  // Pause ambient — release mic so Robin chat can take over
  const pauseForRobin = useCallback(() => {
    if (!isListeningRef.current || isPausedRef.current) return;
    isPausedRef.current = true;
    setIsPausedForRobin(true);
    // Tear down audio processing and WebSocket but remember we're still "listening"
    if (keepaliveRef.current) { clearInterval(keepaliveRef.current); keepaliveRef.current = null; }
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (contextRef.current) {
      (contextRef.current as AudioContext & { _cleanup?: () => void })._cleanup?.();
      contextRef.current.close(); contextRef.current = null;
    }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      wsRef.current.close(); wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  // Resume ambient — restart after Robin chat finishes
  const resumeFromRobin = useCallback(() => {
    if (!isPausedRef.current) return;
    isPausedRef.current = false;
    setIsPausedForRobin(false);
    if (isListeningRef.current) {
      // Brief delay so the mic stream from chat fully releases first
      setTimeout(() => startListening(), 600);
    }
  }, [startListening]);

  useEffect(() => {
    return () => {
      isListeningRef.current = false;
      stopListening();
    };
  }, [stopListening]);

  return {
    isListening,
    isConnected,
    isPausedForRobin,
    ambientMode,
    error,
    currentTranscript,
    pendingEncounter,
    pendingReval,
    pendingBriefing,
    pendingAction,
    pendingConfirmation,
    pendingRobinQuery,
    robinActivated,
    setShiftId,
    startListening,
    stopListening,
    pauseForRobin,
    resumeFromRobin,
    endDictation,
    endQASession,
    dismissPendingEncounter,
    confirmPendingEncounter,
    dismissReval,
    dismissBriefing,
    dismissAction,
    dismissConfirmation,
    confirmAction,
    clearRobinQuery,
    clearRobinActivated,
  };
}
