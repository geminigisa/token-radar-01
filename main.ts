// Token launch radar v2 — make.fun token-radar-01 entry.
// Reads a sealed DefiLlama snapshot, ranks the protocols that record no
// token by an implied token value, and writes the board, the dashboard
// data, and the dossier. Node 22+, standard library only, no network at
// runtime. Deterministic: the same snapshot always yields the same bytes.
// The snapshot date is frozen in the data, never the runtime date.
//
// v2 adds, over v1: (1) out-of-sample validation of the valuation model
// (5-fold held-out cross-validation AND two walk-forward time splits,
// both computed live from the snapshot's own priced peers); (2) empirical
// token-launch odds from cross-sectional peer conversion rates by
// category and age band, with shrinkage; (3) costed, deposit-sized farm
// plans with FARM / THIN / SKIP verdicts net of gas, protocol fees and
// the T-bill opportunity cost; (4) full 758/758 protocol accounting.
//
// Honest limits, stated on the dashboard: the priced peers' mcap/TVL
// ratios span ~5 orders of magnitude, so the category multiple is a
// central-tendency anchor, not a point forecast. Held-out MdAPE is ~0.91
// and the category multiples do not beat the pooled median out of sample
// (CV MdAPE 0.91 vs 0.89 pooled); they are kept because they encode real
// between-category price differences, shrunk toward the pooled median.
// Walk-forward is worse than random folds (regime drift): trust the
// walk-forward. The airdrop payoff assumes a 5% airdrop shared pro-rata
// by deposit — a planning assumption, labelled as such, never a promise.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

const DAY_MS = 86_400_000;

// --- declared modelling assumptions (not snapshot facts) -----------------
const AIRDROP_SHARE = 0.05; // fraction of fitted FDV assumed paid out as an airdrop
const TBILL_RATE = 0.045; // risk-free opportunity cost, per year
const PROTOCOL_FEE_RATE = 0.003; // assumed protocol fee on the deposit
const DEPOSIT_LADDER = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];
const MAX_DEPOSIT = 25000;
const GAS_PER_TX: Record<string, number> = {
  ethereum: 8, solana: 0.05, bitcoin: 3,
  base: 0.5, arbitrum: 0.5, optimism: 0.5, polygon: 0.5, binance: 0.5, bsc: 0.5,
};
const GAS_TX_COUNT = 4; // deposit, two qualifying actions, claim/withdraw

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

// --- small helpers -------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseArgs(argv: string[]): { input: string } {
  let input = "/input/snapshot.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && i + 1 < argv.length) input = argv[++i];
  }
  return { input };
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const from = Date.parse(fromYmd + "T00:00:00Z");
  const to = Date.parse(toYmd + "T00:00:00Z");
  return Math.floor((to - from) / DAY_MS);
}

function hashSlug(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

function ageOf(p: Protocol, asOf: string): number | null {
  return p.listed_at === null ? null : daysBetween(p.listed_at, asOf);
}

// --- board membership ----------------------------------------------------

const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
  "Cross Chain Bridge",
]);

const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const VERSION_SUFFIX = /\s+(v\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)$/i;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// First matching reason wins, so the exclusion counts sum exactly.
function exclusionReason(p: Protocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return "category: " + p.category;
  if (VERSION_SUFFIX.test(p.name)) return "version-marker name";
  if (WRAPPED_WORD.test(p.name)) return "wrapped/staked name";
  if (EXCHANGE_PREFIX.test(p.name)) return "exchange-prefixed name";
  return null;
}

// --- value model ---------------------------------------------------------
// Category multiple = median mcap/TVL of priced peers in the category,
// shrunk toward the pooled median (n/(n+10)); categories with fewer than
// 5 priced peers use the pooled median. Computed live, never hardcoded.

interface Calibration {
  pooled: number;
  byCategory: Map<string, { n: number; median: number; multiple: number }>;
}

