import type { RunDifferentialExpanderResult } from "../../src/lib/differentialExpander";
import type { BadnessBucket } from "../../src/lib/robinTypes";

// ─── Ground truth shape ───────────────────────────────────────────────────────

export interface DifferentialFixture {
  id: string;
  description: string;
  chiefComplaint: string;
  transcript: string;
  groundTruth: DifferentialGroundTruth;
}

export interface DifferentialGroundTruth {
  /**
   * Substrings that MUST appear (case-insensitive) in at least one added
   * diagnosis. Allows matching "Pulmonary embolism" or "PE" interchangeably
   * via targeted substrings.
   */
  expectedAdded: string[];

  /**
   * Substrings that MUST NOT appear in any added diagnosis. The over-fire
   * safety net. Critical — a differential addition whose rationale is
   * weak trains the physician to ignore the panel forever.
   */
  forbiddenAdded: string[];

  /** Per-substring: required badness_if_missed bucket. */
  requiredBadness?: Record<string, BadnessBucket>;

  /**
   * Hard cap on additions for this fixture. Exceeding this is a fail —
   * catches "noisy" fires where Robin pads the list. Defaults to 4 (the
   * engine cap).
   */
  maxAdded?: number;

  notes?: string;
}

// ─── Assertion result ─────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface DifferentialReport {
  id: string;
  description: string;
  checks: Check[];
  passCount: number;
  failCount: number;
  verdict: CheckStatus;
  summary: {
    added: string[];
    iterations: number;
  };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function anyContains(haystack: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return haystack.some((h) => h.toLowerCase().includes(n));
}

function findMatching(
  haystack: string[],
  needle: string
): string | undefined {
  const n = needle.toLowerCase();
  return haystack.find((h) => h.toLowerCase().includes(n));
}

export function scoreDifferential(
  fixture: DifferentialFixture,
  result: RunDifferentialExpanderResult
): DifferentialReport {
  const checks: Check[] = [];
  const gt = fixture.groundTruth;
  const added = result.differentials;
  const addedNames = added.map((d) => d.diagnosis);

  // Expected substrings present
  for (const expected of gt.expectedAdded) {
    const hit = anyContains(addedNames, expected);
    checks.push({
      name: `Expected: "${expected}"`,
      status: hit ? "pass" : "fail",
      detail: hit ? "added" : `not added (got [${addedNames.join(", ") || "none"}])`,
    });
  }

  // Forbidden substrings absent
  for (const forbidden of gt.forbiddenAdded) {
    const match = findMatching(addedNames, forbidden);
    checks.push({
      name: `Forbidden: "${forbidden}"`,
      status: match ? "fail" : "pass",
      detail: match ? `OVER-FIRED (got "${match}")` : "correctly suppressed",
    });
  }

  // Required badness bucket for specific additions
  for (const [substr, expectedBadness] of Object.entries(
    gt.requiredBadness ?? {}
  )) {
    const matched = added.find((d) =>
      d.diagnosis.toLowerCase().includes(substr.toLowerCase())
    );
    if (!matched) continue; // Already flagged by Expected check
    const ok = matched.badness_if_missed === expectedBadness;
    checks.push({
      name: `"${substr}" badness = ${expectedBadness}`,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `matched`
        : `got ${matched.badness_if_missed}`,
    });
  }

  // Cap check
  const cap = gt.maxAdded ?? 4;
  const overCap = added.length > cap;
  checks.push({
    name: `Added count ≤ ${cap}`,
    status: overCap ? "fail" : "pass",
    detail: overCap ? `added ${added.length}` : `added ${added.length}`,
  });

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
      added: addedNames,
      iterations: result.iterations,
    },
  };
}

// ─── Pretty printing ─────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function printDifferentialReport(report: DifferentialReport): void {
  const mark = report.verdict === "pass" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const header = `${mark} ${BOLD}${report.id}${RESET} ${DIM}— ${report.description}${RESET}`;
  console.log(header);
  console.log(
    `  added=[${report.summary.added.join(", ") || "none"}]  iters=${report.summary.iterations}`
  );
  for (const check of report.checks) {
    if (check.status === "fail") {
      const detail = check.detail ? ` ${DIM}(${check.detail})${RESET}` : "";
      console.log(`  ${RED}✗${RESET} ${check.name}${detail}`);
    }
  }
  console.log();
}

export function printDifferentialSummary(reports: DifferentialReport[]): void {
  const total = reports.length;
  const passed = reports.filter((r) => r.verdict === "pass").length;
  const failed = total - passed;
  const bar =
    failed === 0
      ? `${GREEN}${BOLD}${passed}/${total} PASS${RESET}`
      : `${RED}${BOLD}${failed} FAIL${RESET}${DIM}, ${passed} pass${RESET}`;
  console.log(`${bar}\n`);
}
