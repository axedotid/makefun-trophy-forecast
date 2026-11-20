// Trend-aware forecaster for GTA VI trophy rarity - make.fun gta6-trophy-rarity-forecast-01
// gta6-trophy-rarity-forecast-01: trend-aware forecaster with tier-calibrated spread.
// Fits a logit-linear trend to recent reads and projects it forward,
// with spread that widens by horizon and trophy tier.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

interface Trophy { id: number; name: string; tier: string; }
interface Read { slot: string; at: string; players_tracked: number; rates: Array<number | null>; }
interface Case { levels: number[]; horizon_minutes: number; trophies: Trophy[]; history: Read[]; }

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

// Tier-based spread: platinum is more stable, bronze more volatile
const TIER_SPREAD: Record<string, number> = { platinum: 0.35, gold: 0.45, silver: 0.5, bronze: 0.6 };

// Fit logit-linear trend to last N reads, return slope per hour
function fitTrend(history: Read[], trophyIdx: number, maxReads: number): number {
  const reads = history.slice(-maxReads);
  if (reads.length < 3) return 0;
  const times: number[] = [];
  const logits: number[] = [];
  for (const r of reads) {
    const rate = r.rates[trophyIdx];
    if (rate == null || rate === 0) continue;
    times.push(new Date(r.at).getTime() / 3600000);
    logits.push(logit(rate));
  }
  if (times.length < 3) return 0;
  // Least squares linear fit
  const n = times.length;
  const mx = times.reduce((a, b) => a + b, 0) / n;
  const my = logits.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (times[i] - mx) * (logits[i] - my); den += (times[i] - mx) ** 2; }
  return den > 0 ? num / den : 0;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const last = c.history[c.history.length - 1];
  if (!last) throw new Error(`${file} has no history`);
  const horizonDays = c.horizon_minutes / 1440;
  const horizonHours = c.horizon_minutes / 60;

  const trophies = c.trophies.map((t, i) => {
    const r = last.rates[i] ?? 0.01;
    const l = logit(r);
    const tier = t.tier || 'bronze';
    const baseSpread = TIER_SPREAD[tier] || 0.5;
    // Wider spread for longer horizons + extra for refresh uncertainty
    const spread = baseSpread * Math.sqrt(horizonDays + 0.15);
    // Trend: project logit forward, but dampen for long horizons
    const slope = fitTrend(c.history, i, 12);
    const dampenedSlope = slope * Math.min(horizonHours, 24) * 0.3;
    const medianLogit = l + dampenedSlope;
    return { id: t.id, q: Z.map((z) => round4(100 / (1 + Math.exp(-(medianLogit + z * spread))))) };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
