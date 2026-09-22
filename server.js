import http from "node:http";

const PORT = Number(process.env.PORT || 8080);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const GOD_MODE = true;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

const API_BASES = [
  "https://apiv2.nobitex.ir",
  "https://api.nobitex.ir"
];

let busy = false;
let lastScan = null;
let lastError = null;
let lastSignals = [];
let lastNotified = new Map();

/* =========================
   HTTP HEALTH SERVER
========================= */

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8"
  });

  res.end(JSON.stringify({
    status: "online",
    service: "Nobitex Hunter God Mode",
    godMode: GOD_MODE,
    lastScan,
    lastError,
    signals: lastSignals.length
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Nobitex Hunter running on port ${PORT}`);
});

/* =========================
   HTTP FETCH
========================= */

async function fetchWithTimeout(url, timeout = 15000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Nobitex-Hunter-GodMode/1.0"
      }
    });

    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url) {
  try {
    const response = await fetchWithTimeout(url, 15000);

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP_${response.status}`
      };
    }

    return {
      ok: true,
      data: await response.json(),
      via: "direct"
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || "FETCH_FAIL"
    };
  }
}

/* =========================
   NOBITEX STATS
========================= */

function buildStatsUrls() {
  return API_BASES.map(
    base => `${base}/market/stats?dstCurrency=rls`
  );
}

function parseStats(data) {
  if (!data) return [];

  const stats = data.stats || data;

  if (!stats || typeof stats !== "object") {
    return [];
  }

  const out = [];

  Object.keys(stats).forEach(key => {
    const row = stats[key];

    if (
      !row ||
      typeof row !== "object" ||
      row.isClosed === true
    ) {
      return;
    }

    const parts = key.split("-");

    let src = (parts[0] || "").toUpperCase();
    let dst = (parts[1] || "").toUpperCase();

    if (!src) return;

    if (dst === "RLS") {
      dst = "IRT";
    }

    const price = Number(
      row.latest ||
      row.dayClose ||
      0
    );

    const volume = Number(
      row.volumeDst || 0
    );

    const ch = Number(
      row.dayChange || 0
    );

    const bestBuy = Number(
      row.bestBuy || 0
    );

    const bestSell = Number(
      row.bestSell || 0
    );

    if (price <= 0) return;

    if (dst === "IRT" && volume < 30000000) {
      return;
    }

    if (dst === "USDT" && volume < 300) {
      return;
    }

    out.push({
      symbol: `${src}/${dst}`,
      key,
      src: src.toLowerCase(),
      dst: dst === "IRT" ? "rls" : dst.toLowerCase(),
      price,
      volume,
      ch,
      bestBuy,
      bestSell
    });
  });

  return out;
}

/* =========================
   OHLC
========================= */

