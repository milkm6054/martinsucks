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
    mainRole: string | null;
    fetchedAt: string | null;
    status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "UNKNOWN";
    error: string | null;
  } | null;
  runItem: {
    status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "UNKNOWN";
    kpm180: number | null;
    duelStrength180: number | null;
    mainRole: string | null;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
};

type StatsRun = {
  id: string;
  status: "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED";
  speedProfile: "SLOW" | "NORMAL" | "FAST";
  requestedBy: string | null;
  totalPlayers: number;
  processedPlayers: number;
  successPlayers: number;
  failedPlayers: number;
  startedAt: string;
  finishedAt: string | null;
  playersRemaining: number;
  averageRetrievalMs: number | null;
  estimatedRemainingMs: number | null;
  estimatedCompletionAt: string | null;
};

type StatsResponse = {
  latestRun: StatsRun | null;
  players: PlayerRow[];
  diagnostics?: {
    rosterEntries: number;
  };
};

type HllPoachStatus = "NEW" | "MESSAGED" | "SECURED" | "ROSTERED";

type HllRecentKillResult = {
  id: string;
  playerName: string;
  profileUrl: string;
  steamId: string | null;
  kills: number;
  kpm: number | null;
  kd: number | null;
  weapon: string | null;
  kpm180: number | null;
  mainRole: string | null;
  statError: string | null;
  mapName: string | null;
  duration: string | null;
  playedOn: string | null;
  playedAt: string | null;
  sourceOrder: number;
  fetchedAt: string;
  isFreePlayer: boolean;
  rosterTeamNames: string[];
  poachStatus: HllPoachStatus;
  poachTeamId: string | null;
  poachTeamName: string | null;
};

type HllRecordsServer = {
  id: string;
  name: string;
  sourceUrl: string;
  fetchStatus: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  fetchError: string | null;
  lastRunAt: string | null;
  createdAt: string;
  results: HllRecentKillResult[];
};

type HllRecordsResponse = {
  servers: HllRecordsServer[];
  teams?: HllTeam[];
};

type HllTeam = {
  id: string;
  name: string;
  tag: string | null;
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

function averageValue(values: Array<number | null | undefined>): number | null {
  const numericValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numericValues.length === 0) {
    return null;
  }

  return numericValues.reduce((total, value) => total + value, 0) / numericValues.length;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("en-GB");
}

