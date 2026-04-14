/**
 * Robin clinical-surfacing eval harness.
 *
 *   npx tsx evals/surfacing/runSurfacingEvals.ts             # all fixtures
 *   npx tsx evals/surfacing/runSurfacingEvals.ts heart       # filter by id
 *
 * Calls runClinicalSurfacing() directly — no dev server, no auth, no SSE
 * parsing. Uses temperature: 0 for deterministic reruns.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", override: true });

import {
  type SurfacingFixture,
  type SurfacingReport,
  scoreSurfacing,
  printSurfacingReport,
  printSurfacingSummary,
} from "./rubric";

type RunFn = (typeof import("../../src/lib/clinicalSurfacing"))["runClinicalSurfacing"];
let runClinicalSurfacing: RunFn;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

async function loadFixtures(filter?: string): Promise<SurfacingFixture[]> {
  const files = (await readdir(FIXTURES_DIR))
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !filter || f.includes(filter))
    .sort();

  const fixtures: SurfacingFixture[] = [];
  for (const file of files) {
    const raw = await readFile(join(FIXTURES_DIR, file), "utf-8");
    fixtures.push(JSON.parse(raw) as SurfacingFixture);
  }
  return fixtures;
}

async function runOne(fixture: SurfacingFixture): Promise<SurfacingReport> {
  const result = await runClinicalSurfacing({
    transcript: fixture.transcript,
    chiefComplaint: fixture.chiefComplaint,
    evalMode: true,
  });
  return scoreSurfacing(fixture, result);
}

async function main() {
  ({ runClinicalSurfacing } = await import("../../src/lib/clinicalSurfacing"));

  const filter = process.argv[2];
  const fixtures = await loadFixtures(filter);

  if (fixtures.length === 0) {
    console.error(
      `No surfacing fixtures found${filter ? ` matching "${filter}"` : ""}.`
    );
    process.exit(1);
  }

  console.log(
    `\nRunning ${fixtures.length} surfacing fixture${fixtures.length === 1 ? "" : "s"} (temperature: 0)...\n`
  );

  const start = Date.now();
  const reports = await Promise.all(fixtures.map(runOne));
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  for (const report of reports) {
    printSurfacingReport(report);
  }

  printSurfacingSummary(reports);
  console.log(`Completed in ${elapsed}s\n`);

  const anyFailed = reports.some((r) => r.verdict === "fail");
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
