#!/usr/bin/env python3
"""Forecast GTA VI (PS5) trophy earn rates on Exophase at a case's target.

Approach, in brief.  A trophy's earn rate is a share of the players Exophase
tracks, and both the numerator (players who earned it) and the denominator
(players tracked) move as the launch week goes on: early players progress and
earn more, while each Exophase refresh pulls in a wave of newer, less
progressed players and drags every rate down a step.  So a rate's path is a
slow climb interrupted by dilution steps, and it saturates in log time.

For every trophy this program therefore works on the logit scale against
log time, x = ln(1 + hours since 2026-11-19T00:00Z):

  * It first collapses the history to its distinct page states.  The house
    reads every 10-30 minutes but Exophase only refreshes every few hours,
    so most reads repeat the previous page byte for byte; counting each
    repeat as an observation would let long stale plateaus dominate the fit.
    One observation per distinct (players_tracked, rates) state, dated at
    the first read that showed it.
  * It fits a least-squares line of logit(rate) on x over the distinct
    states of the last 48 hours (or all of them when there are fewer), then
    shrinks the slope toward the median slope of the trophy's tier
    (platinum is shrunk toward zero: a week-one platinum barely moves) and
    caps the slope, so a noisy rare trophy cannot run away.
  * The median is a blend of that line read at the target and the last
    observed rate, with the line's weight growing with the number of
    distinct states, and the total move from the last rate capped.
  * A stale page earns a small downward nudge and a wider spread: when the
    page has not changed for hours, the next refresh is overdue and it
    dilutes rates, which is exactly what the practice cases straddle.  The
    nudge is weighted by how short the horizon is next to a refresh
    interval: over a 90-minute horizon a single overdue refresh can move
    every rate, while over a 4.5-day horizon many refreshes come and go and
    the fitted trend already carries their net effect, so the stale terms
    fade to almost nothing there.

The spread (logit units) combines a random-walk term growing with the
horizon, the fit's residual volatility carried forward to the target with a
standard prediction-interval factor, a stale-page term, and a floor, so a
flat launch-night history still gets an honest band while a rich two-day
history gets a band shaped by each trophy's own wobble.

Standard library only, no network, deterministic: the same input always
writes the same bytes.
"""

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

INPUT_DIR = Path(os.environ.get("MAKEFUN_INPUT_DIR", "/input"))
OUTPUT_DIR = Path(os.environ.get("MAKEFUN_OUTPUT_DIR", "/output"))

LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95]
NORM_Q = [-1.6448536269514722, -0.6744897501960817, 0.0, 0.6744897501960817, 1.6448536269514722]

# Launch day begins here; log time is measured from this instant.
EPOCH = datetime(2026, 11, 19, 0, 0, 0, tzinfo=timezone.utc)

LO = 0.01
HI = 99.99

# Fit window: distinct states from the last this many hours, when available.
FIT_WINDOW_HOURS = 48.0
# Shrinkage: a trophy's own slope gets weight n / (n + SLOPE_SHRINK).
SLOPE_SHRINK = 4.0
MAX_SLOPE = 1.75
# How far the median may move from the last observed rate, in logit units.
MAX_MOVE = 1.6
PLATINUM_MAX_RISE = 0.6
# Spread pieces, in logit units.
RW_PER_SQRT_DAY = 0.35
RESID_PRIOR_SD = 0.35
STALE_SIGMA = 0.75
STALE_HALF_LIFE_HOURS = 6.0
SPREAD_FLOOR = 0.20
SIGMA_MIN = 0.30
SIGMA_MAX = 1.90
STALE_SHIFT = 0.30


def parse_time(text):
    """ISO-8601 UTC timestamp -> aware datetime."""
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def clip_pct(value):
    return min(HI, max(LO, value))


def logit_of(pct):
    p = clip_pct(pct) / 100.0
    return math.log(p / (1.0 - p))


def inv_logit(lg):
    if lg >= 0:
        return 100.0 / (1.0 + math.exp(-lg))
    e = math.exp(lg)
    return 100.0 * e / (1.0 + e)


def round4(value):
    """Round to 4 decimals, halves away from zero, returning int for wholes."""
    scaled = value * 10000.0
    whole = math.floor(scaled + 0.5)
    out = whole / 10000.0
    return int(out) if out == int(out) else out


def log_hours(moment):
    """ln(1 + hours from the release midnight to `moment`)."""
    hours = (moment - EPOCH).total_seconds() / 3600.0
    return math.log1p(max(0.0, hours))


def distinct_states(history):
    """Collapse consecutive identical reads to one state each.

    Returns a list of (moment, players_tracked, rates tuple) in time order,
    keeping the first read that showed each distinct page.
    """
    states = []
    prev_key = None
    for read in history:
        rates = tuple(read.get("rates") or [])
        key = (read.get("players_tracked"), rates)
        if key == prev_key:
            continue
        prev_key = key
        try:
            moment = parse_time(read["at"])
        except (KeyError, TypeError, ValueError):
            continue
        states.append((moment, read.get("players_tracked"), rates))
    return states


def ols(points):
    """Least-squares line through (x, y) points; returns (intercept, slope).

    Also returns the residual standard deviation, the mean of x, and the
    sum of squared x deviations, for the prediction-interval factor.
    """
    n = len(points)
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    if sxx <= 1e-12:
        return my, 0.0, 0.0, mx, sxx
    sxy = sum((p[0] - mx) * (p[1] - my) for p in points)
    slope = sxy / sxx
    intercept = my - slope * mx
    if n > 2:
        resid = sum((p[1] - (intercept + slope * p[0])) ** 2 for p in points)
        sd = math.sqrt(resid / (n - 2))
    else:
        sd = 0.0
    return intercept, slope, sd, mx, sxx


