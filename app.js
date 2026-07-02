// GitHub Homestead — a zero-build static app.
// All GitHub calls run in the visitor's browser (api.github.com sends CORS
// headers); the contribution calendar comes from the public
// github-contributions-api service. No server, no secrets, no build step.
//
// Everything from the API is inserted with textContent — never innerHTML —
// so arbitrary bios/names from GitHub can't inject markup.

import rough from "https://unpkg.com/roughjs@4.6.6/bundled/rough.esm.js";

const gen = rough.generator();
const SVG_NS = "http://www.w3.org/2000/svg";

// ---- Scene constants -----------------------------------------------------------

const W = 760;
const MAX_HOUSES = 20;
const CHALK = "#aeb6c6"; // outline color: chalk on a night sky

// The road serpentines across the canvas in horizontal switchbacks — the whole
// town fits one screen. Houses stand behind each stretch, lamps in front.
const PER_BAND = 7;
const BAND_Y0 = 238; // centerline of the first stretch
const BAND_H = 206; // vertical distance between stretches
const ROAD_HALF = 13; // half the road's width
const SLOT_X0 = 78;
const SLOT_STEP = (682 - 78) / 6;

const DOOR_COLORS = ["#5a4632", "#704a35", "#4a3a5e", "#35566b"];

// ---- Colors ----------------------------------------------------------------------

const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572a5", Vue: "#41b883",
  HTML: "#e34c26", CSS: "#663399", PHP: "#4f5d95", Ruby: "#701516", Go: "#00add8",
  Rust: "#dea584", Java: "#b07219", "C#": "#178600", C: "#8f8f8f", "C++": "#f34b7d",
  Shell: "#89e051", Swift: "#f05138", Kotlin: "#a97bff", Dart: "#00b4ab",
};

function langColor(lang) {
  return (lang && LANG_COLORS[lang]) || "#5a6072";
}

// A window's look reads more architectural as discrete states: lit, dim, dark.
function windowLook(freshness) {
  if (freshness < 0) return { fill: "#3a3f4b", glow: false };
  if (freshness < 0.15) return { fill: "#20242e", glow: false };
  if (freshness < 0.6) return { fill: "#8a7340", glow: false };
  return { fill: "#f5b450", glow: true };
}

// ---- Deterministic "randomness" ---------------------------------------------

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Data fetching ---------------------------------------------------------------

const API = "https://api.github.com";

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function gh(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    throw new GitHubError("GitHub API rate limit reached for your IP. Try again in a bit.", 429);
  }
  if (res.status === 404) {
    throw new GitHubError("User not found (is the profile public?).", 404);
  }
  if (!res.ok) {
    throw new GitHubError(`GitHub API error (${res.status}).`, res.status);
  }
  return res.json();
}

