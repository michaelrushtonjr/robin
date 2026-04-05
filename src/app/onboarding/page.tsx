"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export default function OnboardingInterview() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [saved, setSaved] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  // Auto-scroll on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streamingText]);

  // Auto-start interview on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    sendMessage("Hi Robin, I'm ready to set up my preferences.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendMessage(text?: string) {
    const msg = text || input.trim();
    if (!msg || streaming || saved) return;
    setInput("");

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: msg,
    };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    setStreaming(true);
    setStreamingText("");

    try {
      const response = await fetch("/api/onboarding-interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, history }),
      });

      if (!response.ok || !response.body) throw new Error("Failed");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        setStreamingText(fullText);
      }

      // Strip JSON block from displayed text
      const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/);
      const displayText = jsonMatch
        ? fullText.replace(/```json\s*[\s\S]*?```/, "").trim()
        : fullText;

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: displayText,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Detect and save preferences
      if (jsonMatch) {
        try {
          const preferences = JSON.parse(jsonMatch[1]);
          const res = await fetch("/api/physician/preferences", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preferences }),
          });
          if (res.ok) {
            setSaved(true);
            setTimeout(() => router.push("/shift"), 2500);
          }
        } catch {
          // JSON parse failed — interview continues
        }
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Sorry, I ran into an issue. Try again in a moment.",
        },
      ]);
    } finally {
      setStreaming(false);
      setStreamingText("");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div
      className="flex flex-col h-dvh"
      style={{ backgroundColor: "var(--bg)" }}
    >
      {/* Header */}
      <div
        className="shrink-0 px-4 py-3 flex items-center gap-3"
        style={{
          backgroundColor: "var(--surface)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-white font-bold font-space-mono text-sm"
          style={{ backgroundColor: "var(--robin)" }}
        >
          R
        </div>
        <div>
          <p
            className="text-sm font-bold font-syne"
            style={{ color: "var(--text)" }}
          >
            Welcome to Robin
          </p>
          <p
            className="text-xs font-syne"
            style={{ color: "var(--muted)" }}
          >
            Let&apos;s learn how you like to chart
          </p>
        </div>
      </div>

      {/* Chat area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-2xl space-y-3">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className="max-w-[85%] rounded-[14px] px-4 py-2.5 text-sm font-syne whitespace-pre-wrap"
                style={
                  msg.role === "user"
                    ? {
                        backgroundColor: "var(--robin)",
                        color: "#FFFFFF",
                      }
                    : {
                        backgroundColor: "var(--surface)",
                        color: "var(--text)",
                        border: "1px solid var(--border)",
                      }
                }
              >
                {msg.content}
              </div>
            </div>
          ))}

          {/* Streaming indicator */}
          {streaming && streamingText && (
            <div className="flex justify-start">
              <div
                className="max-w-[85%] rounded-[14px] px-4 py-2.5 text-sm font-syne whitespace-pre-wrap"
                style={{
                  backgroundColor: "var(--surface)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                }}
              >
                {streamingText.replace(/```json\s*[\s\S]*$/, "").trim() ||
                  streamingText}
              </div>
            </div>
          )}

          {streaming && !streamingText && (
            <div className="flex justify-start">
              <div
                className="rounded-[14px] px-4 py-2.5 flex items-center gap-1.5"
                style={{
                  backgroundColor: "var(--surface)",
                  border: "1px solid var(--border)",
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: "var(--robin)" }}
                />
                <span
                  className="h-1.5 w-1.5 rounded-full animate-pulse"
                  style={{
                    backgroundColor: "var(--robin)",
                    animationDelay: "150ms",
                  }}
                />
                <span
                  className="h-1.5 w-1.5 rounded-full animate-pulse"
                  style={{
                    backgroundColor: "var(--robin)",
                    animationDelay: "300ms",
                  }}
                />
              </div>
            </div>
          )}

          {/* Preferences saved confirmation */}
          {saved && (
            <div
              className="rounded-[14px] px-4 py-3 text-center"
              style={{
                backgroundColor: "var(--teal-dim)",
                border: "1px solid rgba(0,168,150,0.20)",
              }}
            >
              <p
                className="text-sm font-bold font-syne"
                style={{ color: "var(--teal)" }}
              >
                Preferences saved
              </p>
              <p
                className="text-xs font-syne mt-1"
                style={{ color: "var(--muted)" }}
              >
                Redirecting to your shift...
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Input bar */}
      {!saved && (
        <div
          className="shrink-0 px-4 py-3"
          style={{
            backgroundColor: "var(--surface)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div className="mx-auto max-w-2xl flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your answer..."
              disabled={streaming}
              className="flex-1 rounded-[10px] border px-3 py-2.5 text-sm font-syne focus:outline-none focus:ring-1 disabled:opacity-50"
              style={{
                borderColor: "var(--border2)",
                backgroundColor: "var(--surface2)",
                color: "var(--text)",
              }}
            />
            <button
              onClick={() => sendMessage()}
              disabled={streaming || !input.trim()}
              className="shrink-0 px-4 py-2.5 rounded-[10px] font-syne font-bold text-sm text-white transition-all active:scale-95 disabled:opacity-40"
              style={{ backgroundColor: "var(--robin)" }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
