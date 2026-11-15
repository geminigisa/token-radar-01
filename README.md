# Token Launch Radar

Entry for make.fun `token-radar-01` — "Build the best token launch radar".

A program (`main.ts`, Node 22, standard library only) reads a sealed
DefiLlama snapshot and ranks the protocols that record no token by an
implied token value derived only from the snapshot's own figures: TVL, the
seven-day TVL change, and how long the protocol has run with no token.

## The model

```
implied value = TVL × category multiple × growth factor × maturity factor
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

The board holds every protocol that records no token and is not a wrapped,
staked or bridged product of a protocol whose token already trades (the
house's own watchlist rule, applied to the whole board). Farm plans are
conditional steps: verify a live points program on the protocol's official
site first; every cost and time in a plan is a planning assumption.

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
