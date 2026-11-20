[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/geminigisa/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/geminigisa/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar

Entry for make.fun `token-radar-01` — "Build the best token launch radar".

A program (`main.ts`, Node 22, standard library only) reads a sealed
DefiLlama snapshot and ranks the protocols that record no token by an
implied token value derived only from the snapshot's own figures: TVL, the
seven-day TVL change, and how long the protocol has run with no token.
Every protocol in the snapshot is accounted for (758/758): the board, the
already-traded peer anchors, and the excluded pre-token protocols with a
stated reason.

## The model

```
implied value = TVL × category multiple × growth factor × maturity factor
expected value = implied value × token odds
```

- **Category multiple.** The median market-cap / TVL ratio of token-recorded
  protocols in the same category, shrunk toward the overall median
  (n / (n + 10) weight); categories with fewer than 5 priced peers use the
  overall median. Computed from the snapshot at run time, never hardcoded.
- **Growth factor.** 1 + clamp(7-day TVL change, −30, +30) / 100 × 0.5.
  A change beyond ±300% or a missing value counts as 0 and is flagged.
- **Maturity factor.** 0.90 + 0.10 × min(days tracked, 1095) / 1095;
  unknown age counts as 0.95. Days are counted from the snapshot's frozen
  date and shown as "days tracked", not "days awaiting a token".
- **Out-of-sample validation.** The model is tested live at run time on the
  128 priced peers: a 5-fold held-out cross-validation and two walk-forward
  time splits (cuts 2024-06-30 and 2025-06-30), with MdAPE, MAE-log,
  R²-log and hit rates shown on the dashboard. The honest result: the
  category multiples do not beat the pooled median out of sample, and the
  walk-forward is worse than the random folds — the dashboard says so.
- **Token odds.** The empirical conversion rate of the snapshot's own
  protocols by category and age band (shrunk toward the category, then the
  pooled rate): the probability a pre-token protocol ever records a token.
- **Farm plans.** For every board protocol, a deposit-sized plan net of gas,
  a 0.30% protocol fee and the T-bill opportunity cost over the hold, with
  a two-outcome payoff (token launches vs. never launches) and a verdict:
  FARM (beats the T-bill after all costs), THIN (covers gas and fees but
  not the T-bill), or SKIP. The airdrop is assumed to be 5% of fitted FDV
  shared pro-rata by deposit — a planning assumption, labelled as such.

Farm plans are conditional steps: verify a live points program on the
protocol's official site first; every cost and time in a plan is a planning
assumption, not the protocol's own terms.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

This writes `out/board.json`, `out/data.js`, `out/dashboard/`,
`out/screenshots/` and `out/dossier.json`. The program is deterministic:
two runs on the same snapshot write the same bytes.

## Layout

- `main.ts` — the entrypoint.
- `dashboard/` — `index.html`, `app.js`, `app.css` (no network).
- `screenshots/` — board, detail and filtered views of the dashboard.
- `vendor/makefun-board.ts` — the kit's dossier library, unchanged.