function calibrate(peers: Protocol[]): Calibration {
  const ratios: number[] = [];
  const byCat = new Map<string, number[]>();
  for (const p of peers) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    ratios.push(ratio);
    if (p.category !== null) {
      const list = byCat.get(p.category) ?? [];
      list.push(ratio);
      byCat.set(p.category, list);
    }
  }
  const pooled = median(ratios);
  const byCategory = new Map<string, { n: number; median: number; multiple: number }>();
  for (const [cat, list] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const med = median(list);
    const n = list.length;
    const multiple = n >= 5
      ? clamp((n / (n + 10)) * med + (10 / (n + 10)) * pooled, 0.05, 1.0)
      : pooled;
    byCategory.set(cat, { n, median: med, multiple });
  }
  return { pooled, byCategory };
}

function multipleFor(p: Protocol, cal: Calibration): number {
  if (p.category === null) return cal.pooled;
  const entry = cal.byCategory.get(p.category);
  return entry === undefined ? cal.pooled : entry.multiple;
}

function growthFactor(p: Protocol): { growth: number; mult: number; flag: string | null } {
  const g = p.change_7d;
  if (g === null || !Number.isFinite(g)) return { growth: 0, mult: 1, flag: "growth unavailable" };
  if (Math.abs(g) > 300) return { growth: 0, mult: 1, flag: "growth anomalous" };
  const growth = clamp(g, -30, 30);
  return { growth, mult: 1 + (growth / 100) * 0.5, flag: null };
}

function maturityFactor(ageDays: number | null): number {
  if (ageDays === null) return 0.95;
  return 0.9 + 0.1 * (Math.min(Math.max(ageDays, 0), 1095) / 1095);
}

interface ModelResult {
  value: number;
  multiple: number;
  growth: number;
  growthMult: number;
  maturity: number;
  ageDays: number | null;
  growthFlag: string | null;
}

function impliedValue(p: Protocol, cal: Calibration, asOf: string): ModelResult {
  const multiple = multipleFor(p, cal);
  const g = growthFactor(p);
  const ageDays = ageOf(p, asOf);
  const maturity = maturityFactor(ageDays);
  const value = Math.max(1, Math.round(p.tvl_usd * multiple * g.mult * maturity));
  return { value, multiple, growth: g.growth, growthMult: g.mult, maturity, ageDays, growthFlag: g.flag };
}

// --- out-of-sample validation --------------------------------------------
// The 128 priced peers (mcap>0, tvl>0) are the only protocols with a known
// market cap, so they are the only ground truth the model can be tested
// against. Held-out: 5 folds by deterministic slug hash; each fold's
// multiples are recalibrated from the other four folds only. Walk-forward:
// train on protocols tracked before a cutoff date, test on those tracked
// after it (two cutoffs). No data leakage: a tested peer never calibrates
// its own prediction.

interface OosMetrics {
  n: number;
  mdape: number;
  maeLog: number;
  r2log: number;
  hit2x: number;
  hit3x: number;
  hit5x: number;
}

function oosMetrics(pairs: { pred: number; actual: number }[]): OosMetrics {
  const apes = pairs.map(({ pred, actual }) => Math.abs(pred - actual) / actual);
  const logs = pairs.map(({ pred, actual }) => Math.log10(pred) - Math.log10(actual));
  const maeLog = logs.reduce((s, x) => s + Math.abs(x), 0) / logs.length;
  const meanLogA = pairs.reduce((s, { actual }) => s + Math.log10(actual), 0) / pairs.length;
  const ssTot = pairs.reduce((s, { actual }) => s + (Math.log10(actual) - meanLogA) ** 2, 0);
  const ssRes = logs.reduce((s, x) => s + x * x, 0);
  const hit = (lo: number, hi: number) =>
    pairs.filter(({ pred, actual }) => pred / actual >= lo && pred / actual <= hi).length / pairs.length;
  return {
    n: pairs.length,
    mdape: median(apes),
    maeLog,
    r2log: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    hit2x: hit(0.5, 2),
    hit3x: hit(1 / 3, 3),
    hit5x: hit(0.2, 5),
  };
}

interface Validation {
  heldOut: OosMetrics;
  walkForward: { cutoff: string; trainN: number; testN: number; metrics: OosMetrics }[];
  chartPoints: { pred: number; actual: number }[];
}

