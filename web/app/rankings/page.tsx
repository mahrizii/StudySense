"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";

const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500", "700"] });
const body = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"] });

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Spot = {
  name: string;
  score: number | null;
  temp_score: number | null;
  humidity_score: number | null;
  lux_score: number | null;
  noise_score: number | null;
  avg_temp: number | null;
  avg_humidity: number | null;
  avg_lux: number | null;
  avg_noise: number | null;
  count: number;
  minutes: number;
};

// Keep these in sync with WEIGHTS and the comfort bands in backend.py.
const FACTORS: {
  key: "noise_score" | "lux_score" | "temp_score" | "humidity_score";
  avg: "avg_noise" | "avg_lux" | "avg_temp" | "avg_humidity";
  label: string;
  weight: number;
  unit: string;
  rule: string;
}[] = [
  { key: "noise_score", avg: "avg_noise", label: "Noise", weight: 40, unit: "rel", rule: "Quietest spot scores 100, loudest scores 0" },
  { key: "lux_score", avg: "avg_lux", label: "Light", weight: 25, unit: "lx", rule: "100 at 300 lx or brighter, less below that" },
  { key: "temp_score", avg: "avg_temp", label: "Temperature", weight: 25, unit: "°C", rule: "100 between 20 and 23 °C, −20 per degree outside" },
  { key: "humidity_score", avg: "avg_humidity", label: "Humidity", weight: 10, unit: "%", rule: "100 between 30 and 60 %, −2 per point outside" },
];

const fmt = (v: number | null) =>
  v == null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1);

function FactorBar({ label, score, value, unit }: { label: string; score: number | null; value: number | null; unit: string }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr_3.5rem] items-center gap-3 text-sm">
      <span className="text-[#5b6577] dark:text-[#93a0b4]">{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-[#e3e8ef] dark:bg-white/10">
        <div
          className="h-full rounded-full bg-[#d98a1f] transition-[width] duration-700"
          style={{ width: `${score ?? 0}%` }}
        />
      </div>
      <span className={`${mono.className} text-right text-xs tabular-nums text-[#5b6577] dark:text-[#93a0b4]`}>
        {fmt(value)}
        {value != null && <span className="ml-0.5 text-[#8a94a6]">{unit}</span>}
      </span>
    </div>
  );
}

