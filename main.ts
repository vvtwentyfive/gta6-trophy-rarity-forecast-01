// gta6-trophy-rarity-forecast-01 — v2 entry (fresh rewrite).
//
// Forecast each GTA VI PS5 trophy's Exophase earn rate at the case target.
//
// Model idea (decomposition, not a trend line on the rate):
//   rate(t) = k(t) / N(t),  k = earners of the trophy, N = players tracked.
// Exophase's displayed page is a stale snapshot that refreshes hours apart, so
// the displayed rate moves mostly when the denominator jumps, not smoothly.
//   * N(t): the tracked-player count grows fast just after launch and then
//     saturates. From the distinct page states in the history we estimate the
//     recent log-growth rate of N, shrink it toward a prior, add a catch-up
//     jump for how stale the last displayed state is, and let the growth rate
//     decay exponentially over the horizon (half-life 1 day).
//     With only one distinct state (a frozen launch-night page) there is no
//     growth signal in the history at all, so we fall back to a prior jump
//     of 1.80 log units (the first refresh actually observed: 638 -> 3868
//     players) plus a decaying trend at 1.70/day (the refresh-to-refresh
//     rate, 3868 -> 14,028 over 18.4 h). The prior is calibrated on those
//     two observed refreshes, so a backtest against the later snapshot is
//     a check of the rest of the model (k-priors, spread), not of the
//     N prior itself — see README.
//   * k(t): earners only grow. Per trophy we estimate the log-growth rate of
//     k between the first and last distinct states and shrink it toward a
//     prior keyed on the trophy's first rate (early trophies accumulate
//     earners fast, late ones barely move), then let that rate decay over the
//     horizon (half-life 1.5 days) and cap k at the player count.
//     Trophies near 100% are forecast in non-earner space instead
//     (m = N - k stays tiny while k tracks N).
//   * Spread on the logit scale combines a refresh-timing term, an N-growth
//     term that widens with horizon, and a k-growth term. The spread stays
//     wide even on short horizons: a refresh can jump every rate at once,
//     which is exactly what the practice cases punish narrow forecasts for.
//
// Everything is deterministic (no randomness, no dates beyond the case file),
// stdlib only, no network. Reads $MAKEFUN_INPUT_DIR else /input, writes
// $MAKEFUN_OUTPUT_DIR else /output, one <id>.out per <id>.in.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

/** Levels the contest scores, in row order. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at the levels. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Release midnight, the anchor for the growth-rate decay clock. */
const RELEASE_MS = Date.parse("2026-11-19T00:00:00Z");
const DAY_MS = 86_400_000;
const LN2 = Math.LN2;

/** Prior log-growth rate of N (per day) when history shows no refresh. */
const N_PRIOR_RATE = 1.7;
/** Prior pending-refresh jump (log units) for a frozen page: 1.80 is the
 * first refresh actually observed (638 -> 3868 players); 1.7/day is the
 * refresh-to-refresh rate (3868 -> 14,028 over 18.4 h). */
const N_PRIOR_JUMP = 1.8;
/** Half-life (days) of the N growth rate's decay over the horizon. */
const N_HALF_LIFE_D = 1.0;
/** Half-life (days) of the earner growth rate's decay over the horizon.
 * 0.75 days, not 1.5: a growth rate measured over the launch transient
 * (hours) is not sustainable — it halves every 18 h. With 1.5 d the
 * data path extrapolated the launch sprint (id 20: 13 -> 265 earners in
 * a day) to a 21% rate a week out; with 0.75 d it lands near 2%. */
const K_HALF_LIFE_D = 0.75;
/** Cap on total log earner growth over the horizon: no trophy gains more
 * than ~x20 earners from its last read, however fast it sprinted at launch. */
const G_K_CAP = 3.0;
/** Global spread scale. The unscaled spread over-covers the 19 h backtest
 * (90% coverage 0.96-1.00); 0.85 keeps honest width for the 4.5-day final
 * while trimming the excess the backtest exposes. Kept at 0.85 rather than
 * 1.0 (which costs +0.018 on the backtest) on the judgement that the
 * horizon term already carries most of the final's extra width; the
 * backtest is the only scored evidence available for the level. */
const SPREAD_SCALE = 0.85;

interface TrophyMeta {
  id: number;
  tier: string;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  horizon_minutes: number;
  levels: number[];
  trophies: TrophyMeta[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));
const clampRate = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number =>
  clampRate(100 / (1 + Math.exp(-clamp(l, -12, 12))));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** Integral of a rate decaying with half-life hl over h days, times the rate. */
const decayedGrowth = (rate: number, hDays: number, hlDays: number): number =>
  rate * (hlDays / LN2) * (1 - Math.exp((-LN2 * hDays) / hlDays));

interface State {
  /** Days since release midnight. */
  t: number;
  n: number;
  rates: Array<number | null>;
}

/** Collapse consecutive identical reads into distinct page states. */
function distinctStates(c: Case): State[] {
  const states: State[] = [];
  let prevKey = "";
  for (const r of c.history) {
    const key = `${r.players_tracked}|${r.rates.join(",")}`;
    if (key === prevKey) continue;
    prevKey = key;
    states.push({
      t: (Date.parse(r.at) - RELEASE_MS) / DAY_MS,
      n: r.players_tracked,
      rates: r.rates,
    });
  }
  return states;
}