function formatDuration(valueMs: number | null | undefined): string {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "-";
  }

  const totalSeconds = Math.round(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
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

function getRowMainRole(row: PlayerRow): string {
  return row.runItem?.mainRole ?? row.cachedStat?.mainRole ?? "-";
}

function getRowError(row: PlayerRow): string | null {
  return row.runItem?.error ?? row.cachedStat?.error ?? null;
}

function getPrimaryTeam(row: PlayerRow): string {
  return row.teamNames[0] || "Unknown";
}

function getNormalizedMainRole(row: PlayerRow): string | null {
  const role = getRowMainRole(row);
  return role === "-" ? null : role;
}

function getPoachStatusRowClass(status: HllPoachStatus): string {
  if (status === "MESSAGED") {
    return "bg-yellow-500/10";
  }

  if (status === "SECURED") {
    return "bg-cyan-500/10";
  }

  return "bg-emerald-500/10";
}

function getPoachStatusTextClass(status: HllPoachStatus): string {
  if (status === "MESSAGED") {
    return "text-yellow-300";
  }

  if (status === "SECURED") {
    return "text-cyan-300";
  }

  return "text-emerald-300";
}

export function StatsClient() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [hllRecordsServers, setHllRecordsServers] = useState<HllRecordsServer[]>([]);
  const [hllRecordsTeams, setHllRecordsTeams] = useState<HllTeam[]>([]);
  const [busy, setBusy] = useState(false);
  const [hllRecordsBusy, setHllRecordsBusy] = useState(false);
  const [rerunningServerId, setRerunningServerId] = useState<string | null>(null);
  const [updatingPoachSteamId, setUpdatingPoachSteamId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hllRecordsLoading, setHllRecordsLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeTab, setActiveTab] = useState<"runner" | "leaderboards" | "recentKills" | "poach">("runner");
  const [playerSearch, setPlayerSearch] = useState("");
  const [playerMetric, setPlayerMetric] = useState<"kpm" | "duelStrength">("kpm");
  const [teamMetric, setTeamMetric] = useState<"kpm" | "duelStrength">("kpm");
  const [newHllRecordsName, setNewHllRecordsName] = useState("");
  const [newHllRecordsUrl, setNewHllRecordsUrl] = useState("");
  const [expandedHllRecordsServerIds, setExpandedHllRecordsServerIds] = useState<Set<string>>(() => new Set());

  const loadStats = useCallback(async () => {
    const response = await fetch("/api/stats", { cache: "no-store" });
    const payload = await parseApiResponse<StatsResponse>(response);

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load stats.");
    }

    setData(payload);
  }, []);

  const loadHllRecordsServers = useCallback(async () => {
    const response = await fetch("/api/hll-records/servers", { cache: "no-store" });
    const payload = await parseApiResponse<HllRecordsResponse>(response);

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load HLLRecords servers.");
    }

    setHllRecordsServers(payload.servers || []);
    setHllRecordsTeams(payload.teams || []);
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
    let cancelled = false;

    async function run() {
      try {
        await loadHllRecordsServers();
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load HLLRecords servers.");
        }
      } finally {
        if (!cancelled) {
          setHllRecordsLoading(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [loadHllRecordsServers]);

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
      averageRetrievalMs: latestRun?.averageRetrievalMs ?? null,
      estimatedRemainingMs: latestRun?.estimatedRemainingMs ?? null,
      estimatedCompletionAt: latestRun?.estimatedCompletionAt ?? null,
    };
  }, [data]);

  const infantryPlayers = useMemo(() => {
    return (data?.players ?? [])
      .map((row) => ({
        playerId: row.playerId,
        player: row.displayName || "-",
        team: getPrimaryTeam(row),
        steamId64: row.steamId64,
        kpm180: getRowKpm(row),
        duelStrength180: getRowDuelStrength(row),
        mainRole: getNormalizedMainRole(row),
        status: getRowStatus(row),
      }))
      .filter((row) => row.mainRole === "Infantry");
  }, [data]);

  const rankedInfantryPlayers = useMemo(() => {
    const ranked = [...infantryPlayers].sort((left, right) => {
      const leftMetric = playerMetric === "kpm" ? left.kpm180 ?? -1 : left.duelStrength180 ?? -1;
      const rightMetric = playerMetric === "kpm" ? right.kpm180 ?? -1 : right.duelStrength180 ?? -1;

      if (leftMetric !== rightMetric) {
        return rightMetric - leftMetric;
      }

      return left.player.localeCompare(right.player);
    });

    return ranked.map((row, index) => ({
      ...row,
      overallRank: index + 1,
    }));
  }, [infantryPlayers, playerMetric]);

  const filteredInfantryPlayers = useMemo(() => {
    const query = playerSearch.trim().toLowerCase();

    return rankedInfantryPlayers.filter((row) => {
      if (!query) {
        return true;
      }

      return row.player.toLowerCase().includes(query);
    });
  }, [playerSearch, rankedInfantryPlayers]);

  const infantryTeamRankings = useMemo(() => {
    const teamMap = new Map<
      string,
      {
        team: string;
        infantryPlayers: number;
        kpmTotal: number;
        kpmCount: number;
        duelTotal: number;
        duelCount: number;
      }
    >();

    for (const player of infantryPlayers) {
      const team = player.team;
      const existing = teamMap.get(team) ?? {
        team,
        infantryPlayers: 0,
        kpmTotal: 0,
        kpmCount: 0,
        duelTotal: 0,
        duelCount: 0,
      };

      existing.infantryPlayers += 1;
      if (typeof player.kpm180 === "number") {
        existing.kpmTotal += player.kpm180;
        existing.kpmCount += 1;
      }
      if (typeof player.duelStrength180 === "number") {
        existing.duelTotal += player.duelStrength180;
        existing.duelCount += 1;
      }

      teamMap.set(team, existing);
    }

    return Array.from(teamMap.values())
      .map((team) => ({
        team: team.team,
        infantryPlayers: team.infantryPlayers,
        averageKpm180: team.kpmCount > 0 ? team.kpmTotal / team.kpmCount : null,
        averageDuelStrength180: team.duelCount > 0 ? team.duelTotal / team.duelCount : null,
      }))
      .sort((left, right) => {
        const leftMetric = teamMetric === "kpm" ? left.averageKpm180 ?? -1 : left.averageDuelStrength180 ?? -1;
        const rightMetric = teamMetric === "kpm" ? right.averageKpm180 ?? -1 : right.averageDuelStrength180 ?? -1;

        if (leftMetric !== rightMetric) {
          return rightMetric - leftMetric;
        }

        return left.team.localeCompare(right.team);
      });
  }, [infantryPlayers, teamMetric]);

  const poachCandidates = useMemo(() => {
    const candidateMap = new Map<
      string,
      {
        steamId: string;
        playerName: string;
        profileUrl: string;
        kpm180: number | null;
        averageKills: number | null;
        averageKpm: number | null;
        bestKills: number;
        weapons: string[];
        mainRole: string | null;
        statError: string | null;
        poachStatus: HllPoachStatus;
        poachTeamId: string | null;
        poachTeamName: string | null;
        appearances: Array<HllRecentKillResult & {
          serverName: string;
          serverUrl: string;
          serverLastRunAt: string | null;
        }>;
        sourceNames: string[];
      }
    >();

    hllRecordsServers
      .flatMap((server) =>
        server.results
          .filter((result) => result.isFreePlayer)
          .map((result) => ({
            ...result,
            serverName: server.name,
            serverUrl: server.sourceUrl,
            serverLastRunAt: server.lastRunAt,
          })),
      )
      .forEach((result) => {
        if (!result.steamId) {
          return;
        }

        const existing = candidateMap.get(result.steamId);
        const appearances = [...(existing?.appearances ?? []), result];
        const sourceNames = Array.from(new Set(appearances.map((appearance) => appearance.serverName)));
        const weapons = Array.from(
          new Set(appearances.map((appearance) => appearance.weapon).filter((weapon): weapon is string => Boolean(weapon))),
        );
        const bestAppearance = appearances.reduce((best, appearance) => {
          if (appearance.kills !== best.kills) {
            return appearance.kills > best.kills ? appearance : best;
          }

          return (appearance.kpm ?? -1) > (best.kpm ?? -1) ? appearance : best;
        }, appearances[0]);

        candidateMap.set(result.steamId, {
          steamId: result.steamId,
          playerName: bestAppearance.playerName,
          profileUrl: bestAppearance.profileUrl,
          kpm180: averageValue(appearances.map((appearance) => appearance.kpm180)),
          averageKills: averageValue(appearances.map((appearance) => appearance.kills)),
          averageKpm: averageValue(appearances.map((appearance) => appearance.kpm)),
          bestKills: bestAppearance.kills,
          weapons,
          mainRole: bestAppearance.mainRole,
          statError: bestAppearance.statError,
          poachStatus: bestAppearance.poachStatus,
          poachTeamId: bestAppearance.poachTeamId,
          poachTeamName: bestAppearance.poachTeamName,
          appearances,
          sourceNames,
        });
      });

    return Array.from(candidateMap.values())
      .sort((left, right) => {
        const leftKpm = left.kpm180 ?? -1;
        const rightKpm = right.kpm180 ?? -1;
        if (leftKpm !== rightKpm) {
          return rightKpm - leftKpm;
        }

        return right.bestKills - left.bestKills;
      });
  }, [hllRecordsServers]);

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

  async function updateRun(action: "pause" | "resume" | "retry" | "retryAll") {
    if (!data?.latestRun) {
      return;
    }

    if (
      action === "retryAll" &&
      !window.confirm(
        "Retry every player from scratch? This will start a fresh full run for the whole tournament.",
      )
    ) {
      return;
    }

    if (
      action === "retry" &&
      !window.confirm(
        "Retry only players that are still pending or failed? Completed players will be skipped.",
      )
    ) {
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

      setNotice(
        action === "pause"
          ? "Stats refresh paused."
          : action === "resume"
            ? "Stats refresh resumed."
            : action === "retry"
              ? "Retry started for pending and failed players."
              : "Full retry started for all players.",
      );
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

  async function updateSpeed(action: "speedUp" | "slowDown") {
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
        throw new Error(payload.error || `Failed to ${action}.`);
      }

      setNotice(action === "speedUp" ? "Runner speed increased." : "Runner speed reduced.");
      setData((current) => ({
        latestRun: payload.latestRun,
        players: current?.players ?? [],
        diagnostics: current?.diagnostics,
      }));
      await loadStats();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : `Failed to ${action}.`);
    } finally {
      setBusy(false);
    }
  }

  async function addHllRecordsServer(event: React.FormEvent) {
    event.preventDefault();
    setHllRecordsBusy(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/hll-records/servers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: newHllRecordsName,
          sourceUrl: newHllRecordsUrl,
        }),
      });
      const payload = await parseApiResponse<{ server: HllRecordsServer }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to add HLLRecords server.");
      }

      setNotice("HLLRecords server added and scraped.");
      setNewHllRecordsName("");
      setNewHllRecordsUrl("");
      await loadHllRecordsServers();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to add HLLRecords server.");
    } finally {
      setHllRecordsBusy(false);
    }
  }

  async function rerunHllRecordsServer(serverId: string) {
    setRerunningServerId(serverId);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/hll-records/servers/${serverId}/refresh`, {
        method: "POST",
      });
      const payload = await parseApiResponse<{ server: HllRecordsServer }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to rerun HLLRecords server.");
      }

      setNotice("HLLRecords server rerun completed.");
      await loadHllRecordsServers();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to rerun HLLRecords server.");
    } finally {
      setRerunningServerId(null);
    }
  }

  function toggleHllRecordsServer(serverId: string) {
    setExpandedHllRecordsServerIds((current) => {
      const next = new Set(current);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return next;
    });
  }

  async function updatePoachStatus(steamId: string, status: HllPoachStatus, teamId?: string | null) {
    setUpdatingPoachSteamId(steamId);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/hll-records/poach", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          steamId,
          status,
          teamId: status === "ROSTERED" ? teamId : null,
        }),
      });
      const payload = await parseApiResponse<HllRecordsResponse>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to update poach status.");
      }

      setHllRecordsServers(payload.servers || []);
      if (payload.teams) {
        setHllRecordsTeams(payload.teams);
      }
      setNotice("Poach status updated.");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Failed to update poach status.");
    } finally {
      setUpdatingPoachSteamId(null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <button
          className={activeTab === "runner" ? "primary-button px-4 py-2" : "px-4 py-2"}
          onClick={() => setActiveTab("runner")}
          type="button"
        >
          Runner
        </button>
        <button
          className={activeTab === "leaderboards" ? "primary-button px-4 py-2" : "px-4 py-2"}
          onClick={() => setActiveTab("leaderboards")}
          type="button"
        >
          Leaderboards
        </button>
        <button
          className={activeTab === "recentKills" ? "primary-button px-4 py-2" : "px-4 py-2"}
          onClick={() => setActiveTab("recentKills")}
          type="button"
        >
          HLLRecords 100+
        </button>
        <button
          className={activeTab === "poach" ? "primary-button px-4 py-2" : "px-4 py-2"}
          onClick={() => setActiveTab("poach")}
          type="button"
        >
          Players to poach
        </button>
      </div>

      {activeTab === "runner" ? (
        <>
      <div className="surface-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-500">Standalone Service</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">HCA Stats Runner</h1>
            <p className="mt-2 max-w-3xl text-sm muted-copy">
              Pull KPM, Duel Strength and MainRole from the last 180 days for the current tournament playerbase in the
              shared HCA database. Results are cached back into Postgres so the roster app can read them without
              scraping each time.
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
            {data?.latestRun ? (
              <>
                <button className="px-4 py-2" onClick={() => updateRun("retry")} disabled={busy}>
                  Retry
                </button>
                <button className="px-4 py-2" onClick={() => updateRun("retryAll")} disabled={busy}>
                  Retry all
                </button>
                <button className="px-4 py-2" onClick={() => updateSpeed("slowDown")} disabled={busy}>
                  Slow down
                </button>
                <button className="px-4 py-2" onClick={() => updateSpeed("speedUp")} disabled={busy}>
                  Speed up
                </button>
                {data?.latestRun?.status === "PAUSED" ? (
                  <button className="px-4 py-2" onClick={() => updateRun("resume")} disabled={busy}>
                    Resume
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
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
        <div className="surface-card p-5">
          <p className="text-xs uppercase tracking-[0.2em] muted-copy">Avg / player</p>
          <p className="mt-3 text-3xl font-semibold">{formatDuration(summary.averageRetrievalMs)}</p>
        </div>
        <div className="surface-card p-5">
          <p className="text-xs uppercase tracking-[0.2em] muted-copy">ETA</p>
          <p className="mt-3 text-3xl font-semibold">{formatDuration(summary.estimatedRemainingMs)}</p>
          {summary.estimatedCompletionAt ? (
            <p className="mt-2 text-xs muted-copy">Finishes around {formatDateTime(summary.estimatedCompletionAt)}</p>
          ) : null}
        </div>
      </div>

      {data?.latestRun ? (
        <section className="surface-card space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Latest run</h2>
              <p className="text-sm muted-copy">
                {data.latestRun.status} | started {formatDateTime(data.latestRun.startedAt)} | requested by{" "}
                {data.latestRun.requestedBy || "Unknown"} | speed {data.latestRun.speedProfile}
              </p>
            </div>
            <p className="text-sm muted-copy">
              Success {data.latestRun.successPlayers} | Failed {data.latestRun.failedPlayers} | Avg{" "}
              {formatDuration(data.latestRun.averageRetrievalMs)} | Remaining{" "}
              {formatDuration(data.latestRun.estimatedRemainingMs)}
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
              <th className="px-4 py-3">MainRole</th>
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
                <td colSpan={9} className="px-4 py-6 text-center muted-copy">
                  Loading stats...
                </td>
              </tr>
            ) : null}
            {!loading && (data?.players ?? []).map((row) => (
              <tr key={row.playerId}>
                <td className="px-4 py-3">{row.teamNames.join(", ")}</td>
                <td className="px-4 py-3">{row.displayName || "-"}</td>
                <td className="px-4 py-3 font-mono text-xs">{row.steamId64}</td>
                <td className="px-4 py-3">{getRowMainRole(row)}</td>
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
                <td colSpan={9} className="px-4 py-6 text-center muted-copy">
                  No active roster players found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
        </>
      ) : activeTab === "leaderboards" ? (
        <>
          <section className="surface-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-500">Infantry only</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">Player leaderboards</h2>
                <p className="mt-2 text-sm muted-copy">
                  Rankings below only include players whose cached `MainRole` is `Infantry`.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <input
                  value={playerSearch}
                  onChange={(event) => setPlayerSearch(event.target.value)}
                  placeholder="Search player name"
                  className="min-w-[240px]"
                />
                <div className="flex gap-2">
                  <button
                    className={playerMetric === "kpm" ? "primary-button px-4 py-2" : "px-4 py-2"}
                    onClick={() => setPlayerMetric("kpm")}
                    type="button"
                  >
                    KPM
                  </button>
                  <button
                    className={playerMetric === "duelStrength" ? "primary-button px-4 py-2" : "px-4 py-2"}
                    onClick={() => setPlayerMetric("duelStrength")}
                    type="button"
                  >
                    Duel strength
                  </button>
                </div>
              </div>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
            <div className="surface-table">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr>
                    <th className="px-4 py-3">Rank</th>
                    <th className="px-4 py-3">Player</th>
                    <th className="px-4 py-3">Team</th>
                    <th className="px-4 py-3">Steam ID</th>
                    <th className="px-4 py-3">KPM 180d</th>
                    <th className="px-4 py-3">Duel Strength 180d</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInfantryPlayers.map((row, index) => (
                    <tr key={row.playerId}>
                      <td className="px-4 py-3 font-semibold">{row.overallRank}</td>
                      <td className="px-4 py-3">{row.player}</td>
                      <td className="px-4 py-3">{row.team}</td>
                      <td className="px-4 py-3 font-mono text-xs">{row.steamId64}</td>
                      <td className="px-4 py-3">{formatValue(row.kpm180)}</td>
                      <td className="px-4 py-3">{formatValue(row.duelStrength180)}</td>
                      <td className="px-4 py-3">{row.status}</td>
                    </tr>
                  ))}
                  {filteredInfantryPlayers.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center muted-copy">
                        No infantry players match this search yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <section className="space-y-4">
              <div className="surface-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-500">Infantry only</p>
                    <h3 className="mt-3 text-xl font-semibold tracking-tight">Team averages</h3>
                    <p className="mt-2 text-sm muted-copy">
                      Team ranking uses infantry players only and averages the cached values per team.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className={teamMetric === "kpm" ? "primary-button px-4 py-2" : "px-4 py-2"}
                      onClick={() => setTeamMetric("kpm")}
                      type="button"
                    >
                      Avg KPM
                    </button>
                    <button
                      className={teamMetric === "duelStrength" ? "primary-button px-4 py-2" : "px-4 py-2"}
                      onClick={() => setTeamMetric("duelStrength")}
                      type="button"
                    >
                      Avg Duel
                    </button>
                  </div>
                </div>
              </div>

              <div className="surface-table">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr>
                      <th className="px-4 py-3">Rank</th>
                      <th className="px-4 py-3">Team</th>
                      <th className="px-4 py-3">Inf players</th>
                      <th className="px-4 py-3">Avg KPM 180d</th>
                      <th className="px-4 py-3">Avg Duel Strength 180d</th>
                    </tr>
                  </thead>
                  <tbody>
                    {infantryTeamRankings.map((row, index) => (
                      <tr key={row.team}>
                        <td className="px-4 py-3 font-semibold">{index + 1}</td>
                        <td className="px-4 py-3">{row.team}</td>
                        <td className="px-4 py-3">{row.infantryPlayers}</td>
                        <td className="px-4 py-3">{formatValue(row.averageKpm180)}</td>
                        <td className="px-4 py-3">{formatValue(row.averageDuelStrength180)}</td>
                      </tr>
                    ))}
                    {infantryTeamRankings.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center muted-copy">
                          No infantry team averages available yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      ) : activeTab === "recentKills" ? (
        <>
          <section className="surface-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-500">HLLRecords</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">Recent 100+ kill matches</h2>
                <p className="mt-2 max-w-3xl text-sm muted-copy">
                  Add a community page such as `https://hllrecords.com/exd` or `https://hllrecords.com/circle`.
                  The scraper stores the latest Recent 100+ Kill Matches cards with profile links and Steam IDs.
                </p>
              </div>
            </div>
          </section>

          <form onSubmit={addHllRecordsServer} className="grid gap-3 surface-card p-5 md:grid-cols-[1fr_2fr_auto]">
            <input
              value={newHllRecordsName}
              onChange={(event) => setNewHllRecordsName(event.target.value)}
              placeholder="Name, e.g. EXD"
              disabled={hllRecordsBusy}
            />
            <input
              type="url"
              value={newHllRecordsUrl}
              onChange={(event) => setNewHllRecordsUrl(event.target.value)}
              placeholder="https://hllrecords.com/exd"
              required
              disabled={hllRecordsBusy}
            />
            <button className="primary-button px-4 py-2" disabled={hllRecordsBusy}>
              {hllRecordsBusy ? "Scraping..." : "Add and run"}
            </button>
          </form>

          {hllRecordsLoading ? (
            <div className="surface-card p-6 text-sm muted-copy">Loading HLLRecords sources...</div>
          ) : null}

          {!hllRecordsLoading && hllRecordsServers.length === 0 ? (
            <div className="surface-card p-6 text-sm muted-copy">
              No HLLRecords server pages saved yet.
            </div>
          ) : null}

          <div className="space-y-6">
            {hllRecordsServers.map((server) => {
              const isExpanded = expandedHllRecordsServerIds.has(server.id);
              const freePlayerCount = server.results.filter((result) => result.isFreePlayer).length;

              return (
              <section key={server.id} className="surface-card space-y-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="text-xl font-semibold tracking-tight">{server.name}</h3>
                    <a
                      href={server.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-cyan-400 underline decoration-cyan-400/50 underline-offset-4"
                    >
                      {server.sourceUrl}
                    </a>
                    <p className="mt-2 text-xs muted-copy">
                      Status {server.fetchStatus} | Last run {formatDateTime(server.lastRunAt)}
                    </p>
                    <p className="mt-2 text-xs muted-copy">
                      {server.results.length} gun-based 100+ results |{" "}
                      <span className="text-emerald-400">{freePlayerCount} free players</span>
                    </p>
                    {server.fetchError ? <p className="mt-2 text-xs text-red-400">{server.fetchError}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="px-4 py-2"
                      type="button"
                      onClick={() => toggleHllRecordsServer(server.id)}
                    >
                      {isExpanded ? "Hide stats" : "Show stats"}
                    </button>
                    <button
                      className="px-4 py-2"
                      type="button"
                      onClick={() => rerunHllRecordsServer(server.id)}
                      disabled={rerunningServerId === server.id || hllRecordsBusy}
                    >
                      {rerunningServerId === server.id ? "Rerunning..." : "Rerun"}
                    </button>
                  </div>
                </div>

                {isExpanded ? (
                <div className="surface-table">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr>
                        <th className="px-4 py-3">#</th>
                        <th className="px-4 py-3">Player</th>
                        <th className="px-4 py-3">Kills</th>
                        <th className="px-4 py-3">KPM</th>
                        <th className="px-4 py-3">KD</th>
                        <th className="px-4 py-3">Most used</th>
                        <th className="px-4 py-3">KPM 180d</th>
                        <th className="px-4 py-3">MainRole</th>
                        <th className="px-4 py-3">Match</th>
                        <th className="px-4 py-3">Steam ID</th>
                        <th className="px-4 py-3">Roster</th>
                        <th className="px-4 py-3">Profile</th>
                      </tr>
                    </thead>
                    <tbody>
                      {server.results.map((result) => (
                        <tr key={result.id} className={result.isFreePlayer ? "bg-emerald-500/10" : undefined}>
                          <td className="px-4 py-3">{result.sourceOrder}</td>
                          <td className={result.isFreePlayer ? "px-4 py-3 font-semibold text-emerald-300" : "px-4 py-3"}>
                            {result.playerName}
                          </td>
                          <td className="px-4 py-3 font-semibold">{result.kills}</td>
                          <td className="px-4 py-3">{formatValue(result.kpm)}</td>
                          <td className="px-4 py-3">{formatValue(result.kd)}</td>
                          <td className="px-4 py-3">{result.weapon || "-"}</td>
                          <td className="px-4 py-3">{formatValue(result.kpm180)}</td>
                          <td className="px-4 py-3">
                            {result.mainRole || (result.statError ? "Stats failed" : "-")}
                          </td>
                          <td className="px-4 py-3">
                            {result.mapName || "-"}
                            {result.duration ? ` (${result.duration})` : ""}
                            <br />
                            <span className="text-xs muted-copy">{result.playedOn || "-"}</span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">{result.steamId || "-"}</td>
                          <td className="px-4 py-3">
                            {result.isFreePlayer ? (
                              <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-xs font-semibold text-emerald-300">
                                Free
                              </span>
                            ) : result.rosterTeamNames.length > 0 ? (
                              <span className="text-xs muted-copy">{result.rosterTeamNames.join(", ")}</span>
                            ) : (
                              <span className="text-xs muted-copy">Unknown</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <a
                              href={result.profileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-cyan-400 underline decoration-cyan-400/50 underline-offset-4"
                            >
                              Open
                            </a>
                          </td>
                        </tr>
                      ))}
                      {server.results.length === 0 ? (
                        <tr>
                          <td colSpan={12} className="px-4 py-6 text-center muted-copy">
                            No gun-based recent 100+ kill matches found for this page yet.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                ) : null}
              </section>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <section className="surface-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-500">Free agents</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">Players to poach</h2>
                <p className="mt-2 max-w-3xl text-sm muted-copy">
                  Free players from the saved HLLRecords 100+ lists, filtered to gun-based results and ranked by 180d
                  comp KPM from their HLLRecords profile.
                </p>
              </div>
              <p className="text-sm muted-copy">{poachCandidates.length} available players</p>
            </div>
          </section>

          <div className="surface-table">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr>
                  <th className="px-4 py-3">Rank</th>
                  <th className="px-4 py-3">Player</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">KPM 180d</th>
                  <th className="px-4 py-3">Avg 100+ kills</th>
                  <th className="px-4 py-3">Avg 100+ KPM</th>
                  <th className="px-4 py-3">Hits</th>
                  <th className="px-4 py-3">Most used</th>
                  <th className="px-4 py-3">MainRole</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Steam ID</th>
                  <th className="px-4 py-3">Profile</th>
                </tr>
              </thead>
              <tbody>
                {hllRecordsLoading ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-6 text-center muted-copy">
                      Loading players to poach...
                    </td>
                  </tr>
                ) : null}
                {!hllRecordsLoading && poachCandidates.map((result, index) => (
                  <tr key={result.steamId} className={getPoachStatusRowClass(result.poachStatus)}>
                    <td className="px-4 py-3 font-semibold">{index + 1}</td>
                    <td className={`px-4 py-3 font-semibold ${getPoachStatusTextClass(result.poachStatus)}`}>
                      {result.playerName}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-[240px] flex-wrap gap-2">
                        <select
                          value={result.poachStatus}
                          onChange={(event) => {
                            const nextStatus = event.target.value as HllPoachStatus;
                            if (nextStatus === "ROSTERED" && !result.poachTeamId) {
                              setError("Select the HCA team roster for rostered players.");
                              return;
                            }

                            void updatePoachStatus(
                              result.steamId,
                              nextStatus,
                              result.poachTeamId,
                            );
                          }}
                          disabled={updatingPoachSteamId === result.steamId}
                          className="min-w-[130px]"
                        >
                          <option value="NEW">NEW</option>
                          <option value="MESSAGED">MESSAGED</option>
                          <option value="SECURED">SECURED</option>
                          <option value="ROSTERED">ROSTERED</option>
                        </select>
                        <select
                          value={result.poachTeamId || ""}
                          onChange={(event) => void updatePoachStatus(result.steamId, "ROSTERED", event.target.value)}
                          disabled={updatingPoachSteamId === result.steamId}
                          className="min-w-[160px]"
                        >
                          <option value="">Select roster</option>
                          {hllRecordsTeams.map((team) => (
                            <option key={team.id} value={team.id}>
                              {team.tag ? `${team.name} (${team.tag})` : team.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-semibold">{formatValue(result.kpm180)}</td>
                    <td className="px-4 py-3">{formatValue(result.averageKills)}</td>
                    <td className="px-4 py-3">{formatValue(result.averageKpm)}</td>
                    <td className="px-4 py-3">{result.appearances.length}</td>
                    <td className="px-4 py-3">{result.weapons.slice(0, 3).join(", ") || "-"}</td>
                    <td className="px-4 py-3">{result.mainRole || (result.statError ? "Stats failed" : "-")}</td>
                    <td className="px-4 py-3">
                      {result.sourceNames.join(", ")}
                      <br />
                      <span className="text-xs muted-copy">
                        Best {result.bestKills} kills | {result.appearances[0]?.mapName || "-"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{result.steamId || "-"}</td>
                    <td className="px-4 py-3">
                      <a
                        href={result.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400 underline decoration-cyan-400/50 underline-offset-4"
                      >
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
                {!hllRecordsLoading && poachCandidates.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-6 text-center muted-copy">
                      No free gun-based 100+ players found yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
