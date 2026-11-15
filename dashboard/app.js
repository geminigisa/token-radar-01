// Token Launch Radar — dashboard.
// Renders window.RADAR (written by main.ts). Pure functions first: the
// model recompute and the farm-plan derivation live here in the source so
// the detail view shows code and screenshot agreeing, and the page can
// verify its own numbers against the board. No network: no imports, no
// fetches, no external addresses anywhere in this file.

var R = window.RADAR;

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

// --- model recompute (same formula as main.ts, from the calibration table
// in the data: multiple per category, pooled median as the fallback) -------

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

// --- farm plans ----------------------------------------------------------
// Same derivation as main.ts buildFarmSteps. Every step is conditional:
// the snapshot cannot prove a points program exists, so each plan says
// what to verify first and labels costs and times as planning assumptions.

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

function capitalTier(tvl) {
  if (tvl >= 1000000000) return 250;
  if (tvl >= 250000000) return 150;
  if (tvl >= 100000000) return 100;
  return 50;
}

function gasEstimate(chains) {
  var primary = (chains[0] || "").toLowerCase();
  if (primary === "ethereum") return "$5–15";
  if (primary === "solana") return "about $0.01";
  if (primary === "bitcoin") return "$1–5";
  if (["base", "arbitrum", "optimism", "polygon", "binance", "bsc"].indexOf(primary) !== -1) return "$0.10–1";
  return "under $1";
}

function deriveFarmSteps(row) {
  var capital = capitalTier(row.tvl_usd);
  var gas = gasEstimate(row.chains);
  var chain = row.chains[0] || "its main chain";
  var slow = row.category === "Risk Curators" || row.category === "RWA";
  var hold;
  if (slow) {
    hold = "Hold the position for about 60 to 90 days, then re-check whether " + row.name + " still records no token before adding more; these positions are slow-moving, so a short hold proves little.";
  } else {
    var days = row.age_days === null || row.age_days === undefined ? 45 : row.age_days < 180 ? 60 : row.age_days < 365 ? 45 : 30;
    hold = "Hold the position for about " + days + " days, then re-check whether " + row.name + " still records no token before adding more; do not add funds while the official rewards page is unreachable.";
  }
  return [
    "Open a fresh wallet that you use only for " + row.name + ", write its seed phrase on paper and store it offline, and never connect it to a link from a message or a social post.",
    farmAction(row),
    "Plan about $" + capital + " of capital and roughly " + gas + " in gas per transaction on " + chain + " — planning estimates, not the protocol's fees — and keep the amount small enough that losing it would not hurt.",
    hold,
    "Once a week, open " + row.name + "'s official rewards or points page from a bookmarked official link and write the date, wallet and transaction in a farm log; if the page is missing or changed, pause and re-check later instead of following links from social posts.",
    "Withdraw or claim only from " + row.name + "'s own official site, never pay anyone to claim for you, and never sign a transaction you did not read; if no claim exists yet, leave the position and review it again next month."
  ];
}

// --- page rendering ------------------------------------------------------

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function el(id) { return document.getElementById(id); }

function sortedRows(rows) {
  var sort = el("sort").value;
  var copy = rows.slice();
  if (sort === "tvl") copy.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
  else if (sort === "growth") copy.sort(function (a, b) { return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d); });
  else if (sort === "age") copy.sort(function (a, b) { return (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days); });
  else if (sort === "name") copy.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  else copy.sort(function (a, b) { return (b.implied_value_usd - a.implied_value_usd) || (a.slug < b.slug ? -1 : 1); });
  return copy;
}

function filteredRows() {
  var q = el("q").value.trim().toLowerCase();
  var cat = el("cat").value;
  var chain = el("chain").value;
  var watchOnly = el("watch").checked;
  return R.rows.filter(function (row) {
    if (q && row.name.toLowerCase().indexOf(q) === -1 && row.slug.toLowerCase().indexOf(q) === -1) return false;
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
    var shownChains = row.chains.slice(0, 3).join(", ")
      + (row.chains.length > 3 ? " +" + (row.chains.length - 3) + " more" : "");
    html += '<tr tabindex="0" data-slug="' + esc(row.slug) + '">'
      + "<td>" + row.rank + "</td>"
      + "<td>" + esc(row.name) + '<br><span class="slug">' + esc(row.slug) + "</span></td>"
      + "<td>" + esc(row.category || "—") + "</td>"
      + "<td>" + esc(shownChains) + "</td>"
      + '<td class="num">' + fmtUsd(row.tvl_usd) + "</td>"
      + '<td class="num">' + fmtPct(row.change_7d) + flag + "</td>"
      + '<td class="num">' + fmtDays(row.age_days) + "</td>"
      + '<td class="num">' + fmtUsd(row.implied_value_usd) + "</td>"
      + "<td>" + (row.watchlist ? '<span class="badge">WATCHLIST</span>' : "") + "</td>"
      + "</tr>";
  });
  tbody.innerHTML = html;
  el("count").textContent = rows.length + " of " + R.rows.length + " protocols shown.";
  el("boardTitle").textContent = "Board";
}

