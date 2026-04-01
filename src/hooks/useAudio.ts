"use client";

import { useRef, useState, useCallback } from "react";

export type AudioMode = "ambient" | "ptt";

interface UseAudioReturn {
  isRecording: boolean;
  stream: MediaStream | null;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}

export function useAudio(): UseAudioReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = mediaStream;
      setStream(mediaStream);
      setIsRecording(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Microphone access denied";
      setError(message);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setStream(null);
    setIsRecording(false);
  }, []);

  return { isRecording, stream, error, startRecording, stopRecording };
}
