# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/vvtwentyfive/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/vvtwentyfive/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts every GTA VI (PS5) trophy's Exophase earn rate at 2026-11-26T00:00:00Z, as five quantiles per trophy (levels 0.05 / 0.25 / 0.5 / 0.75 / 0.95), scored by mean pinball loss on the logit scale. Entry for make.fun's "Forecast how many GTA VI players earn each trophy in week one" bounty ($250 in USDC, 20 places).

## Model

The rate is decomposed as **rate = k / N** — earner count over players tracked — and the two are forecast separately, because launch night showed the story is a denominator explosion, not a drift: every rate fell while the denominator went 638 → 3,868 → 14,028 players, and most earner counts barely moved (11 trophies gained zero new earners; the early-game trophies id 20 / 3 / 21 gained +252 / +94 / +52).

- **N(t) — players tracked.** The history is collapsed into distinct page states (a new state when the players count or any rate changes). With 2+ states, the log-growth rate r comes from first → last state, shrunk toward the 1.70/day prior (prior weight 1 day), plus r × staleness for the freeze since the last state was first seen; the growth rate decays with a 1-day half-life. With 1 state (a frozen launch-night page), a prior log-jump of 1.80 plus the 1.70/day trend, decaying the same way.
- **k(t) — earners per trophy.** Log-growth shrunk toward a prior set by the trophy's launch rate: 0.15/day below a 1.0% launch rate, then 0.15 + 2.5 × (rate − 1.0), capped at 2.9. Earner growth decays with a 0.75-day half-life and is capped at 3.0/day. No new-cohort term: v2 tried one and it hurt (backtest 0.350 with it vs 0.292 without), so earner growth from new joiners is picked up only by the data path when the history shows it.
- **Near-100% trophies** (last rate ≥ 99%, i.e. id 2) are forecast in non-earner space: m = N − k grows only a little, plus 0.00005 × ΔN.
- **Spread (logit scale):** sqrt(0.55² + (0.30 + 0.35√H)² + sK²), sK = 0.30 + 0.25 × min(gK, 2.5), × 0.85 scale, clipped to [0.6, 2.0], and at least 1.2 for near-100% trophies. H is the horizon in days.

## Honest caveat

The N prior (jump 1.80, rate 1.70/day) is calibrated on the same Exophase refreshes the snapshot records (638 → 3,868 → 14,028), so a backtest against that snapshot validates the earner model and the spread, **not the N prior itself**. The N prior's justification is the observed refreshes, not the backtest. The fresh 2026-11-20T05:09Z snapshot (N = 14,028, all 55 rates byte-identical to 19 Nov 22:53Z) shows the page frozen for a further 6 h 16 min — it is evidence of a continued freeze, not of new growth, and it does not extend the N prior. v3's backtest uses the extended horizon (launch-night reads → the 05:09Z snapshot, ~25.6 h) with the v3 snapshot as answers; see the verification log in the work dir for the honest numbers.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. Reads every `*.in` case in the input directory and writes one `<id>.out` per case to the output directory: `{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}`, 55 rows, non-decreasing quantiles in [0, 100], deterministic (byte-identical across runs).

---

<sub>Entered on [make.fun](https://make.fun/?ref=073t4skd&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
