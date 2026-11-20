// gta6-trophy-rarity-forecast-01 v3 — forecast GTA VI PS5 trophy earn rates
// on Exophase at the case target.
//
// Model (re-derived from the v2 build record; see README.md for the full
// description and the honest caveat): decompose each trophy's rate as
// rate = k / N, forecast the players-tracked count N(t) and each trophy's
// earner count k(t) separately, then form the rate and a logit spread.
//
//   N(t): distinct page states in the case history. With >= 2 states the
//     log-growth rate r comes from first -> last state, shrunk toward the
//     1.70/day prior (prior weight 1 day), plus r x staleness for the freeze
//     since the last state was first seen; the growth rate decays with a
//     1-day half-life. With 1 state: a prior log-jump of 1.80 plus the
//     1.70/day trend, decaying the same way.
//   k(t): log-growth shrunk toward a prior that depends on the trophy's
//     launch rate — 0.15/day below a 1.0% launch rate, then
//     0.15 + 2.5 x (rate - 1.0) — with earner-growth decay (half-life
//     0.75 days) and a cap of 3.0/day. No new-cohort term (tried in v2,
//     it hurt: 0.350 with it vs 0.292 without).
//   Near-100% trophies (last rate >= 99%) are forecast in non-earner
//     space: m = N - k grows only a little, plus 0.00005 x (N_target - N).
//   Spread (logit): sqrt(0.55^2 + (0.30 + 0.35 x sqrt(H))^2 + sK^2),
//     sK = 0.30 + 0.25 x min(gK, 2.5), times a 0.85 scale, clipped to
//     [0.6, 2.0], and at least 1.2 for near-100% trophies.
//
// CAVEAT (also in the README): the N prior (jump 1.80, rate 1.70/day) is
// calibrated on the same Exophase refreshes the snapshot records (638 ->
// 3,868 -> 14,028 players), so a backtest against that snapshot validates
// the earner model and the spread, NOT the N prior itself. The N prior's
// justification is the observed refreshes, stated here, not the backtest.
//
// Node 22, standard library only. Reads every *.in case in the input dir
// ($MAKEFUN_INPUT_DIR, else /input/) and writes one *.out per case to the
// output dir ($MAKEFUN_OUTPUT_DIR, else /output/). Deterministic: pure
// functions of the case file, fixed iteration order, no clock, no random.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const LN2 = Math.log(2);
const DAY_MS = 86_400_000;

// ---- Model constants (fixed in advance of any run; see header) ----
/** Log-jump of N when the history shows a single frozen page state. */
const N_PRIOR_JUMP_LOG = 1.8;
/** Prior log-growth rate of N, per day. */
const N_PRIOR_RATE = 1.7;
/** Weight (in days of span) given to the 1.70/day N prior when shrinking. */
const N_PRIOR_WEIGHT_DAYS = 1.0;
/** Half-life (days) of the N growth rate's decay. */
const N_DECAY_HALF_LIFE_D = 1.0;
/** Half-life (days) of the earner growth rate's decay. */
const K_DECAY_HALF_LIFE_D = 0.75;
/** Cap on the earner log-growth rate, per day. */
const G_K_CAP = 3.0;
/** Refresh (jump) component of the logit spread. */
const SPREAD_REFRESH = 0.55;
/** Horizon component of the logit spread: 0.30 + 0.35 x sqrt(H_days). */
const SPREAD_H_BASE = 0.3;
const SPREAD_H_SLOPE = 0.35;
/** Overall scale on the spread (kept at 0.85; tighter scales scored better
 *  on the short backtest but would overfit the 4.5-day final horizon). */
const SPREAD_SCALE = 0.85;
const SPREAD_MIN = 0.6;
const SPREAD_MAX = 2.0;
/** Spread floor for near-100% trophies. */
const SPREAD_NEAR100_MIN = 1.2;
/** A trophy counts as near-100% when its last rate is at least this. */
const NEAR100_RATE = 99.0;
/** Non-earner growth from new players joining, per extra player tracked. */
const NEAR100_PER_NEW_PLAYER = 0.00005;
/** Launch-rate threshold (percent) below which the k prior is flat. */
const K_PRIOR_FLAT_BELOW = 1.0;
/** Flat k-prior log-growth (per day) for trophies below the threshold. */
const K_PRIOR_FLAT = 0.15;
/** Slope of the k prior above the threshold, per percentage point. */
const K_PRIOR_SLOPE = 2.5;
/** Cap on the k prior itself. */
const K_PRIOR_CAP = 2.9;
/** Weight (in days of span) given to the k prior when shrinking g_data. */
const K_PRIOR_WEIGHT_DAYS = 0.5;