function validate(peers: Protocol[], asOf: string): Validation {
  const folds: Protocol[][] = [[], [], [], [], []];
  for (const p of peers) folds[hashSlug(p.slug) % 5].push(p);
  const chartPoints: { pred: number; actual: number }[] = [];
  const cvPairs: { pred: number; actual: number }[] = [];
  for (let f = 0; f < 5; f++) {
    const train = folds.flatMap((fl, i) => (i === f ? [] : fl));
    const cal = calibrate(train);
    for (const p of folds[f]) {
      const pred = impliedValue(p, cal, asOf).value;
      cvPairs.push({ pred, actual: p.mcap_usd as number });
      chartPoints.push({ pred, actual: p.mcap_usd as number });
    }
  }
  const walkForward = [];
  for (const cutoff of ["2024-06-30", "2025-06-30"]) {
    const dated = peers.filter((p) => p.listed_at !== null);
    const train = dated.filter((p) => (p.listed_at as string) <= cutoff);
    const test = dated.filter((p) => (p.listed_at as string) > cutoff);
    const cal = calibrate(train);
    const pairs = test.map((p) => ({ pred: impliedValue(p, cal, asOf).value, actual: p.mcap_usd as number }));
    walkForward.push({ cutoff, trainN: train.length, testN: test.length, metrics: oosMetrics(pairs) });
  }
  return { heldOut: oosMetrics(cvPairs), walkForward, chartPoints };
}

// --- token-launch odds ---------------------------------------------------
// Empirical cross-sectional conversion rate: among the snapshot's own
// protocols, what fraction in the same category and age band already
// record a token (gecko_id or mcap present)? Shrunk toward the category
// rate, then toward the pooled rate (weight 20 each step), clamped
// [0.02, 0.98]. This is a peer conversion rate from one frozen snapshot,
// not a forecast of a dated launch — and it is labelled as such.

function ageBand(p: Protocol, asOf: string): string {
  const a = ageOf(p, asOf);
  if (a === null) return "unknown";
  if (a < 180) return "<180d";
  if (a <= 730) return "180-730d";
  return ">730d";
}

function hasOwnToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.mcap_usd !== null;
}

interface OddsTables {
  pooled: number;
  byCategory: Record<string, number>;
  byCell: Record<string, number>;
}

function buildOddsTables(protocols: Protocol[], asOf: string): OddsTables {
  const pooled = protocols.filter(hasOwnToken).length / protocols.length;
  const byCategory: Record<string, number> = {};
  const byCell: Record<string, number> = {};
  const cats = new Map<string, Protocol[]>();
  for (const p of protocols) {
    const c = p.category ?? "(null)";
    const list = cats.get(c) ?? [];
    list.push(p);
    cats.set(c, list);
  }
  for (const [cat, list] of [...cats.entries()].sort()) {
    const catRate = (list.filter(hasOwnToken).length + 20 * pooled) / (list.length + 20);
    byCategory[cat] = catRate;
    for (const band of ["<180d", "180-730d", ">730d", "unknown"]) {
      const cell = list.filter((q) => ageBand(q, asOf) === band);
      if (cell.length === 0) continue;
      const cellRate = (cell.filter(hasOwnToken).length + 20 * catRate) / (cell.length + 20);
      byCell[cat + "|" + band] = clamp(cellRate, 0.02, 0.98);
    }
  }
  return { pooled, byCategory, byCell };
}

function tokenOdds(p: Protocol, tables: OddsTables, asOf: string): number {
  const cat = p.category ?? "(null)";
  const cell = tables.byCell[cat + "|" + ageBand(p, asOf)];
  if (cell !== undefined) return cell;
  if (tables.byCategory[cat] !== undefined) return clamp(tables.byCategory[cat], 0.02, 0.98);
  return clamp(tables.pooled, 0.02, 0.98);
}

