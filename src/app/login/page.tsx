"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: authError } = isSignUp
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    router.push("/shift");
    router.refresh();
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{ backgroundColor: "var(--bg)" }}
    >
      <div
        className="w-full max-w-sm rounded-[24px] p-8 space-y-7"
        style={{
          backgroundColor: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "0 8px 40px rgba(0,0,0,0.06)",
        }}
      >
        {/* Logo + tagline */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-2xl text-white font-bold font-syne text-xl shadow-lg"
            style={{
              backgroundColor: "var(--robin)",
              boxShadow: "0 6px 20px rgba(224,75,32,0.28)",
            }}
          >
            R
          </div>
          <div className="text-center">
            <h1
              className="text-2xl font-bold font-syne"
              style={{ color: "var(--text)" }}
            >
              Robin
            </h1>
            <p
              className="mt-1 text-sm font-syne"
              style={{ color: "var(--muted)" }}
            >
              Your on-shift sidekick.
            </p>
          </div>
        </div>

        {/* Tab toggle */}
        <div
          className="flex rounded-[12px] p-1"
          style={{ backgroundColor: "var(--surface2)" }}
        >
          <button
            type="button"
            onClick={() => { setIsSignUp(false); setError(null); }}
            className="flex-1 py-2 rounded-[9px] text-sm font-syne font-semibold transition-all"
            style={
              !isSignUp
                ? {
                    backgroundColor: "var(--surface)",
                    color: "var(--text)",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
                  }
                : { color: "var(--muted)" }
            }
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => { setIsSignUp(true); setError(null); }}
            className="flex-1 py-2 rounded-[9px] text-sm font-syne font-semibold transition-all"
            style={
              isSignUp
                ? {
                    backgroundColor: "var(--surface)",
                    color: "var(--text)",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
                  }
                : { color: "var(--muted)" }
            }
          >
            Sign Up
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email */}
          <div>
            <label
              htmlFor="email"
              className="block text-[10px] font-bold font-space-mono uppercase tracking-widest mb-1.5"
              style={{ color: "var(--muted)" }}
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@hospital.com"
              className="w-full rounded-[12px] border px-3.5 py-2.5 text-sm font-syne focus:outline-none transition-colors"
              style={{
                borderColor: "var(--border2)",
                backgroundColor: "var(--surface2)",
                color: "var(--text)",
              }}
            />
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="block text-[10px] font-bold font-space-mono uppercase tracking-widest mb-1.5"
              style={{ color: "var(--muted)" }}
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-[12px] border px-3.5 py-2.5 text-sm font-syne focus:outline-none transition-colors"
              style={{
                borderColor: "var(--border2)",
                backgroundColor: "var(--surface2)",
                color: "var(--text)",
              }}
            />
          </div>

          {error && (
            <p
              className="text-xs font-syne px-3 py-2 rounded-lg"
              style={{
                color: "var(--robin)",
                backgroundColor: "var(--robin-dim)",
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-[14px] font-syne font-bold text-sm text-white transition-all active:scale-[0.98] disabled:opacity-50"
            style={{
              backgroundColor: "var(--robin)",
              boxShadow: "0 3px 12px rgba(224,75,32,0.30)",
            }}
          >
            {loading
              ? "Loading..."
              : isSignUp
                ? "Create Account"
                : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
