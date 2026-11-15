// Token launch radar — make.fun token-radar-01 entry (v1).
// Reads a sealed DefiLlama snapshot, ranks the protocols that record no
// token by an implied token value derived only from the snapshot's own
// figures (TVL, seven-day TVL change, days tracked), and writes the board,
// the dashboard data, and the dossier. Node 22+, standard library only,
// no network at runtime. Deterministic: the same snapshot always yields
// the same bytes. The snapshot date is frozen in the data, never the
// runtime date.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

const DAY_MS = 86_400_000;

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

// The house's own watchlist rule, applied to the whole board (RULES.txt):
// a wrapped, staked or bridged product of a protocol whose token already
// trades is not a launch candidate, whatever its TVL.
function isExcluded(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  return false;
}

// --- value model (STUDY.md section 9.4, revised after the second-brain
// consult: category multiples with shrinkage, winsorized growth with an
// anomaly flag, and a small monotonic maturity premium) --------------------

interface Calibration {
  pooled: number;
  byCategory: Map<string, { n: number; median: number; multiple: number }>;
}

function calibrate(protocols: Protocol[]): Calibration {
  const ratios: number[] = [];
  const byCat = new Map<string, number[]>();
  for (const p of protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
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
  const ageDays = p.listed_at === null ? null : daysBetween(p.listed_at, asOf);
  const maturity = maturityFactor(ageDays);
  const value = Math.max(1, Math.round(p.tvl_usd * multiple * g.mult * maturity));
  return { value, multiple, growth: g.growth, growthMult: g.mult, maturity, ageDays, growthFlag: g.flag };
}

// --- farm plans ----------------------------------------------------------
// Every step is conditional: the snapshot's ten fields cannot prove a
// points program, a fee or a lockup exists, so each plan says what to
// verify first and labels its costs and times as planning assumptions.

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

function capitalTier(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

function gasEstimate(chains: string[]): string {
  const primary = (chains[0] ?? "").toLowerCase();
  if (primary === "ethereum") return "$5–15";
  if (primary === "solana") return "about $0.01";
  if (primary === "bitcoin") return "$1–5";
  if (["base", "arbitrum", "optimism", "polygon", "binance", "bsc"].includes(primary)) return "$0.10–1";
  return "under $1";
}

function buildFarmSteps(p: Protocol, ageDays: number | null): string[] {
  const capital = capitalTier(p.tvl_usd);
  const gas = gasEstimate(p.chains);
  const chain = p.chains[0] ?? "its main chain";
  const slow = p.category === "Risk Curators" || p.category === "RWA";
  let hold: string;
  if (slow) {
    hold = `Hold the position for about 60 to 90 days, then re-check whether ${p.name} still records no token before adding more; these positions are slow-moving, so a short hold proves little.`;
  } else {
    const days = ageDays === null ? 45 : ageDays < 180 ? 60 : ageDays < 365 ? 45 : 30;
    hold = `Hold the position for about ${days} days, then re-check whether ${p.name} still records no token before adding more; do not add funds while the official rewards page is unreachable.`;
  }
  return [
    `Open a fresh wallet that you use only for ${p.name}, write its seed phrase on paper and store it offline, and never connect it to a link from a message or a social post.`,
    farmAction(p),
    `Plan about $${capital} of capital and roughly ${gas} in gas per transaction on ${chain} — planning estimates, not the protocol's fees — and keep the amount small enough that losing it would not hurt.`,
    hold,
    `Once a week, open ${p.name}'s official rewards or points page from a bookmarked official link and write the date, wallet and transaction in a farm log; if the page is missing or changed, pause and re-check later instead of following links from social posts.`,
    `Withdraw or claim only from ${p.name}'s own official site, never pay anyone to claim for you, and never sign a transaction you did not read; if no claim exists yet, leave the position and review it again next month.`,
  ];
}

// --- program -------------------------------------------------------------

interface BoardEntry {
  p: Protocol;
  model: ModelResult;
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

  const ranked = snapshot.protocols
    .filter((p) => recordsNoToken(p) && !isExcluded(p))
    .map((p) => ({ p, model: impliedValue(p, cal, asOf) }))
    .sort((a, b) => (b.model.value - a.model.value) ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardEntry[] = ranked.map((entry, i) => ({
    ...entry,
    rank: i + 1,
    farmSteps: buildFarmSteps(entry.p, entry.model.ageDays),
  }));

  if (board.length < 100) {
    throw new Error(`board too small: ${board.length} rows, need at least 100`);
  }
  const missing = snapshot.watchlist.filter((slug) => !board.some((e) => e.p.slug === slug));
  if (missing.length > 0) {
    throw new Error(`watchlist not covered, missing: ${missing.join(", ")}`);
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
  const data = {
    as_of: asOf,
    floor_usd: snapshot.floor_usd,
    pooled_multiple: cal.pooled,
    calibration,
    rows: board.map(({ p, model, rank, farmSteps }) => ({
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
