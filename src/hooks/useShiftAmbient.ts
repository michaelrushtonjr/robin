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
  error: string | null;
  currentTranscript: string;
  pendingEncounter: DetectedEncounter | null;
  pendingReval: RevalCommand | null;
  pendingBriefing: PatientBriefing | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
  dismissPendingEncounter: () => void;
  confirmPendingEncounter: () => DetectedEncounter | null;
  dismissReval: () => void;
  dismissBriefing: () => void;
}

// Words to accumulate before running encounter detection
const DETECTION_WORD_THRESHOLD = 12;
// Minimum time between new encounter creations — no encounter is faster than 1 minute
const DETECTION_COOLDOWN_MS = 60_000;

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
  /\brobin[,\s]+/i,
  /\bhey robin[,\s]+/i,
  /\bok robin[,\s]+/i,
];

function extractRevalCommand(transcript: string): string | null {
  for (const pattern of ROBIN_WAKE_PATTERNS) {
    const match = transcript.match(pattern);
    if (match) {
      const afterWake = transcript.slice(
        transcript.indexOf(match[0]) + match[0].length
      ).trim();
      if (afterWake.length > 5) return afterWake;
    }
  }
  return null;
}

export function useShiftAmbient(): UseShiftAmbientReturn {
  const [isListening, setIsListening] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [pendingEncounter, setPendingEncounter] =
    useState<DetectedEncounter | null>(null);
  const [pendingReval, setPendingReval] = useState<RevalCommand | null>(null);
  const [pendingBriefing, setPendingBriefing] = useState<PatientBriefing | null>(null);

  const wakeLock = useWakeLock();

  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isListeningRef = useRef(false);

  const detectionBufferRef = useRef("");
  const lastDetectionRef = useRef(0);
  const detectingRef = useRef(false);

  const runDetection = useCallback(async (buffer: string) => {
    if (detectingRef.current) return;
    detectingRef.current = true;
    lastDetectionRef.current = Date.now();
    detectionBufferRef.current = "";

    try {
      const res = await fetch("/api/detect-encounter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buffer }),
      });
      const data = await res.json();
      if (data.detected) {
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
        // Robin wake word — classify and handle immediately
        const robinCommand = extractRevalCommand(transcript);
        if (robinCommand) {
          if (isPatientBriefing(robinCommand)) {
            setPendingBriefing({ raw: robinCommand, detectedAt: Date.now() });
          } else {
            setPendingReval({ raw: robinCommand, detectedAt: Date.now() });
          }
          return;
        }

        // EMS radio chatter — skip encounter detection entirely
        if (isRadioChatter(transcript)) {
          return;
        }

        setCurrentTranscript((prev) =>
          prev ? `${prev} ${transcript}` : transcript
        );
        detectionBufferRef.current += ` ${transcript}`;

        const wordCount = detectionBufferRef.current.trim().split(/\s+/).length;
        const cooldownElapsed =
          Date.now() - lastDetectionRef.current > DETECTION_COOLDOWN_MS;

        if (
          wordCount >= DETECTION_WORD_THRESHOLD &&
          cooldownElapsed &&
          !pendingEncounter
        ) {
          runDetection(detectionBufferRef.current.trim());
        }
      }
    },
    [pendingEncounter, runDetection]
  );

  const startListening = useCallback(async () => {
    const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
    if (!apiKey) {
      setError("Deepgram API key not configured");
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
        { apiKey },
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
        wakeLock.request();

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
    wakeLock.release();
  }, [wakeLock]);

  const dismissPendingEncounter = useCallback(() => {
    setPendingEncounter(null);
    lastDetectionRef.current = Date.now();
  }, []);

  const confirmPendingEncounter = useCallback(() => {
    const enc = pendingEncounter;
    setPendingEncounter(null);
    lastDetectionRef.current = Date.now();
    return enc;
  }, [pendingEncounter]);

  const dismissReval = useCallback(() => {
    setPendingReval(null);
  }, []);

  const dismissBriefing = useCallback(() => {
    setPendingBriefing(null);
  }, []);

  useEffect(() => {
    return () => {
      isListeningRef.current = false;
      stopListening();
    };
  }, [stopListening]);

  return {
    isListening,
    isConnected,
    error,
    currentTranscript,
    pendingEncounter,
    pendingReval,
    pendingBriefing,
    startListening,
    stopListening,
    dismissPendingEncounter,
    confirmPendingEncounter,
    dismissReval,
    dismissBriefing,
  };
}
