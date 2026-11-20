// Launch Radar — dashboard.
// Renders window.RADAR (written by main.ts). Pure functions first: the
// model recompute, the token-odds lookup, the farm economics and the
// farm-plan derivation live here in the source so the detail view shows
// code and screenshot agreeing, and the page can verify its own numbers
// against the board. No network: no imports, no fetches, no external
// addresses anywhere in this file.

var R = window.RADAR;
var A = R.assumptions;

function fmtUsd(x) {
  return "$" + Math.round(x).toLocaleString("en-US");
}

function fmtPct(x) {
  if (x === null || x === undefined) return "—";
  return (x > 0 ? "+" : "") + x.toFixed(2) + "%";
}

function fmtDays(ageDays) {
  if (ageDays === null || ageDays === undefined) return "unknown";
  return ageDays + " days";
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// --- model recompute (same formula as main.ts) -----------------------------

function multipleFor(row) {
  if (!row.category) return R.pooled_multiple;
  var entry = null;
  for (var i = 0; i < R.calibration.length; i++) {
    if (R.calibration[i].category === row.category) { entry = R.calibration[i]; break; }
  }
  return entry ? entry.multiple : R.pooled_multiple;
}

function growthFactor(row) {
  var g = row.change_7d;
  if (g === null || g === undefined || !isFinite(g)) return { growth: 0, mult: 1, flag: "growth unavailable" };
  if (Math.abs(g) > 300) return { growth: 0, mult: 1, flag: "growth anomalous" };
  var growth = clamp(g, -30, 30);
  return { growth: growth, mult: 1 + (growth / 100) * 0.5, flag: null };
}

function maturityFactor(ageDays) {
  if (ageDays === null || ageDays === undefined) return 0.95;
  return 0.9 + 0.1 * (Math.min(Math.max(ageDays, 0), 1095) / 1095);
}

function impliedValue(row) {
  var multiple = multipleFor(row);
  var g = growthFactor(row);
  var maturity = maturityFactor(row.age_days);
  var value = Math.max(1, Math.round(row.tvl_usd * multiple * g.mult * maturity));
  return { value: value, multiple: multiple, growth: g.growth, growthMult: g.mult, maturity: maturity, flag: g.flag };
}

// --- token odds (same lookup as main.ts) -----------------------------------

function ageBand(row) {
  var a = row.age_days;
  if (a === null || a === undefined) return "unknown";
  if (a < 180) return "<180d";
  if (a <= 730) return "180-730d";
  return ">730d";
}

function tokenOdds(row) {
  var cat = row.category || "(null)";
  var cell = R.odds.byCell[cat + "|" + ageBand(row)];
  if (cell !== undefined) return cell;
  if (R.odds.byCategory[cat] !== undefined) return clamp(R.odds.byCategory[cat], 0.02, 0.98);
  return clamp(R.odds.pooled, 0.02, 0.98);
}

// --- farm economics (same derivation as main.ts) ---------------------------

var LADDER = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];

function gasPerTx(chains) {
  var primary = (chains[0] || "").toLowerCase();
  if (A.gasPerTx[primary] !== undefined) return A.gasPerTx[primary];
  return 1;
}

function tierFloor(tvl) {
  if (tvl >= 1000000000) return 250;
  if (tvl >= 250000000) return 150;
  if (tvl >= 100000000) return 100;
  return 50;
}

function holdDays(row) {
  var slow = row.category === "Risk Curators" || row.category === "RWA";
  if (slow) return 75;
  var a = row.age_days;
  if (a === null || a === undefined) return 45;
  return a < 180 ? 60 : a < 365 ? 45 : 30;
}