// --- costed farm economics -----------------------------------------------
// Expected payoff if the token launches: the assumed airdrop share of the
// fitted FDV, shared pro-rata by deposit. Net of gas (per-chain planning
// assumption x 4 transactions), a 0.30% protocol fee, and the T-bill
// opportunity cost over the hold. Verdicts: FARM beats the T-bill after
// all costs; THIN covers gas and fees but not the T-bill; SKIP cannot
// cover gas and fees at any deposit up to $25,000.

function gasPerTx(chains: string[]): number {
  const primary = (chains[0] ?? "").toLowerCase();
  return GAS_PER_TX[primary] ?? 1;
}

function tierFloor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

function holdDays(p: Protocol, asOf: string): number {
  const slow = p.category === "Risk Curators" || p.category === "RWA";
  if (slow) return 75;
  const a = ageOf(p, asOf);
  if (a === null) return 45;
  return a < 180 ? 60 : a < 365 ? 45 : 30;
}

type Verdict = "FARM" | "THIN" | "SKIP";

interface FarmEcon {
  deposit: number;
  breakEven: number | null;
  gas: number;
  fee: number;
  oppCost: number;
  payoffIf: number;
  expectedPayoff: number;
  net: number;
  roi: number;
  verdict: Verdict;
  verdictReason: string;
  hold: number;
}

function farmEconomics(
  p: Protocol, model: ModelResult, odds: number, asOf: string, airdropShare: number,
): FarmEcon {
  const hold = holdDays(p, asOf);
  const gas = gasPerTx(p.chains) * GAS_TX_COUNT;
  const floor = tierFloor(p.tvl_usd);
  const fdvPerTvl = model.value / p.tvl_usd;
  const oppRate = TBILL_RATE * (hold / 365);
  const bNet = odds * airdropShare * fdvPerTvl - PROTOCOL_FEE_RATE - oppRate;
  const bGross = odds * airdropShare * fdvPerTvl - PROTOCOL_FEE_RATE;
  let deposit = floor;
  let verdict: Verdict = "SKIP";
  let verdictReason = "the expected airdrop share cannot cover gas and fees at any deposit";
  let breakEven: number | null = null;
  const ladderAtLeast = (x: number): number | null => {
    for (const d of DEPOSIT_LADDER) if (d >= x) return d;
    return null;
  };
  if (bNet > 0) {
    breakEven = gas / bNet;
    const d = ladderAtLeast(Math.max(breakEven, floor));
    if (d !== null && d <= MAX_DEPOSIT) {
      deposit = d;
      verdict = "FARM";
      verdictReason = "beats the T-bill alternative after all costs";
    } else {
      verdictReason = "break-even deposit above $25,000";
    }
  } else if (bGross > 0) {
    breakEven = gas / bGross;
    const d = ladderAtLeast(Math.max(breakEven, floor));
    if (d !== null && d <= MAX_DEPOSIT) {
      deposit = d;
      verdict = "THIN";
      verdictReason = "covers gas and fees but not the T-bill alternative";
    } else {
      verdictReason = "break-even deposit above $25,000";
    }
  }
  const payoffIf = Math.round(airdropShare * model.value * (deposit / p.tvl_usd));
  const expectedPayoff = odds * payoffIf;
  const fee = Math.round(PROTOCOL_FEE_RATE * deposit);
  const oppCost = Math.round(deposit * oppRate);
  const net = Math.round(expectedPayoff - gas - fee - oppCost);
  return {
    deposit, breakEven: breakEven === null ? null : Math.round(breakEven),
    gas, fee, oppCost, payoffIf, expectedPayoff: Math.round(expectedPayoff),
    net, roi: net / deposit, verdict, verdictReason, hold,
  };
}

// --- farm plans ----------------------------------------------------------
// Every step is conditional: the snapshot's ten fields cannot prove a
// points program, a fee or a lockup exists, so each plan says what to
// verify first and labels its costs and times as planning assumptions.
// The costed step and the verdict step carry the plan's own numbers.