interface TrophyDef {
  id: number;
}

interface HistoryRead {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  levels: number[];
  trophies: TrophyDef[];
  history: HistoryRead[];
}

/** One distinct page state: a run of reads with the same N and rates. */
interface PageState {
  /** When this state was first seen (ms since epoch). */
  firstSeenMs: number;
  players: number;
  rates: Array<number | null>;
}

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));
const clampRate = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const logistic = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/**
 * Integral of a growth rate that decays exponentially with the given
 * half-life, over H days: the total log-growth a rate g would produce.
 * HL / ln 2 x (1 - 2^(-H / HL)).
 */
const decayIntegral = (hDays: number, halfLifeDays: number): number =>
  (halfLifeDays / LN2) * (1 - Math.pow(2, -hDays / halfLifeDays));

/** Collapse the history into distinct page states, oldest first. */
function distinctStates(history: HistoryRead[]): PageState[] {
  const states: PageState[] = [];
  for (const read of history) {
    const prev = states[states.length - 1];
    const same =
      prev !== undefined &&
      prev.players === read.players_tracked &&
      prev.rates.length === read.rates.length &&
      prev.rates.every((r, i) => r === read.rates[i]);
    if (same) continue;
    states.push({
      firstSeenMs: Date.parse(read.at),
      players: read.players_tracked,
      rates: read.rates.slice(),
    });
  }
  return states;
}