function farmEconomics(row, model, odds) {
  var hold = holdDays(row);
  var gas = gasPerTx(row.chains) * A.gasTxCount;
  var floor = tierFloor(row.tvl_usd);
  var fdvPerTvl = model.value / row.tvl_usd;
  var oppRate = A.tbillRate * (hold / 365);
  var bNet = odds * A.airdropShare * fdvPerTvl - A.protocolFeeRate - oppRate;
  var bGross = odds * A.airdropShare * fdvPerTvl - A.protocolFeeRate;
  var deposit = floor;
  var verdict = "SKIP";
  var verdictReason = "the expected airdrop share cannot cover gas and fees at any deposit";
  var breakEven = null;
  function ladderAtLeast(x) {
    for (var i = 0; i < LADDER.length; i++) if (LADDER[i] >= x) return LADDER[i];
    return null;
  }
  if (bNet > 0) {
    breakEven = gas / bNet;
    var d = ladderAtLeast(Math.max(breakEven, floor));
    if (d !== null && d <= A.maxDeposit) {
      deposit = d;
      verdict = "FARM";
      verdictReason = "beats the T-bill alternative after all costs";
    } else {
      verdictReason = "break-even deposit above $25,000";
    }
  } else if (bGross > 0) {
    breakEven = gas / bGross;
    var d2 = ladderAtLeast(Math.max(breakEven, floor));
    if (d2 !== null && d2 <= A.maxDeposit) {
      deposit = d2;
      verdict = "THIN";
      verdictReason = "covers gas and fees but not the T-bill alternative";
    } else {
      verdictReason = "break-even deposit above $25,000";
    }
  }
  var payoffIf = Math.round(A.airdropShare * model.value * (deposit / row.tvl_usd));
  var expectedPayoff = odds * payoffIf;
  var fee = Math.round(A.protocolFeeRate * deposit);
  var oppCost = Math.round(deposit * oppRate);
  var net = Math.round(expectedPayoff - gas - fee - oppCost);
  return {
    deposit: deposit,
    breakEven: breakEven === null ? null : Math.round(breakEven),
    gas: gas, fee: fee, oppCost: oppCost, payoffIf: payoffIf,
    expectedPayoff: Math.round(expectedPayoff),
    net: net, roi: net / deposit, verdict: verdict, verdictReason: verdictReason, hold: hold
  };
}

// --- farm plans (same derivation as main.ts buildFarmSteps) ----------------

var FARM_ACTIONS = {
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
  "Indexes": "If {name} runs a points program, buy a small amount of the index after reading which assets it holds and how it rebalances."
};

function farmAction(row) {
  var template = (row.category && FARM_ACTIONS[row.category] !== undefined)
    ? FARM_ACTIONS[row.category]
    : "If {name} runs a points program, use its main product with a small position after reading the official docs, and record what you did in your farm log.";
  return template.split("{name}").join(row.name);
}

function deriveFarmSteps(row, model, odds, econ) {
  var chain = row.chains[0] || "its main chain";
  var totalCost = econ.gas + econ.fee + econ.oppCost;
  var costStep = "Deposit " + fmtUsd(econ.deposit) + " (break-even "
    + (econ.breakEven === null ? "none" : fmtUsd(econ.breakEven)) + " at " + Math.round(odds * 100)
    + "% token odds). Costs, planning estimates: gas ~" + fmtUsd(econ.gas) + " for 4 transactions on "
    + chain + ", protocol fee ~" + fmtUsd(econ.fee) + " (0.30%), T-bill opportunity cost ~"
    + fmtUsd(econ.oppCost) + " over " + econ.hold + " days — total ~" + fmtUsd(totalCost) + ".";
  var hold;
  if (econ.hold === 75) {
    hold = "Hold the position for about 60 to 90 days, then re-check whether " + row.name + " still records no token before adding more; these positions are slow-moving, so a short hold proves little.";
  } else {
    hold = "Hold the position for about " + econ.hold + " days, then re-check whether " + row.name + " still records no token before adding more; do not add funds while the official rewards page is unreachable.";
  }
  var verdictStep = "If " + row.name + " issues a token, a 5% airdrop shared pro-rata pays about "
    + fmtUsd(econ.payoffIf) + " on this deposit; if it never does, the cost is about " + fmtUsd(totalCost)
    + ". Expected value " + fmtUsd(econ.expectedPayoff) + " at " + Math.round(odds * 100)
    + "% odds, net " + fmtUsd(econ.net) + ". Verdict: " + econ.verdict + " — " + econ.verdictReason + ".";
  return [
    "Open a fresh wallet that you use only for " + row.name + ", write its seed phrase on paper and store it offline, and never connect it to a link from a message or a social post.",
    farmAction(row),
    costStep,
    hold,
    "Once a week, open " + row.name + "'s official rewards or points page from a bookmarked official link and write the date, wallet and transaction in a farm log; if the page is missing or changed, pause and re-check later instead of following links from social posts.",
    verdictStep,
    "Withdraw or claim only from " + row.name + "'s own official site, never pay anyone to claim for you, and never sign a transaction you did not read; if no claim exists yet, leave the position and review it again next month."
  ];
}

