import type { RunClinicalSurfacingResult } from "../../src/lib/clinicalSurfacing";
import type { ClinicalToolName } from "../../src/lib/robinTypes";

// ─── Ground truth shape ───────────────────────────────────────────────────────

export interface SurfacingFixture {
  id: string;
  description: string;
  chiefComplaint: string;
  transcript: string;
  groundTruth: SurfacingGroundTruth;
}

export interface SurfacingGroundTruth {
  /**
   * Tools that MUST be surfaced. Ordered list, but order isn't asserted.
   */
  expectedSurfaced: ClinicalToolName[];

  /**
   * Tools that MUST NOT be surfaced. The over-fire regression. This is the
   * critical safety net for the "interruption cost zero" promise.
   */
  forbiddenSurfaced: ClinicalToolName[];

  /**
   * Per-tool: keys (dot-notation supported, e.g. "high_risk.age_65_or_over")
   * that MUST appear in pre_fill. Robin must have heard these elements.
   */
  requiredPreFillKeys?: Partial<Record<ClinicalToolName, string[]>>;

  /**
   * Per-tool: substrings that MUST appear in missing_elements.
   * Catches under-pre-filling — Robin should know what's still needed.
   */
  requiredMissingElements?: Partial<Record<ClinicalToolName, string[]>>;

  notes?: string;
}

// ─── Assertion result ─────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface SurfacingReport {
  id: string;
  description: string;
  checks: Check[];
  passCount: number;
  failCount: number;
  verdict: CheckStatus;
  summary: {
    surfaced: ClinicalToolName[];
    iterations: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Look up a dot-notation path in an object.
 * "high_risk.age_65_or_over" → obj?.high_risk?.age_65_or_over
 */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function scoreSurfacing(
  fixture: SurfacingFixture,
  result: RunClinicalSurfacingResult
): SurfacingReport {
  const checks: Check[] = [];
  const gt = fixture.groundTruth;
  const surfaced = result.surfacedTools;
  const surfacedNames = surfaced.map((s) => s.tool_name);

  // Expected tools surfaced
  for (const expected of gt.expectedSurfaced) {
    const hit = surfacedNames.includes(expected);
    checks.push({
      name: `Expected: ${expected}`,
      status: hit ? "pass" : "fail",
      detail: hit ? "surfaced" : `not surfaced (got [${surfacedNames.join(", ") || "none"}])`,
    });
  }

  // Forbidden tools NOT surfaced — the over-fire regression
  for (const forbidden of gt.forbiddenSurfaced) {
    const fired = surfacedNames.includes(forbidden);
    checks.push({
      name: `Forbidden: ${forbidden}`,
      status: fired ? "fail" : "pass",
      detail: fired ? "OVER-FIRED" : "correctly suppressed",
    });
  }

  // Required pre-fill keys (only checked for tools that did surface)
  for (const [toolName, requiredKeys] of Object.entries(gt.requiredPreFillKeys ?? {})) {
    const surfacing = surfaced.find((s) => s.tool_name === toolName);
    if (!surfacing) continue; // Already failed under "Expected" check
    for (const key of requiredKeys ?? []) {
      const value = getByPath(surfacing.pre_fill, key);
      const present = value !== undefined;
      checks.push({
        name: `${toolName} pre_fill: ${key}`,
        status: present ? "pass" : "fail",
        detail: present ? `= ${JSON.stringify(value)}` : "missing",
      });
    }
  }

  // Required missing_elements substrings
  for (const [toolName, requiredMissing] of Object.entries(gt.requiredMissingElements ?? {})) {
    const surfacing = surfaced.find((s) => s.tool_name === toolName);
    if (!surfacing) continue;
    const missingBlob = surfacing.missing_elements.join(" | ").toLowerCase();
    for (const substr of requiredMissing ?? []) {
      const hit = missingBlob.includes(substr.toLowerCase());
      checks.push({
        name: `${toolName} missing_elements: "${substr}"`,
        status: hit ? "pass" : "fail",
        detail: hit ? "present" : `not in [${surfacing.missing_elements.join(", ")}]`,
      });
    }
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
      surfaced: surfacedNames,
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

export function printSurfacingReport(report: SurfacingReport): void {
  const mark = report.verdict === "pass" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const header = `${mark} ${BOLD}${report.id}${RESET} ${DIM}— ${report.description}${RESET}`;
  console.log(header);
  console.log(
    `  surfaced=[${report.summary.surfaced.join(", ") || "none"}]  iters=${report.summary.iterations}`
  );
  for (const check of report.checks) {
    if (check.status === "fail") {
      const detail = check.detail ? ` ${DIM}(${check.detail})${RESET}` : "";
      console.log(`  ${RED}✗${RESET} ${check.name}${detail}`);
    }
  }
  console.log();
}

export function printSurfacingSummary(reports: SurfacingReport[]): void {
  const total = reports.length;
  const passed = reports.filter((r) => r.verdict === "pass").length;
  const failed = total - passed;
  const bar =
    failed === 0
      ? `${GREEN}${BOLD}${passed}/${total} PASS${RESET}`
      : `${RED}${BOLD}${failed} FAIL${RESET}${DIM}, ${passed} pass${RESET}`;
  console.log(`${bar}\n`);
}
