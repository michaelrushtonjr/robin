"use client";

import type { RobinAuditState } from "@/lib/robinTypes";

interface Props {
  audit: RobinAuditState;
}

const COMPLEXITY_COLORS: Record<string, { bg: string; text: string }> = {
  high: { bg: "var(--robin)", text: "#fff" },
  moderate: { bg: "var(--amber)", text: "#fff" },
  low: { bg: "var(--teal)", text: "#fff" },
  straightforward: { bg: "var(--surface2)", text: "var(--muted)" },
};

const SEVERITY_COLORS: Record<string, string> = {
  high: "var(--robin)",
  medium: "var(--amber)",
  low: "var(--muted)",
};

function ComplexityBadge({ level }: { level: string }) {
  const colors = COMPLEXITY_COLORS[level] ?? COMPLEXITY_COLORS.straightforward;
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold font-space-mono uppercase"
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {level}
    </span>
  );
}

export default function RobinInsightsPanel({ audit }: Props) {
  const { hpi, mdm, gaps, em, summary, loading } = audit;
  const hasData = hpi || mdm || gaps.length > 0 || em;

  return (
    <div
      className="rounded-[14px] border p-4 flex flex-col gap-3"
      style={{
        backgroundColor: "var(--surface)",
        borderColor: "var(--border)",
      }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <span
          className="text-sm font-bold font-syne"
          style={{ color: "var(--robin)" }}
        >
          Robin
        </span>
        {loading && !summary && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full animate-pulse"
              style={{ backgroundColor: "var(--robin)" }}
            />
            <span
              className="text-xs font-space-mono"
              style={{ color: "var(--muted)" }}
            >
              reviewing…
            </span>
          </span>
        )}
        {summary && (
          <span
            className="text-xs font-space-mono"
            style={{ color: "var(--muted)" }}
          >
            {summary}
          </span>
        )}
      </div>

      {/* ── Loading skeleton ────────────────────────────────────────────── */}
      {loading && !hasData && (
        <div className="flex flex-col gap-2">
          <div
            className="h-3 rounded w-3/4 animate-pulse"
            style={{ backgroundColor: "var(--surface2)" }}
          />
          <div
            className="h-3 rounded w-1/2 animate-pulse"
            style={{ backgroundColor: "var(--surface2)" }}
          />
        </div>
      )}

      {/* ── HPI Card ────────────────────────────────────────────────────── */}
      {hpi && (
        <div
          className="rounded-[10px] border px-3 py-2.5"
          style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span
              className="text-xs font-bold font-syne uppercase tracking-wider"
              style={{ color: "var(--text)" }}
            >
              HPI
            </span>
            <div className="flex items-center gap-2">
              <span
                className="text-xs font-bold font-space-mono"
                style={{ color: "var(--text)" }}
              >
                {hpi.score}/8
              </span>
              <span
                className="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold font-space-mono"
                style={{
                  backgroundColor:
                    hpi.brief_or_extended === "brief"
                      ? "var(--amber-dim)"
                      : "var(--teal-dim)",
                  color:
                    hpi.brief_or_extended === "brief"
                      ? "var(--amber)"
                      : "var(--teal)",
                }}
              >
                {hpi.brief_or_extended === "brief" ? "Brief HPI" : "Extended"}
              </span>
            </div>
          </div>
          {hpi.missing.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {hpi.missing.map((el) => (
                <span
                  key={el}
                  className="text-[10px] font-space-mono px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: "var(--surface2)",
                    color: "var(--muted)",
                  }}
                >
                  {el.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── MDM Card ────────────────────────────────────────────────────── */}
      {mdm && (
        <div
          className="rounded-[10px] border px-3 py-2.5"
          style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
        >
          <div className="flex flex-col gap-2">
            {(["problems", "data", "risk"] as const).map((element) => (
              <div key={element} className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <span
                    className="text-xs font-bold font-syne capitalize"
                    style={{ color: "var(--text)" }}
                  >
                    {element}
                  </span>
                  <p
                    className="text-[10px] mt-0.5"
                    style={{ color: "var(--muted)" }}
                  >
                    {mdm[element].rationale}
                  </p>
                </div>
                <ComplexityBadge level={mdm[element].complexity} />
              </div>
            ))}
          </div>

          <div
            className="my-2 h-px"
            style={{ backgroundColor: "var(--border)" }}
          />

          <div className="flex items-center justify-between">
            <span
              className="text-xs font-bold font-space-mono"
              style={{ color: "var(--text)" }}
            >
              Supported code: {mdm.supported_code}
            </span>
            {em && (
              <span
                className="text-xs font-space-mono"
                style={{ color: "var(--muted)" }}
              >
                RVU: {em.rvu}
              </span>
            )}
          </div>

          {mdm.next_code && mdm.one_thing_to_upgrade && (
            <div
              className="mt-2 rounded-lg px-3 py-2"
              style={{ backgroundColor: "var(--amber-dim)" }}
            >
              <p
                className="text-xs font-syne"
                style={{ color: "var(--text)" }}
              >
                {mdm.one_thing_to_upgrade}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Gaps ────────────────────────────────────────────────────────── */}
      {gaps.map((gap, i) => (
        <div
          key={i}
          className="rounded-[10px] border px-3 py-2.5"
          style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
        >
          <div className="flex items-start gap-2">
            <span
              className="mt-1.5 h-2 w-2 rounded-full shrink-0"
              style={{
                backgroundColor: SEVERITY_COLORS[gap.severity] ?? "var(--muted)",
              }}
            />
            <div className="flex-1">
              <p
                className="text-xs font-syne"
                style={{ color: "var(--text)" }}
              >
                {gap.description}
              </p>
              <p
                className="text-[10px] mt-1"
                style={{ color: "var(--muted)" }}
              >
                <span className="font-bold">Fix: </span>
                {gap.suggested_fix}
              </p>
              <span
                className="inline-block mt-1 text-[9px] font-space-mono uppercase tracking-wider"
                style={{ color: "var(--muted)" }}
              >
                {gap.gap_type.replace(/_/g, " ")}
              </span>
            </div>
          </div>
        </div>
      ))}

      {/* ── E&M Card ────────────────────────────────────────────────────── */}
      {em && (
        <div
          className="rounded-[10px] border px-3 py-2.5"
          style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
        >
          <div className="flex items-center justify-between mb-1">
            <span
              className="text-sm font-bold font-space-mono"
              style={{ color: "var(--text)" }}
            >
              {em.code} · {em.rvu} RVU
            </span>
            <ComplexityBadge level={em.mdm_level} />
          </div>
          <p
            className="text-[10px]"
            style={{ color: "var(--muted)" }}
          >
            {em.rationale}
          </p>
          {em.upgrade_possible && em.upgrade_requires && (
            <div
              className="mt-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
              style={{ backgroundColor: "var(--teal-dim)" }}
            >
              <span
                className="text-xs font-bold font-space-mono"
                style={{ color: "var(--teal)" }}
              >
                ↑
              </span>
              <span
                className="text-[10px] font-syne"
                style={{ color: "var(--text)" }}
              >
                {em.upgrade_requires}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
