const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

export interface DeepgramConfig {
  apiKey: string;
  model?: string;
  language?: string;
  smartFormat?: boolean;
  punctuate?: boolean;
  interimResults?: boolean;
  utteranceEndMs?: number;
  vadEvents?: boolean;
  maxSpeakers?: number;
}

export interface DeepgramChannel {
  alternatives: Array<{
    transcript: string;
    confidence: number;
    words?: Array<{
      word: string;
      start: number;
      end: number;
      confidence: number;
      speaker?: number;
    }>;
  }>;
}

export interface DeepgramMessage {
  type: string;
  channel?: DeepgramChannel;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
}

export function createDeepgramSocket(
  config: DeepgramConfig,
  onTranscript: (data: DeepgramMessage) => void,
  onError: (error: Event | string) => void,
  onClose: () => void
): WebSocket {
  const params = new URLSearchParams({
    model: config.model || "nova-2-medical",
    language: config.language || "en-US",
    smart_format: String(config.smartFormat ?? true),
    punctuate: String(config.punctuate ?? true),
    interim_results: String(config.interimResults ?? true),
    utterance_end_ms: String(config.utteranceEndMs ?? 1000),
    vad_events: String(config.vadEvents ?? true),
    diarize: "true",
    diarize_version: "latest",
    max_speakers: String(config.maxSpeakers ?? 30),
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
  });

  const ws = new WebSocket(`${DEEPGRAM_WS_URL}?${params}`, [
    "token",
    config.apiKey,
  ]);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as DeepgramMessage;
      if (data.type === "Results" && data.channel) {
        onTranscript(data);
      }
    } catch {
      // Ignore non-JSON messages
    }
  };

  ws.onerror = (event) => onError(event);
  ws.onclose = () => onClose();

  return ws;
}
