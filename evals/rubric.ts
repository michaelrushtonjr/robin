import type { RunRobinThinkResult } from "../src/lib/robinThink";

// ─── Ground truth shape ───────────────────────────────────────────────────────

export interface EncounterFixture {
  id: string;
  description: string;
  chiefComplaint: string;
  disposition?: string | null;
  transcript: string;
  groundTruth: GroundTruth;
}

export interface GroundTruth {
  code: string;
  codeAlternates: string[];
  /** Acceptable overall MDM levels. First entry is "ideal," rest are accepted. */
  overallMDM: Array<"straightforward" | "low" | "moderate" | "high">;
  axes: {
    problems: Array<"straightforward" | "low" | "moderate" | "high">;
    data: Array<"straightforward" | "low" | "moderate" | "high">;
    risk: Array<"straightforward" | "low" | "moderate" | "high">;
  };
  /** Each inner array is a set of acceptable synonyms; Robin must hit one. */
  requiredGapMentions: string[][];
  /**
   * Substrings that must NOT appear in any rationale or gap text — UNLESS
   * they appear in a clearly negated context (e.g. "no X", "without X",
   * "not X", "X is not", "no documented X"). Use these to catch affirmative
   * wrong reasoning, not negated explanations of what does NOT apply.
   */
  forbiddenRationaleSubstrings: string[];
  notes?: string;
}

/**
 * Returns true if the substring appears in a clearly negated context.
 * Conservative: only matches a small set of explicit negation patterns
 * directly preceding the substring. Designed to avoid false positives
 * when Robin correctly explains what does NOT apply.
 */
function isNegated(blob: string, substring: string): boolean {
  const negationPatterns = [
    "no ",
    "not ",
    "without ",
    "no documented ",
    "absent ",
    "lacks ",
    "lacking ",
    "rather than ",
    "instead of ",
  ];
  // For each occurrence of the substring, check if it's preceded by a
  // negation token within a small window (last ~30 chars).
  let idx = blob.indexOf(substring);
  while (idx !== -1) {
    const window = blob.slice(Math.max(0, idx - 30), idx);
    const negated = negationPatterns.some((pat) => window.endsWith(pat));
    if (!negated) return false; // at least one occurrence is unnegated
    idx = blob.indexOf(substring, idx + substring.length);
  }
  return true; // all occurrences are negated, OR no occurrences found
}

