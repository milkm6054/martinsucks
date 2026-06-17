import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PYTHON_CANDIDATES = [process.env.PYTHON_BIN?.trim(), "python3", "python"].filter(
  (value): value is string => Boolean(value),
);

type PythonFetchResult = {
  steamId64?: string;
  sourceUrl: string;
  pageTitle?: string;
  kpm180: number | null;
  duelStrength180: number | null;
  mainRole?: string | null;
  error?: string;
};

type HllRecordStatResult = {
  sourceUrl: string;
  kpm180: number | null;
  duelStrength180: number | null;
  mainRole: string | null;
};

async function runPythonScraper(args: string[]): Promise<string> {
  const scriptPath = path.join(process.cwd(), "scripts", "fetch_hll_stats.py");
  let rawOutput = "";
  let lastError = "";

  for (const pythonBin of PYTHON_CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(pythonBin, [scriptPath, ...args], {
        timeout: 120000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      rawOutput = stdout.trim() || stderr.trim();
      lastError = "";
      break;
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string; code?: string };
      lastError = execError.stdout?.trim() || execError.stderr?.trim() || execError.message;

      if (execError.code === "ENOENT") {
        continue;
      }

      rawOutput = lastError;
      break;
    }
  }

  if (!rawOutput && lastError) {
    rawOutput = lastError;
  }

  if (!rawOutput) {
    throw new Error(
      `Stats scraper returned no output. Tried Python binaries: ${PYTHON_CANDIDATES.join(", ") || "none"}.`,
    );
  }

  return rawOutput;
}

function parseSingleResult(parsed: PythonFetchResult): HllRecordStatResult {
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  if (parsed.kpm180 === null && parsed.duelStrength180 === null) {
    throw new Error("Stats scraper did not return KPM or Duel Strength.");
  }

  return {
    sourceUrl: parsed.sourceUrl,
    kpm180: parsed.kpm180,
    duelStrength180: parsed.duelStrength180,
    mainRole: parsed.mainRole ?? null,
  };
}

export async function fetchHllRecordStats(steamId64: string): Promise<HllRecordStatResult> {
  const rawOutput = await runPythonScraper([steamId64]);

  let parsed: PythonFetchResult;
  try {
    parsed = JSON.parse(rawOutput) as PythonFetchResult;
  } catch {
    throw new Error(`Unexpected scraper output: ${rawOutput}`);
  }

  return parseSingleResult(parsed);
}

export async function fetchHllRecordStatsBatch(steamIds64: string[]): Promise<Map<string, HllRecordStatResult | Error>> {
  if (steamIds64.length === 0) {
    return new Map();
  }

  const rawOutput = await runPythonScraper(steamIds64);

  let parsed: PythonFetchResult[] | PythonFetchResult;
  try {
    parsed = JSON.parse(rawOutput) as PythonFetchResult[] | PythonFetchResult;
  } catch {
    throw new Error(`Unexpected scraper output: ${rawOutput}`);
  }

  if (!Array.isArray(parsed) && parsed?.error) {
    throw new Error(parsed.error);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected batch scraper output: ${rawOutput}`);
  }

  const results = new Map<string, HllRecordStatResult | Error>();

  for (const steamId64 of steamIds64) {
    results.set(steamId64, new Error("No result returned for this player."));
  }

  for (const item of parsed) {
    const steamId64 = item.steamId64?.trim();
    if (!steamId64) {
      continue;
    }

    try {
      results.set(steamId64, parseSingleResult(item));
    } catch (error) {
      results.set(steamId64, error instanceof Error ? error : new Error("Unknown scrape error."));
    }
  }

  return results;
}

export type { HllRecordStatResult };