/** Parse a username out of a profile URL, "@name", or bare "name". */
function parseUserInput(input) {
  const cleaned = input.trim().replace(/^@/, "");
  const urlMatch = cleaned.match(/github\.com\/([A-Za-z0-9-]+)\/?(?:[?#].*)?$/i);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(cleaned)) return cleaned;
  return null;
}

/**
 * Window brightness from push recency, tuned to windowLook()'s bands:
 * lit ≥ 0.6 (pushed within ~3 months), dim ≥ 0.15 (within a year), dark below.
 */
function freshnessFromPush(pushedAt) {
  if (!pushedAt) return -1;
  const days = (Date.now() - new Date(pushedAt).getTime()) / 86400000;
  if (days <= 90) return 1 - (days / 90) * 0.4;
  if (days <= 365) return 0.6 - ((days - 90) / 275) * 0.45;
  return Math.max(0, 0.15 - (days - 365) / 2000);
}

async function fetchCalendar(login) {
  try {
    const res = await fetch(
      `https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(login)}?y=last`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const days = data.contributions ?? [];
    if (days.length === 0) return null;
    const byMonth = new Map();
    let total = 0;
    let activeDays = 0;
    for (const d of days) {
      total += d.count;
      if (d.count > 0) activeDays++;
      const key = d.date.slice(0, 7);
      byMonth.set(key, (byMonth.get(key) ?? 0) + d.count);
    }
    const months = [...byMonth.keys()]
      .sort()
      .slice(-12)
      .map((key) => ({
        month: key,
        label: new Date(`${key}-15`).toLocaleString("en", { month: "short" }),
        count: byMonth.get(key) ?? 0,
      }));
    return { total, activeDays, months };
  } catch {
    return null; // the lamps going out shouldn't kill the neighborhood
  }
}

async function fetchPrStats(login) {
  try {
    const q = encodeURIComponent(`author:${login} type:pr`);
    const res = await fetch(`${API}/search/issues?q=${q}&per_page=100`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items ?? [];
    return {
      total: data.total_count ?? items.length,
      sampled: items.length,
      merged: items.filter((i) => i.pull_request?.merged_at).length,
    };
  } catch {
    return null;
  }
}

async function fetchHomestead(login) {
  const [user, repos, contributions, prStats] = await Promise.all([
    gh(`/users/${encodeURIComponent(login)}`),
    gh(`/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed`),
    fetchCalendar(login),
    fetchPrStats(login),
  ]);

  const houses = repos.map((r) => ({
    name: r.name,
    url: r.html_url,
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    isFork: Boolean(r.fork),
    pushedAt: r.pushed_at ?? r.updated_at ?? "",
    freshness: freshnessFromPush(r.pushed_at ?? r.updated_at ?? null),
    sizeKB: r.size ?? 0,
  }));

  // Vitality: how many days the lights were on, plus PR merge quality.
  // 60% active days = a perfect score; merge rate fills the rest.
  const activeScore = contributions
    ? Math.min(100, Math.round(((contributions.activeDays / 365) * 100) / 0.6))
    : 50;
  const mergeScore =
    prStats && prStats.sampled > 0
      ? Math.round((prStats.merged / prStats.sampled) * 100)
      : activeScore;
  const vitality = Math.round(0.55 * activeScore + 0.45 * mergeScore);

  return {
    login: user.login,
    name: user.name ?? null,
    bio: user.bio ?? null,
    createdAt: user.created_at,
    followers: user.followers ?? 0,
    following: user.following ?? 0,
    publicRepos: user.public_repos ?? houses.length,
    houses,
    contributions,
    prStats,
    vitality,
  };
}

function buildStory(hood) {
  const c = hood.contributions;
  const lit = hood.houses.filter((h) => h.freshness >= 0.6).length;
  const homes = `${lit} of ${hood.houses.length} homes have their lights on`;
  if (!c) return `The calendar was dark, but the street tells its own story — ${homes}.`;
  return (
    `${c.total.toLocaleString()} contributions in the last year, ` +
    `spread over ${c.activeDays} days — ${homes}.`
  );
}

// A visitor re-checking the same profile within 10 minutes hits the cache,
// not GitHub. localStorage may be unavailable (private mode) — degrade quietly.
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet(login) {
  try {
    const raw = localStorage.getItem(`hood:${login.toLowerCase()}`);
    if (!raw) return null;
    const { t, hood } = JSON.parse(raw);
    return Date.now() - t < CACHE_TTL ? hood : null;
  } catch {
    return null;
  }
}

function cacheSet(login, hood) {
  try {
    localStorage.setItem(`hood:${login.toLowerCase()}`, JSON.stringify({ t: Date.now(), hood }));
  } catch {
    /* full or unavailable — fine */
  }
}

// ---- SVG helpers -----------------------------------------------------------------

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Render a rough.js drawable as sketchy SVG paths inside a <g>. */
function R(drawable, attrs = {}) {
  const g = svgEl("g", attrs);
  for (const p of gen.toPaths(drawable)) {
    g.appendChild(
      svgEl("path", {
        d: p.d,
        stroke: p.stroke,
        "stroke-width": p.strokeWidth,
        fill: p.fill && p.fill !== "none" ? p.fill : "none",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    );
  }
  return g;
}

function svgText(x, y, cls, content, anchor) {
  const t = svgEl("text", { x, y, class: cls });
  if (anchor) t.setAttribute("text-anchor", anchor);
  t.textContent = content;
  return t;
}

function starPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}

// ---- Sky -------------------------------------------------------------------------

function drawSky(svg, height) {
  const rnd = mulberry32(42);
  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height, fill: "url(#sky)" }));
  const stars = Array.from({ length: 46 }, (_, i) => ({
    x: 24 + rnd() * (W - 48),
    y: 36 + rnd() * 90,
    r: 0.7 + rnd() * 1,
    tw: i % 2 === 0,
    delay: rnd() * 4,
  })).filter((s) => !(s.x > W - 140 && s.y < 100)); // keep the moon's corner clear
  for (const s of stars) {
    const c = svgEl("circle", { cx: s.x, cy: s.y, r: s.r, fill: "#dfe6f5", opacity: 0.6 });
    if (s.tw) {
      c.setAttribute("class", "star-tw");
      c.style.animationDelay = `${s.delay}s`;
    }
    svg.appendChild(c);
  }
  // doodled crescent moon
  svg.appendChild(R(gen.circle(W - 84, 64, 36, { seed: 11, stroke: "#e9e4d2", strokeWidth: 1.2, roughness: 1.6, fill: "#e9e4d2", fillStyle: "solid" }), { opacity: 0.85 }));
  svg.appendChild(svgEl("circle", { cx: W - 77, cy: 58, r: 16, fill: "#0d101d" }));
  svg.appendChild(R(gen.circle(W - 84, 64, 52, { seed: 13, stroke: "#e9e4d2", strokeWidth: 0.8, roughness: 2.4 }), { opacity: 0.14 }));
}

// ---- A single lit/dark window ------------------------------------------------

function drawWin(parent, x, y, w, h, fr, seed, flicker, delay) {
  const look = windowLook(fr);
  const g = svgEl("g");
  if (look.glow && flicker) {
    g.setAttribute("class", "win-flicker");
    g.style.animationDelay = `${delay}s`;
  }
  if (look.glow) {
    g.appendChild(svgEl("rect", { x: x - 3, y: y - 3, width: w + 6, height: h + 6, rx: 3, fill: look.fill, opacity: 0.22 }));
  }
  g.appendChild(
    R(gen.rectangle(x, y, w, h, {
      seed,
      fill: look.fill,
      fillStyle: "solid",
      stroke: look.glow ? "#e8c078" : "#767e90",
      strokeWidth: 1,
      roughness: 1.1,
    })),
  );
  parent.appendChild(g);
}

// ---- One home per repo ---------------------------------------------------------

function drawHouse(svg, house, cx, groundY, scale, roadTopY) {
  const h = hash(house.name);
  const seed = (h % 9973) + 1;
  const bodyW = 92 * scale;
  const bodyH = 74 * scale;
  const left = cx - bodyW / 2;
  const bodyTop = groundY - bodyH;
  const roofColor = langColor(house.language);
  const roofH = (26 + (h % 12)) * scale;
  const hipRoof = !house.isFork && h % 3 === 2; // flat-topped trapezoid variant
  const peakY = bodyTop - roofH;
  const lit = house.freshness >= 0.6;
  const smoking = house.freshness >= 0.95; // pushed within days — chimney's going
  const hasChimney = !house.isFork && (h >> 3) % 2 === 0;
  const chimneyX = cx + bodyW * (0.16 + ((h >> 5) % 2) * 0.06);
  const doorColor = DOOR_COLORS[(h >> 7) % DOOR_COLORS.length];
  const doorShift = (((h >> 9) % 3) - 1) * bodyW * 0.2;
  const doorX = cx + doorShift;
  const bushLeft = (h >> 11) % 2 === 0;
  const bushRight = (h >> 12) % 3 === 0;

  // Bigger repos earn a 3x2 window grid instead of 2x2.
  const sixWins = house.sizeKB > 500;
  const cols = sixWins ? 3 : 2;
  const winCount = cols * 2;
  const falloff = sixWins ? [1, 0.92, 0.82, 0.74, 0.66, 0.58] : [1, 0.9, 0.78, 0.62];
  const winFr = falloff.map((k) => (house.freshness < 0 ? -1 : house.freshness * k));
  const ws = (sixWins ? 17 : 22) * scale;
  const gap = (sixWins ? 8 : 11) * scale;
  const gridW = cols * ws + (cols - 1) * gap;
  const gridLeft = left + (bodyW - gridW) / 2;
  const gridTop = bodyTop + (bodyH - (2 * ws + gap)) / 2 - 4;
  const label = house.name.length > 12 ? `${house.name.slice(0, 11)}…` : house.name;

  const g = svgEl("g");
  const title = svgEl("title");
  title.textContent = `${house.name}${house.isFork ? " (fork)" : ""} · ${house.language ?? "—"} · ★${house.stars} · last push ${house.pushedAt.slice(0, 10)}`;
  g.appendChild(title);

  // footpath from the front door down to the road
  g.appendChild(
    R(gen.line(doorX, groundY, doorX + (((h >> 4) % 5) - 2) * 2, roadTopY, {
      seed: seed + 14, stroke: "#4a5162", strokeWidth: 1.1, roughness: 1.6, strokeLineDash: [3, 6],
    })),
  );
  // warm light pooling on the ground under a lit home
  if (lit) {
    g.appendChild(svgEl("ellipse", { cx, cy: groundY + 4, rx: bodyW * 0.8, ry: 10, fill: "url(#spill)", opacity: 0.55 }));
  }
  // this house's little plot
  g.appendChild(R(gen.line(left - 16, groundY, left + bodyW + 16, groundY, { seed: seed + 1, stroke: "#3d4450", strokeWidth: 1.2, roughness: 1.8 })));
  // grass tufts
  g.appendChild(R(gen.linearPath([[left - 8, groundY], [left - 6, groundY - 5], [left - 4, groundY]], { seed: seed + 2, stroke: "#2e4436", roughness: 1.4 })));
  g.appendChild(R(gen.linearPath([[left + bodyW + 4, groundY], [left + bodyW + 6, groundY - 6], [left + bodyW + 8, groundY]], { seed: seed + 3, stroke: "#2e4436", roughness: 1.4 })));

  if (hasChimney) {
    g.appendChild(R(gen.rectangle(chimneyX, peakY - 5, 7 * scale, roofH, { seed: seed + 4, fill: "#4a3f52", fillStyle: "hachure", hachureGap: 3, stroke: CHALK, strokeWidth: 1, roughness: 1.4 })));
    if (smoking) {
      [0, 1.4, 2.8].forEach((d) => {
        const puff = svgEl("circle", { cx: chimneyX + 3.5 * scale, cy: peakY - 10, r: 2.6, fill: "#9aa0ad", class: "smoke-puff" });
        puff.style.animationDelay = `${d}s`;
        g.appendChild(puff);
      });
    }
  }

  if (house.isFork) {
    // Forks read as sheds: flat parapet instead of a gabled roof.
    g.appendChild(R(gen.rectangle(left - 7, bodyTop - 11, bodyW + 14, 11, { seed: seed + 5, fill: "#57496b", fillStyle: "hachure", hachureGap: 4, stroke: CHALK, strokeWidth: 1.1, roughness: 1.5 })));
  } else {
    const roofPts = hipRoof
      ? [[left - 10, bodyTop], [left + bodyW * 0.28, peakY], [left + bodyW * 0.72, peakY], [left + bodyW + 10, bodyTop]]
      : [[left - 10, bodyTop], [cx, peakY], [left + bodyW + 10, bodyTop]];
    g.appendChild(R(gen.polygon(roofPts, { seed: seed + 6, fill: roofColor, fillStyle: "hachure", hachureGap: 5, fillWeight: 0.9, stroke: CHALK, strokeWidth: 1.2, roughness: 1.6 })));
  }
  g.appendChild(R(gen.rectangle(left, bodyTop, bodyW, bodyH, { seed: seed + 7, fill: "#4a5164", fillStyle: "hachure", hachureGap: 6, fillWeight: 0.7, stroke: CHALK, strokeWidth: 1.2, roughness: 1.5 })));

  winFr.slice(0, winCount).forEach((fr, i) => {
    drawWin(
      g,
      gridLeft + (i % cols) * (ws + gap),
      gridTop + Math.floor(i / cols) * (ws + gap),
      ws,
      ws,
      fr,
      seed + 20 + i,
      ((h >> (13 + i)) & 3) === 0,
      ((h >> i) % 50) / 10,
    );
  });

  g.appendChild(R(gen.rectangle(doorX - 6 * scale, groundY - 18 * scale, 12 * scale, 18 * scale, { seed: seed + 8, fill: doorColor, fillStyle: "solid", stroke: CHALK, strokeWidth: 1, roughness: 1.3 })));
  g.appendChild(svgEl("circle", { cx: doorX + 3.5 * scale, cy: groundY - 9 * scale, r: 1.3, fill: "#f5b450" }));

  if (bushLeft) {
    g.appendChild(R(gen.circle(left - 12, groundY - 4, 11, { seed: seed + 9, fill: "#2a4a35", fillStyle: "hachure", hachureGap: 3, stroke: "#4d7a5c", roughness: 1.7 })));
  }
  if (bushRight) {
    g.appendChild(R(gen.circle(left + bodyW + 13, groundY - 4, 10, { seed: seed + 11, fill: "#2a4a35", fillStyle: "hachure", hachureGap: 3, stroke: "#4d7a5c", roughness: 1.7 })));
  }
  if (house.stars > 0) {
    const badgeY = house.isFork ? bodyTop - 12 : peakY;
    g.appendChild(R(gen.polygon(starPoints(cx, badgeY - 9, 6), { seed: seed + 12, fill: "#f5b450", fillStyle: "solid", stroke: "#8a6420", strokeWidth: 1, roughness: 1.2 })));
    if (house.stars > 1) g.appendChild(svgText(cx + 10, badgeY - 5, "floor-label", String(house.stars)));
  }
  g.appendChild(svgText(cx, groundY + 15, "floor-label", label, "middle"));
  svg.appendChild(g);
}

// ---- The serpentine road ---------------------------------------------------------

function serpentinePoints(bandYs) {
  const pts = [];
  bandYs.forEach((y, b) => {
    const dir = b % 2 === 0 ? 1 : -1;
    const xs = [];
    for (let x = 56; x <= 704; x += 36) xs.push(x);
    if (dir === -1) xs.reverse();
    for (const x of xs) pts.push([x, y]);
    if (b < bandYs.length - 1) {
      // U-turn down to the next stretch
      const y2 = bandYs[b + 1];
      const cxTurn = dir === 1 ? 704 : 56;
      const bulge = dir === 1 ? 40 : -40;
      for (let t = 1; t < 8; t++) {
        const th = (t / 8) * Math.PI;
        pts.push([cxTurn + bulge * Math.sin(th), y + ((y2 - y) * (1 - Math.cos(th))) / 2]);
      }
    }
  });
  return pts;
}

function offsetPath(pts, off) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / len) * off, p[1] + (dx / len) * off];
  });
}