function renderCalibration() {
  var tbody = document.querySelector("#calib tbody");
  var rows = R.calibration.slice().sort(function (a, b) { return b.multiple - a.multiple; });
  var html = "";
  rows.forEach(function (c) {
    html += "<tr><td>" + esc(c.category) + "</td><td>" + c.n + "</td><td>" + c.median.toFixed(3)
      + "</td><td>" + c.multiple.toFixed(3) + "</td></tr>";
  });
  html += '<tr><td>Overall median (fallback)</td><td>—</td><td>' + R.pooled_multiple.toFixed(3)
    + "</td><td>" + R.pooled_multiple.toFixed(3) + "</td></tr>";
  tbody.innerHTML = html;
}

function renderSummary() {
  var byCat = {};
  R.rows.forEach(function (row) {
    var cat = row.category || "No category";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(row.implied_value_usd);
  });
  var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b].length - byCat[a].length; });
  var html = "";
  cats.forEach(function (cat) {
    var vals = byCat[cat].slice().sort(function (a, b) { return a - b; });
    var med = vals[Math.floor(vals.length / 2)];
    html += '<span class="chip">' + esc(cat) + ": <b>" + vals.length + "</b> rows, median implied <b>"
      + fmtUsd(med) + "</b></span>";
  });
  el("summaryBody").innerHTML = html;
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
  var rec = impliedValue(row);
  var derived = deriveFarmSteps(row);
  var planMatches = JSON.stringify(derived) === JSON.stringify(row.farm_steps);
  var steps = derived.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");
  var matchLine = rec.value === row.implied_value_usd
    ? '<span class="match">Recomputed ' + fmtUsd(rec.value) + " — matches the board.</span>"
    : '<span class="mismatch">Recomputed ' + fmtUsd(rec.value) + " — differs from the board's " + fmtUsd(row.implied_value_usd) + ".</span>";
  el("detailBody").innerHTML =
    "<h2>" + esc(row.name) + "</h2>"
    + '<p class="meta">Rank #' + row.rank + " · " + esc(row.slug)
    + (row.watchlist ? ' · <span class="badge">WATCHLIST</span>' : "")
    + (row.growth_flag ? ' · <span class="flag">⚠ ' + esc(row.growth_flag) + "</span>" : "") + "</p>"
    + "<dl class=\"kv\">"
    + "<dt>Implied value</dt><dd>" + fmtUsd(row.implied_value_usd) + "</dd>"
    + "<dt>TVL</dt><dd>" + fmtUsd(row.tvl_usd) + "</dd>"
    + "<dt>7-day TVL change</dt><dd>" + fmtPct(row.change_7d) + "</dd>"
    + "<dt>Days tracked</dt><dd>" + fmtDays(row.age_days) + (row.listed_at ? " (since " + esc(row.listed_at) + ")" : "") + "</dd>"
    + "<dt>Category</dt><dd class=\"plain\">" + esc(row.category || "—") + "</dd>"
    + "<dt>Chains</dt><dd class=\"plain\">" + esc(row.chains.join(", ")) + "</dd>"
    + "<dt>Category multiple</dt><dd>" + rec.multiple.toFixed(3)
    + " (category median " + (row.multiple_median === null ? "—" : row.multiple_median.toFixed(3))
    + ", n = " + (row.multiple_n === null ? "—" : row.multiple_n)
    + "; pooled median " + R.pooled_multiple.toFixed(3) + ")</dd>"
    + "<dt>Growth factor</dt><dd>" + rec.growthMult.toFixed(3) + " (change used: " + fmtPct(rec.growth) + ")</dd>"
    + "<dt>Maturity factor</dt><dd>" + rec.maturity.toFixed(3) + "</dd>"
    + "<dt>Model check</dt><dd class=\"plain\">" + matchLine + "</dd>"
    + "</dl>"
    + "<h3>Farm plan — conditional steps</h3>"
    + '<p class="hint">These steps assume the protocol runs a points program. Verify that on its official site first; every cost and time here is a planning assumption, not the protocol\u2019s own terms.</p>'
    + '<ol class="steps">' + steps + "</ol>"
    + '<p class="hint">Plan shown by the page\u2019s own derivation ' + (planMatches ? "matches" : "does NOT match") + " board.json.</p>";
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
    o.value = c; o.textContent = c; el("cat").appendChild(o);
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
  if (params.get("cat")) el("cat").value = params.get("cat");
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
  renderCalibration();
  renderSummary();
  ["q", "cat", "chain", "watch", "sort"].forEach(function (id) {
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