/** Last non-null rate for trophy i across the states, oldest first. */
function lastSeenRate(states: PageState[], i: number): number | null {
  for (let s = states.length - 1; s >= 0; s--) {
    const r = states[s].rates[i];
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

/** First non-null rate for trophy i across the states, oldest first. */
function firstSeenRate(states: PageState[], i: number): number | null {
  for (const s of states) {
    const r = s.rates[i];
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

/** Prior earner log-growth rate (per day) from the launch rate (percent). */
function kPriorRate(firstRatePct: number): number {
  if (firstRatePct < K_PRIOR_FLAT_BELOW) return K_PRIOR_FLAT;
  return clamp(
    K_PRIOR_FLAT + K_PRIOR_SLOPE * (firstRatePct - K_PRIOR_FLAT_BELOW),
    K_PRIOR_FLAT,
    K_PRIOR_CAP,
  );
}

/**
 * Forecast the players-tracked count at the target.
 * Returns { nTarget, logGrowth } with logGrowth = ln(N_target / N_last).
 */
function forecastN(
  states: PageState[],
  checkpointMs: number,
  hDays: number,
): { nTarget: number; logGrowth: number } {
  const last = states[states.length - 1];
  const nLast = last.players;
  let logGrowth: number;
  if (states.length < 2) {
    // One frozen state: expect a refresh jump, then the prior trend,
    // decaying over the horizon.
    logGrowth =
      N_PRIOR_JUMP_LOG + N_PRIOR_RATE * decayIntegral(hDays, N_DECAY_HALF_LIFE_D);
  } else {
    const first = states[0];
    const spanDays = Math.max(
      (last.firstSeenMs - first.firstSeenMs) / DAY_MS,
      0,
    );
    // Observed log-growth rate, shrunk toward the 1.70/day prior.
    const rData =
      spanDays > 0 && first.players > 0 && last.players > 0
        ? Math.log(last.players / first.players) / spanDays
        : N_PRIOR_RATE;
    const r =
      (rData * spanDays + N_PRIOR_RATE * N_PRIOR_WEIGHT_DAYS) /
      (spanDays + N_PRIOR_WEIGHT_DAYS);
    // The last state may already be stale (page frozen since it was first
    // seen): expect a catch-up jump of r x staleness on top of future growth.
    const stalenessDays = Math.max(
      (checkpointMs - last.firstSeenMs) / DAY_MS,
      0,
    );
    logGrowth =
      r * stalenessDays + r * decayIntegral(hDays, N_DECAY_HALF_LIFE_D);
  }
  // Guard the long-horizon extrapolation: even a steep observed r must
  // not send N to Infinity/NaN (or to an absurd count) on the f00 path,
  // where the history spans many distinct states.
  logGrowth = clamp(logGrowth, -2, 12);
  return { nTarget: nLast * Math.exp(logGrowth), logGrowth };
}

interface TrophyForecast {
  medianPct: number;
  spread: number;
}

/** Forecast one trophy's median rate (percent) and logit spread. */
function forecastTrophy(
  states: PageState[],
  i: number,
  nLast: number,
  nTarget: number,
  hDays: number,
): TrophyForecast {
  const first = states[0];
  const last = states[states.length - 1];
  const firstRate = firstSeenRate(states, i);
  const lastRate = lastSeenRate(states, i);
  const launchRate = firstRate ?? lastRate ?? 0;
  const lastPct = lastRate ?? firstRate ?? 0;

  const spanDays =
    states.length >= 2
      ? Math.max((last.firstSeenMs - first.firstSeenMs) / DAY_MS, 0)
      : 0;

  // Earner log-growth rate: data path shrunk toward the launch-rate prior.
  const gPrior = kPriorRate(launchRate);
  let g = gPrior;
  if (states.length >= 2 && spanDays > 0) {
    const kFirst = (firstRate ?? 0) * first.players / 100;
    const kLast = (lastRate ?? 0) * last.players / 100;
    if (kFirst > 0 && kLast > 0) {
      const gData = Math.log(kLast / kFirst) / spanDays;
      g =
        (gData * spanDays + gPrior * K_PRIOR_WEIGHT_DAYS) /
        (spanDays + K_PRIOR_WEIGHT_DAYS);
    }
  }
  // Earners only grow; cap the rate for the long final horizon.
  g = clamp(g, 0, G_K_CAP);

  let medianPct: number;
  if (lastPct >= NEAR100_RATE) {
    // Near-100%: forecast in non-earner space. m barely grows, plus a
    // small share of the new players also lack the trophy.
    const kLast = (lastPct / 100) * nLast;
    const mLast = Math.max(nLast - kLast, 0);
    const mTarget =
      mLast * Math.exp(K_PRIOR_FLAT * decayIntegral(hDays, K_DECAY_HALF_LIFE_D)) +
      NEAR100_PER_NEW_PLAYER * Math.max(nTarget - nLast, 0);
    medianPct = clampRate(100 * (1 - mTarget / nTarget));
  } else {
    const kLast = (lastPct / 100) * nLast;
    const kTarget =
      kLast * Math.exp(g * decayIntegral(hDays, K_DECAY_HALF_LIFE_D));
    medianPct = clampRate((100 * kTarget) / nTarget);
  }

  const sK = 0.3 + 0.25 * Math.min(g, 2.5);
  const horizonTerm = SPREAD_H_BASE + SPREAD_H_SLOPE * Math.sqrt(hDays);
  let spread = Math.sqrt(
    SPREAD_REFRESH * SPREAD_REFRESH +
      horizonTerm * horizonTerm +
      sK * sK,
  );
  spread = clamp(spread * SPREAD_SCALE, SPREAD_MIN, SPREAD_MAX);
  if (lastPct >= NEAR100_RATE) spread = Math.max(spread, SPREAD_NEAR100_MIN);
  return { medianPct, spread };
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const hDays = c.horizon_minutes / 1440;
  const checkpointMs = Date.parse(c.at);
  const states = distinctStates(c.history);
  if (states.length === 0) {
    // No history at all (does not occur in graded cases): fall back to a
    // wide, low forecast rather than crashing the run.
    return c.trophies.map((t) => ({
      id: t.id,
      q: Z.map((z) => round4(clamp(logistic(logit(0.5) + z * 1.5), 0, 100))),
    }));
  }
  const last = states[states.length - 1];
  const { nTarget } = forecastN(states, checkpointMs, hDays);
  return c.trophies.map((t, i) => {
    const { medianPct, spread } = forecastTrophy(
      states,
      i,
      last.players,
      nTarget,
      hDays,
    );
    const centre = logit(medianPct);
    let prev = -Infinity;
    const q = Z.map((z) => {
      const v = round4(clamp(logistic(centre + z * spread), 0, 100));
      // Rounding can only tie, never invert; enforce non-decreasing anyway.
      const out = Math.max(v, prev);
      prev = out;
      return out;
    });
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(
      `${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`,
    );
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