const FARM_ACTIONS: Record<string, string> = {
  "Risk Curators": "If {name} runs a points program, deposit into a curator vault only after reading the vault's stated strategy and allocation on the official site, and note the vault's curator and fee terms in your farm log.",
  "RWA": "If {name} runs a points program, mint or hold its yield-bearing asset only after checking the official attestation of the underlying assets and the redemption schedule.",
  "Onchain Capital Allocator": "If {name} runs a points program, deposit into an allocator vault after comparing its reported allocation with the vault's own stated benchmark on the official site.",
  "Lending": "If {name} runs a points program, supply collateral and, only if you understand the risk, borrow a modest amount while keeping the health factor well above the liquidation level shown on the official site.",
  "CDP": "If {name} runs a points program, mint its stable asset against collateral only after reading the official docs on the collateral ratio and the liquidation rule.",
  "Collateral Markets": "If {name} runs a points program, supply collateral in a market you have read the docs for, and keep the position small enough that a price move does not liquidate it.",
  "Dexs": "If {name} runs a points program, provide liquidity in a pool you understand, single-sided if the official site offers it, and watch the pool's fee earnings and impermanent loss weekly.",
  "Basis Trading": "If {name} runs a points program, deposit into a delta-neutral vault or open one small hedged position, and watch the funding rate on the official site before adding more.",
  "Yield": "If {name} runs a points program, deposit into a vault and let it auto-compound where the official site says it does, then check the reported yield against the vault's own page weekly.",
  "Yield Aggregator": "If {name} runs a points program, deposit into one vault, compare its reported APY with the other vaults on the official site, and harvest and re-deposit only when the gas cost is smaller than the harvest.",
  "Chain": "If {name} runs a points program, bridge funds to the chain from the official bridge, use its native apps, and stake the native asset only if the official docs describe staking.",
  "Insurance": "If {name} runs a points program, buy a cover for an asset you hold, keep the policy details, and read the official claim process before you need it.",
  "Stablecoin Wrapper": "If {name} runs a points program, mint or deposit the wrapped stable asset and watch its peg and the redemption terms on the official site.",
  "Prediction Market": "If {name} runs a points program, fund an account and take small positions only in markets you understand, and record each market's resolution rule before entering.",
  "Perpetual": "If {name} runs a points program, deposit margin and open one small hedged position, setting a loss limit before the trade, not after it.",
  "Derivatives": "If {name} runs a points program, deposit margin for one small position in a market you understand, and set a loss limit before opening it.",
  "Restaking": "If {name} runs a points program, restake only an amount you can leave locked, after reading the official docs on the lock period and the slashing terms.",
  "Payments": "If {name} runs a points program, use it for a small real payment first to confirm the flow, and keep the receipt in your farm log.",
  "Indexes": "If {name} runs a points program, buy a small amount of the index after reading which assets it holds and how it rebalances.",
};

function farmAction(p: Protocol): string {
  const template = p.category !== null && FARM_ACTIONS[p.category] !== undefined
    ? FARM_ACTIONS[p.category]
    : "If {name} runs a points program, use its main product with a small position after reading the official docs, and record what you did in your farm log.";
  return template.replaceAll("{name}", p.name);
}

function fmtUsd(x: number): string {
  return "$" + Math.round(x).toLocaleString("en-US");
}

