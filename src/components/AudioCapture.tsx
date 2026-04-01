"use client";

import { useState, useEffect, useCallback } from "react";
import { useAudio, type AudioMode } from "@/hooks/useAudio";
import { useDeepgram } from "@/hooks/useDeepgram";

import type { TranscriptSegment } from "@/hooks/useDeepgram";

interface AudioCaptureProps {
  onTranscriptUpdate: (segments: TranscriptSegment[], labeled: string, interim: string) => void;
}

export default function AudioCapture({
  onTranscriptUpdate,
}: AudioCaptureProps) {
  const [mode, setMode] = useState<AudioMode>("ambient");
  const [isPttActive, setIsPttActive] = useState(false);
  const audio = useAudio();
  const deepgram = useDeepgram();

  // Sync segments + labeled transcript up to parent
  useEffect(() => {
    onTranscriptUpdate(deepgram.segments, deepgram.labeledTranscript, deepgram.interimText);
  }, [deepgram.segments, deepgram.labeledTranscript, deepgram.interimText, onTranscriptUpdate]);

  // Connect Deepgram when audio stream is available
  useEffect(() => {
    if (audio.stream && !deepgram.isConnected) {
      deepgram.connect(audio.stream);
    }
  }, [audio.stream, deepgram.isConnected, deepgram]);

  const handleAmbientToggle = useCallback(async () => {
    if (audio.isRecording) {
      audio.stopRecording();
      deepgram.disconnect();
    } else {
      await audio.startRecording();
    }
  }, [audio, deepgram]);

  const handlePttDown = useCallback(async () => {
    if (!audio.isRecording) {
      setIsPttActive(true);
      await audio.startRecording();
    }
  }, [audio]);

  const handlePttUp = useCallback(() => {
    if (audio.isRecording && isPttActive) {
      audio.stopRecording();
      deepgram.disconnect();
      setIsPttActive(false);
    }
  }, [audio, deepgram, isPttActive]);

  const error = audio.error || deepgram.error;

  return (
    <div className="space-y-4">
      {/* Mode Toggle */}
      <div className="flex items-center gap-2 rounded-lg bg-gray-100 p-1">
        <button
          onClick={() => setMode("ambient")}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            mode === "ambient"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          Ambient
        </button>
        <button
          onClick={() => setMode("ptt")}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            mode === "ptt"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          Push to Talk
        </button>
      </div>

      {/* Controls */}
      {mode === "ambient" ? (
        <button
          onClick={handleAmbientToggle}
          className={`w-full rounded-lg px-4 py-3 text-sm font-medium transition-all ${
            audio.isRecording
              ? "bg-red-500 text-white hover:bg-red-600"
              : "bg-blue-600 text-white hover:bg-blue-700"
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            {audio.isRecording && (
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            )}
            {audio.isRecording ? "Stop Listening" : "Start Ambient"}
          </span>
        </button>
      ) : (
        <button
          onMouseDown={handlePttDown}
          onMouseUp={handlePttUp}
          onMouseLeave={handlePttUp}
          onTouchStart={handlePttDown}
          onTouchEnd={handlePttUp}
          className={`w-full rounded-lg px-4 py-6 text-sm font-medium transition-all select-none ${
            isPttActive
              ? "bg-red-500 text-white scale-[0.98]"
              : "bg-blue-600 text-white hover:bg-blue-700"
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            {isPttActive && (
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            )}
            {isPttActive ? "Listening..." : "Hold to Talk"}
          </span>
        </button>
      )}

      {/* Status */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {deepgram.isConnected
            ? "Connected to Deepgram"
            : audio.isRecording
              ? "Connecting..."
              : "Ready"}
        </span>
        {deepgram.segments.length > 0 && (
          <button
            onClick={deepgram.clearTranscript}
            className="text-gray-400 hover:text-gray-600"
          >
            Clear
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
