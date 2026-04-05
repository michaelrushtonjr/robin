import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { preferences } = await request.json();

  if (
    !preferences ||
    !preferences.interview_completed_at ||
    !preferences.interview_version
  ) {
    return Response.json(
      { error: "Invalid preferences object" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("physicians")
    .update({ robin_preferences: preferences })
    .eq("id", user.id);

  if (error) {
    return Response.json(
      { error: "Failed to save preferences" },
      { status: 500 }
    );
  }

  return Response.json({ ok: true });
}
