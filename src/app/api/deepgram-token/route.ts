import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET() {
  // Auth-gate — only authenticated physicians get a token
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return new Response("Deepgram API key not configured", { status: 500 });
  }

  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl_seconds: 30 }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Deepgram token grant failed:", text);
    return new Response("Failed to generate Deepgram token", { status: 502 });
  }

  const data = await res.json();

  const response = NextResponse.json({ accessToken: data.access_token });
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.headers.set("Surrogate-Control", "no-store");
  return response;
}