function drawRoad(svg, bandYs) {
  const center = serpentinePoints(bandYs);
  svg.appendChild(R(gen.curve(offsetPath(center, -ROAD_HALF), { seed: 21, stroke: "#4a5162", strokeWidth: 1.5, roughness: 1.7 })));
  svg.appendChild(R(gen.curve(offsetPath(center, ROAD_HALF), { seed: 22, stroke: "#4a5162", strokeWidth: 1.5, roughness: 1.7 })));
  svg.appendChild(R(gen.curve(center, { seed: 23, stroke: "#565e70", strokeWidth: 1.3, roughness: 1.5, strokeLineDash: [12, 11] })));
}

// ---- Street lamps: months flow along the road's direction ------------------------

function drawLamps(svg, months, bandYs) {
  const max = Math.max(1, ...months.map((m) => m.count));
  const brightest = months.reduce((best, m, i) => (m.count > months[best].count ? i : best), 0);

  // Distribute the 12 months across the stretches, following the road.
  const bands = bandYs.length;
  const counts = bandYs.map((_, b) => Math.floor(months.length / bands) + (b < months.length % bands ? 1 : 0));
  const placed = [];
  let idx = 0;
  counts.forEach((n, b) => {
    const dir = b % 2 === 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const frac = (i + 0.5) / n;
      const x = dir === 1 ? 92 + frac * 576 : W - 92 - frac * 576;
      placed.push({ m: months[idx], j: idx, x, y: bandYs[b] + 46 });
      idx++;
    }
  });

  const layer = svgEl("g");
  const tipLayer = svgEl("g", { "pointer-events": "none" });

  function showTip(p) {
    tipLayer.textContent = ""; // clear
    const text = `${p.m.label} · ${p.m.count} contribution${p.m.count === 1 ? "" : "s"}`;
    const bw = text.length * 7.4 + 26;
    const bh = 30;
    const bx = Math.min(Math.max(8, p.x - bw / 2), W - bw - 8);
    const by = p.y - 28 - 52;
    tipLayer.appendChild(R(gen.line(p.x, by + bh, p.x, p.y - 40, { seed: (hash(p.m.month) % 9973) + 8, stroke: CHALK, strokeWidth: 1, roughness: 1.6 })));
    tipLayer.appendChild(R(gen.rectangle(bx, by, bw, bh, { seed: (hash(p.m.month) % 9973) + 9, fill: "#171a24", fillStyle: "solid", stroke: CHALK, strokeWidth: 1.2, roughness: 1.5 })));
    tipLayer.appendChild(svgText(bx + bw / 2, by + 20, "tip-label", text, "middle"));
  }

  for (const p of placed) {
    const { m, j, x, y } = p;
    const seed = (hash(m.month) % 9973) + 1;
    const k = m.count / max;
    const headY = y - 28;
    const g = svgEl("g");
    g.style.cursor = "pointer";

    const hoverRing = svgEl("circle", { cx: x, cy: headY, r: 13 + 12 * k, fill: "#f5b450", opacity: 0.3, visibility: "hidden" });
    g.appendChild(hoverRing);

    if (k > 0) {
      g.appendChild(svgEl("polygon", {
        points: `${x},${headY} ${x - 7 - 11 * k},${y + 6} ${x + 7 + 11 * k},${y + 6}`,
        fill: "url(#cone)",
        opacity: 0.1 + 0.28 * k,
      }));
    }
    g.appendChild(R(gen.line(x, y, x, headY + 4, { seed: seed + 1, stroke: "#8b93a5", strokeWidth: 1.5, roughness: 1.3 })));
    if (k > 0) {
      const glowWrap = svgEl("g", { class: "lamp-breathe" });
      glowWrap.style.animationDelay = `${j * 0.45}s`;
      glowWrap.appendChild(svgEl("circle", { cx: x, cy: headY, r: 7 + 12 * k, fill: "#f5b450", opacity: 0.1 + 0.2 * k }));
      g.appendChild(glowWrap);
    }
    g.appendChild(R(gen.circle(x, headY, 9, {
      seed: seed + 3,
      fill: k > 0 ? `rgba(245, 180, 80, ${0.35 + 0.65 * k})` : "#20242e",
      fillStyle: "solid",
      stroke: CHALK,
      strokeWidth: 1,
      roughness: 1.2,
    })));
    if (j === brightest && m.count > 0) {
      [0, 1.7, 3.4].forEach((d, f) => {
        const fly = svgEl("circle", { cx: x + (f - 1) * 12, cy: headY - 12 + f * 4, r: 1.5, fill: "#ffd98a", class: "firefly" });
        fly.style.animationDelay = `${d}s`;
        g.appendChild(fly);
      });
    }
    g.appendChild(svgText(x + 13, y + 2, "floor-label", m.label, "start"));
    // generous invisible hit area so the lamp is easy to hover
    g.appendChild(svgEl("circle", { cx: x, cy: headY + 8, r: 22, fill: "transparent" }));

    g.addEventListener("mouseenter", () => {
      hoverRing.setAttribute("visibility", "visible");
      showTip(p);
    });
    g.addEventListener("mouseleave", () => {
      hoverRing.setAttribute("visibility", "hidden");
      tipLayer.textContent = "";
    });
    layer.appendChild(g);
  }

  svg.appendChild(layer);
  svg.appendChild(tipLayer); // last: the bubble paints above everything
}

