"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";

const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500", "700"] });
const body = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"] });

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Edit these to match the spots you'll actually test.
const LOCATIONS = ["Dorm", "Library 3F", "Library 1F", "CS Lab", "Student Lounge", "Cafe"];
const OTHER = "__other__";

// Trim and collapse spaces so " library  3f " and "library 3f" don't become two spots.
const cleanName = (s: string) => s.trim().replace(/\s+/g, " ");

type StudySession = {
  id: number;
  location: string;
  session_start: number; // epoch seconds, UTC
  session_end: number | null;
};

type Reading = {
  id: number;
  temp_c: number | null;
  humidity: number | null;
  pressure_hpa: number | null;
  lux: number | null;
  noise: number | null;
  received_at: number | null;
};

async function readError(res: Response): Promise<string> {
  try {
    const b = await res.json();
    const d = b?.detail;
    if (typeof d === "string") return d;
    if (d?.error) return d.error;
  } catch {
    /* not JSON */
  }
  return `Request failed (${res.status})`;
}

const pad = (n: number) => String(n).padStart(2, "0");

function formatElapsed(total: number) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function formatClock(epoch: number) {
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

type Metric = "temp_c" | "humidity" | "lux" | "noise";

const METRICS: { key: Metric; label: string; unit: string }[] = [
  { key: "temp_c", label: "Temperature", unit: "°C" },
  { key: "humidity", label: "Humidity", unit: "%" },
  { key: "lux", label: "Light", unit: "lx" },
  { key: "noise", label: "Noise", unit: "rel" },
];

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// Area sparkline drawn as plain SVG. Gaps (null readings) break the line.
function Sparkline({ values, id }: { values: (number | null)[]; id: string }) {
  const W = 300;
  const H = 72;
  const P = 6;
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) {
    return (
      <div className="flex h-[72px] items-center text-xs text-[#8a94a6]">Collecting readings…</div>
    );
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const x = (i: number) => (values.length === 1 ? 0 : (i / (values.length - 1)) * W);
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);

  // Split into runs of consecutive non-null points.
  const runs: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push({ i, v });
  });
  if (cur.length) runs.push(cur);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[72px] w-full" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d98a1f" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#d98a1f" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1="0"
          x2={W}
          y1={H * f}
          y2={H * f}
          stroke="currentColor"
          strokeOpacity="0.07"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {runs.map((run, k) => {
        const line = run.map((p, j) => `${j ? "L" : "M"}${x(p.i)},${y(p.v)}`).join(" ");
        const area = `${line} L${x(run[run.length - 1].i)},${H} L${x(run[0].i)},${H} Z`;
        return (
          <g key={k}>
            <path d={area} fill={`url(#${id})`} />
            <path
              d={line}
              fill="none"
              stroke="#d98a1f"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </svg>
  );
}

export default function Home() {
  const [active, setActive] = useState<StudySession | null>(null);
  const [history, setHistory] = useState<Reading[]>([]);
  const [newest, setNewest] = useState<Reading | null>(null); // newest reading from ANY session
  const activeId = useRef<number | null>(null);
  const [location, setLocation] = useState(LOCATIONS[0]);
  const [custom, setCustom] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  async function fetchActive() {
    try {
      const res = await fetch(`${API}/active_session`);
      if (!res.ok) throw new Error(await readError(res));
      setActive((await res.json()) ?? null);
      setError(null);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? `Can't reach the backend at ${API}. Is uvicorn running?`
          : (e as Error).message
      );
    } finally {
      setLoading(false);
    }
  }

  // While recording: this session's readings. Otherwise: the last ~10 minutes (120 × 5 s).
  async function fetchHistory() {
    try {
      const sid = activeId.current;
      const res = await fetch(
        `${API}/readings/recent?limit=120${sid != null ? `&session_id=${sid}` : ""}`
      );
      if (res.ok) setHistory(await res.json());
    } catch {
      /* the charts just stay hidden */
    }
  }

  // Newest reading overall, not filtered by session, so "online" doesn't depend on the session.
  async function fetchNewest() {
    try {
      const res = await fetch(`${API}/readings/recent?limit=1`);
      if (res.ok) {
        const rows: Reading[] = await res.json();
        setNewest(rows.length ? rows[rows.length - 1] : null);
      }
    } catch {
      /* badge just shows offline */
    }
  }

  useEffect(() => {
    setNow(Date.now() / 1000);
    fetchActive();
    const a = setInterval(fetchActive, 10_000);
    fetchNewest();
    const r = setInterval(() => {
      fetchHistory();
      fetchNewest();
    }, 1_000);
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => {
      clearInterval(a);
      clearInterval(r);
      clearInterval(t);
    };
  }, []);

  // When the session changes, switch the charts to it right away.
  useEffect(() => {
    activeId.current = active?.id ?? null;
    fetchHistory();
  }, [active?.id]);

  async function call(path: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}${path}`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      await fetchActive();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chosen = location === OTHER ? cleanName(custom) : location;
  const start = () => chosen && call(`/start_session?location=${encodeURIComponent(chosen)}`);
  // end_session still takes location; drop it here if you remove it from the backend.
  const stop = () => active && call(`/end_session?location=${encodeURIComponent(active.location)}`);

  const recording = active !== null;
  const latest = history.length ? history[history.length - 1] : null;
  const lastSeen = newest?.received_at ? now - newest.received_at : null;
  const deviceOnline = lastSeen !== null && lastSeen < 20;

  return (
    <main
      className={`${body.className} min-h-screen bg-[#e9edf2] text-[#172033] dark:bg-[#0a0f1a] dark:text-[#dfe5ee]`}
    >
      <div className="mx-auto flex max-w-md flex-col gap-5 px-4 py-8">
        {/* Top bar */}
        <header className="flex items-center justify-between px-1">
          <h1 className={`${display.className} text-xl font-bold tracking-tight`}>
            Study<span className="text-[#d98a1f]">Sense</span>
          </h1>
          <div className="flex items-center gap-2">
          <Link
            href="/rankings"
            className={`${mono.className} rounded-full bg-white/70 px-3 py-1 text-[11px] text-[#5b6577] ring-1 ring-black/5 hover:ring-black/15 dark:bg-white/5 dark:text-[#93a0b4] dark:ring-white/10 dark:hover:ring-white/25`}
          >
            Rankings →
          </Link>
          <span
            className={`${mono.className} flex items-center gap-1.5 rounded-full bg-white/70 px-2.5 py-1 text-[11px] text-[#5b6577] ring-1 ring-black/5 dark:bg-white/5 dark:text-[#93a0b4] dark:ring-white/10`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${deviceOnline ? "bg-[#3fae7a]" : "bg-[#a3acba]"}`}
            />
            node1 {deviceOnline ? "online" : "offline"}
          </span>
          </div>
        </header>

        {/* Hero card */}
        <section
          aria-live="polite"
          className="relative overflow-hidden rounded-2xl bg-[#172033] p-6 text-[#eef2f7] shadow-[0_20px_40px_-24px_rgba(23,32,51,0.8)] dark:bg-[#141c2c] dark:ring-1 dark:ring-white/10"
        >
          {/* lamp glow */}
          <div
            aria-hidden
            className={`pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full blur-3xl transition-opacity duration-700 ${
              recording ? "bg-[#f2a541]/30 opacity-100" : "opacity-0"
            }`}
          />

          <div className="relative flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                {recording && (
                  <span className="absolute inline-flex h-full w-full rounded-full bg-[#f2a541] opacity-70 motion-safe:animate-ping" />
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                    recording ? "bg-[#f2a541]" : "bg-[#4a5670]"
                  }`}
                />
              </span>
              <span className={`${mono.className} text-[11px] uppercase tracking-[0.2em] text-[#93a0b4]`}>
                {loading ? "Checking" : recording ? "Recording" : "Idle"}
              </span>
            </div>

            {recording ? (
              <div className="flex flex-col gap-1">
                <p className={`${display.className} text-2xl font-medium text-[#c9d2df]`}>
                  {active.location}
                </p>
                <p
                  className={`${mono.className} text-6xl font-medium tabular-nums tracking-tight text-[#f2a541]`}
                >
                  {formatElapsed(now - active.session_start)}
                </p>
                <p className="mt-1 text-sm text-[#93a0b4]">
                  Since {formatClock(active.session_start)} · session #{active.id}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <p className={`${display.className} text-3xl font-bold leading-tight`}>
                  Pick a spot,
                  <br />
                  start a session.
                </p>
                <p className="text-sm text-[#93a0b4]">
                  Readings get tagged with the location until you stop.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Location chips */}
        <section className="flex flex-col gap-2.5">
          <span className={`${mono.className} px-1 text-[11px] uppercase tracking-[0.2em] text-[#5b6577] dark:text-[#93a0b4]`}>
            Location
          </span>
          <div className="grid grid-cols-2 gap-2">
            {[...LOCATIONS, OTHER].map((l) => {
              const isOther = l === OTHER;
              const selected = recording
                ? isOther
                  ? !LOCATIONS.includes(active.location)
                  : active.location === l
                : location === l;
              return (
                <button
                  key={l}
                  type="button"
                  aria-pressed={selected}
                  disabled={recording || busy}
                  onClick={() => setLocation(l)}
                  className={`${isOther ? "col-span-2" : ""} h-11 rounded-xl px-3 text-left text-[15px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d98a1f] ${
                    selected
                      ? "bg-[#172033] text-white dark:bg-[#eef2f7] dark:text-[#172033]"
                      : "bg-white text-[#172033] ring-1 ring-black/5 hover:ring-black/15 dark:bg-white/5 dark:text-[#dfe5ee] dark:ring-white/10 dark:hover:ring-white/25"
                  } ${recording && !selected ? "opacity-40" : ""}`}
                >
                  {isOther ? "Other…" : l}
                </button>
              );
            })}
          </div>

          {location === OTHER && !recording && (
            <input
              id="custom-location"
              type="text"
              autoFocus
              maxLength={40}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && chosen && !busy && start()}
              placeholder="e.g. Hagerty Library 2F"
              className="h-12 rounded-xl bg-white px-4 text-[15px] ring-1 ring-black/10 placeholder:text-[#8a94a6] focus:outline-none focus:ring-2 focus:ring-[#d98a1f] dark:bg-white/5 dark:ring-white/15"
            />
          )}
        </section>

        {/* Action */}
        <button
          onClick={recording ? stop : start}
          disabled={busy || loading || (!recording && !chosen)}
          className={`h-14 rounded-xl text-base font-semibold transition active:scale-[0.99] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d98a1f] ${
            recording
              ? "bg-white text-[#b3261e] ring-1 ring-[#b3261e]/30 hover:bg-[#fdf2f1] dark:bg-white/5 dark:text-[#ff8a80] dark:ring-[#ff8a80]/30"
              : "bg-[#d98a1f] text-[#1b1206] hover:bg-[#c97c14]"
          }`}
        >
          {busy
            ? "Working…"
            : recording
            ? "Stop session"
            : chosen
            ? `Start at ${chosen}`
            : "Type a location"}
        </button>

        {error && (
          <p
            role="alert"
            className="rounded-xl bg-[#fdecea] px-4 py-3 text-sm text-[#8c1d18] dark:bg-[#3a1614] dark:text-[#ffb4ab]"
          >
            {error}
          </p>
        )}

        {/* Live charts */}
        {(latest || recording) && (
          <section className="flex flex-col gap-2.5 pt-2">
            <div className="flex items-baseline justify-between px-1">
              <span className={`${mono.className} text-[11px] uppercase tracking-[0.2em] text-[#5b6577] dark:text-[#93a0b4]`}>
                {recording ? "This session" : "Last 10 minutes"}
              </span>
              {lastSeen !== null && (
                <span className={`${mono.className} text-[11px] text-[#5b6577] dark:text-[#93a0b4]`}>
                  {lastSeen < 10
                    ? "live"
                    : lastSeen < 60
                    ? `updated ${Math.round(lastSeen)}s ago`
                    : lastSeen < 3600
                    ? `updated ${Math.round(lastSeen / 60)}m ago`
                    : `updated ${Math.round(lastSeen / 3600)}h ago`}
                </span>
              )}
            </div>
            {!latest ? (
              <div className="rounded-xl bg-white p-4 text-sm text-[#5b6577] ring-1 ring-black/5 dark:bg-white/5 dark:text-[#93a0b4] dark:ring-white/10">
                {deviceOnline
                  ? "Waiting for the first reading of this session…"
                  : "The device looks offline, so no readings are arriving. Check that the ESP32 is powered and connected."}
              </div>
            ) : (
            <div className="flex flex-col gap-2">
              {METRICS.map((m) => {
                const values = history.map((r) => r[m.key]);
                const nums = values.filter((v): v is number => v != null);
                const current = latest[m.key];
                return (
                  <div
                    key={m.key}
                    className="flex flex-col gap-2 rounded-xl bg-white p-4 ring-1 ring-black/5 dark:bg-white/5 dark:ring-white/10"
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-[#5b6577] dark:text-[#93a0b4]">{m.label}</span>
                      <span className={`${mono.className} text-2xl font-medium tabular-nums`}>
                        {current != null ? fmt(current) : "—"}
                        <span className="ml-1 text-sm text-[#8a94a6]">{current != null ? m.unit : ""}</span>
                      </span>
                    </div>
                    <Sparkline values={values} id={`grad-${m.key}`} />
                    {nums.length > 1 && (
                      <div className={`${mono.className} flex justify-between text-[11px] text-[#8a94a6] tabular-nums`}>
                        <span>min {fmt(Math.min(...nums))}</span>
                        <span>avg {fmt(nums.reduce((a, b) => a + b, 0) / nums.length)}</span>
                        <span>max {fmt(Math.max(...nums))}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}
          </section>
        )}

        {/* Rankings */}
        <Link
          href="/rankings"
          className="flex h-12 items-center justify-between rounded-xl bg-white px-4 text-[15px] font-medium ring-1 ring-black/5 hover:ring-black/15 dark:bg-white/5 dark:ring-white/10 dark:hover:ring-white/25"
        >
          <span>See rankings</span>
          <span className="text-[#d98a1f]">→</span>
        </Link>
      </div>
    </main>
  );
}