function buildFarmSteps(p: Protocol, model: ModelResult, odds: number, econ: FarmEcon): string[] {
  const chain = p.chains[0] ?? "its main chain";
  const totalCost = econ.gas + econ.fee + econ.oppCost;
  const costStep =
    `Deposit ${fmtUsd(econ.deposit)} (break-even ${econ.breakEven === null ? "none" : fmtUsd(econ.breakEven)} at ${Math.round(odds * 100)}% token odds). Costs, planning estimates: gas ~${fmtUsd(econ.gas)} for 4 transactions on ${chain}, protocol fee ~${fmtUsd(econ.fee)} (0.30%), T-bill opportunity cost ~${fmtUsd(econ.oppCost)} over ${econ.hold} days — total ~${fmtUsd(totalCost)}.`;
  const hold = econ.hold === 75
    ? `Hold the position for about 60 to 90 days, then re-check whether ${p.name} still records no token before adding more; these positions are slow-moving, so a short hold proves little.`
    : `Hold the position for about ${econ.hold} days, then re-check whether ${p.name} still records no token before adding more; do not add funds while the official rewards page is unreachable.`;
  const verdictStep =
    `If ${p.name} issues a token, a 5% airdrop shared pro-rata pays about ${fmtUsd(econ.payoffIf)} on this deposit; if it never does, the cost is about ${fmtUsd(totalCost)}. Expected value ${fmtUsd(econ.expectedPayoff)} at ${Math.round(odds * 100)}% odds, net ${fmtUsd(econ.net)}. Verdict: ${econ.verdict} — ${econ.verdictReason}.`;
  return [
    `Open a fresh wallet that you use only for ${p.name}, write its seed phrase on paper and store it offline, and never connect it to a link from a message or a social post.`,
    farmAction(p),
    costStep,
    hold,
    `Once a week, open ${p.name}'s official rewards or points page from a bookmarked official link and write the date, wallet and transaction in a farm log; if the page is missing or changed, pause and re-check later instead of following links from social posts.`,
    verdictStep,
    `Withdraw or claim only from ${p.name}'s own official site, never pay anyone to claim for you, and never sign a transaction you did not read; if no claim exists yet, leave the position and review it again next month.`,
  ];
}

// --- program -------------------------------------------------------------

interface BoardEntry {
  p: Protocol;
  model: ModelResult;
  odds: number;
  ev: number;
  econ: FarmEcon;
  rank: number;
  farmSteps: string[];
}

