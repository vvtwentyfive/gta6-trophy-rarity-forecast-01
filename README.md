# GTA VI Trophy Rarity Forecast

![Bounty](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)
![Rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/vvtwentyfive/gta6-trophy-rarity-forecast-01/rank.svg)
![Reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/vvtwentyfive/gta6-trophy-rarity-forecast-01/reward.svg)

A forecaster for GTA VI PlayStation 5 trophy earn rates on Exophase, entered in the
[make.fun bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

## What it does

Given a snapshot of Exophase trophy pages — each trophy's current earn rate and the
history of how that rate has moved since launch — the forecaster predicts what each
trophy's earn rate will be at **2026-11-26T00:00:00Z**. For every trophy it outputs
five quantiles (5%, 25%, 50%, 75%, 95%) of the predicted earn rate, so the forecast
is a full distribution, not a single point guess.

Scoring is mean pinball loss on the logit scale: the quantiles are judged on how
well they cover the true rate and how tight they are, with errors measured after
the logit transform, which treats small rates near 0% fairly instead of letting
them be swamped by the popular trophies.

## How the model works

The model works on the logit scale against log time. For each trophy it defines
`x = ln(1 + hours since 2026-11-19T00:00Z)` — launch — and tracks
`logit(rate)` as a function of `x`.

Exophase pages only refresh every few hours, so most reads of a trophy's history
are exact repeats of the previous read. The history is first collapsed to its
distinct page states, so a stale page that was read ten times counts once, not
ten times.

Then, per trophy:

- A least-squares line of `logit(rate)` on `x` is fitted over the last 48 hours
  of distinct page states. Trophy earn rates drift roughly linearly in log time
  as the player base grows and the early-adopter mix dilutes, so a line in
  `(x, logit(rate))` is the natural shape.
- The fitted slope is shrunk toward the median slope of the trophy's tier
  (trophies of the same rarity tier tend to move together), which keeps a noisy
  short history from producing a wild slope.
- The line is read at the target time and blended with the last observed rate,
  so the forecast never runs far from what was actually seen. The total move
  from the last observed rate is capped at ±1.6 logit.
- The spread around the median combines a random-walk term that grows with the
  square root of the horizon (`0.35·√days`), the residual scatter of the line
  fit, a term for how stale the page is, and a 0.20 logit floor; the total
  spread is capped to the range [0.30, 1.90] logit.
- A stale page also shifts the forecast: if a refresh is overdue, the true
  rates have likely drifted down since the page was last updated (more players
  dilute every rate). That shift is weighted by `min(1, 12h / horizon)`, so it
  matters on a short 90-minute horizon and fades away over the 4.52-day final
  horizon, where the line fit itself carries the drift.

The five quantiles are the median plus/minus the spread scaled by the standard
normal quantiles, mapped back from logit to rate.

## How to run

Requires Python 3 (standard library only — no third-party packages).

```bash
python3 main.py
```

By default the program reads its input from the kit's input directory and writes
`forecast.csv` to the kit's output directory. The directories can be overridden
with environment variables:

```bash
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output python3 main.py
```

Input: the kit-provided snapshot of Exophase trophy histories.
Output: `forecast.csv`, one row per trophy with the five predicted quantiles.

## Validation

All checks below were run against the submitted `main.py` before this entry was
assembled.

| Check | Result |
|---|---|
| Rules worked example | An independent pinball scorer reproduces the competition rules' worked example exactly — loss **0.403404** |
| Practice cases p00 / p01 | Outputs well-formed: 55 rows, monotone quantiles (5% ≤ 25% ≤ 50% ≤ 75% ≤ 95%) |
| Determinism | Byte-identical output across two runs of the same case |
| Speed | ~0.05 s per case |
| vs house starter baseline (flat practice history) | Medians close — mean shift about **−0.13 percentage points** — with an honestly wider 90% band |
| Synthetic refresh backtest (players tracked jumping 638 → 3,868) | Entry **0.9337** vs starter **1.4048** mean pinball loss |
| Self-built rich-history, final-like simulation | Loss **0.1755**, 90% coverage **0.98** |

## Honest caveats

- **No true practice loss can be computed.** The kit ships no practice answers,
  so there is no ground truth to score the practice cases against. The numbers
  above are consistency checks (well-formed output, determinism, closeness to
  the baseline on flat history) and synthetic backtests, not measured practice
  performance.
- **All backtest answers are synthetic.** The refresh backtest and the
  rich-history simulation were built by the author with invented player counts
  and invented true rates; they test that the machinery behaves sensibly when
  history moves, not that it predicts real Exophase rates.
- **The final history is unseen.** The entry is scored on trophy histories up
  to 2026-11-26T00:00:00Z that do not exist yet. Real launch-week behaviour —
  refresh cadence, player influx, trophy difficulty surprises — may differ from
  every simulation above. The caps (±1.6 logit move, spread in [0.30, 1.90])
  and the shrinkage toward tier medians exist precisely to limit the damage
  when it does.

## License

MIT — see [LICENSE](LICENSE).

---

Built for the [GTA VI trophy rarity forecast bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?ref=073t4skd) on make.fun. Follow the author's entries via https://make.fun/r/073t4skd