export default function Rankings() {
  const [spots, setSpots] = useState<Spot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const res = await fetch(`${API}/rankings`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("The /rankings endpoint didn't return a list. Check that it ends with `return spots`.");
      setSpots(data);
      setError(null);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? `Can't reach the backend at ${API}. Is uvicorn running?`
          : (e as Error).message
      );
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const best = spots?.find((s) => s.score != null) ?? null;
  const totalMinutes = spots?.reduce((a, s) => a + s.minutes, 0) ?? 0;

  return (
    <main className={`${body.className} min-h-screen bg-[#e9edf2] text-[#172033] dark:bg-[#0a0f1a] dark:text-[#dfe5ee]`}>
      <div className="mx-auto flex max-w-md flex-col gap-5 px-4 py-8">
        {/* Top bar */}
        <header className="flex items-center justify-between px-1">
          <h1 className={`${display.className} text-xl font-bold tracking-tight`}>
            Study<span className="text-[#d98a1f]">Sense</span>
          </h1>
          <Link
            href="/"
            className={`${mono.className} rounded-full bg-white/70 px-3 py-1 text-[11px] text-[#5b6577] ring-1 ring-black/5 hover:ring-black/15 dark:bg-white/5 dark:text-[#93a0b4] dark:ring-white/10`}
          >
            ← Session
          </Link>
        </header>

        {/* Hero: the answer */}
        <section className="relative overflow-hidden rounded-2xl bg-[#172033] p-6 text-[#eef2f7] shadow-[0_20px_40px_-24px_rgba(23,32,51,0.8)] dark:bg-[#141c2c] dark:ring-1 dark:ring-white/10">
          <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-[#f2a541]/25 blur-3xl" />
          <div className="relative flex flex-col gap-3">
            <span className={`${mono.className} text-[11px] uppercase tracking-[0.2em] text-[#93a0b4]`}>
              Best place to study
            </span>
            {best ? (
              <>
                <div className="flex items-end justify-between gap-4">
                  <p className={`${display.className} text-3xl font-bold leading-tight`}>{best.name}</p>
                  <p className={`${mono.className} text-6xl font-medium leading-none tabular-nums text-[#f2a541]`}>
                    {best.score}
                  </p>
                </div>
                <p className="text-sm text-[#93a0b4]">
                  Out of {spots!.length} {spots!.length === 1 ? "spot" : "spots"} · {totalMinutes} min recorded in total
                </p>
              </>
            ) : (
              <p className={`${display.className} text-2xl font-bold leading-tight`}>
                {spots === null && !error ? "Loading…" : "No sessions recorded yet."}
              </p>
            )}
          </div>
        </section>

        {error && (
          <p role="alert" className="rounded-xl bg-[#fdecea] px-4 py-3 text-sm text-[#8c1d18] dark:bg-[#3a1614] dark:text-[#ffb4ab]">
            {error}
          </p>
        )}

        {/* Ranked list */}
        {spots && spots.length > 0 && (
          <section className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between px-1">
              <span className={`${mono.className} text-[11px] uppercase tracking-[0.2em] text-[#5b6577] dark:text-[#93a0b4]`}>
                All spots
              </span>
              <button
                onClick={load}
                disabled={refreshing}
                className={`${mono.className} text-[11px] text-[#5b6577] underline-offset-4 hover:underline disabled:opacity-50 dark:text-[#93a0b4]`}
              >
                {refreshing ? "refreshing…" : "refresh"}
              </button>
            </div>

            <ol className="flex flex-col gap-2">
              {spots.map((s, i) => (
                <li
                  key={s.name}
                  className="flex flex-col gap-4 rounded-xl bg-white p-4 ring-1 ring-black/5 dark:bg-white/5 dark:ring-white/10"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`${mono.className} mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                        i === 0
                          ? "bg-[#d98a1f] text-[#1b1206]"
                          : "bg-[#e3e8ef] text-[#5b6577] dark:bg-white/10 dark:text-[#93a0b4]"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className={`${display.className} truncate text-lg font-medium`}>{s.name}</span>
                      <span className={`${mono.className} text-[11px] text-[#8a94a6]`}>
                        {s.minutes} min · {s.count} readings
                      </span>
                    </div>
                    <span className={`${mono.className} text-3xl font-medium tabular-nums`}>
                      {s.score ?? "—"}
                    </span>
                  </div>

                  <div className="flex flex-col gap-2">
                    {FACTORS.map((f) => (
                      <FactorBar key={f.key} label={f.label} score={s[f.key]} value={s[f.avg]} unit={f.unit} />
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* How it works */}
        <section className="flex flex-col gap-3 rounded-xl p-4 ring-1 ring-black/10 dark:ring-white/10">
          <span className={`${mono.className} text-[11px] uppercase tracking-[0.2em] text-[#5b6577] dark:text-[#93a0b4]`}>
            How the score works
          </span>
          <p className="text-sm text-[#5b6577] dark:text-[#93a0b4]">
            Each factor gets a 0–100 subscore from the spot&apos;s average reading. The total is their weighted
            average. A failed sensor is left out, not counted as zero.
          </p>
          <ul className="flex flex-col gap-2">
            {FACTORS.map((f) => (
              <li key={f.key} className="grid grid-cols-[5.5rem_2.5rem_1fr] gap-3 text-sm">
                <span className="font-medium">{f.label}</span>
                <span className={`${mono.className} tabular-nums text-[#d98a1f]`}>{f.weight}%</span>
                <span className="text-[#5b6577] dark:text-[#93a0b4]">{f.rule}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}