// --- page rendering --------------------------------------------------------

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function el(id) { return document.getElementById(id); }

function verdictBadge(v) {
  return '<span class="verdict ' + v.toLowerCase() + '">' + v + "</span>";
}

function renderKpis() {
  var acc = R.accounting;
  var vc = R.verdictCounts;
  var cards = [
    { big: acc.board + acc.traded + acc.excluded + " / " + R.total_protocols, small: "Protocols accounted — none missing" },
    { big: "MdAPE " + R.validation.heldOut.mdape.toFixed(2), small: "Held-out 5-fold, n=" + R.validation.heldOut.n + " priced peers" },
    { big: vc.FARM + " FARM · " + vc.THIN + " THIN · " + vc.SKIP + " SKIP", small: "Verdicts across the " + acc.board + "-row board" },
    { big: fmtUsd(R.totalEdge), small: "Total expected farmable edge (FARM rows, net of all costs)" },
    { big: Math.round(R.odds.pooled * 100) + "%", small: "Pooled token odds — strict peer conversion rate" },
    { big: R.as_of, small: "Snapshot date — sealed in the kit, never fetched live" }
  ];
  el("kpis").innerHTML = cards.map(function (c) {
    return '<div class="kpi"><div class="kpi-big">' + esc(c.big) + '</div><div class="kpi-small">' + esc(c.small) + "</div></div>";
  }).join("");
}

