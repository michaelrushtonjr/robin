import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ShiftLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div
      className="flex min-h-screen flex-col"
      style={{ backgroundColor: "var(--bg)" }}
    >
      {/* Top nav */}
      <header
        className="sticky top-0 z-40 border-b px-4 py-3"
        style={{
          backgroundColor: "var(--surface)",
          borderColor: "var(--border)",
        }}
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          {/* Robin wordmark */}
          <div className="flex items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg text-white font-bold font-syne text-sm"
              style={{ backgroundColor: "var(--robin)" }}
            >
              R
            </div>
            <span
              className="font-syne font-bold text-base tracking-tight"
              style={{ color: "var(--text)" }}
            >
              Robin
            </span>
          </div>

          {/* User + sign out */}
          <div className="flex items-center gap-3">
            <span
              className="hidden sm:block text-xs font-space-mono"
              style={{ color: "var(--muted)" }}
            >
              {user.email}
            </span>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="text-xs font-syne font-medium px-3 py-1.5 rounded-lg border transition-all active:scale-95"
                style={{
                  color: "var(--muted)",
                  borderColor: "var(--border2)",
                  backgroundColor: "var(--surface2)",
                }}
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
