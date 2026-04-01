"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface Props {
  shiftId?: string;
  encounterId?: string;
}

export default function RobinChat({ shiftId, encounterId }: Props) {
  const supabase = createClient();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [unread, setUnread] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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
        // First open — Robin sends a greeting
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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

    // Optimistic user message
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // Save user message
    saveMessage("user", text);

    // Build history for API (exclude optimistic greeting)
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

      // Commit streamed message
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

  return (
    <>
      {/* Chat panel */}
      {isOpen && (
        <div className="fixed inset-0 sm:inset-auto sm:bottom-20 sm:right-6 z-50 flex flex-col sm:w-96 sm:h-[70vh] sm:max-h-[600px] bg-white sm:rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-blue-700 text-white shrink-0">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-sm font-bold">
                R
              </span>
              <span className="font-semibold text-sm">Robin</span>
              {encounterId && (
                <span className="text-xs text-blue-200 font-normal">
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
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-br-sm"
                      : "bg-gray-100 text-gray-900 rounded-bl-sm"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))}

            {/* Streaming response */}
            {streaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2 text-sm text-gray-900 leading-relaxed">
                  {streamingText ? (
                    <p className="whitespace-pre-wrap">{streamingText}</p>
                  ) : (
                    <span className="flex gap-1 items-center h-5">
                      <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:300ms]" />
                    </span>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-gray-100 shrink-0">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask Robin anything…"
                disabled={streaming}
                className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || streaming}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 shrink-0"
                aria-label="Send"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4 rotate-90"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
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
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-blue-700 text-white shadow-lg hover:bg-blue-800 transition-all active:scale-95"
        aria-label="Open Robin"
      >
        {isOpen ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        ) : (
          <span className="text-lg font-bold tracking-tight">R</span>
        )}
        {unread && !isOpen && (
          <span className="absolute top-1 right-1 h-3 w-3 rounded-full bg-red-500 border-2 border-white" />
        )}
      </button>
    </>
  );
}