function renderCalibration() {
  var tbody = document.querySelector("#oos-table tbody");
  function row(label, m, sub) {
    return "<tr><td>" + esc(label) + (sub ? '<br><span class="slug">' + esc(sub) + "</span>" : "")
      + '</td><td class="num">' + m.n + '</td><td class="num">' + m.mdape.toFixed(3)
      + '</td><td class="num">' + m.maeLog.toFixed(3) + '</td><td class="num">' + m.r2log.toFixed(2)
      + '</td><td class="num">' + Math.round(m.hit2x * 100) + "%" + '</td><td class="num">' + Math.round(m.hit3x * 100)
      + "%" + '</td><td class="num">' + Math.round(m.hit5x * 100) + "%</td></tr>";
  }
  var html = row("Held-out 5-fold CV", R.validation.heldOut);
  R.validation.walkForward.forEach(function (wf) {
    html += row("Walk-forward", wf.metrics, "cut " + wf.cutoff + " · train " + wf.trainN);
  });
  tbody.innerHTML = html;
  var ho = R.validation.heldOut;
  var wf0 = R.validation.walkForward[0].metrics;
  var wf1 = R.validation.walkForward[1].metrics;
  el("cal-notes").innerHTML = [
    "<li><b>The model is a weak point forecast.</b> Held-out median error " + Math.round(ho.mdape * 100)
    + "% and R²-log " + ho.r2log.toFixed(2) + ": priced peers' mcap/TVL ratios span about five orders of magnitude, so the multiple is a central-tendency anchor for ranking, not a prediction of an exact FDV.</li>",
    "<li><b>Category multiples do not beat the pooled median out of sample.</b> Held-out MdAPE 0.91 with category multiples vs 0.89 pooled-only. They are kept because they encode real between-category price differences, shrunk toward the pooled median so their influence is bounded.</li>",
    "<li><b>Trust the walk-forward, not the random folds.</b> Time-split tests are worse (MdAPE "
    + wf0.mdape.toFixed(2) + " and " + wf1.mdape.toFixed(2) + ", R²-log " + wf0.r2log.toFixed(2) + " and " + wf1.r2log.toFixed(2)
    + ") — the price regime drifts, so a multiple fitted on old peers decays on new ones. The board ranks on the full-snapshot fit and shows this decay instead of hiding it.</li>",
    "<li><b>Calibration peers are survivors.</b> Only protocols that already record a token can be tested, so the fitted multiples describe protocols that did launch. Predictions for pre-token protocols are biased high; the dashboard uses the median, not the mean, and says so here.</li>"
  ].join("");
  renderScatter();
  var tbody2 = document.querySelector("#calib tbody");
  var rows = R.calibration.slice().sort(function (a, b) { return b.multiple - a.multiple; });
  var html2 = "";
  rows.forEach(function (c) {
    html2 += "<tr><td>" + esc(c.category) + "</td><td>" + c.n + "</td><td>" + c.median.toFixed(3)
      + "</td><td>" + c.multiple.toFixed(3) + "</td></tr>";
  });
  html2 += '<tr><td>Overall median (fallback)</td><td>—</td><td>' + R.pooled_multiple.toFixed(3)
    + "</td><td>" + R.pooled_multiple.toFixed(3) + "</td></tr>";
  tbody2.innerHTML = html2;
}

function renderScatter() {
  var pts = R.validation.chartPoints;
  var svg = el("scatter");
  var W = 460, H = 300, padL = 44, padB = 32, padT = 10, padR = 10;
  var logs = pts.map(function (p) { return { x: Math.log10(p.pred), y: Math.log10(p.actual) }; });
  var xs = logs.map(function (p) { return p.x; });
  var ys = logs.map(function (p) { return p.y; });
  var lo = Math.floor(Math.min.apply(null, xs.concat(ys))) - 0.5;
  var hi = Math.ceil(Math.max.apply(null, xs.concat(ys))) + 0.5;
  function X(v) { return padL + (v - lo) / (hi - lo) * (W - padL - padR); }
  function Y(v) { return H - padB - (v - lo) / (hi - lo) * (H - padT - padB); }
  var s = "";
  for (var g = Math.ceil(lo); g <= Math.floor(hi); g++) {
    s += '<line x1="' + X(g) + '" y1="' + Y(lo) + '" x2="' + X(g) + '" y2="' + Y(hi) + '" class="grid"/>'
      + '<line x1="' + X(lo) + '" y1="' + Y(g) + '" x2="' + X(hi) + '" y2="' + Y(g) + '" class="grid"/>'
      + '<text x="' + X(g) + '" y="' + (H - 12) + '" class="axis">' + (g >= 0 ? "10^" + g : "0." + "0".repeat(-g - 1) + "1") + "</text>"
      + '<text x="10" y="' + (Y(g) + 4) + '" class="axis">' + (g >= 0 ? "10^" + g : "0." + "0".repeat(-g - 1) + "1") + "</text>";
  }
  s += '<line x1="' + X(lo) + '" y1="' + Y(lo) + '" x2="' + X(hi) + '" y2="' + Y(hi) + '" class="diag"/>';
  logs.forEach(function (p) {
    s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="2.6" class="dot"/>';
  });
  s += '<text x="' + (W / 2) + '" y="' + (H - 12) + '" class="axis-label"></text>';
  svg.innerHTML = s;
}

