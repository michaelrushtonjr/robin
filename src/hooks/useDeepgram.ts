"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { createDeepgramSocket, type DeepgramMessage } from "@/lib/deepgram";

export interface TranscriptSegment {
  text: string;
  isFinal: boolean;
  speaker?: number;
  timestamp: number;
}

interface UseDeepgramReturn {
  segments: TranscriptSegment[];
  interimText: string;
  finalTranscript: string;
  labeledTranscript: string;
  isConnected: boolean;
  error: string | null;
  connect: (stream: MediaStream) => void;
  disconnect: () => void;
  clearTranscript: () => void;
}

export function useDeepgram(): UseDeepgramReturn {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);

  // Plain transcript for backward compat
  const finalTranscript = segments
    .filter((s) => s.isFinal)
    .map((s) => s.text)
    .join(" ");

  // Speaker-labeled transcript — format: "[Speaker 0] text\n[Speaker 1] text"
  // Consecutive segments from the same speaker are merged into one block
  const labeledTranscript = segments
    .filter((s) => s.isFinal)
    .reduce<string>((acc, seg) => {
      const label =
        seg.speaker !== undefined ? `[Speaker ${seg.speaker}]` : "[Speaker]";
      const lastLine = acc.split("\n").pop() || "";
      if (lastLine.startsWith(label)) {
        return `${acc} ${seg.text}`;
      }
      return acc ? `${acc}\n${label} ${seg.text}` : `${label} ${seg.text}`;
    }, "");

  const connect = useCallback((stream: MediaStream) => {
    const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
    if (!apiKey) {
      setError("Deepgram API key not configured");
      return;
    }

    const ws = createDeepgramSocket(
      { apiKey },
      (data: DeepgramMessage) => {
        const transcript =
          data.channel?.alternatives[0]?.transcript || "";
        if (!transcript) return;

        const speaker = data.channel?.alternatives[0]?.words?.[0]?.speaker;

        if (data.is_final) {
          setSegments((prev) => [
            ...prev,
            {
              text: transcript,
              isFinal: true,
              speaker,
              timestamp: Date.now(),
            },
          ]);
          setInterimText("");
        } else {
          setInterimText(transcript);
        }
      },
      (err) => {
        const message =
          err instanceof Event ? "WebSocket error" : String(err);
        setError(message);
      },
      () => {
        setIsConnected(false);
      }
    );

    ws.onopen = () => {
      setIsConnected(true);
      setError(null);

      // Stream audio to Deepgram via AudioContext → ScriptProcessor
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 to Int16 PCM
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
    };

    wsRef.current = ws;
  }, []);

  const disconnect = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (contextRef.current) {
      contextRef.current.close();
      contextRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const clearTranscript = useCallback(() => {
    setSegments([]);
    setInterimText("");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    segments,
    interimText,
    finalTranscript,
    labeledTranscript,
    isConnected,
    error,
    connect,
    disconnect,
    clearTranscript,
  };
}