async function fetchOHLC(marketKey, resolution) {
  const parts = marketKey.split("-");

  let src = (parts[0] || "").toUpperCase();
  let dst = (parts[1] || "").toUpperCase();

  if (dst === "RLS") {
    dst = "IRT";
  }

  const symbol = src + dst;

  const to = Math.floor(Date.now() / 1000);

  const hours =
    resolution === 15
      ? 24
      : resolution === 240
        ? 10 * 24
        : 48;

  const from = to - 60 * 60 * hours;

  for (const base of API_BASES) {
    const url =
      `${base}/market/udf/history` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&resolution=${resolution}` +
      `&from=${from}` +
      `&to=${to}`;

    const result = await fetchJSON(url);

    if (!result.ok || !result.data) {
      continue;
    }

    const d = result.data;

    if (
      d.s === "ok" &&
      Array.isArray(d.c) &&
      d.c.length >= 15
    ) {
      return {
        c: d.c.map(Number),
        o: d.o.map(Number),
        h: d.h.map(Number),
        l: d.l.map(Number),
        v: (d.v || []).map(Number),
        res: resolution
      };
    }
  }

  return null;
}

/* =========================
   INDICATORS
   EXACT HTML LOGIC
========================= */

function ema(arr, n) {
  if (arr.length < n) return null;

  const k = 2 / (n + 1);

  let e = arr[0];

  for (let i = 1; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
  }

  return e;
}

function sma(arr, n) {
  if (arr.length < n) return null;

  let s = 0;

  for (
    let i = arr.length - n;
    i < arr.length;
    i++
  ) {
    s += arr[i];
  }

  return s / n;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = closes.length - period;
    i < closes.length;
    i++
  ) {
    const d = closes[i] - closes[i - 1];

    if (d >= 0) {
      gains += d;
    } else {
      losses -= d;
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

function atr(h, l, c, period = 14) {
  if (h.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < h.length; i++) {
    const tr = Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    );

    trs.push(tr);
  }

  if (trs.length < period) {
    return null;
  }

  let s = 0;

  for (
    let i = trs.length - period;
    i < trs.length;
    i++
  ) {
    s += trs[i];
  }

  return s / period;
}

function macd(closes) {
  if (closes.length < 35) {
    return null;
  }

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  if (
    ema12 == null ||
    ema26 == null
  ) {
    return null;
  }

  const line = ema12 - ema26;

  return {
    line,
    hist: line,
    bull: line > 0
  };
}

function bollinger(closes, n = 20, k = 2) {
  if (closes.length < n) {
    return null;
  }

  const mid = sma(closes, n);

  let sum = 0;

  for (
    let i = closes.length - n;
    i < closes.length;
    i++
  ) {
    sum += Math.pow(
      closes[i] - mid,
      2
    );
  }

  const std = Math.sqrt(sum / n);

  return {
    mid,
    upper: mid + k * std,
    lower: mid - k * std,
    width: (2 * k * std) / mid * 100
  };
}

function stoch(h, l, c, period = 14) {
  if (h.length < period) {
    return null;
  }

  let hh = -Infinity;
  let ll = Infinity;

  for (
    let i = h.length - period;
    i < h.length;
    i++
  ) {
    if (h[i] > hh) hh = h[i];
    if (l[i] < ll) ll = l[i];
  }

  if (hh === ll) {
    return 50;
  }

  return (
    ((
      c[c.length - 1] - ll
    ) / (hh - ll)) * 100
  );
}

/* =========================
   CANDLE PATTERNS
========================= */

function detectPatterns(o, h, l, c) {
  const notes = [];

  const n = c.length;

  if (n < 3) {
    return notes;
  }

  const body = Math.abs(
    c[n - 1] - o[n - 1]
  );

  const range =
    h[n - 1] - l[n - 1];

  const upper =
    h[n - 1] -
    Math.max(c[n - 1], o[n - 1]);

  const lower =
    Math.min(c[n - 1], o[n - 1]) -
    l[n - 1];

  if (
    range > 0 &&
    lower > body * 2 &&
    upper < body * 0.5 &&
    body / range < 0.35
  ) {
    notes.push("Pinbar/Hammer");
  }

  const prevBody = Math.abs(
    c[n - 2] - o[n - 2]
  );

  if (
    c[n - 1] > o[n - 1] &&
    c[n - 2] < o[n - 2] &&
    c[n - 1] > o[n - 2] &&
    o[n - 1] < c[n - 2] &&
    body > prevBody * 1.1
  ) {
    notes.push("Bull Engulfing");
  }

  if (
    c[n - 1] < o[n - 1] &&
    c[n - 2] > o[n - 2] &&
    c[n - 1] < o[n - 2] &&
    o[n - 1] > c[n - 2] &&
    body > prevBody * 1.1
  ) {
    notes.push("Bear Engulfing");
  }

  if (
    range > 0 &&
    body / range < 0.1
  ) {
    notes.push("Doji");
  }

  return notes;
}

/* =========================
   ANALYZE TIMEFRAME
   EXACT HTML LOGIC
========================= */

function analyzeTF(ohlc) {
  if (
    !ohlc ||
    !ohlc.c ||
    ohlc.c.length < 20
  ) {
    return {
      ok: false,
      scoreAdd: 0,
      notes: [],
      conf: []
    };
  }

  const c = ohlc.c;
  const o = ohlc.o;
  const h = ohlc.h;
  const l = ohlc.l;
  const v = ohlc.v || [];

  const notes = [];
  const conf = [];

  let scoreAdd = 0;

  const last = c[c.length - 1];

  const ema9 = ema(c, 9);
  const ema21 = ema(c, 21);
  const ema50 = ema(c, 50);

  const r = rsi(c, 14);
  const a = atr(h, l, c, 14);
  const m = macd(c);
  const bb = bollinger(c, 20, 2);
  const st = stoch(h, l, c, 14);

  const patterns =
    detectPatterns(o, h, l, c);

  if (
    ema9 != null &&
    ema21 != null
  ) {
    if (
      ema9 > ema21 &&
      last > ema9
    ) {
      notes.push("روند صعودی (EMA)");
      scoreAdd += 10;
      conf.push("EMA↑");
    } else if (
      ema9 < ema21 &&
      last < ema9
    ) {
      notes.push("روند نزولی (EMA)");
      scoreAdd += 3;
      conf.push("EMA↓");
    }
  }

  if (
    ema50 != null &&
    last > ema50
  ) {
    scoreAdd += 4;
    conf.push("بالای EMA50");
  }

  if (r != null) {
    notes.push(
      "RSI≈" + r.toFixed(0)
    );

    if (
      r > 45 &&
      r < 65
    ) {
      scoreAdd += 8;
      conf.push("RSI خوب");
    } else if (r >= 70) {
      scoreAdd -= 12;
      conf.push("اشباع خرید");
    } else if (r <= 30) {
      scoreAdd += 5;
      conf.push("اشباع فروش");
    }
  }

  if (m && m.bull) {
    scoreAdd += 6;
    conf.push("MACD+");
    notes.push("MACD مثبت");
  } else if (m && !m.bull) {
    scoreAdd -= 2;
  }

  if (bb) {
    if (
      last < bb.lower * 1.01
    ) {
      scoreAdd += 5;
      conf.push("نزدیک کف BB");
      notes.push("نزدیک باند پایین");
    }

    if (
      last > bb.upper * 0.99
    ) {
      scoreAdd -= 6;
      conf.push("نزدیک سقف BB");
    }

    if (bb.width < 4) {
      notes.push(
        "فشردگی BB · احتمال انفجار"
      );
      scoreAdd += 4;
    }
  }

  if (st != null) {
    if (
      st > 20 &&
      st < 80
    ) {
      scoreAdd += 3;
    }

    if (st < 20) {
      scoreAdd += 4;
      conf.push("Stoch اشباع");
    }
  }

  if (v.length > 10) {
    let avgV = 0;

    for (
      let i = v.length - 10;
      i < v.length - 1;
      i++
    ) {
      avgV += v[i];
    }

    avgV /= 9;

    if (
      v[v.length - 1] >
      avgV * 1.8
    ) {
      scoreAdd += 6;
      conf.push("حجم اسپایک");
      notes.push("حجم بالا");
    }
  }

  patterns.forEach(p => {
    notes.push(p);
    scoreAdd += 5;
    conf.push(p);
  });

  const lows = l.slice(-8);
  const highs = h.slice(-8);

  if (
    lows[lows.length - 1] >
    lows[0]
  ) {
    scoreAdd += 5;
    conf.push("HL");
    notes.push("کف بالاتر");
  }

  if (
    highs[highs.length - 1] <
    highs[0]
  ) {
    scoreAdd += 2;
    notes.push("سقف پایین‌تر");
  }

  return {
    ok: true,
    scoreAdd,
    notes,
    conf,
    rsi: r,
    atr: a,
    ema9,
    ema21,
    bb,
    last
  };
}

/* =========================
   BASE SCORE
   EXACT HTML LOGIC
========================= */

function baseScore(s) {
  let score = 28;

  if (
    s.ch > 1.5 &&
    s.ch < 9
  ) {
    score += 18;
  }

  if (
    s.ch >= 0 &&
    s.ch <= 3
  ) {
    score += 8;
  }

  if (s.volume > 0) {
    score += 6;
  }

  if (s.ch > 14) {
    score -= 22;
  }

  if (s.ch < -7) {
    score -= 10;
  }

  if (
    s.bestBuy > 0 &&
    s.bestSell > 0
  ) {
    const mid =
      (s.bestBuy + s.bestSell) / 2;

    const spread =
      (s.bestSell - s.bestBuy) / mid;

    if (spread < 0.008) {
      score += 6;
    }

    if (spread > 0.035) {
      score -= 8;
    }
  }

  return score;
}

/* =========================
   CLASSIFICATION
   EXACT HTML LOGIC
========================= */

function classify(score, ch, th) {
  if (GOD_MODE) {
    if (
      score >= th + 8 &&
      ch > 2 &&
      ch < 11
    ) {
      return "GOD_SIGNAL";
    }

    if (
      score >= th &&
      ch > 1.5 &&
      ch < 10
    ) {
      return "EARLY_BREAKOUT";
    }

    if (
      score >= th - 5 &&
      ch >= 0 &&
      ch <= 4
    ) {
      return "PRE_MOVE";
    }

    if (score >= 62) {
      return "WATCHLIST";
    }

    return "WAIT";
  }

  if (
    score >= th &&
    ch > 3 &&
    ch < 10
  ) {
    return "EARLY_BREAKOUT";
  }

  if (
    score >= th - 6 &&
    ch >= 0 &&
    ch <= 4
  ) {
    return "PRE_MOVE";
  }

  if (score >= 58) {
    return "WATCHLIST";
  }

  return "WAIT";
}

/* =========================
   SUCCESS PROBABILITY
   EXACT HTML LOGIC
========================= */

function successProb(item) {
  let p = 38;

  p +=
    (item.score - 60) * 0.95;

  if (
    item.tech &&
    item.tech.ok
  ) {
    p +=
      item.tech.scoreAdd * 0.55;
  }

  if (
    item.levels &&
    item.levels.rr2 >= 2.8
  ) {
    p += 8;
  }

  if (
    item.levels &&
    item.levels.rr2 < 1.9
  ) {
    p -= 10;
  }

  if (
    Math.abs(item.ch) > 13
  ) {
    p -= 14;
  }

  if (item.rsi != null) {
    if (item.rsi > 72) {
      p -= 12;
    }

    if (
      item.rsi > 48 &&
      item.rsi < 62
    ) {
      p += 6;
    }
  }

  if (
    GOD_MODE &&
    item.confluence &&
    item.confluence.length >= 4
  ) {
    p += 7;
  }

  p = Math.max(
    15,
    Math.min(
      88,
      Math.round(p)
    )
  );

  return p;
}

/* =========================
   LEVERAGE
   EXACT HTML LOGIC
========================= */

function leverageDecision(item) {
  let dir = "WAIT";

  if (
    item.classification === "GOD_SIGNAL" ||
    item.classification === "EARLY_BREAKOUT" ||
    item.classification === "PRE_MOVE"
  ) {
    dir = "LONG";
  } else if (
    item.ch <= -3 &&
    item.score >= 60
  ) {
    dir = "SHORT";
  } else if (
    item.ch >= 1.2 &&
    item.score >= 62
  ) {
    dir = "LONG";
  } else if (
    item.ch <= -1.5 &&
    item.score >= 62
  ) {
    dir = "SHORT";
  }

  let lev = 1;

  const absCh =
    Math.abs(item.ch || 0);

  const sc =
    item.score || 0;

  if (dir === "WAIT") {
    return {
      dir,
      lev: 1,
      note: "سیگنال اهرمی نیست",
      riskIfStop: null
    };
  }

  if (
    sc >= 90 &&
    absCh >= 1.5 &&
    absCh <= 8
  ) {
    lev = 5;
  } else if (
    sc >= 82 &&
    absCh >= 1.2 &&
    absCh <= 10
  ) {
    lev = 3;
  } else if (
    sc >= 72
  ) {
    lev = 2;
  }

  if (absCh > 12) {
    lev = Math.min(lev, 2);
  }

  if (absCh > 17) {
    lev = 1;
  }

  if (
    (item.levels?.rr2 || 0) < 2.2
  ) {
    lev = Math.min(lev, 2);
  }

  const stopPct =
    item.levels
      ? Math.abs(
          (
            item.levels.entry -
            item.levels.stop
          ) /
          item.levels.entry
        )
      : 0.05;

  return {
    dir,
    lev,
    note:
      (dir === "LONG"
        ? "سناریوی صعودی"
        : "سناریوی نزولی") +
      " · اهرم x" +
      lev,
    riskIfStop:
      +(stopPct * lev * 100)
        .toFixed(1)
  };
}

/* =========================
   TELEGRAM
========================= */

async function sendTelegram(text) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    console.log(
      "Telegram ENV not configured"
    );

    return false;
  }

  const url =
    `https://api.telegram.org/bot` +
    `${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response =
      await fetchWithTimeout(
        url,
        15000
      );

    // بالا عمداً GET نیست؛ ارسال واقعی پایین انجام می‌شود
    void response;
  } catch {}

  try {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        15000
      );

    const response =
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          chat_id:
            TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview:
            true
        }),
        signal: controller.signal
      });

    clearTimeout(timer);

    const data =
      await response.json();

    if (!data.ok) {
      console.error(
        "Telegram error:",
        data
      );

      return false;
    }

    return true;
  } catch (e) {
    console.error(
      "Telegram send failed:",
      e?.message
    );

    return false;
  }
}

/* =========================
   TELEGRAM SIGNAL FORMAT
========================= */

function formatPrice(n) {
  if (!Number.isFinite(Number(n))) {
    return "—";
  }

  const x = Number(n);

  if (x >= 1000) {
    return Math.round(x)
      .toLocaleString("en-US");
  }

  if (x >= 1) {
    return x.toLocaleString(
      "en-US",
      {
        maximumFractionDigits: 4
      }
    );
  }

  return x.toPrecision(5);
}

function signalEmoji(type) {
  if (type === "GOD_SIGNAL") {
    return "🚀";
  }

  if (type === "EARLY_BREAKOUT") {
    return "🔥";
  }

  if (type === "PRE_MOVE") {
    return "👀";
  }

  return "📊";
}

function formatSignal(s) {
  const emoji =
    signalEmoji(
      s.classification
    );

  const side =
    s.side || "WAIT";

  const sideEmoji =
    side === "LONG"
      ? "🟢"
      : side === "SHORT"
        ? "🔴"
        : "⚪";

  const notes =
    (
      s.tech?.notes || []
    )
      .slice(0, 7)
      .map(x => `• ${x}`)
      .join("\n");

  const conf =
    (
      s.confluence || []
    )
      .slice(0, 8)
      .join(" · ");

  return (
`${emoji} ${s.classification}

💎 ${s.symbol}

⭐ Score: ${s.score}/98
📈 Change: ${s.ch.toFixed(2)}%
🎯 Probability: ${s.prob}%

${sideEmoji} Direction: ${side}
⚡ Leverage: x${s.leverage || 1}

💰 Entry: ${formatPrice(s.levels.entry)}
🛑 Stop: ${formatPrice(s.levels.stop)}
🎯 T1: ${formatPrice(s.levels.t1)}
🎯 T2: ${formatPrice(s.levels.t2)}

📐 R/R: ${s.levels.rr2}

🔬 Confluence:
${conf || "—"}

🧠 Technical:
${notes || "—"}

⚠️ این خروجی تحلیل الگوریتمی است و تضمین سود نیست.`
  );
}

/* =========================
   SCAN
========================= */

async function scan() {
  if (busy) {
    return;
  }

  busy = true;

  console.log(
    "\n=============================="
  );

  console.log(
    "Nobitex Hunter scan started:",
    new Date().toISOString()
  );

  try {
    let pack = null;

    let lastErr = "";

    const urls =
      buildStatsUrls();

    for (
      let i = 0;
      i < urls.length && !pack;
      i++
    ) {
      const result =
        await fetchJSON(urls[i]);

      if (!result.ok) {
        lastErr =
          result.error ||
          "FETCH_FAIL";

        continue;
      }

      const list =
        parseStats(result.data);

      if (list.length < 5) {
        lastErr =
          "LIST_SMALL";

        continue;
      }

      pack = {
        list,
        via: result.via
      };
    }

    if (!pack) {
      throw new Error(
        "NOBITEX_DATA_FAILED: " +
        lastErr
      );
    }

    console.log(
      "Market pairs:",
      pack.list.length
    );

    /* =========================
       REGIME
    ========================= */

    let avg = 0;

    pack.list.forEach(
      x => {
        avg += x.ch;
      }
    );

    avg /=
      pack.list.length;

    const regime =
      avg <= -2.5
        ? "BEARISH"
        : avg <= -0.8
          ? "WEAK"
          : avg >= 1.5
            ? "BULLISH"
            : "NEUTRAL";

    const th = {
      BULLISH: 72,
      NEUTRAL: 78,
      WEAK: 84,
      BEARISH: 90
    }[regime] || 74;

    console.log(
      "Regime:",
      regime,
      "Average:",
      avg.toFixed(3),
      "Threshold:",
      th
    );

    /* =========================
       PRELIM
    ========================= */

    let prelim = [];

    pack.list.forEach(s => {
      const score =
        baseScore(s);

      if (score < 52) {
        return;
      }

      const entry =
        s.price;

      const stop =
        entry * 0.94;

      const t1 =
        entry * 1.08;

      const t2 =
        entry * 1.16;

      const risk =
        entry - stop;

      const rr2 =
        risk > 0
          ? +(
              (t2 - entry) /
              risk
            ).toFixed(2)
          : 0;

      if (rr2 < 1.6) {
        return;
      }

      prelim.push({
        id:
          `${s.symbol}_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 6)}`,

        symbol:
          s.symbol,

        key:
          s.key,

        price:
          entry,

        ch:
          s.ch,

        volume:
          s.volume,

        score:
          Math.min(88, score),

        classification:
          "WAIT",

        levels: {
          entry,
          stop,
          t1,
          t2,
          rr2
        },

        signalTime:
          new Date().toISOString(),

        currentPrice:
          entry
      });
    });

    prelim.sort(
      (a, b) =>
        b.score - a.score
    );

    prelim =
      prelim.slice(0, 10);

    console.log(
      "Preliminary candidates:",
      prelim.length
    );

    /* =========================
       GOD MULTI TIMEFRAME
    ========================= */

    const enriched = [];

    for (
      let i = 0;
      i < prelim.length;
      i++
    ) {
      const item =
        prelim[i];

      console.log(
        `Analyzing ${i + 1}/${prelim.length}: ${item.symbol}`
      );

      const ohlc60 =
        await fetchOHLC(
          item.key,
          60
        );

      const tech60 =
        analyzeTF(
          ohlc60
        );

      const tech15 =
        analyzeTF(
          await fetchOHLC(
            item.key,
            15
          )
        );

      const tech240 =
        analyzeTF(
          await fetchOHLC(
            item.key,
            240
          )
        );

      let totalAdd =
        tech60.scoreAdd || 0;

      let allNotes =
        (
          tech60.notes || []
        ).slice();

      let allConf =
        (
          tech60.conf || []
        ).slice();

      if (tech15.ok) {
        totalAdd +=
          tech15.scoreAdd * 0.6;

        allNotes =
          allNotes.concat(
            tech15.notes.map(
              n =>
                "15m: " + n
            )
          );

        allConf =
          allConf.concat(
            tech15.conf
          );
      }

      if (tech240.ok) {
        totalAdd +=
          tech240.scoreAdd * 0.8;

        allNotes =
          allNotes.concat(
            tech240.notes.map(
              n =>
                "4H: " + n
            )
          );

        allConf =
          allConf.concat(
            tech240.conf
          );
      }

      item.tech =
        tech60;

      item.tech.notes =
        allNotes;

      item.confluence =
        [...new Set(allConf)];

      item.score =
        Math.min(
          98,
          Math.max(
            0,
            Math.round(
              item.score +
              totalAdd
            )
          )
        );

      item.rsi =
        tech60.rsi;

      item.atr =
        tech60.atr;

      /* =========================
         ATR LEVELS
      ========================= */

      if (
        item.atr &&
        item.atr > 0
      ) {
        const atrMult = 1.8;

        item.levels.stop =
          item.price -
          item.atr *
            atrMult;

        item.levels.t1 =
          item.price +
          item.atr *
            2.5;

        item.levels.t2 =
          item.price +
          item.atr *
            4.2;

        const risk =
          item.price -
          item.levels.stop;

        item.levels.rr2 =
          risk > 0
            ? +(
                (
                  item.levels.t2 -
                  item.price
                ) / risk
              ).toFixed(2)
            : 0;
      }

      /* =========================
         FINAL CLASSIFICATION
      ========================= */

      item.classification =
        classify(
          item.score,
          item.ch,
          th
        );

      item.prob =
        successProb(item);

      const L =
        leverageDecision(
          item
        );

      item.side =
        L.dir;

      item.leverage =
        L.lev;

      item.levNote =
        L.note;

      item.riskIfStop =
        L.riskIfStop;

      if (
        item.classification !==
        "WAIT"
      ) {
        enriched.push(
          item
        );
      }
    }

    /* =========================
       SORT
    ========================= */

    enriched.sort(
      (a, b) =>
        b.score - a.score
    );

    const signals =
      enriched
        .filter(s =>
          [
            "GOD_SIGNAL",
            "PRE_MOVE",
            "EARLY_BREAKOUT"
          ].includes(
            s.classification
          ) &&
          s.score >= th
        )
        .slice(0, 5);

    const watchlist =
      enriched
        .filter(s =>
          !signals.some(
            x =>
              x.symbol ===
              s.symbol
          ) &&
          (
            s.classification ===
              "WATCHLIST" ||
            s.score >= 60
          )
        )
        .slice(0, 8);

    /* =========================
       TELEGRAM
    ========================= */

    console.log(
      "FINAL SIGNALS:",
      signals.length
    );

    for (const signal of signals) {
      const previous =
        lastNotified.get(
          signal.symbol
        );

      const now =
        Date.now();

      if (
        previous &&
        now - previous <
          30 * 60 * 1000
      ) {
        continue;
      }

      lastNotified.set(
        signal.symbol,
        now
      );

      await sendTelegram(
        formatSignal(signal)
      );

      console.log(
        "Telegram sent:",
        signal.symbol
      );

      await new Promise(
        r =>
          setTimeout(r, 500)
      );
    }

    /* =========================
       STATE
    ========================= */

    lastSignals =
      signals;

    lastScan =
      new Date().toISOString();

    lastError =
      null;

    console.log(
      "Scan completed:",
      lastScan
    );

    console.log(
      "Signals:",
      signals.map(
        x =>
          `${x.symbol}:${x.score}:${x.classification}`
      )
    );

    console.log(
      "==============================\n"
    );

  } catch (error) {
    lastError =
      error?.message ||
      String(error);

    console.error(
      "SCAN ERROR:",
      lastError
    );

    await sendTelegram(
      "⚠️ Nobitex Hunter\n\n" +
      "خطا در اسکن:\n" +
      lastError
    );
  } finally {
    busy = false;
  }
}

/* =========================
   START
========================= */

console.log(
  "================================"
);

console.log(
  "NOBITEX HUNTER GOD MODE"
);

console.log(
  "God Mode:",
  GOD_MODE
);

console.log(
  "Scan interval: 5 minutes"
);

console.log(
  "Telegram:",
  TELEGRAM_BOT_TOKEN
    ? "CONFIGURED"
    : "NOT CONFIGURED"
);

console.log(
  "================================"
);

/*
  اولین اسکن
*/
setTimeout(
  () => {
    scan();
  },
  3000
);

/*
  اسکن خودکار هر 5 دقیقه
*/
setInterval(
  () => {
    if (!busy) {
      scan();
    }
  },
  SCAN_INTERVAL_MS
);