function renderAccounting() {
  var acc = R.accounting;
  el("accounting-text").textContent = "Every one of the " + R.total_protocols + " protocols in the sealed snapshot is counted exactly once: "
    + acc.board + " on the board, " + acc.traded + " already traded (the calibration anchors), and "
    + acc.excluded + " pre-token protocols excluded for a stated reason. The three buckets sum to "
    + (acc.board + acc.traded + acc.excluded) + ".";
  var reasons = Object.keys(acc.exclusionCounts).sort(function (a, b) { return acc.exclusionCounts[b] - acc.exclusionCounts[a]; });
  var reasonText = reasons.map(function (r) { return r + ": " + acc.exclusionCounts[r]; }).join(" · ");
  var html = ""
    + "<tr><td>Board (pre-token, farmable scope)</td><td class=\"num\">" + acc.board + "</td><td>Records no token and is not excluded — ranked by fitted value.</td></tr>"
    + "<tr><td>Already traded (peer anchors)</td><td class=\"num\">" + acc.traded + "</td><td>Records a token (gecko_id, mcap or symbol) — calibrates the model, not ranked.</td></tr>"
    + "<tr><td>Excluded pre-token</td><td class=\"num\">" + acc.excluded + "</td><td>" + esc(reasonText) + " — house exclusion rules, stated per protocol.</td></tr>"
    + "<tr class=\"total\"><td>Total</td><td class=\"num\">" + (acc.board + acc.traded + acc.excluded) + "</td><td>Snapshot protocols, as of " + esc(R.as_of) + ".</td></tr>";
  document.querySelector("#acc-table tbody").innerHTML = html;
}

function renderAssumptions() {
  var s = R.sensitivityAt10;
  var gasText = Object.keys(A.gasPerTx).map(function (k) { return k + " $" + A.gasPerTx[k]; }).join(", ");
  el("assump-list").innerHTML = [
    "<li><b>Airdrop share 5% of fitted FDV</b>, shared pro-rata by deposit — a planning assumption, labelled as such, never a promise. At a 10% share the verdicts would be "
    + s.FARM + " FARM / " + s.THIN + " THIN / " + s.SKIP + " SKIP, so the verdicts are sensitive to this assumption.</li>",
    "<li><b>Token odds are peer conversion rates</b> from one frozen snapshot (category × age band, shrunk toward the category then the pooled rate). They are base rates for whether a protocol ever records a token, not a forecast of a dated launch.</li>",
    "<li><b>Costs:</b> gas " + esc(gasText) + ", other chains $1 per transaction, " + A.gasTxCount
    + " transactions per plan; protocol fee 0.30% of the deposit; T-bill opportunity cost " + (A.tbillRate * 100).toFixed(1)
    + "% per year over the hold.</li>",
    "<li><b>Deposit:</b> the smallest ladder step ($50 / $100 / $250 / $500 / $1,000 / $2,500 / $5,000 / $10,000 / $25,000) at or above the break-even deposit; nothing is recommended above $25,000.</li>",
    "<li><b>Hold:</b> 30–60 days by age (75 days, shown as 60–90, for RWA and Risk Curators). The farm plan is conditional: the snapshot cannot prove a points program exists, so each plan says what to verify first.</li>"
  ].join("");
}

function sortedRows(rows) {
  var sort = el("sort").value;
  var copy = rows.slice();
  if (sort === "ev") copy.sort(function (a, b) { return (b.net_usd - a.net_usd) || (a.slug < b.slug ? -1 : 1); });
  else if (sort === "tvl") copy.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
  else if (sort === "chg") copy.sort(function (a, b) { return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d); });
  else if (sort === "age") copy.sort(function (a, b) { return (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days); });
  else if (sort === "name") copy.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  else copy.sort(function (a, b) { return (b.implied_value_usd - a.implied_value_usd) || (a.slug < b.slug ? -1 : 1); });
  return copy;
}