// ---- Scene assembly ---------------------------------------------------------------

function gradientDefs() {
  const defs = svgEl("defs");
  const sky = svgEl("linearGradient", { id: "sky", x1: 0, y1: 0, x2: 0, y2: 1 });
  [["0", "#0a0d18"], ["0.15", "#12162a"], ["0.35", "#151929"], ["1", "#171a26"]].forEach(([o, c]) => {
    sky.appendChild(svgEl("stop", { offset: o, "stop-color": c }));
  });
  const spill = svgEl("radialGradient", { id: "spill", cx: 0.5, cy: 0.5, r: 0.5 });
  spill.appendChild(svgEl("stop", { offset: 0, "stop-color": "#f5b450", "stop-opacity": 0.35 }));
  spill.appendChild(svgEl("stop", { offset: 1, "stop-color": "#f5b450", "stop-opacity": 0 }));
  const cone = svgEl("linearGradient", { id: "cone", x1: 0, y1: 0, x2: 0, y2: 1 });
  cone.appendChild(svgEl("stop", { offset: 0, "stop-color": "#f5b450", "stop-opacity": 0.55 }));
  cone.appendChild(svgEl("stop", { offset: 1, "stop-color": "#f5b450", "stop-opacity": 0.05 }));
  defs.append(sky, spill, cone);
  return defs;
}

