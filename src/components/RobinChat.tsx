"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { createDeepgramSocket } from "@/lib/deepgram";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface Props {
  shiftId?: string;
  encounterId?: string;
  pendingRobinQuery?: string | null;
  onRobinQueryHandled?: () => void;
  isAmbientListening?: boolean;
}

export default function RobinChat({ shiftId, encounterId, pendingRobinQuery, onRobinQueryHandled, isAmbientListening }: Props) {
  const supabase = createClient();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [unread, setUnread] = useState(false);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [isVoiceListening, setIsVoiceListening] = useState(false);
  const voiceWsRef = useRef<WebSocket | null>(null);
  const voiceProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const voiceContextRef = useRef<AudioContext | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);

  // Load chat history for this shift
  useEffect(() => {
    if (!shiftId) {
      setMessages([{
        id: "greeting",
        role: "assistant",
        content: "I'm Robin. Start your shift to begin.",
        created_at: new Date().toISOString(),
      }]);
      return;
    }
    async function loadHistory() {
      const { data } = await supabase
        .from("robin_messages")
        .select("*")
        .eq("shift_id", shiftId)
        .order("created_at", { ascending: true })
        .limit(100);
      if (data && data.length > 0) {
        setMessages(data);
      } else {
        const greeting: Message = {
          id: "greeting",
          role: "assistant",
          content:
            "Hey! I'm Robin — I've got full context on your shift and I'm ready to roll. Ask me anything: documentation gaps, discharge instructions, patient summaries, coding questions. Let's make this shift smooth.",
          created_at: new Date().toISOString(),
        };
        setMessages([greeting]);
      }
    }
    loadHistory();
  }, [shiftId, supabase]);

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
      setUnread(false);
    }
  }, [isOpen]);

  const saveMessage = useCallback(
    async (role: "user" | "assistant", content: string) => {
      const { data } = await supabase
        .from("robin_messages")
        .insert({ shift_id: shiftId, role, content })
        .select()
        .single();
      return data;
    },
    [shiftId, supabase]
  );

  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming || !shiftId) return;
    setInput("");

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    saveMessage("user", text);

    const history = messages
      .filter((m) => m.id !== "greeting")
      .map((m) => ({ role: m.role, content: m.content }));

    setStreaming(true);
    setStreamingText("");
    abortRef.current = new AbortController();

    try {
      const response = await fetch("/api/robin-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          shiftId,
          encounterId: encounterId ?? null,
          history,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error("Robin is unavailable right now.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        setStreamingText(fullText);
      }

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: fullText,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      saveMessage("assistant", fullText);

      if (!isOpen) setUnread(true);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        const errMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Sorry, I ran into an issue. Try again in a moment.",
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errMsg]);
      }
    } finally {
      setStreaming(false);
      setStreamingText("");
      abortRef.current = null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // Auto-open and send when "Hey Robin" is heard via ambient
  useEffect(() => {
    if (!pendingRobinQuery || !shiftId) return;
    setIsOpen(true);
    setInput(pendingRobinQuery);
    onRobinQueryHandled?.();
    // Small delay so the chat opens visually before sending
    const t = setTimeout(() => {
      setInput("");
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: pendingRobinQuery,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      saveMessage("user", pendingRobinQuery);

      const history = messages
        .filter((m) => m.id !== "greeting")
        .map((m) => ({ role: m.role, content: m.content }));

      setStreaming(true);
      setStreamingText("");
      abortRef.current = new AbortController();

      fetch("/api/robin-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: pendingRobinQuery, shiftId, encounterId: encounterId ?? null, history }),
        signal: abortRef.current.signal,
      }).then(async (response) => {
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullText += decoder.decode(value, { stream: true });
          setStreamingText(fullText);
        }
        const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: fullText, created_at: new Date().toISOString() };
        setMessages((prev) => [...prev, assistantMsg]);
        saveMessage("assistant", fullText);
      }).catch(() => {}).finally(() => { setStreaming(false); setStreamingText(""); });
    }, 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRobinQuery]);

  // Voice mic for chat input
  const stopVoice = useCallback(() => {
    voiceProcessorRef.current?.disconnect();
    voiceProcessorRef.current = null;
    voiceContextRef.current?.close();
    voiceContextRef.current = null;
    voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
    voiceStreamRef.current = null;
    if (voiceWsRef.current?.readyState === WebSocket.OPEN) {
      voiceWsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      voiceWsRef.current.close();
    }
    voiceWsRef.current = null;
    setIsVoiceListening(false);
  }, []);

  const startVoice = useCallback(async () => {
    if (isVoiceListening) { stopVoice(); return; }
    const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
    if (!apiKey) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true } });
      voiceStreamRef.current = stream;
      setIsVoiceListening(true);

      const ws = createDeepgramSocket(
        { apiKey, interimResults: true, utteranceEndMs: 1000 },
        (data) => {
          const t = data.channel?.alternatives[0]?.transcript || "";
          if (!t) return;
          if (data.speech_final) {
            setInput(t);
            stopVoice();
          } else if (!data.is_final) {
            setInput(t);
          }
        },
        () => stopVoice(),
        () => setIsVoiceListening(false)
      );

      ws.onopen = () => {
        const ctx = new AudioContext({ sampleRate: 16000 });
        const src = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(pcm.buffer);
        };
        src.connect(proc);
        proc.connect(ctx.destination);
        voiceProcessorRef.current = proc;
        voiceContextRef.current = ctx;
      };
      voiceWsRef.current = ws;
    } catch { setIsVoiceListening(false); }
  }, [isVoiceListening, stopVoice]);

  useEffect(() => () => stopVoice(), [stopVoice]);

  return (
    <>
      {/* Chat panel */}
      {isOpen && (
        <div
          className="fixed inset-0 sm:inset-auto sm:bottom-20 sm:right-6 z-50 flex flex-col sm:w-96 sm:h-[70vh] sm:max-h-[600px] sm:rounded-2xl shadow-2xl overflow-hidden"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ backgroundColor: "var(--robin)" }}
          >
            <div className="flex items-center gap-2">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold font-syne"
                style={{ backgroundColor: "rgba(255,255,255,0.2)", color: "white" }}
              >
                R
              </span>
              <span className="font-bold text-sm text-white font-syne">Robin</span>
              {encounterId && (
                <span className="text-xs font-syne" style={{ color: "rgba(255,255,255,0.65)" }}>
                  · encounter context
                </span>
              )}
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/70 hover:text-white text-xl leading-none p-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Messages */}
          <div ref={messagesScrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className="max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed font-syne"
                  style={
                    msg.role === "user"
                      ? {
                          backgroundColor: "var(--robin)",
                          color: "white",
                          borderBottomRightRadius: "4px",
                        }
                      : {
                          backgroundColor: "var(--surface2)",
                          color: "var(--text)",
                          borderBottomLeftRadius: "4px",
                        }
                  }
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))}

            {/* Streaming response */}
            {streaming && (
              <div className="flex justify-start">
                <div
                  className="max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed font-syne"
                  style={{
                    backgroundColor: "var(--surface2)",
                    color: "var(--text)",
                    borderBottomLeftRadius: "4px",
                  }}
                >
                  {streamingText ? (
                    <p className="whitespace-pre-wrap">{streamingText}</p>
                  ) : (
                    <span className="flex gap-1 items-center h-5">
                      <span className="h-1.5 w-1.5 rounded-full animate-bounce [animation-delay:0ms]" style={{ backgroundColor: "var(--muted)" }} />
                      <span className="h-1.5 w-1.5 rounded-full animate-bounce [animation-delay:150ms]" style={{ backgroundColor: "var(--muted)" }} />
                      <span className="h-1.5 w-1.5 rounded-full animate-bounce [animation-delay:300ms]" style={{ backgroundColor: "var(--muted)" }} />
                    </span>
                  )}
                </div>
              </div>
            )}

          </div>

          {/* Input */}
          <div
            className="px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] shrink-0"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <div className="flex items-center gap-2">
              {/* Voice mic button */}
              <button
                onClick={startVoice}
                className="flex h-9 w-9 items-center justify-center rounded-full shrink-0 transition-all active:scale-95"
                style={isVoiceListening
                  ? { backgroundColor: "var(--robin)", color: "white" }
                  : { backgroundColor: "var(--surface2)", color: "var(--muted)", border: "1px solid var(--border2)" }
                }
                aria-label={isVoiceListening ? "Stop listening" : "Speak"}
              >
                {isVoiceListening ? (
                  <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-7 10a1 1 0 0 1 2 0 5 5 0 0 0 10 0 1 1 0 0 1 2 0 7 7 0 0 1-6 6.92V20h2a1 1 0 0 1 0 2H9a1 1 0 0 1 0-2h2v-2.08A7 7 0 0 1 5 11z"/>
                  </svg>
                )}
              </button>

              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isVoiceListening ? "Listening…" : "Ask Robin anything…"}
                disabled={streaming}
                className="flex-1 rounded-full px-4 py-2 text-sm font-syne focus:outline-none disabled:opacity-50"
                style={{
                  border: "1px solid var(--border2)",
                  backgroundColor: isVoiceListening ? "var(--robin-dim)" : "var(--surface2)",
                  color: "var(--text)",
                }}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || streaming}
                className="flex h-9 w-9 items-center justify-center rounded-full text-white disabled:opacity-40 shrink-0 transition-all active:scale-95"
                style={{ backgroundColor: "var(--robin)" }}
                aria-label="Send"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 rotate-90" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating button */}
      <button
        onClick={() => {
          setIsOpen((prev) => !prev);
          setUnread(false);
        }}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg transition-all active:scale-95"
        style={{
          backgroundColor: "var(--robin)",
          boxShadow: "0 4px 16px rgba(224,75,32,0.35)",
        }}
        aria-label="Open Robin"
      >
        {/* Ambient listening ring */}
        {isAmbientListening && !isOpen && (
          <span
            className="absolute inset-0 rounded-full animate-ping opacity-30"
            style={{ backgroundColor: "var(--robin)" }}
          />
        )}
        {isOpen ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        ) : (
          <span className="text-lg font-bold font-syne">R</span>
        )}
        {unread && !isOpen && (
          <span
            className="absolute top-1 right-1 h-3 w-3 rounded-full border-2"
            style={{ backgroundColor: "var(--amber)", borderColor: "var(--surface)" }}
          />
        )}
      </button>
    </>
  );
}