function filteredRows() {
  var q = el("q").value.trim().toLowerCase();
  var verdict = el("verdict").value;
  var cat = el("category").value;
  var chain = el("chain").value;
  var watchOnly = el("watch").checked;
  return R.rows.filter(function (row) {
    if (q && row.name.toLowerCase().indexOf(q) === -1 && row.slug.toLowerCase().indexOf(q) === -1 && (row.category || "").toLowerCase().indexOf(q) === -1) return false;
    if (verdict && row.verdict !== verdict) return false;
    if (cat && row.category !== cat) return false;
    if (chain && row.chains.indexOf(chain) === -1) return false;
    if (watchOnly && !row.watchlist) return false;
    return true;
  });
}

function renderBoard() {
  var rows = sortedRows(filteredRows());
  var tbody = document.querySelector("#board tbody");
  var html = "";
  rows.forEach(function (row) {
    var flag = row.growth_flag ? ' <span class="flag" title="' + esc(row.growth_flag) + '">⚠</span>' : "";
    var shownChains = row.chains.slice(0, 2).join(", ")
      + (row.chains.length > 2 ? " +" + (row.chains.length - 2) + " more" : "");
    html += '<tr tabindex="0" data-slug="' + esc(row.slug) + '">'
      + "<td>" + row.rank + "</td>"
      + "<td>" + esc(row.name) + '<br><span class="slug">' + esc(row.slug) + "</span></td>"
      + "<td>" + esc(row.category || "—") + "<br><span class=\"slug\">" + esc(shownChains) + "</span></td>"
      + '<td class="num">' + fmtUsd(row.implied_value_usd) + flag + "</td>"
      + '<td class="num">' + Math.round(row.token_odds * 100) + "%</td>"
      + '<td class="num ' + (row.net_usd > 0 ? "pos" : row.net_usd < 0 ? "neg" : "") + '">' + fmtUsd(row.net_usd) + "</td>"
      + '<td class="num">' + fmtUsd(row.deposit_usd) + " · " + row.hold_days + "d</td>"
      + "<td>" + verdictBadge(row.verdict) + "</td>"
      + "</tr>";
  });
  tbody.innerHTML = html;
  el("count").textContent = rows.length + " of " + R.rows.length + " protocols shown.";
  el("empty") && (document.querySelector(".empty") || { hidden: true });
}

function rowBySlug(slug) {
  for (var i = 0; i < R.rows.length; i++) {
    if (R.rows[i].slug === slug) return R.rows[i];
  }
  return null;
}