function buildScene(hood) {
  const houses = hood.houses.slice(0, MAX_HOUSES);
  const overflow = hood.houses.length - houses.length;
  const bands = Math.max(1, Math.ceil(houses.length / PER_BAND));
  const bandYs = Array.from({ length: bands }, (_, b) => BAND_Y0 + b * BAND_H);
  const height = bandYs[bands - 1] + 78 + (overflow > 0 ? 14 : 0);
  const maxKB = Math.max(1, ...houses.map((h) => h.sizeKB));
  const brightest = hood.contributions
    ? hood.contributions.months.reduce((a, b) => (b.count > a.count ? b : a))
    : null;

  const wrap = document.createElement("div");
  wrap.className = "building-wrap";

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${height}`,
    class: "building",
    role: "img",
    "aria-label": "GitHub profile as a doodled village along a winding road",
  });
  svg.appendChild(gradientDefs());
  drawSky(svg, height);

  svg.appendChild(svgText(W / 2, 32, "name-sign", `@${hood.login}'s homestead`, "middle"));
  svg.appendChild(R(gen.line(W / 2 - 96, 42, W / 2 + 96, 40, { seed: 31, stroke: "#6b7280", strokeWidth: 1.3, roughness: 2.4 })));

  drawRoad(svg, bandYs);

  houses.forEach((house, i) => {
    const b = Math.floor(i / PER_BAND);
    const idxInBand = i % PER_BAND;
    const dir = b % 2 === 0 ? 1 : -1;
    const slot = dir === 1 ? idxInBand : PER_BAND - 1 - idxInBand; // follow the road
    const h = hash(house.name);
    const cx = SLOT_X0 + slot * SLOT_STEP + ((h % 17) - 8);
    const roadTopY = bandYs[b] - ROAD_HALF;
    const groundY = roadTopY - 22; // a small verge between plot and road
    // Bigger repos get slightly bigger lots (log scale keeps it tasteful).
    const scale = 0.62 + 0.23 * (Math.log1p(house.sizeKB) / Math.log1p(maxKB));
    drawHouse(svg, house, cx, groundY, scale, roadTopY);
  });

  // lamps last: SVG paints in document order, and the hover bubble must sit on top
  if (hood.contributions) drawLamps(svg, hood.contributions.months, bandYs);

  if (overflow > 0) {
    svg.appendChild(svgText(W / 2, height - 6, "floor-label", `+${overflow} more homes down the road…`, "middle"));
  }
  wrap.appendChild(svg);

  const caption = document.createElement("div");
  caption.className = "building-caption";
  const badge = document.createElement("span");
  badge.className = "typo-badge";
  badge.textContent = "🏘 neighborhood";
  const capText = document.createElement("span");
  capText.textContent =
    `${houses.length} homes along the road` +
    (brightest ? ` · brightest month: ${brightest.label} (${brightest.count})` : "");
  caption.append(badge, capText);
  wrap.appendChild(caption);

  const legend = document.createElement("div");
  legend.className = "legend";
  const entries = [
    [windowLook(1).fill, "lit · pushed recently", false],
    [windowLook(0.4).fill, "dim · this year", false],
    [windowLook(0).fill, "dark · asleep", false],
    ["#f5b450", "lamp = month of commits", true],
    ["#9aa0ad", "smoke = pushed this week", true],
  ];
  for (const [color, text, round] of entries) {
    const span = document.createElement("span");
    const i = document.createElement("i");
    i.style.background = color;
    if (round) i.style.borderRadius = "50%";
    span.append(i, document.createTextNode(` ${text}`));
    legend.appendChild(span);
  }
  wrap.appendChild(legend);
  return wrap;
}

