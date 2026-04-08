/**
 * Robin `robin-think` eval harness.
 *
 *   npx tsx evals/runEvals.ts             # run all encounters
 *   npx tsx evals/runEvals.ts 02          # run only encounters whose id includes "02"
 *
 * Calls runRobinThink() directly — no dev server, no auth, no SSE parsing.
 * Uses temperature: 0 for deterministic reruns.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

// Load .env.local BEFORE we import anything that constructs an Anthropic
// client at module-load time. Static imports would resolve before this runs,
// so robinThink is dynamically imported below.
loadEnv({ path: ".env.local", override: true });

import {
  type EncounterFixture,
  type EncounterReport,
  scoreEncounter,
  printReport,
  printSummary,
} from "./rubric";

// Dynamically imported after dotenv has populated process.env
type RunRobinThinkFn = (typeof import("../src/lib/robinThink"))["runRobinThink"];
let runRobinThink: RunRobinThinkFn;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENCOUNTERS_DIR = join(__dirname, "encounters");

async function loadFixtures(filter?: string): Promise<EncounterFixture[]> {
  const files = (await readdir(ENCOUNTERS_DIR))
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !filter || f.includes(filter))
    .sort();

  const fixtures: EncounterFixture[] = [];
  for (const file of files) {
    const raw = await readFile(join(ENCOUNTERS_DIR, file), "utf-8");
    fixtures.push(JSON.parse(raw) as EncounterFixture);
  }
  return fixtures;
}

async function runOne(fixture: EncounterFixture): Promise<EncounterReport> {
  const result = await runRobinThink({
    transcript: fixture.transcript,
    chiefComplaint: fixture.chiefComplaint,
    disposition: fixture.disposition ?? undefined,
    evalMode: true,
  });
  return scoreEncounter(fixture, result);
}

async function main() {
  ({ runRobinThink } = await import("../src/lib/robinThink"));

  const filter = process.argv[2];
  const fixtures = await loadFixtures(filter);

  if (fixtures.length === 0) {
    console.error(
      `No encounter fixtures found${filter ? ` matching "${filter}"` : ""}.`
    );
    process.exit(1);
  }

  console.log(
    `\nRunning ${fixtures.length} encounter${fixtures.length === 1 ? "" : "s"} (temperature: 0)...\n`
  );

  const start = Date.now();

  // Run all encounters in parallel — Anthropic rate limits are generous
  // enough for a 10-encounter suite.
  const reports = await Promise.all(fixtures.map(runOne));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  for (const report of reports) {
    printReport(report);
  }

  printSummary(reports);
  console.log(`Completed in ${elapsed}s\n`);

  const anyFailed = reports.some((r) => r.verdict === "fail");
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