function openDetail(slug) {
  var row = rowBySlug(slug);
  if (!row) return;
  var model = impliedValue(row);
  var odds = tokenOdds(row);
  var econ = farmEconomics(row, model, odds);
  var derived = deriveFarmSteps(row, model, odds, econ);
  var checks = [];
  checks.push("value " + (model.value === row.implied_value_usd ? "✓" : "✗"));
  checks.push("odds " + (Math.abs(odds - row.token_odds) < 1e-9 ? "✓" : "✗"));
  checks.push("net " + (econ.net === row.net_usd ? "✓" : "✗"));
  checks.push("verdict " + (econ.verdict === row.verdict ? "✓" : "✗"));
  checks.push("plan " + (JSON.stringify(derived) === JSON.stringify(row.farm_steps) ? "✓" : "✗"));
  var anchors = R.peerAnchors[row.category] || [];
  var anchorRows = anchors.map(function (a) {
    return "<tr><td>" + esc(a.name) + "</td><td class=\"num\">" + a.ratio.toFixed(3) + "</td></tr>";
  }).join("");
  var totalCost = econ.gas + econ.fee + econ.oppCost;
  var steps = derived.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");
  el("detailBody").innerHTML =
    "<h2>" + esc(row.name) + "</h2>"
    + '<p class="meta">Rank #' + row.rank + " · " + esc(row.slug)
    + (row.watchlist ? ' · <span class="badge">WATCHLIST</span>' : "")
    + (row.growth_flag ? ' · <span class="flag">⚠ ' + esc(row.growth_flag) + "</span>" : "") + "</p>"
    + "<dl class=\"kv\">"
    + "<dt>Fitted launch FDV</dt><dd>" + fmtUsd(row.implied_value_usd) + "</dd>"
    + "<dt>Token odds</dt><dd>" + Math.round(odds * 100) + "% (" + esc(row.category || "no category") + " × " + esc(ageBand(row))
    + "; category " + Math.round((R.odds.byCategory[row.category] || R.odds.pooled) * 100) + "%, pooled " + Math.round(R.odds.pooled * 100) + "%)</dd>"
    + "<dt>Expected launch value</dt><dd>" + fmtUsd(row.expected_value_usd) + " (fitted FDV × odds)</dd>"
    + "<dt>Recommended deposit</dt><dd>" + fmtUsd(econ.deposit) + " · hold " + econ.hold + " days · break-even " + (econ.breakEven === null ? "none" : fmtUsd(econ.breakEven)) + "</dd>"
    + "<dt>Net farm EV</dt><dd>" + fmtUsd(econ.net) + " (" + (econ.roi * 100).toFixed(1) + "% on the deposit)</dd>"
    + "<dt>Verdict</dt><dd>" + verdictBadge(row.verdict) + " — " + esc(row.verdict_reason) + "</dd>"
    + "<dt>TVL</dt><dd>" + fmtUsd(row.tvl_usd) + "</dd>"
    + "<dt>7-day TVL change</dt><dd>" + fmtPct(row.change_7d) + "</dd>"
    + "<dt>Days tracked</dt><dd>" + fmtDays(row.age_days) + (row.listed_at ? " (since " + esc(row.listed_at) + ")" : "") + "</dd>"
    + "<dt>Chains</dt><dd class=\"plain\">" + esc(row.chains.join(", ")) + "</dd>"
    + "<dt>Category multiple</dt><dd>" + model.multiple.toFixed(3)
    + " (category median " + (row.multiple_median === null ? "—" : row.multiple_median.toFixed(3))
    + ", n = " + (row.multiple_n === null ? "—" : row.multiple_n)
    + "; pooled median " + R.pooled_multiple.toFixed(3) + ")</dd>"
    + "<dt>Growth factor</dt><dd>" + model.growthMult.toFixed(3) + " (change used: " + fmtPct(model.growth) + ")</dd>"
    + "<dt>Maturity factor</dt><dd>" + model.maturity.toFixed(3) + "</dd>"
    + "<dt>Page recompute</dt><dd class=\"plain\">" + esc(checks.join(" · ")) + "</dd>"
    + "</dl>"
    + "<h3>Peer anchors — highest mcap/TVL in " + esc(row.category || "this category") + "</h3>"
    + (anchorRows ? '<table class="anchors"><thead><tr><th>Traded peer</th><th class="num">mcap / TVL</th></tr></thead><tbody>' + anchorRows + "</tbody></table>" : "<p class=\"hint\">No priced peer in this category.</p>")
    + "<h3>Costed farm plan</h3>"
    + '<table class="costs"><tbody>'
    + "<tr><td>Deposit</td><td class=\"num\">" + fmtUsd(econ.deposit) + "</td></tr>"
    + "<tr><td>Gas (4 transactions, " + esc(row.chains[0] || "main chain") + ")</td><td class=\"num\">" + fmtUsd(econ.gas) + "</td></tr>"
    + "<tr><td>Protocol fee (0.30%)</td><td class=\"num\">" + fmtUsd(econ.fee) + "</td></tr>"
    + "<tr><td>T-bill opportunity cost (" + econ.hold + " days at 4.5%/yr)</td><td class=\"num\">" + fmtUsd(econ.oppCost) + "</td></tr>"
    + "<tr class=\"total\"><td>Total cost</td><td class=\"num\">" + fmtUsd(totalCost) + "</td></tr>"
    + "<tr><td>Payoff if a token launches (5% airdrop, pro-rata)</td><td class=\"num\">" + fmtUsd(econ.payoffIf) + "</td></tr>"
    + "<tr><td>Expected payoff (" + Math.round(odds * 100) + "% odds)</td><td class=\"num\">" + fmtUsd(econ.expectedPayoff) + "</td></tr>"
    + "<tr class=\"total\"><td>Net expected value</td><td class=\"num\">" + fmtUsd(econ.net) + "</td></tr>"
    + "</tbody></table>"
    + '<p class="hint">Two outcomes: if ' + esc(row.name) + " issues a token, this deposit returns about " + fmtUsd(econ.payoffIf - totalCost)
    + " after costs; if it never does, the cost is about " + fmtUsd(totalCost) + ".</p>"
    + "<h3>Farm plan — conditional steps</h3>"
    + '<p class="hint">These steps assume the protocol runs a points program. Verify that on its official site first; every cost and time here is a planning assumption, not the protocol\u2019s own terms.</p>'
    + '<ol class="steps">' + steps + "</ol>";
  el("detail").showModal();
}