// ---- Stats panel ----------------------------------------------------------------

function scoreColor(score) {
  if (score >= 70) return "#5fd18a";
  if (score >= 45) return "#e2c34b";
  return "#e57373";
}

function buildPanel(hood) {
  const c = hood.contributions;
  const pr = hood.prStats;
  const rows = [];

  if (c) {
    const activePct = Math.round((c.activeDays / 365) * 100);
    rows.push({
      label: "Days with the lights on",
      score: activePct,
      display: `${activePct}%`,
      detail: `${c.activeDays} of the last 365 days · ${c.total.toLocaleString()} contributions`,
    });
    // Momentum: trailing 3 months vs the 9 before them.
    const recent = c.months.slice(-3);
    const before = c.months.slice(0, -3);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const now = avg(recent.map((m) => m.count));
    const base = avg(before.map((m) => m.count));
    const ratio = base > 0 ? now / base : now > 0 ? 2 : 1;
    rows.push({
      label: "Momentum",
      score: Math.min(100, Math.round(ratio * 50)),
      display: ratio >= 1.15 ? "rising" : ratio <= 0.85 ? "cooling" : "steady",
      detail: `${Math.round(now)}/mo lately vs ${Math.round(base)}/mo before`,
    });
  }
  if (pr && pr.sampled > 0) {
    const rate = Math.round((pr.merged / pr.sampled) * 100);
    rows.push({
      label: "PRs that made it home",
      score: rate,
      display: `${rate}%`,
      detail: `${pr.merged} merged of ${pr.sampled} recent public PRs (${pr.total} all-time)`,
    });
  }
  const lit = hood.houses.filter((h) => h.freshness >= 0.6).length;
  if (hood.houses.length > 0) {
    rows.push({
      label: "Homes with lit windows",
      score: Math.round((lit / hood.houses.length) * 100),
      display: `${lit}/${hood.houses.length}`,
      detail: "repos pushed in the last ~3 months",
    });
  }

  const panel = document.createElement("div");

  const overall = document.createElement("div");
  overall.className = "overall";
  const ring = document.createElement("div");
  ring.className = "ring";
  ring.style.setProperty("--score", hood.vitality);
  ring.style.setProperty("--col", scoreColor(hood.vitality));
  const ringVal = document.createElement("span");
  ringVal.textContent = String(hood.vitality);
  ring.appendChild(ringVal);
  const overallLabel = document.createElement("div");
  overallLabel.className = "overall-label";
  overallLabel.textContent = "Street vitality";
  overall.append(ring, overallLabel);
  panel.appendChild(overall);

  const ul = document.createElement("ul");
  ul.className = "vitals";
  for (const v of rows) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "vital-head";
    const lbl = document.createElement("span");
    lbl.className = "vital-label";
    lbl.textContent = v.label;
    const scr = document.createElement("span");
    scr.className = "vital-score";
    scr.style.color = scoreColor(v.score);
    scr.textContent = v.display;
    head.append(lbl, scr);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${v.score}%`;
    fill.style.background = scoreColor(v.score);
    bar.appendChild(fill);
    const detail = document.createElement("div");
    detail.className = "vital-detail";
    detail.textContent = v.detail;
    li.append(head, bar, detail);
    ul.appendChild(li);
  }
  const factsLi = document.createElement("li");
  const facts = document.createElement("div");
  facts.className = "vital-detail";
  facts.textContent = `${hood.followers} followers · ${hood.publicRepos} public repos · resident since ${new Date(hood.createdAt).getFullYear()}`;
  factsLi.appendChild(facts);
  ul.appendChild(factsLi);
  panel.appendChild(ul);
  return panel;
}

// ---- Page wiring ------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const form = $("search-form");
const input = $("user-input");
const goBtn = $("go-btn");
const errorBox = $("error");
const resultSec = $("result");
const examplesBox = $("examples");

const EXAMPLES = ["blacklen", "sindresorhus", "gaearon"];

examplesBox.appendChild(document.createTextNode("Try: "));
for (const ex of EXAMPLES) {
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.type = "button";
  chip.textContent = ex;
  chip.addEventListener("click", () => {
    input.value = ex;
    run(ex);
  });
  examplesBox.appendChild(chip);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run(input.value);
});

async function run(raw) {
  const login = parseUserInput(raw ?? "");
  if (!login) {
    showError("Couldn't read a username from that. Try a github.com profile URL or a plain username.");
    return;
  }
  goBtn.disabled = true;
  goBtn.textContent = "Building…";
  errorBox.hidden = true;
  resultSec.hidden = true;
  try {
    let hood = cacheGet(login);
    if (!hood) {
      hood = await fetchHomestead(login);
      cacheSet(login, hood);
    }
    render(hood);
  } catch (err) {
    showError(err instanceof Error ? err.message : "Something went wrong building that neighborhood.");
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = "Move in";
  }
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function render(hood) {
  $("r-login").textContent = `@${hood.login}`;
  $("r-name").textContent = hood.name ?? "";
  $("r-stars").textContent = `★ ${hood.houses.reduce((s, h) => s + h.stars, 0).toLocaleString()}`;
  const bio = $("r-bio");
  bio.textContent = hood.bio ?? "";
  bio.hidden = !hood.bio;
  $("r-story").textContent = buildStory(hood);
  $("r-calnote").hidden = Boolean(hood.contributions);

  const scene = $("scene");
  scene.textContent = "";
  scene.appendChild(buildScene(hood));

  const panel = $("panel");
  panel.textContent = "";
  panel.appendChild(buildPanel(hood));

  resultSec.hidden = false;
}
