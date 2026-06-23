import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PYTHON_CANDIDATES = [process.env.PYTHON_BIN?.trim(), "python3", "python"].filter(
  (value): value is string => Boolean(value),
);

type HllRecentKillScrapeResult = {
  sourceUrl: string;
  pageTitle?: string;
  results: Array<{
    sourceOrder: number;
    playerName: string;
    profileUrl: string;
    steamId?: string | null;
    kills: number;
    kpm?: number | null;
    kd?: number | null;
    weapon?: string | null;
    mapName?: string | null;
    duration?: string | null;
    playedOn?: string | null;
    playedAt?: string | null;
    rawLines: string[];
  }>;
  error?: string;
};

async function runPythonScraper(sourceUrl: string): Promise<string> {
  const scriptPath = path.join(process.cwd(), "scripts", "fetch_hll_recent_kills.py");
  let rawOutput = "";
  let lastError = "";

  for (const pythonBin of PYTHON_CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(pythonBin, [scriptPath, sourceUrl], {
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
      `Recent kills scraper returned no output. Tried Python binaries: ${PYTHON_CANDIDATES.join(", ") || "none"}.`,
    );
  }

  return rawOutput;
}

export function normalizeHllRecordsServerUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Enter a valid HLLRecords URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.hostname !== "hllrecords.com") {
    throw new Error("URL must be on hllrecords.com.");
  }

  parsed.hash = "";
  return parsed.toString();
}

export async function fetchHllRecentKills(sourceUrl: string): Promise<HllRecentKillScrapeResult> {
  const rawOutput = await runPythonScraper(sourceUrl);

  let parsed: HllRecentKillScrapeResult;
  try {
    parsed = JSON.parse(rawOutput) as HllRecentKillScrapeResult;
  } catch {
    throw new Error(`Unexpected recent kills scraper output: ${rawOutput}`);
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return parsed;
}

export type { HllRecentKillScrapeResult };