/** Last non-null rate for trophy i across states (carried forward), else null. */
function lastRate(states: State[], i: number): number | null {
  for (let s = states.length - 1; s >= 0; s--) {
    const v = states[s].rates[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/** Prior log-growth rate of a trophy's earners (per day), from its first rate.
 * Tracks the MEDIAN growth within each launch-rate group, not the mean: most
 * trophies in a group barely move while one or two sprint (same launch rate,
 * very different earner growth), so the pinball-optimal prior sits low and
 * lets the spread cover the sprinters. Calibrated on launch -> ~23h later:
 * median g ~0.15/day below 1.0%, then rising roughly linearly in the rate. */
function kPriorRate(firstRate: number): number {
  if (firstRate < 1.0) return 0.15;
  return clamp(0.15 + 2.5 * (firstRate - 1.0), 0.15, 2.9);
}

/** Prior log-growth rate of a trophy's earners (per day), from its first rate.
 * Tracks the MEDIAN growth within each launch-rate group, not the mean: most
 * trophies in a group barely move while one or two sprint (same launch rate,
 * very different earner growth), so the pinball-optimal prior sits low and
 * lets the spread cover the sprinters. Calibrated on launch -> ~23h later:
 * median g ~0.15/day below 1.0%, then rising roughly linearly in the rate. */

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const hDays = c.horizon_minutes / 1440;
  const states = distinctStates(c);
  const nTrophies = c.trophies.length;

  // --- N(t): players tracked at the target -------------------------------
  let nLast = 638;
  let gN = 0; // total log growth of N from the last displayed state to target
  if (states.length > 0) {
    nLast = states[states.length - 1].n;
    if (states.length >= 2) {
      const first = states[0];
      const last = states[states.length - 1];
      const span = Math.max(last.t - first.t, 1 / 1440);
      const rData = clamp(
        (Math.log(Math.max(last.n, 1)) - Math.log(Math.max(first.n, 1))) / span,
        0,
        3.5,
      );
      const wData = Math.min(states.length - 1, 3);
      const r = (wData * rData + 2 * N_PRIOR_RATE) / (wData + 2);
      const lastChangeT = last.t;
      const tLastRead =
        (Date.parse(c.history[c.history.length - 1].at) - RELEASE_MS) / DAY_MS;
      const staleness = clamp(tLastRead - lastChangeT, 0, 0.75);
      const jump = r * staleness;
      gN = jump + decayedGrowth(r, hDays, N_HALF_LIFE_D);
    } else {
      // Frozen page: no growth signal in the history; prior jump + trend.
      gN = N_PRIOR_JUMP + decayedGrowth(N_PRIOR_RATE, hDays, N_HALF_LIFE_D);
    }
    gN = clamp(gN, 0, 4.5);
  }
  const nTarget = nLast * Math.exp(gN);

  // --- per trophy: k(t) and the median rate ------------------------------
  const rows: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < nTrophies; i++) {
    const rLast = lastRate(states, i);
    const rateLast = rLast === null ? 0.5 : rLast;
    const kLast = Math.round((clampRate(rateLast) / 100) * nLast);

    // Earner growth rate: data (first -> last distinct state) shrunk to prior.
    const firstRate = states.length > 0 ? (lastRate([states[0]], i) ?? rateLast) : rateLast;
    const gPrior = kPriorRate(firstRate);
    let g = gPrior;
    if (states.length >= 2) {
      const kFirst = Math.round(
        (clampRate(lastRate([states[0]], i) ?? rateLast) / 100) * states[0].n,
      );
      const span = Math.max(
        states[states.length - 1].t - states[0].t,
        1 / 1440,
      );
      const gData = clamp(
        (Math.log(kLast + 0.5) - Math.log(kFirst + 0.5)) / span,
        0,
        3.5,
      );
      const wData = Math.min(states.length - 1, 3);
      g = (wData * gData + 1.5 * gPrior) / (wData + 1.5);
    }
    const gK = Math.min(decayedGrowth(g, hDays, K_HALF_LIFE_D), G_K_CAP);

    let rateMed: number;
    let sK: number;
    if (rateLast >= 90) {
      // Near-100%: forecast the non-earners m = N - k, which stays tiny.
      const mLast = Math.max(nLast - kLast, 0);
      const mTarget = Math.max(1, mLast) * Math.exp(0.05 * hDays) +
        0.00005 * Math.max(nTarget - nLast, 0);
      const kTarget = Math.max(nTarget - mTarget, 0);
      rateMed = (100 * kTarget) / nTarget;
      sK = 0.9;
    } else {
      // Earners at target: log growth of the existing cohort, decaying over
      // the horizon. (A new-cohort term — new players arriving already
      // holding the trophy — was tried and REJECTED on the backtest: it
      // helps the 2-3 sprinting early trophies but overstates earners for
      // the ~20 mid-pack trophies at the same launch rates, net worse.
      // Earner growth from new joiners is instead picked up by the data
      // path above whenever the history shows it.)
      const kTarget = clamp(
        Math.max(kLast, (kLast + 0.5) * Math.exp(gK) - 0.5),
        kLast,
        0.98 * nTarget,
      );
      rateMed = (100 * kTarget) / nTarget;
      sK = 0.3 + 0.25 * Math.min(gK, 2.5);
    }

    // --- spread on the logit scale ---------------------------------------
    const sN = 0.3 + 0.35 * Math.sqrt(hDays);
    const sJump = 0.55; // a refresh can jump every rate at once, any horizon
    let s = Math.sqrt(sJump * sJump + sN * sN + sK * sK);
    if (rateLast >= 90) s = Math.max(s, 1.2);
    s = clamp(s * SPREAD_SCALE, 0.6, 2.0);

    const medLogit = logit(rateMed);
    let qs = Z.map((z) => round4(invLogitPct(medLogit + z * s)));
    // Enforce non-decreasing after rounding.
    for (let j = 1; j < qs.length; j++) qs[j] = Math.max(qs[j], qs[j - 1]);
    rows.push({ id: c.trophies[i].id, q: qs });
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith(".in"))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as Case;
  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}`);
  }
  if (!c.history || c.history.length === 0) {
    throw new Error(`${file} has no history`);
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
