/**
 * Bonus over-fire regression: run the clinical surfacing engine against
 * the 13 MDM eval fixtures (which were not designed for surfacing) and
 * print what it surfaces. Human eyeball — no assertions.
 *
 * The MDM fixtures cover naturalistic ED presentations. Some SHOULD
 * legitimately trigger surfacing (chest pain, PE workup, head trauma,
 * ankle injury). Others should NOT (abd pain, peds OM, ACE rash, dental).
 *
 *   npx tsx evals/surfacing/runOverfireRegression.ts
 */
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", override: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "encounters");

interface EncounterFixture {
  id: string;
  description?: string;
  chiefComplaint?: string;
  transcript: string;
}

async function main() {
  const { runClinicalSurfacing } = await import("../../src/lib/clinicalSurfacing");

  const files = (await readdir(FIXTURES_DIR))
    .filter((f) => f.endsWith(".json"))
    .sort();

  const fixtures: EncounterFixture[] = [];
  for (const file of files) {
    const raw = await readFile(join(FIXTURES_DIR, file), "utf-8");
    fixtures.push(JSON.parse(raw) as EncounterFixture);
  }

  console.log(`\nOver-fire regression: ${fixtures.length} MDM fixtures (temperature: 0)\n`);

  const results = await Promise.all(
    fixtures.map(async (f) => {
      const result = await runClinicalSurfacing({
        transcript: f.transcript,
        chiefComplaint: f.chiefComplaint || "",
        evalMode: true,
      });
      return { fixture: f, result };
    })
  );

  for (const { fixture, result } of results) {
    const surfaced = result.surfacedTools;
    const tag = surfaced.length === 0 ? "─" : `→ ${surfaced.map((s) => s.tool_name).join(", ")}`;
    console.log(`${fixture.id.padEnd(28)} ${tag}`);
    for (const s of surfaced) {
      console.log(`    ${s.tool_name}: ${s.trigger_rationale}`);
    }
  }

  const fired = results.filter((r) => r.result.surfacedTools.length > 0).length;
  console.log(`\n${fired}/${results.length} fixtures had at least one tool surfaced.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
