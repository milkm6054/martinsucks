import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type PythonFetchResult = {
  sourceUrl: string;
  pageTitle?: string;
  kpm180: number | null;
  duelStrength180: number | null;
  error?: string;
};

export async function fetchHllRecordStats(steamId64: string): Promise<{
  sourceUrl: string;
  kpm180: number | null;
  duelStrength180: number | null;
}> {
  const scriptPath = path.join(process.cwd(), "scripts", "fetch_hll_stats.py");
  let rawOutput = "";

  try {
    const { stdout, stderr } = await execFileAsync("python", [scriptPath, steamId64], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    rawOutput = stdout.trim() || stderr.trim();
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string };
    rawOutput = execError.stdout?.trim() || execError.stderr?.trim() || execError.message;
  }

  if (!rawOutput) {
    throw new Error("Stats scraper returned no output.");
  }

  let parsed: PythonFetchResult;
  try {
    parsed = JSON.parse(rawOutput) as PythonFetchResult;
  } catch {
    throw new Error(`Unexpected scraper output: ${rawOutput}`);
  }

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
  };
}