function fillSelects() {
  var cats = {};
  var chains = {};
  R.rows.forEach(function (row) {
    if (row.category) cats[row.category] = true;
    row.chains.forEach(function (c) { chains[c] = true; });
  });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement("option");
    o.value = c; o.textContent = c; el("category").appendChild(o);
  });
  Object.keys(chains).sort().forEach(function (c) {
    var o = document.createElement("option");
    o.value = c; o.textContent = c; el("chain").appendChild(o);
  });
}

function applyHash() {
  var params = new URLSearchParams(location.search);
  var hashParams = new URLSearchParams(location.hash.slice(1));
  hashParams.forEach(function (value, key) { params.set(key, value); });
  if (params.get("q")) el("q").value = params.get("q");
  if (params.get("verdict")) el("verdict").value = params.get("verdict");
  if (params.get("category")) el("category").value = params.get("category");
  if (params.get("chain")) el("chain").value = params.get("chain");
  if (params.get("watchlist") === "1") el("watch").checked = true;
  if (params.get("sort")) el("sort").value = params.get("sort");
  renderBoard();
  if (params.get("scroll") === "board") {
    var target = document.getElementById("boardTitle");
    if (target) target.scrollIntoView();
  }
  if (params.get("detail")) openDetail(params.get("detail"));
}

function init() {
  var wl = R.rows.filter(function (r) { return r.watchlist; }).length;
  el("meta").innerHTML = "Snapshot <b>" + esc(R.as_of) + "</b> · board <b>" + R.rows.length
    + "</b> protocols · watchlist <b>" + wl + "</b> · floor <b>" + fmtUsd(R.floor_usd) + "</b>";
  fillSelects();
  renderKpis();
  renderCalibration();
  renderAccounting();
  renderAssumptions();
  ["q", "verdict", "category", "chain", "watch", "sort"].forEach(function (id) {
    el(id).addEventListener("input", renderBoard);
    el(id).addEventListener("change", renderBoard);
  });
  document.querySelector("#board tbody").addEventListener("click", function (e) {
    var tr = e.target.closest("tr");
    if (tr) openDetail(tr.getAttribute("data-slug"));
  });
  document.querySelector("#board tbody").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      var tr = e.target.closest("tr");
      if (tr) openDetail(tr.getAttribute("data-slug"));
    }
  });
  el("detail").addEventListener("click", function (e) {
    if (e.target === el("detail")) el("detail").close();
  });
  applyHash();
}

document.addEventListener("DOMContentLoaded", init);