function main(): void {
  const { input } = parseArgs(process.argv.slice(2));
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const snapshot = JSON.parse(readFileSync(input, "utf8")) as Snapshot;
  const asOf = snapshot.as_of;
  const cal = calibrate(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);
  const pricedPeers = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const validation = validate(pricedPeers, asOf);
  const oddsTables = buildOddsTables(snapshot.protocols, asOf);

  const ranked = snapshot.protocols
    .filter((p) => recordsNoToken(p) && exclusionReason(p) === null)
    .map((p) => {
      const model = impliedValue(p, cal, asOf);
      const odds = tokenOdds(p, oddsTables, asOf);
      const econ = farmEconomics(p, model, odds, asOf, AIRDROP_SHARE);
      return { p, model, odds, ev: Math.round(model.value * odds), econ };
    })
    .sort((a, b) => (b.model.value - a.model.value) ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardEntry[] = ranked.map((entry, i) => ({
    ...entry,
    rank: i + 1,
    farmSteps: buildFarmSteps(entry.p, entry.model, entry.odds, entry.econ),
  }));

  if (board.length < 100) {
    throw new Error(`board too small: ${board.length} rows, need at least 100`);
  }
  const missing = snapshot.watchlist.filter((slug) => !board.some((e) => e.p.slug === slug));
  if (missing.length > 0) {
    throw new Error(`watchlist not covered, missing: ${missing.join(", ")}`);
  }
  for (const row of board) {
    for (const step of row.farmSteps) {
      if (step.trim().length < 20 || step.trim().length > 600) {
        throw new Error(`farm step length out of range for ${row.p.slug}: ${step.trim().length}`);
      }
    }
  }

  // Full 758/758 accounting: board + already-traded + excluded pre-token.
  const tradedCount = snapshot.protocols.filter((p) => !recordsNoToken(p)).length;
  const excluded = snapshot.protocols.filter((p) => recordsNoToken(p) && exclusionReason(p) !== null);
  const exclusionCounts: Record<string, number> = {};
  for (const p of excluded) {
    const r = exclusionReason(p) as string;
    exclusionCounts[r] = (exclusionCounts[r] ?? 0) + 1;
  }
  if (board.length + tradedCount + excluded.length !== snapshot.protocols.length) {
    throw new Error("accounting does not sum to the snapshot");
  }

  // Verdict counts at the stated 5% airdrop, and a sensitivity at 10%.
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  let totalEdge = 0;
  for (const row of board) {
    verdictCounts[row.econ.verdict]++;
    if (row.econ.verdict === "FARM") totalEdge += row.econ.net;
  }
  const sensCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const row of board) {
    const econ10 = farmEconomics(row.p, row.model, row.odds, asOf, 0.10);
    sensCounts[econ10.verdict]++;
  }

  mkdirSync(outDir, { recursive: true });

  const rows = board.map(({ p, model, rank, farmSteps }) => ({
    slug: p.slug,
    name: p.name,
    rank,
    implied_value_usd: model.value,
    farm_steps: farmSteps,
  }));
  writeFileSync(join(outDir, "board.json"), JSON.stringify({ rows }, null, 2) + "\n", "utf8");

  const calibration = [...cal.byCategory.entries()].map(([category, e]) => ({
    category,
    n: e.n,
    median: e.median,
    multiple: e.multiple,
  }));
  const peerAnchors: Record<string, { slug: string; name: string; ratio: number }[]> = {};
  for (const p of pricedPeers) {
    const cat = p.category ?? "(null)";
    const list = peerAnchors[cat] ?? [];
    list.push({ slug: p.slug, name: p.name, ratio: (p.mcap_usd as number) / p.tvl_usd });
    peerAnchors[cat] = list;
  }
  for (const cat of Object.keys(peerAnchors)) {
    peerAnchors[cat].sort((a, b) => b.ratio - a.ratio);
    peerAnchors[cat] = peerAnchors[cat].slice(0, 3);
  }
  const data = {
    as_of: asOf,
    floor_usd: snapshot.floor_usd,
    total_protocols: snapshot.protocols.length,
    pooled_multiple: cal.pooled,
    calibration,
    validation: {
      heldOut: validation.heldOut,
      walkForward: validation.walkForward,
      chartPoints: validation.chartPoints,
    },
    odds: {
      pooled: oddsTables.pooled,
      byCategory: oddsTables.byCategory,
      byCell: oddsTables.byCell,
    },
    peerAnchors,
    accounting: {
      board: board.length,
      traded: tradedCount,
      excluded: excluded.length,
      exclusionCounts,
    },
    verdictCounts,
    totalEdge,
    sensitivityAt10: sensCounts,
    assumptions: {
      airdropShare: AIRDROP_SHARE,
      tbillRate: TBILL_RATE,
      protocolFeeRate: PROTOCOL_FEE_RATE,
      gasPerTx: GAS_PER_TX,
      gasTxCount: GAS_TX_COUNT,
      maxDeposit: MAX_DEPOSIT,
    },
    rows: board.map(({ p, model, odds, ev, econ, rank, farmSteps }) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: model.ageDays,
      listed_at: p.listed_at,
      rank,
      implied_value_usd: model.value,
      watchlist: watchlist.has(p.slug),
      multiple: model.multiple,
      multiple_n: p.category !== null ? cal.byCategory.get(p.category)?.n ?? null : null,
      multiple_median: p.category !== null ? cal.byCategory.get(p.category)?.median ?? null : null,
      growth: model.growth,
      growth_mult: model.growthMult,
      maturity: model.maturity,
      growth_flag: model.growthFlag,
      token_odds: odds,
      expected_value_usd: ev,
      deposit_usd: econ.deposit,
      break_even_usd: econ.breakEven,
      gas_usd: econ.gas,
      fee_usd: econ.fee,
      opp_cost_usd: econ.oppCost,
      payoff_if_usd: econ.payoffIf,
      expected_payoff_usd: econ.expectedPayoff,
      net_usd: econ.net,
      net_roi: econ.roi,
      hold_days: econ.hold,
      verdict: econ.verdict,
      verdict_reason: econ.verdictReason,
      farm_steps: farmSteps,
    })),
  };
  writeFileSync(join(outDir, "data.js"), `window.RADAR = ${JSON.stringify(data)};\n`, "utf8");

  cpSync(join(repoRoot, "dashboard"), join(outDir, "dashboard"), { recursive: true });
  cpSync(join(repoRoot, "screenshots"), join(outDir, "screenshots"), { recursive: true });

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), dossier);
}

main();