def median_of(values):
    ordered = sorted(values)
    m = len(ordered)
    if m == 0:
        return 0.0
    if m % 2:
        return ordered[m // 2]
    return 0.5 * (ordered[m // 2 - 1] + ordered[m // 2])


def forecast_case(case):
    trophies = case["trophies"]
    history = case.get("history") or []
    if not history:
        raise ValueError("case has no history")
    horizon_days = float(case["horizon_minutes"]) / 1440.0
    target = parse_time(case["target"])
    x_target = log_hours(target)
    checkpoint = parse_time(case["at"])

    states = distinct_states(history)
    if not states:
        raise ValueError("case history has no usable reads")

    # Hours since the page last changed (its last distinct state appeared).
    stale_hours = max(0.0, (checkpoint - states[-1][0]).total_seconds() / 3600.0)
    stale_factor = min(1.0, stale_hours / STALE_HALF_LIFE_HOURS)
    # A stale page matters when the horizon is short next to a refresh
    # interval (~hours); over a multi-day horizon its effect washes out.
    horizon_hours = float(case["horizon_minutes"]) / 60.0
    stale_weight = min(1.0, 12.0 / max(horizon_hours, 1.0))
    stale_factor *= stale_weight

    # The last non-null rate of every trophy, for the persistence anchor.
    last_rate = []
    for i in range(len(trophies)):
        rate = None
        for _, _, rates in reversed(states):
            if i < len(rates) and rates[i] is not None:
                rate = float(rates[i])
                break
        last_rate.append(rate if rate is not None else 1.0)

    # Per-trophy log-time fits on the recent distinct states.
    window_start = checkpoint.timestamp() - FIT_WINDOW_HOURS * 3600.0
    fits = []
    for i in range(len(trophies)):
        points = []
        for moment, _, rates in states:
            if moment.timestamp() < window_start and len(states) > 5:
                continue
            if i < len(rates) and rates[i] is not None:
                points.append((log_hours(moment), logit_of(float(rates[i]))))
        if len(points) >= 2:
            intercept, slope, sd, mx, sxx = ols(points)
            fits.append({
                "n": len(points), "slope": slope, "sd": sd,
                "mx": mx, "sxx": sxx, "points": points,
            })
        else:
            fits.append(None)

    # Tier-pooled slopes: the median raw slope within each tier, used to
    # shrink noisy individual slopes.  Platinum pools to zero by design.
    pool = {}
    by_tier = {}
    for trophy, fit in zip(trophies, fits):
        if fit is not None:
            by_tier.setdefault(trophy.get("tier", ""), []).append(fit["slope"])
    for tier, slopes in by_tier.items():
        pool[tier] = median_of(slopes)
    pool["platinum"] = 0.0

    rows = []
    for idx, trophy in enumerate(trophies):
        last = last_rate[idx]
        last_lg = logit_of(last)
        fit = fits[idx]

        if fit is None or fit["n"] < 2:
            centre = last_lg
            resid_sd = RESID_PRIOR_SD
            pred_factor = 1.0
        else:
            tier_slope = pool.get(trophy.get("tier", ""), 0.0)
            weight = fit["n"] / (fit["n"] + SLOPE_SHRINK)
            slope = weight * fit["slope"] + (1.0 - weight) * tier_slope
            if trophy.get("tier") == "platinum":
                slope *= 0.25
            slope = max(-MAX_SLOPE, min(MAX_SLOPE, slope))
            # Re-anchor the line at the shrunk slope through the points.
            mean_x = sum(p[0] for p in fit["points"]) / fit["n"]
            mean_y = sum(p[1] for p in fit["points"]) / fit["n"]
            line_at_target = mean_y + slope * (x_target - mean_x)
            # Blend the extrapolated line with the last observed rate.
            line_weight = min(0.85, fit["n"] / (fit["n"] + 2.0))
            centre = line_weight * line_at_target + (1.0 - line_weight) * last_lg
            resid_sd = fit["sd"] if fit["n"] > 2 else RESID_PRIOR_SD
            lever = 0.0
            if fit["sxx"] > 1e-12:
                lever = (x_target - fit["mx"]) ** 2 / fit["sxx"]
            pred_factor = math.sqrt(1.0 + 1.0 / fit["n"] + lever)
            pred_factor = min(pred_factor, 2.5)

        # Cap the move from the last rate; platinum may barely rise.
        move = centre - last_lg
        if trophy.get("tier") == "platinum":
            move = max(-MAX_MOVE, min(PLATINUM_MAX_RISE, move))
        else:
            move = max(-MAX_MOVE, min(MAX_MOVE, move))
        centre = last_lg + move

        # Stale page: the next refresh is overdue and dilutes rates, so
        # nudge the median down a little and widen the band.
        centre -= STALE_SHIFT * stale_factor

        sigma = math.sqrt(
            (RW_PER_SQRT_DAY * math.sqrt(horizon_days)) ** 2
            + (resid_sd * pred_factor) ** 2
            + (STALE_SIGMA * stale_factor) ** 2
            + SPREAD_FLOOR ** 2
        )
        sigma = max(SIGMA_MIN, min(SIGMA_MAX, sigma))

        quantiles = []
        prev = None
        for z in NORM_Q:
            value = round4(clip_pct(inv_logit(centre + z * sigma)))
            if prev is not None and value < prev:
                value = prev
            quantiles.append(value)
            prev = value
        rows.append({"id": trophy["id"], "q": quantiles})

    return {"trophies": rows}


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for path in sorted(INPUT_DIR.glob("*.in")):
        case = json.loads(path.read_text(encoding="utf-8"))
        forecast = forecast_case(case)
        out_path = OUTPUT_DIR / (path.stem + ".out")
        out_path.write_text(
            json.dumps(forecast, separators=(",", ":")) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