// ─── Assertion result ─────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface EncounterReport {
  id: string;
  description: string;
  checks: Check[];
  passCount: number;
  failCount: number;
  /** Overall verdict: pass if every check passed. */
  verdict: CheckStatus;
  /** Key fields for at-a-glance table. */
  summary: {
    code: string;
    overallMDM: string;
    problems: string;
    data: string;
    risk: string;
    iterations: number;
  };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function scoreEncounter(
  fixture: EncounterFixture,
  result: RunRobinThinkResult
): EncounterReport {
  const checks: Check[] = [];
  const { mdmData } = result;
  const gt = fixture.groundTruth;

  // E&M code
  const code = mdmData.em_assessment?.code ?? "(none)";
  const codeAcceptable =
    code === gt.code || gt.codeAlternates.includes(code);
  checks.push({
    name: "E&M code",
    status: codeAcceptable ? "pass" : "fail",
    detail: codeAcceptable
      ? code
      : `got ${code}, expected ${gt.code}${gt.codeAlternates.length ? ` (or ${gt.codeAlternates.join("/")})` : ""}`,
  });

  // Overall MDM
  const overall = mdmData.mdm_scaffold?.overall_mdm ?? "(none)";
  const overallAcceptable = gt.overallMDM.includes(overall as never);
  checks.push({
    name: "Overall MDM",
    status: overallAcceptable ? "pass" : "fail",
    detail: overallAcceptable
      ? overall
      : `got ${overall}, expected one of [${gt.overallMDM.join(", ")}]`,
  });

  // Individual axes
  const problems = mdmData.mdm_scaffold?.problems.complexity ?? "(none)";
  const data = mdmData.mdm_scaffold?.data.complexity ?? "(none)";
  const risk = mdmData.mdm_scaffold?.risk.complexity ?? "(none)";

  checks.push({
    name: "Problems axis",
    status: gt.axes.problems.includes(problems as never) ? "pass" : "fail",
    detail: `got ${problems}, expected one of [${gt.axes.problems.join(", ")}]`,
  });
  checks.push({
    name: "Data axis",
    status: gt.axes.data.includes(data as never) ? "pass" : "fail",
    detail: `got ${data}, expected one of [${gt.axes.data.join(", ")}]`,
  });
  checks.push({
    name: "Risk axis",
    status: gt.axes.risk.includes(risk as never) ? "pass" : "fail",
    detail: `got ${risk}, expected one of [${gt.axes.risk.join(", ")}]`,
  });

  // Required gap mentions — concatenate all gap text + rationales + summary
  // into a single lowercased blob, then check each required group.
  const gapBlob = [
    ...mdmData.gaps.flatMap((g) => [g.description, g.suggested_fix]),
    mdmData.mdm_scaffold?.one_thing_to_upgrade ?? "",
    mdmData.em_assessment?.upgrade_requires ?? "",
    mdmData.summary ?? "",
  ]
    .join(" | ")
    .toLowerCase();

  for (const synonymGroup of gt.requiredGapMentions) {
    const hit = synonymGroup.some((syn) =>
      gapBlob.includes(syn.toLowerCase())
    );
    checks.push({
      name: `Required gap: ${synonymGroup[0]}`,
      status: hit ? "pass" : "fail",
      detail: hit
        ? "mentioned"
        : `no mention of any of [${synonymGroup.join(", ")}]`,
    });
  }

  // Forbidden rationale substrings — scan rationales + gap text
  const rationaleBlob = [
    mdmData.mdm_scaffold?.problems.rationale ?? "",
    mdmData.mdm_scaffold?.data.rationale ?? "",
    mdmData.mdm_scaffold?.risk.rationale ?? "",
    mdmData.em_assessment?.rationale ?? "",
    mdmData.em_assessment?.upgrade_requires ?? "",
    ...mdmData.gaps.map((g) => g.description),
  ]
    .join(" | ")
    .toLowerCase();

  for (const forbidden of gt.forbiddenRationaleSubstrings) {
    const lower = forbidden.toLowerCase();
    const present = rationaleBlob.includes(lower);
    // Pass if either: (a) substring not present at all, OR
    // (b) every occurrence is in a clearly negated context.
    const violated = present && !isNegated(rationaleBlob, lower);
    checks.push({
      name: `Forbidden: "${forbidden}"`,
      status: violated ? "fail" : "pass",
      detail: violated
        ? "found in rationale (unnegated)"
        : present
          ? "present but negated — OK"
          : "clean",
    });
  }

  const passCount = checks.filter((c) => c.status === "pass").length;
  const failCount = checks.filter((c) => c.status === "fail").length;

  return {
    id: fixture.id,
    description: fixture.description,
    checks,
    passCount,
    failCount,
    verdict: failCount === 0 ? "pass" : "fail",
    summary: {
      code,
      overallMDM: overall,
      problems,
      data,
      risk,
      iterations: result.iterations,
    },
  };
}

// ─── Pretty printing ──────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function printReport(report: EncounterReport): void {
  const mark = report.verdict === "pass" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const header = `${mark} ${BOLD}${report.id}${RESET} ${DIM}— ${report.description}${RESET}`;
  console.log(header);
  console.log(
    `  code=${report.summary.code}  mdm=${report.summary.overallMDM}  problems=${report.summary.problems}  data=${report.summary.data}  risk=${report.summary.risk}  iters=${report.summary.iterations}`
  );
  for (const check of report.checks) {
    const checkMark =
      check.status === "pass" ? `${GREEN}  ✓${RESET}` : `${RED}  ✗${RESET}`;
    const name = check.status === "pass" ? `${DIM}${check.name}${RESET}` : check.name;
    const detail = check.detail ? ` ${DIM}(${check.detail})${RESET}` : "";
    if (check.status === "fail") {
      console.log(`${checkMark} ${name}${detail}`);
    }
  }
  console.log();
}

export function printSummary(reports: EncounterReport[]): void {
  const total = reports.length;
  const passed = reports.filter((r) => r.verdict === "pass").length;
  const failed = total - passed;
  const bar =
    failed === 0
      ? `${GREEN}${BOLD}${passed}/${total} PASS${RESET}`
      : `${RED}${BOLD}${failed} FAIL${RESET}${DIM}, ${passed} pass${RESET}`;
  console.log(`${bar}\n`);
}
