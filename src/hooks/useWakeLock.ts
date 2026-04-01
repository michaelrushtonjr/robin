"use client";

import { useRef, useCallback, useEffect } from "react";

export function useWakeLock() {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wantLock = useRef(false);

  const request = useCallback(async () => {
    if (!("wakeLock" in navigator)) return;
    wantLock.current = true;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // Denied or unavailable — non-fatal
    }
  }, []);

  const release = useCallback(async () => {
    wantLock.current = false;
    if (wakeLockRef.current) {
      await wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  }, []);

  // Wake Lock is automatically released when the page is hidden.
  // Re-acquire it when the page becomes visible again.
  useEffect(() => {
    async function handleVisibility() {
      if (document.visibilityState === "visible" && wantLock.current) {
        try {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        } catch {
          // Non-fatal
        }
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    return () => {
      wantLock.current = false;
      wakeLockRef.current?.release().catch(() => {});
    };
  }, []);

  return { request, release };
}
