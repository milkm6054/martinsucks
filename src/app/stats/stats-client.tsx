"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type PlayerRow = {
  playerId: string;
  steamId64: string;
  displayName: string | null;
  teamNames: string[];
  cachedStat: {
    kpm180: number | null;
    duelStrength180: number | null;
    fetchedAt: string | null;
    status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
    error: string | null;
  } | null;
  runItem: {
    status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
    kpm180: number | null;
    duelStrength180: number | null;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
};

type StatsRun = {
  id: string;
  status: "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED";
  requestedBy: string | null;
  totalPlayers: number;
  processedPlayers: number;
  successPlayers: number;
  failedPlayers: number;
  startedAt: string;
  finishedAt: string | null;
  playersRemaining: number;
};

type StatsResponse = {
  latestRun: StatsRun | null;
  players: PlayerRow[];
  diagnostics?: {
    rosterEntries: number;
  };
};

async function parseApiResponse<T>(response: Response): Promise<T & { error?: string }> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Empty response from server (${response.status}).`);
  }

  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(`Unexpected response from server (${response.status}): ${text.slice(0, 200)}`);
  }
}

function formatValue(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "-";
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("en-GB");
}

function getRowStatus(row: PlayerRow): string {
  if (row.runItem) {
    return row.runItem.status;
  }

  return row.cachedStat?.status ?? "PENDING";
}

function getRowKpm(row: PlayerRow): number | null {
  return row.runItem?.kpm180 ?? row.cachedStat?.kpm180 ?? null;
}

function getRowDuelStrength(row: PlayerRow): number | null {
  return row.runItem?.duelStrength180 ?? row.cachedStat?.duelStrength180 ?? null;
}

function getRowError(row: PlayerRow): string | null {
  return row.runItem?.error ?? row.cachedStat?.error ?? null;
}

export function StatsClient() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadStats = useCallback(async () => {
    const response = await fetch("/api/stats", { cache: "no-store" });
    const payload = await parseApiResponse<StatsResponse>(response);

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load stats.");
    }

    setData(payload);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        await loadStats();
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load stats.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [loadStats]);

  useEffect(() => {
    if (!data?.latestRun || data.latestRun.status !== "RUNNING") {
      return;
    }

    const interval = window.setInterval(() => {
      void loadStats().catch((fetchError) => {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to refresh stats.");
      });
    }, 3000);

    return () => window.clearInterval(interval);
  }, [data?.latestRun, loadStats]);

  const summary = useMemo(() => {
    const players = data?.players ?? [];
    const cachedComplete = players.filter((row) => row.cachedStat?.status === "COMPLETED").length;
    const latestRun = data?.latestRun;

    return {
      totalPlayers: players.length,
      cachedComplete,
      processedPlayers: latestRun?.processedPlayers ?? 0,
      playersRemaining: latestRun?.playersRemaining ?? players.length,
    };
  }, [data]);

  async function startRun() {
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/stats", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });
      const payload = await parseApiResponse<StatsResponse>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to start stats refresh.");
      }

      setNotice("Stats refresh started.");
      setData({
        latestRun: payload.latestRun,
        players: data?.players ?? [],
      });
      await loadStats();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to start stats refresh.");
    } finally {
      setBusy(false);
    }
  }

  async function updateRun(action: "pause" | "resume") {
    if (!data?.latestRun) {
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/stats", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          runId: data.latestRun.id,
        }),
      });
      const payload = await parseApiResponse<StatsResponse>(response);

      if (!response.ok) {
        throw new Error(payload.error || `Failed to ${action} stats refresh.`);
      }

      setNotice(action === "pause" ? "Stats refresh paused." : "Stats refresh resumed.");
      setData((current) => ({
        latestRun: payload.latestRun,
        players: current?.players ?? [],
        diagnostics: current?.diagnostics,
      }));
      await loadStats();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : `Failed to ${action} stats refresh.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="surface-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-500">Standalone Service</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">HCA Stats Runner</h1>
            <p className="mt-2 max-w-3xl text-sm muted-copy">
              Pull KPM and Duel Strength from the last 180 days for the current tournament playerbase in the shared
              HCA database. Results are cached back into Postgres so the roster app can read them without scraping each
              time.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="primary-button px-4 py-2" onClick={startRun} disabled={busy || data?.latestRun?.status === "RUNNING"}>
              {data?.latestRun?.status === "RUNNING" ? "Refresh running" : busy ? "Starting..." : "Refresh stats"}
            </button>
            {data?.latestRun?.status === "RUNNING" ? (
              <button className="px-4 py-2" onClick={() => updateRun("pause")} disabled={busy}>
                Pause
              </button>
            ) : null}
            {data?.latestRun?.status === "PAUSED" ? (
              <button className="px-4 py-2" onClick={() => updateRun("resume")} disabled={busy}>
                Resume
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="surface-card p-5">
          <p className="text-xs uppercase tracking-[0.2em] muted-copy">Tournament players</p>
          <p className="mt-3 text-3xl font-semibold">{summary.totalPlayers}</p>
          {typeof data?.diagnostics?.rosterEntries === "number" ? (
            <p className="mt-2 text-xs muted-copy">{data.diagnostics.rosterEntries} active roster entries found</p>
          ) : null}
        </div>
        <div className="surface-card p-5">
          <p className="text-xs uppercase tracking-[0.2em] muted-copy">Processed this run</p>
          <p className="mt-3 text-3xl font-semibold">{summary.processedPlayers}</p>
        </div>
        <div className="surface-card p-5">
          <p className="text-xs uppercase tracking-[0.2em] muted-copy">Players left</p>
          <p className="mt-3 text-3xl font-semibold">{summary.playersRemaining}</p>
        </div>
        <div className="surface-card p-5">
          <p className="text-xs uppercase tracking-[0.2em] muted-copy">Cached results</p>
          <p className="mt-3 text-3xl font-semibold">{summary.cachedComplete}</p>
        </div>
      </div>

      {data?.latestRun ? (
        <section className="surface-card space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Latest run</h2>
              <p className="text-sm muted-copy">
                {data.latestRun.status} | started {formatDateTime(data.latestRun.startedAt)} | requested by{" "}
                {data.latestRun.requestedBy || "Unknown"}
              </p>
            </div>
            <p className="text-sm muted-copy">
              Success {data.latestRun.successPlayers} | Failed {data.latestRun.failedPlayers}
            </p>
          </div>
          <div className="h-3 overflow-hidden rounded-full border border-white/10 bg-white/6">
            <div
              className="h-full rounded-full bg-cyan-400/80 transition-all"
              style={{
                width:
                  data.latestRun.totalPlayers > 0
                    ? `${(data.latestRun.processedPlayers / data.latestRun.totalPlayers) * 100}%`
                    : "0%",
              }}
            />
          </div>
        </section>
      ) : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-400">{notice}</p> : null}

      <div className="surface-table">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              <th className="px-4 py-3">Team</th>
              <th className="px-4 py-3">Player</th>
              <th className="px-4 py-3">Steam ID</th>
              <th className="px-4 py-3">KPM 180d</th>
              <th className="px-4 py-3">Duel Strength 180d</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3">Note</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center muted-copy">
                  Loading stats...
                </td>
              </tr>
            ) : null}
            {!loading && (data?.players ?? []).map((row) => (
              <tr key={row.playerId}>
                <td className="px-4 py-3">{row.teamNames.join(", ")}</td>
                <td className="px-4 py-3">{row.displayName || "-"}</td>
                <td className="px-4 py-3 font-mono text-xs">{row.steamId64}</td>
                <td className="px-4 py-3">{formatValue(getRowKpm(row))}</td>
                <td className="px-4 py-3">{formatValue(getRowDuelStrength(row))}</td>
                <td className="px-4 py-3">{getRowStatus(row)}</td>
                <td className="px-4 py-3">
                  {formatDateTime(row.runItem?.finishedAt || row.cachedStat?.fetchedAt || row.runItem?.startedAt)}
                </td>
                <td className="px-4 py-3 text-xs muted-copy">{getRowError(row) || "-"}</td>
              </tr>
            ))}
            {!loading && (data?.players ?? []).length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center muted-copy">
                  No active roster players found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
