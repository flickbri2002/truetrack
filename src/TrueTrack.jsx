import { useState, useEffect, useRef } from "react";

/* ════════════════════════════════════════════════════════════
   NUTRITION ENGINE — science-based formulas only
════════════════════════════════════════════════════════════ */
const NE = {
  bmr(weight, height, age, sex) {
    const base = 10 * weight + 6.25 * height - 5 * age;
    return Math.round(sex === "male" ? base + 5 : base - 161);
  },
  tdee(bmr, activity) {
    const f = { sedentary: 1.2, light: 1.375, moderate: 1.55, high: 1.725 };
    return Math.round(bmr * (f[activity] || 1.375));
  },
  target(tdee, speed) {
    // Cut: negative adjustment · Maintain: 0 · Bulk: positive adjustment
    const adj = {
      aggressive:      -750,
      moderate:        -500,
      slow:            -300,
      maintain:           0,
      slow_bulk:        200,
      moderate_bulk:    350,
    };
    const delta = adj[speed] ?? -500;
    // Cuts: floor 1200 kcal. Bulks: no floor needed.
    return delta < 0 ? Math.max(1200, tdee + delta) : tdee + delta;
  },
  macros(calories, weightKg) {
    // Protein: 1g per lb of body weight (1 lb = 0.453592 kg → 2.2046g/kg)
    const protein = Math.round(weightKg * 2.2046);
    // Fat: ~25% of total calories (healthy floor)
    const fat = Math.round((calories * 0.25) / 9);
    const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
    return { protein, fat, carbs };
  },
  weeklyTrend(logs) {
    const w = logs.filter(l => l.weight > 0);
    if (w.length < 3) return null;
    const r = w.slice(-7);
    const avgR = r.reduce((s, l) => s + l.weight, 0) / r.length;
    const p = w.slice(-14, -7);
    if (p.length < 2) return { current: +avgR.toFixed(1), change: null, status: "tracking" };
    const avgP = p.reduce((s, l) => s + l.weight, 0) / p.length;
    const change = +(avgR - avgP).toFixed(2);
    const status = change < -1.0 ? "fast" : change < -0.1 ? "optimal" : change < 0.1 ? "plateau" : "gaining";
    return { current: +avgR.toFixed(1), change, status };
  },
  adaptive(trend) {
    if (!trend?.change) return { delta: 0, msg: "Log your weight daily for 2 weeks to unlock adaptive adjustments." };
    const { change } = trend;
    if (change > 0.1) return { delta: -200, msg: `Weight trending up (+${change}kg). Reducing 200 kcal to reverse.` };
    if (change > -0.15) return { delta: -150, msg: `Plateau detected. Reducing 150 kcal to break through.` };
    if (change < -1.0) return { delta: 200, msg: `Losing too fast (${change}kg/wk). Adding 200 kcal to protect muscle.` };
    return { delta: 0, msg: `Optimal rate (${change}kg/wk). No adjustment needed.` };
  },

  /*
   * learnedTDEE — back-calculates real maintenance calories from observations
   *
   * Science:
   *   1 kg of body fat ≈ 7,700 kcal
   *   deficit/day = weekly_weight_change(kg) × 7700 / 7
   *   real TDEE = avg_daily_calories - deficit/day
   *              = avg_daily_calories + |weight_change_per_week| × 1100
   *
   * Example: ate 1,800 kcal/day, lost 0.5 kg/week
   *   deficit = 0.5 × 7700 / 7 = 550 kcal/day
   *   real TDEE = 1,800 + 550 = 2,350 kcal
   *
   * Confidence is based on days of combined calorie + weight data available:
   *   < 7 days  → "low"    (estimate only)
   *   7–13 days → "medium" (reasonable estimate)
   *   14+ days  → "high"   (reliable)
   */
  learnedTDEE(logs) {
    // Need both calorie AND weight data on the same days
    const paired = logs.filter(l => l.calories > 0 && l.weight > 0);
    if (paired.length < 5) return null;

    // Use the most recent 14 paired days for stability
    const recent = paired.slice(-14);

    // Average daily calorie intake
    const avgCals = Math.round(recent.reduce((s, l) => s + l.calories, 0) / recent.length);

    // Weight change: compare first 3-day avg to last 3-day avg within the window
    const first3 = recent.slice(0, 3);
    const last3  = recent.slice(-3);
    const wStart = first3.reduce((s, l) => s + l.weight, 0) / first3.length;
    const wEnd   = last3.reduce((s, l)  => s + l.weight, 0) / last3.length;
    const days   = recent.length;
    const weeklyChange = ((wEnd - wStart) / days) * 7; // kg/week (negative = losing)

    // Back-calculate TDEE
    // deficit/day = weeklyChange(kg) × 7700 / 7
    // (negative weeklyChange = losing = positive deficit)
    const deficitPerDay = -(weeklyChange) * 7700 / 7;
    const tdee = Math.round(avgCals + deficitPerDay);

    // Confidence tier
    const confidence = paired.length >= 14 ? "high" : paired.length >= 7 ? "medium" : "low";

    // Accuracy window: ±10% for low, ±7% for medium, ±5% for high
    const margin = confidence === "high" ? 0.05 : confidence === "medium" ? 0.07 : 0.10;
    const range  = [Math.round(tdee * (1 - margin)), Math.round(tdee * (1 + margin))];

    return {
      tdee,
      avgCals,
      weeklyChange: +weeklyChange.toFixed(2),
      deficitPerDay: Math.round(deficitPerDay),
      confidence,
      range,
      daysUsed: recent.length,
      pairedDays: paired.length,
    };
  },

  /*
   * recovery — calculates a science-based recovery plan after going over calories
   *
   * Principles:
   *   - Never reduce more than 15% of target per day (max 250 kcal) — steeper cuts
   *     trigger muscle catabolism and rebound hunger
   *   - Cap recovery at 7 days — beyond that, the weekly average handles it
   *   - For extreme overages (e.g. 5,000 kcal), just apply the max 7-day window
   *     and note that most of the excess is glycogen/water, not fat
   *   - A single large-calorie day increases body fat by much less than the number
   *     suggests — 3,500 kcal above maintenance ≈ ~0.45 kg fat, but glycogen
   *     storage, thermic effect, and NEAT compensation absorb a significant portion
   */
  recovery(overageKcal, targetCalories) {
    if (overageKcal <= 0) return null;

    // Safe max daily reduction: 15% of target, floor 100 kcal, cap 250 kcal
    const maxDailyReduction = Math.min(250, Math.max(100, Math.round(targetCalories * 0.15)));

    // Days needed to cover the overage (cap at 7)
    const daysNeeded = Math.min(7, Math.ceil(overageKcal / maxDailyReduction));

    // Spread evenly — daily reduction per day
    const dailyReduction = Math.round(overageKcal / daysNeeded);
    // Never drop below 1,200 kcal absolute floor
    const adjustedTarget = Math.max(1200, targetCalories - dailyReduction);
    const actualReduction = targetCalories - adjustedTarget;
    const coveredKcal = actualReduction * daysNeeded;
    const uncoveredKcal = Math.max(0, overageKcal - coveredKcal);

    // Context note for large overages
    const isLargeOverage = overageKcal > 1000;
    const glycogenNote = isLargeOverage
      ? "Note: large-calorie days are mostly glycogen and water, not fat. The real fat gain is much smaller than the number suggests."
      : null;

    return {
      adjustedTarget,
      dailyReduction: actualReduction,
      daysNeeded,
      coveredKcal,
      uncoveredKcal,
      isLargeOverage,
      glycogenNote,
    };
  },
  supplements(weight, proteinTarget) {
    const perKg = proteinTarget / weight;
    return [
      ...(perKg < 1.8 ? [{ name: "Whey protein", why: "Hitting 2g/kg from whole food in a deficit is hard. Powder is cheap and convenient.", dose: "25–40g after training or before bed", priority: "high" }] : []),
      { name: "Creatine monohydrate", why: "Most researched supplement. Maintains strength during a cut. Cheap, safe, no cycling needed.", dose: "5g/day — any time with water", priority: "high" },
      { name: "Omega-3 fish oil", why: "Reduces inflammation from training. Supports mood and cognition during calorie restriction.", dose: "2–3g EPA/DHA daily with a meal", priority: "medium" },
      { name: "Vitamin D3 + K2", why: "Most people are deficient. Supports hormones, immune function, and mood.", dose: "2000–4000 IU D3 + 100mcg K2 daily", priority: "medium" },
      { name: "Multivitamin", why: "A calorie deficit creates micronutrient gaps. A basic multi is cheap insurance.", dose: "1 capsule daily with food", priority: "low" },
    ];
  },
};

/* ════════════════════════════════════════════════════════════
   STORAGE
════════════════════════════════════════════════════════════ */
const DB = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

/* Saved meals helpers */
const SM = {
  get: ()        => DB.get("tt_saved_meals") || [],
  save: (meals)  => DB.set("tt_saved_meals", meals),
  add: (meal)    => { const m = SM.get(); m.push(meal); SM.save(m); },
  del: (id)      => SM.save(SM.get().filter(m => m.id !== id)),
};
const TODAY = new Date().toISOString().slice(0, 10);

/* ════════════════════════════════════════════════════════════
   AI LAYER
════════════════════════════════════════════════════════════ */
async function callAI(prompt, sys = "You are a precision nutrition coach. Be concise and science-based.") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch("http://localhost:3001/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: sys,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || "API error");
    return d.content?.[0]?.text || "";
  } finally {
    clearTimeout(timeout);
  }
}

async function callAIJSON(prompt) {
  const raw = await callAI(prompt, "You are a nutrition expert. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Start with { and end with }.");
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON in response");
  return JSON.parse(cleaned.slice(s, e + 1));
}

/* ════════════════════════════════════════════════════════════
   DESIGN TOKENS — Forest Green light mode
════════════════════════════════════════════════════════════ */
const T = {
  bg:       "#f2f5f2",
  card:     "#ffffff",
  sidebar:  "#1a2e1a",
  sidebarAct: "#2a4a2a",
  border:   "#d8e8d8",
  borderMid:"#b8d0b8",
  accent:   "#3a7d3a",
  accentBg: "#edf5ed",
  text:     "#1a2e1a",
  muted:    "#6a8a6a",
  dimmed:   "#9aaa9a",
  faint:    "#b8c8b8",
  orange:   "#c47a2a",
  orangeBg: "#fdf3e8",
  blue:     "#2a6a9a",
  blueBg:   "#e8f0f8",
  red:      "#a03030",
  redBg:    "#fdf0f0",
  gold:     "#8a6a2a",
  font:     "'Outfit', 'DM Sans', system-ui, sans-serif",
  serif:    "'Georgia', serif",
};

/* ════════════════════════════════════════════════════════════
   SVG ICON SYSTEM
════════════════════════════════════════════════════════════ */
const Icon = ({ name, size = 16, color = "currentColor", style: st }) => {
  const paths = {
    dashboard:   "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
    log:         "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z",
    meals:       "M18.06 22.99h1.66c.84 0 1.53-.64 1.63-1.46L23 5.05h-5V1h-1.97v4.05h-4.97l.3 2.34c1.71.47 3.31 1.32 4.27 2.26 1.44 1.42 2.43 2.89 2.43 5.29v8.05zM1 21.99V21h15.03v.99c0 .55-.45 1-1.01 1H2.01c-.56 0-1.01-.45-1.01-1zm15.03-7c0-4.5-6.72-5-8.03-5-1.28 0-8 .5-8 5h16.03z",
    insights:    "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z",
    supplements: "M6.5 10h-2v5h2v-5zm6 0h-2v5h2v-5zm8.5 7H2v2h19v-2zm-2.5-7h-2v5h2v-5zM11.5 1L2 6v2h19V6l-9.5-5z",
    ateout:      "M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z",
    planahead:   "M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z",
    search:      "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
    add:         "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
    close:       "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    check:       "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
    trending_up: "M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z",
    trending_dn: "M16 18l2.29-2.29-4.88-4.88-4 4L2 7.41 3.41 6l6 6 4-4 6.3 6.29L22 12v6z",
    warning:     "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    info:        "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
    arrow_right: "M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
    reset:       "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
    steps:       "M13.49 5.48c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9l1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1l-5.2 2.2v4.7h2v-3.4l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z",
    weight:      "M20.57 14.86L22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z",
    fire:        "M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67z",
    sun:         "M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z",
    moon:        "M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z",
    camera:      "M12 15.2A3.2 3.2 0 0 1 8.8 12 3.2 3.2 0 0 1 12 8.8 3.2 3.2 0 0 1 15.2 12 3.2 3.2 0 0 1 12 15.2M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9m3 15a5 5 0 0 1-5-5 5 5 0 0 1 5-5 5 5 0 0 1 5 5 5 5 0 0 1-5 5z",
    barcode:     "M2 6h2v12H2zm3 0h1v12H5zm2 0h2v12H7zm3 0h1v12h-1zm2 0h2v12h-2zm3 0h1v12h-1zm2 0h2v12h-2z",
    quick:       "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z",
    bookmark:    "M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} style={{ display: "inline-block", flexShrink: 0, ...st }}>
      <path d={paths[name] || paths.info} />
    </svg>
  );
};

/* ════════════════════════════════════════════════════════════
   LOGO — SVG mark + wordmark, two variants
   Mark: T with left arm, stem, and right arc all meeting at
   the same junction point so there's no disconnection.
════════════════════════════════════════════════════════════ */
const Logo = ({ variant = "light", size = "md" }) => {
  // size: sm (nav/sidebar), md (onboarding center), lg (landing hero)
  const cfg = {
    sm: { box: 28, rx: 7,  sw: 3.5, lx1: 5,  jx: 14, jy: 12, bot: 24, arc: "M14,12 C19,12 22,9.5 23,5",  textX: 34, textY: 18, textSize: 14 },
    md: { box: 36, rx: 9,  sw: 4.5, lx1: 6,  jx: 18, jy: 15, bot: 31, arc: "M18,15 C24,15 27,12 29,7",   textX: 44, textY: 24, textSize: 18 },
    lg: { box: 44, rx: 11, sw: 5.5, lx1: 8,  jx: 22, jy: 19, bot: 38, arc: "M22,19 C30,19 34,15 36,9",   textX: 54, textY: 30, textSize: 22 },
  };
  const c = cfg[size];
  const isLight = variant === "light";
  const bgFill    = isLight ? "#1a2e1a" : "#2a4a2a";
  const stroke    = "#6fcf6f";
  const word1     = isLight ? "#1a2e1a" : "#c8e6c8";
  const word2     = isLight ? "#3a7d3a" : "#6fcf6f";
  // total SVG width = icon box + gap + approx text width
  const totalW = c.box + 8 + c.textSize * 6.2;
  return (
    <svg width={totalW} height={c.box} viewBox={`0 0 ${totalW} ${c.box}`} role="img" aria-label="TrueTrack">
      <title>TrueTrack</title>
      {/* Icon square */}
      <rect width={c.box} height={c.box} rx={c.rx} fill={bgFill}/>
      {/* Left arm */}
      <line x1={c.lx1} y1={c.jy} x2={c.jx} y2={c.jy}
        stroke={stroke} strokeWidth={c.sw} strokeLinecap="round"/>
      {/* Stem */}
      <line x1={c.jx} y1={c.jy} x2={c.jx} y2={c.bot}
        stroke={stroke} strokeWidth={c.sw} strokeLinecap="round"/>
      {/* Right arc — starts at same junction point */}
      <path d={c.arc} fill="none"
        stroke={stroke} strokeWidth={c.sw} strokeLinecap="round"/>
      {/* Wordmark */}
      <text x={c.textX} y={c.textY}
        fontFamily="Georgia,serif" fontSize={c.textSize} fontWeight="700"
        fill={word1} letterSpacing="-0.5">
        True<tspan fill={word2}>Track</tspan>
      </text>
    </svg>
  );
};

/* Icon-only mark — for favicon, tab, small spaces */
const LogoMark = ({ size = 44, dark = false }) => {
  const scale = size / 44;
  const sw = 5.5 * scale;
  const rx = 11 * scale;
  const lx1 = 8  * scale, jx = 22 * scale, jy = 19 * scale;
  const bot  = 38 * scale;
  const arc  = `M${jx},${jy} C${30*scale},${jy} ${34*scale},${15*scale} ${36*scale},${9*scale}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="TrueTrack">
      <title>TrueTrack</title>
      <rect width={size} height={size} rx={rx} fill={dark ? "#2a4a2a" : "#1a2e1a"}/>
      <line x1={lx1} y1={jy} x2={jx} y2={jy} stroke="#6fcf6f" strokeWidth={sw} strokeLinecap="round"/>
      <line x1={jx}  y1={jy} x2={jx} y2={bot} stroke="#6fcf6f" strokeWidth={sw} strokeLinecap="round"/>
      <path d={arc} fill="none" stroke="#6fcf6f" strokeWidth={sw} strokeLinecap="round"/>
    </svg>
  );
};
const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{
    background: T.card, borderRadius: 10, padding: 16,
    border: `1px solid ${T.border}`,
    cursor: onClick ? "pointer" : "default",
    ...style,
  }}>{children}</div>
);

const Btn = ({ children, onClick, v = "primary", disabled, full, size = "md", style: st }) => {
  const pad = size === "sm" ? "6px 12px" : size === "lg" ? "12px 28px" : "9px 18px";
  const fs = size === "sm" ? 12 : size === "lg" ? 15 : 13;
  const variants = {
    primary: { background: T.accent, color: "#fff", border: "none" },
    ghost:   { background: "transparent", color: T.text, border: `1px solid ${T.border}` },
    warn:    { background: T.orangeBg, color: T.orange, border: `1px solid ${T.orange}40` },
    danger:  { background: T.redBg, color: T.red, border: `1px solid ${T.red}40` },
    subtle:  { background: T.accentBg, color: T.accent, border: `1px solid ${T.border}` },
    dark:    { background: T.sidebar, color: "#c8e6c8", border: "none" },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: pad, borderRadius: 7, fontFamily: T.font, fontWeight: 600,
      fontSize: fs, cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1, transition: "all 0.15s",
      width: full ? "100%" : undefined,
      ...variants[v], ...st,
    }}>{children}</button>
  );
};

const Field = ({ label, value, onChange, type = "text", placeholder, unit, min, max, step, rows }) => (
  <div style={{ marginBottom: 12 }}>
    {label && <div style={{ fontSize: 11, color: T.muted, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 5 }}>{label}</div>}
    <div style={{ position: "relative" }}>
      {rows ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows}
          style={{ width: "100%", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "9px 12px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none", resize: "vertical", boxSizing: "border-box" }} />
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder} min={min} max={max} step={step}
          style={{ width: "100%", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: unit ? "9px 36px 9px 12px" : "9px 12px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
      )}
      {unit && <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: T.dimmed, fontSize: 11, pointerEvents: "none" }}>{unit}</span>}
    </div>
  </div>
);

const DropDown = ({ label, value, onChange, options }) => (
  <div style={{ marginBottom: 12 }}>
    {label && <div style={{ fontSize: 11, color: T.muted, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 5 }}>{label}</div>}
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ width: "100%", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "9px 12px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none" }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const Pill = ({ text, color = T.accent, bg }) => (
  <span style={{ background: bg || color + "18", color, padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600, display: "inline-block", border: `1px solid ${color}30` }}>{text}</span>
);

const Spin = ({ size = 14 }) => (
  <span style={{ display: "inline-block", width: size, height: size, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite", verticalAlign: "middle" }} />
);

const MBar = ({ label, curr, target, color }) => {
  const pct = Math.min(100, Math.round((curr / Math.max(1, target)) * 100));
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: T.muted }}>{label}</span>
        <span style={{ fontSize: 12 }}><b style={{ color: pct > 100 ? T.red : T.text }}>{curr}</b><span style={{ color: T.faint }}>/{target}g</span></span>
      </div>
      <div style={{ height: 5, background: T.bg, borderRadius: 99, overflow: "hidden", border: `1px solid ${T.border}` }}>
        <div style={{ width: `${pct}%`, height: "100%", background: pct > 100 ? T.red : color, borderRadius: 99, transition: "width 0.5s ease" }} />
      </div>
    </div>
  );
};

const SectionHead = ({ title, sub }) => (
  <div style={{ marginBottom: 24 }}>
    <h1 style={{ fontSize: 22, fontWeight: 700, color: T.text, letterSpacing: "-0.3px", marginBottom: 3 }}>{title}</h1>
    {sub && <p style={{ color: T.muted, fontSize: 13, margin: 0 }}>{sub}</p>}
  </div>
);

/* ════════════════════════════════════════════════════════════
   WEIGHT SPARKLINE
════════════════════════════════════════════════════════════ */
const WeightChart = ({ logs }) => {
  const [hovered, setHovered] = useState(null);
  const data = logs.filter(l => l.weight > 0).slice(-21);
  if (data.length < 2) return (
    <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: T.faint, fontSize: 12 }}>
      Log your weight daily to see the trend
    </div>
  );
  const weights = data.map(l => l.weight);
  const mn = Math.min(...weights), mx = Math.max(...weights);
  // Add padding so points don't sit on the axis edges
  const yMin = Math.floor((mn - 0.5) * 2) / 2;
  const yMax = Math.ceil((mx  + 0.5) * 2) / 2;
  const W = 400, H = 110;
  const PL = 38, PR = 12, PT = 14, PB = 26; // room for y-axis labels left, x-axis bottom
  const iw = W - PL - PR, ih = H - PT - PB;
  const px = i  => PL + (i / (data.length - 1)) * iw;
  const py = w  => PT + ih - ((w - yMin) / (yMax - yMin)) * ih;
  const pts = data.map((l, i) => ({ x: px(i), y: py(l.weight), w: l.weight, d: l.date }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length-1].x},${H - PB} L${pts[0].x},${H - PB} Z`;

  // Y-axis ticks — 3 evenly spaced
  const yTicks = [yMin, (yMin + yMax) / 2, yMax].map(v => +v.toFixed(1));

  // X-axis ticks — first, middle, last
  const xTicks = [0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div style={{ position: "relative" }}>
      {/* Hover tooltip */}
      {hovered && (
        <div style={{
          position: "absolute",
          left: Math.min(hovered.x / W * 100, 75) + "%",
          top: 0,
          background: T.sidebar,
          color: "#c8e6c8",
          padding: "4px 10px",
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 600,
          pointerEvents: "none",
          whiteSpace: "nowrap",
          zIndex: 10,
          transform: "translateX(-50%)",
        }}>
          {hovered.d.slice(5)} — {hovered.w} kg
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, overflow: "visible" }}
        onMouseLeave={() => setHovered(null)}>
        <defs>
          <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={T.accent} stopOpacity="0.15" />
            <stop offset="100%" stopColor={T.accent} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y-axis gridlines and labels */}
        {yTicks.map((v, i) => {
          const yPos = py(v);
          return (
            <g key={i}>
              <line x1={PL} y1={yPos} x2={W - PR} y2={yPos}
                stroke={T.border} strokeWidth="0.5" strokeDasharray="3,3" />
              <text x={PL - 5} y={yPos + 3.5} fill={T.faint} fontSize="9" textAnchor="end">{v}</text>
            </g>
          );
        })}

        {/* Y-axis label */}
        <text x="10" y={H / 2} fill={T.muted} fontSize="9" textAnchor="middle"
          transform={`rotate(-90, 10, ${H / 2})`}>kg</text>

        {/* X-axis baseline */}
        <line x1={PL} y1={H - PB} x2={W - PR} y2={H - PB}
          stroke={T.border} strokeWidth="0.5" />

        {/* X-axis tick labels */}
        {xTicks.map(i => (
          <text key={i} x={px(i)} y={H - PB + 11} fill={T.faint} fontSize="9" textAnchor="middle">
            {data[i].date.slice(5)}
          </text>
        ))}

        {/* Area fill + line */}
        <path d={area} fill="url(#wg)" />
        <path d={line} fill="none" stroke={T.accent} strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" />

        {/* Data points with hover zones */}
        {pts.map((p, i) => (
          <g key={i} onMouseEnter={() => setHovered(p)} style={{ cursor: "crosshair" }}>
            {/* Invisible wide hit area */}
            <rect x={p.x - 8} y={PT} width={16} height={ih} fill="transparent" />
            <circle cx={p.x} cy={p.y} r={hovered?.d === p.d ? 4 : 2.5}
              fill={hovered?.d === p.d ? T.text : T.accent}
              stroke={T.card} strokeWidth="1"
              style={{ transition: "r 0.1s" }} />
          </g>
        ))}
      </svg>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════
   LANDING PAGE
════════════════════════════════════════════════════════════ */
function Landing({ onStart }) {
  const feats = [
    { t: "Accurate calorie targets",    d: "BMR and TDEE calculated from the Mifflin-St Jeor formula. Specific to your body, not a population average." },
    { t: "Learned TDEE",                d: "After a week of logging, TrueTrack back-calculates your real maintenance calories from your actual intake and weight data." },
    { t: "AI meal planning",            d: "Generate a full day of meals calibrated to your exact calorie and macro targets, in any style." },
    { t: "Ate out recovery",            d: "Describe what you ate. Get an accurate macro estimate and a realistic plan to rebalance the rest of your week." },
    { t: "Plan ahead",                  d: "Know you have a big meal coming? Pre-adjust your day so it fits your week without any disruption." },
    { t: "Adaptive adjustments",        d: "Every week, TrueTrack reviews your weight trend and adjusts your targets if your rate of loss is too fast, too slow, or stalling." },
  ];
  return (
    <div style={{ background: "#fff", minHeight: "100vh", fontFamily: T.font, color: T.text }}>
      <nav style={{ padding: "16px 48px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, background: "#ffffffee", backdropFilter: "blur(12px)", zIndex: 100 }}>
        <Logo variant="light" size="sm" />
        <Btn onClick={onStart} v="dark" size="sm">Get started</Btn>
      </nav>

      {/* Hero */}
      <section style={{ maxWidth: 640, margin: "0 auto", padding: "96px 40px 80px" }}>
        <h1 style={{ fontSize: "clamp(30px, 4.5vw, 50px)", fontWeight: 800, lineHeight: 1.1, margin: "0 0 20px", letterSpacing: "-1.5px", fontFamily: T.serif }}>
          Nutrition tracking that learns your metabolism.
        </h1>
        <p style={{ fontSize: 16, color: T.muted, maxWidth: 520, lineHeight: 1.75, marginBottom: 36 }}>
          TrueTrack uses your actual intake and weight data to calculate your real maintenance calories — then builds your targets, meals, and weekly adjustments around that number, not a formula guess.
        </p>
        <Btn onClick={onStart} v="dark" size="lg">Create your profile</Btn>
      </section>

      {/* How it works — three clean steps, no icons */}
      <section style={{ maxWidth: 640, margin: "0 auto 80px", padding: "0 40px" }}>
        <div style={{ borderTop: `1px solid ${T.border}` }}>
          {[
            { n: "01", t: "Set up your profile", d: "Enter your age, weight, height, and activity level. TrueTrack calculates your starting calorie and macro targets using the Mifflin-St Jeor formula." },
            { n: "02", t: "Log daily", d: "Record your weight each morning and your food throughout the day. The more consistently you log, the more accurate your targets become." },
            { n: "03", t: "Let the app adjust", d: "After 7 days, TrueTrack compares your intake against your weight trend and recalculates your real TDEE. Your targets update automatically from there." },
          ].map((s, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: 20, padding: "28px 0", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, paddingTop: 2, letterSpacing: "0.05em" }}>{s.n}</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 }}>{s.t}</div>
                <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.7 }}>{s.d}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section style={{ maxWidth: 840, margin: "0 auto 80px", padding: "0 40px" }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.3px", marginBottom: 28, fontFamily: T.serif }}>
          What's included
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 1, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
          {feats.map((f, i) => (
            <div key={i} style={{ padding: "20px 22px", background: T.card, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: T.text, marginBottom: 6 }}>{f.t}</div>
              <div style={{ color: T.muted, fontSize: 12, lineHeight: 1.65 }}>{f.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section style={{ maxWidth: 560, margin: "0 auto 100px", padding: "0 40px" }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.3px", marginBottom: 28, fontFamily: T.serif }}>Pricing</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {[
            { tier: "Free", price: "€0", desc: "Core tracking, always free.", items: ["Daily weight logging", "Calorie and macro targets", "BMR / TDEE calculator", "Activity guidance"], cta: "Get started", dark: false },
            { tier: "Pro",  price: "€9 / month", desc: "Everything in Free, plus:", items: ["AI meal planning", "Adaptive weekly adjustments", "Ate Out recovery", "Plan Ahead", "Weekly insights", "Learned TDEE"], cta: "Start free trial", dark: true },
          ].map((p, i) => (
            <div key={i} style={{ background: p.dark ? T.sidebar : T.card, borderRadius: 10, padding: 24, border: `1px solid ${p.dark ? "transparent" : T.border}` }}>
              <div style={{ fontSize: 10, color: p.dark ? "#4a6a4a" : T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>{p.tier}</div>
              <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4, letterSpacing: "-0.5px", color: p.dark ? "#c8e6c8" : T.text, fontFamily: T.serif }}>{p.price}</div>
              <div style={{ fontSize: 12, color: p.dark ? "#4a6a4a" : T.faint, marginBottom: 20 }}>{p.desc}</div>
              {p.items.map((f, j) => (
                <div key={j} style={{ paddingBottom: 7, marginBottom: 7, borderBottom: `1px solid ${p.dark ? "#2a4a2a" : T.border}`, fontSize: 12, color: p.dark ? "#6a8a6a" : T.muted }}>
                  {f}
                </div>
              ))}
              <Btn onClick={onStart} v={p.dark ? "subtle" : "dark"} full style={{ marginTop: 8 }}>{p.cta}</Btn>
            </div>
          ))}
        </div>
      </section>

      <footer style={{ borderTop: `1px solid ${T.border}`, padding: "24px 40px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Logo variant="light" size="sm" />
        <span style={{ color: T.faint, fontSize: 12 }}>© 2026 TrueTrack</span>
      </footer>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   ONBOARDING
════════════════════════════════════════════════════════════ */
function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: "", sex: "male", age: 28, weight: 80, height: 175, activity: "moderate", goal: "moderate" });
  const [manualMode, setManualMode]   = useState(false);
  const [manualCals, setManualCals]   = useState("");
  const [manualProt, setManualProt]   = useState("");
  const [manualCarbs,setManualCarbs]  = useState("");
  const [manualFat,  setManualFat]    = useState("");

  const upd = (k, v) => setF(p => ({ ...p, [k]: v }));
  const bmrNow   = NE.bmr(+f.weight, +f.height, +f.age, f.sex);
  const tdeeNow  = NE.tdee(bmrNow, f.activity);
  const calsNow  = NE.target(tdeeNow, f.goal);
  const macrosNow = NE.macros(calsNow, +f.weight);

  // Auto-fill logic — 4 cases:
  // 1. Both blank: split remaining 35% fat / 65% carbs
  // 2. Carbs filled, fat blank: fat = remaining after protein + carbs
  // 3. Fat filled, carbs blank: carbs = remaining after protein + fat
  // 4. Both filled: use entered values
  const manCal = manualMode ? (+manualCals || calsNow) : calsNow;
  const manPro = manualMode ? (+manualProt || macrosNow.protein) : macrosNow.protein;
  const manRemaining = Math.max(0, manCal - manPro * 4);
  let manAutoFat, manAutoCarbs;
  if (manualCarbs === "" && manualFat === "") {
    manAutoFat   = Math.round(manRemaining * 0.35 / 9);
    manAutoCarbs = Math.max(0, Math.round((manRemaining - manAutoFat * 9) / 4));
  } else if (manualCarbs !== "" && manualFat === "") {
    manAutoCarbs = +manualCarbs;
    manAutoFat   = Math.max(0, Math.round((manCal - manPro * 4 - manAutoCarbs * 4) / 9));
  } else if (manualCarbs === "" && manualFat !== "") {
    manAutoFat   = +manualFat;
    manAutoCarbs = Math.max(0, Math.round((manCal - manPro * 4 - manAutoFat * 9) / 4));
  } else {
    manAutoCarbs = +manualCarbs || 0;
    manAutoFat   = +manualFat   || 0;
  }

  const finalCals   = manCal;
  const finalMacros = manualMode
    ? { protein: manPro, carbs: manAutoCarbs, fat: manAutoFat }
    : macrosNow;

  const fromMacros = Math.round(finalMacros.protein*4 + finalMacros.carbs*4 + finalMacros.fat*9);

  const handleDone = () => {
    const profile = {
      ...f,
      weight: +f.weight, height: +f.height, age: +f.age,
      bmr: bmrNow, tdee: tdeeNow,
      calories: finalCals,
      macros: finalMacros,
      customTargets: manualMode,
      createdAt: Date.now(),
    };
    DB.set("tt_profile", profile);
    onComplete(profile);
  };

  const steps = ["About you", "Your body", "Your goal"];
  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: T.font, color: T.text, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ textAlign: "center", marginBottom: 28, display: "flex", justifyContent: "center" }}>
          <Logo variant="light" size="md" />
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 28 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ flex: 1 }}>
              <div style={{ height: 3, borderRadius: 99, background: i <= step ? T.accent : T.border, transition: "background 0.3s", marginBottom: 5 }} />
              <div style={{ fontSize: 10, color: i === step ? T.accent : T.faint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s}</div>
            </div>
          ))}
        </div>

        <Card>
          {step === 0 && (
            <>
              <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4, fontFamily: T.serif }}>Let's build your plan</div>
              <p style={{ color: T.muted, fontSize: 13, marginBottom: 22, lineHeight: 1.6 }}>Everything is calculated from your inputs — no AI hallucinations.</p>
              <Field label="Your name" value={f.name} onChange={v => upd("name", v)} placeholder="Alex" />
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>Biological sex</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
                  {[["male", "Male"], ["female", "Female"]].map(([v, l]) => (
                    <div key={v} onClick={() => upd("sex", v)} style={{ padding: "10px", borderRadius: 7, textAlign: "center", cursor: "pointer", border: `1.5px solid ${f.sex === v ? T.accent : T.border}`, background: f.sex === v ? T.accentBg : T.bg, fontWeight: 600, fontSize: 13, transition: "all 0.15s", color: f.sex === v ? T.accent : T.muted }}>{l}</div>
                  ))}
                </div>
              </div>
              <Field label="Age" type="number" value={f.age} onChange={v => upd("age", v)} unit="yrs" min="16" max="80" />
            </>
          )}

          {step === 1 && (
            <>
              <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4, fontFamily: T.serif }}>Your body</div>
              <p style={{ color: T.muted, fontSize: 13, marginBottom: 22, lineHeight: 1.6 }}>Used for the Mifflin-St Jeor BMR formula.</p>
              <Field label="Current weight" type="number" value={f.weight} onChange={v => upd("weight", v)} unit="kg" step="0.1" />
              <Field label="Height" type="number" value={f.height} onChange={v => upd("height", v)} unit="cm" />
              <div style={{ padding: 12, background: T.accentBg, borderRadius: 8, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 10, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Your BMR</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: T.text }}>{bmrNow} <span style={{ fontSize: 13, color: T.muted, fontWeight: 400 }}>kcal at rest</span></div>
                <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>10×{f.weight} + 6.25×{f.height} − 5×{f.age} {f.sex === "male" ? "+ 5" : "− 161"} = {bmrNow}</div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4, fontFamily: T.serif }}>Lifestyle and goal</div>
              <p style={{ color: T.muted, fontSize: 13, marginBottom: 18, lineHeight: 1.6 }}>Honest answers = accurate targets.</p>
              <DropDown label="Activity level" value={f.activity} onChange={v => upd("activity", v)} options={[
                { value: "sedentary", label: "Sedentary — desk job, minimal movement (×1.2)" },
                { value: "light",    label: "Light — 1–3 workouts/week (×1.375)" },
                { value: "moderate", label: "Moderate — 3–5 workouts/week (×1.55)" },
                { value: "high",     label: "High — 6+ sessions or physical job (×1.725)" },
              ]} />
              <DropDown label="Goal" value={f.goal} onChange={v => upd("goal", v)} options={[
                { value: "aggressive",    label: "Cut — aggressive · ~0.75 kg/week (−750 kcal)" },
                { value: "moderate",      label: "Cut — optimal · ~0.5 kg/week (−500 kcal)  ✓ Recommended" },
                { value: "slow",          label: "Cut — conservative · ~0.3 kg/week (−300 kcal)" },
                { value: "maintain",      label: "Maintain — keep current weight (±0 kcal)" },
                { value: "slow_bulk",     label: "Bulk — lean · ~0.2 kg/week (+200 kcal)" },
                { value: "moderate_bulk", label: "Bulk — moderate · ~0.35 kg/week (+350 kcal)" },
              ]} />

              {/* Toggle: use calculated vs manual */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 16, marginTop: 4 }}>
                {[["Use calculated", false], ["Set my own", true]].map(([label, val]) => (
                  <div key={String(val)} onClick={() => setManualMode(val)}
                    style={{ padding: "9px", borderRadius: 7, textAlign: "center", cursor: "pointer", border: `1.5px solid ${manualMode === val ? T.accent : T.border}`, background: manualMode === val ? T.accentBg : T.bg, fontWeight: 600, fontSize: 12, color: manualMode === val ? T.accent : T.muted, transition: "all 0.15s" }}>
                    {label}
                  </div>
                ))}
              </div>

              {!manualMode && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { l: "TDEE", v: tdeeNow, sub: "maintenance" },
                    { l: "Target", v: calsNow, sub: f.goal.includes("bulk") ? "muscle gain" : f.goal === "maintain" ? "maintenance" : "fat loss", hi: true },
                    { l: "Protein", v: macrosNow.protein + "g", sub: "1g per lb body weight" },
                    { l: "Carbs", v: macrosNow.carbs + "g", sub: "remaining calories" },
                  ].map((s, i) => (
                    <div key={i} style={{ padding: 10, background: s.hi ? T.accentBg : T.bg, borderRadius: 7, border: `1px solid ${s.hi ? T.accent + "50" : T.border}` }}>
                      <div style={{ fontSize: 9, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{s.l}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: s.hi ? T.accent : T.text }}>{s.v}</div>
                      <div style={{ fontSize: 10, color: T.faint }}>{s.sub}</div>
                    </div>
                  ))}
                </div>
              )}

              {manualMode && (
                <>
                  <Field label="Daily calorie target" type="number" value={manualCals} onChange={setManualCals} unit="kcal" placeholder={String(calsNow)} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 6 }}>
                    <Field label="Protein" type="number" value={manualProt}  onChange={setManualProt}  unit="g" placeholder={String(macrosNow.protein)} />
                    <Field label="Carbs"   type="number" value={manualCarbs} onChange={setManualCarbs} unit="g" placeholder={String(manAutoCarbs)} />
                    <Field label="Fat"     type="number" value={manualFat}   onChange={setManualFat}   unit="g" placeholder={String(manAutoFat)} />
                  </div>
                  <div style={{ fontSize: 11, color: T.accent, marginBottom: 8, lineHeight: 1.5 }}>
                    Leave any field blank to use the recommended value.
                    Currently using: {manPro}g protein · {manAutoCarbs}g carbs · {manAutoFat}g fat = {fromMacros} kcal.
                  </div>
                  {fromMacros > 0 && (
                    <div style={{ padding: "8px 11px", background: T.bg, borderRadius: 7, border: `1px solid ${T.border}`, fontSize: 11, color: T.muted }}>
                      Calories from macros: <b style={{ color: T.text }}>{fromMacros} kcal</b>
                      {Math.abs(fromMacros - manCal) > 20 && (
                        <span style={{ color: T.orange, marginLeft: 6 }}>
                          {fromMacros > manCal ? "↑ exceeds target" : "↓ below target"}
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
            {step > 0 && <Btn v="ghost" onClick={() => setStep(s => s - 1)}>Back</Btn>}
            {step < 2
              ? <Btn onClick={() => setStep(s => s + 1)} v="dark" full>Continue</Btn>
              : <Btn onClick={handleDone} v="dark" full>Build my plan</Btn>}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   CUSTOM TARGETS MODAL — manually set calories and macros
════════════════════════════════════════════════════════════ */
function CustomTargetsModal({ profile, onSave, onClose }) {
  const [calories, setCalories] = useState(String(profile.calories));
  const [protein,  setProtein]  = useState(String(profile.macros.protein));
  const [carbs,    setCarbs]    = useState("");
  const [fat,      setFat]      = useState("");

  const cal = +calories || profile.calories;
  const pro = +protein  || profile.macros.protein;

  // Auto-fill: 4 cases
  let autoFat, autoCarbs;
  if (carbs === "" && fat === "") {
    autoFat   = Math.round(Math.max(0, cal - pro * 4) * 0.35 / 9);
    autoCarbs = Math.max(0, Math.round((cal - pro * 4 - autoFat * 9) / 4));
  } else if (carbs !== "" && fat === "") {
    autoCarbs = +carbs;
    autoFat   = Math.max(0, Math.round((cal - pro * 4 - autoCarbs * 4) / 9));
  } else if (carbs === "" && fat !== "") {
    autoFat   = +fat;
    autoCarbs = Math.max(0, Math.round((cal - pro * 4 - autoFat * 9) / 4));
  } else {
    autoCarbs = +carbs || 0;
    autoFat   = +fat   || 0;
  }

  const displayFat   = autoFat;
  const displayCarbs = autoCarbs;
  const fromMacros   = Math.round(pro * 4 + displayCarbs * 4 + displayFat * 9);
  const diff         = cal - fromMacros;

  const handleSave = () => {
    const updated = {
      ...profile,
      calories: cal,
      customTargets: true,
      macros: { protein: pro, carbs: displayCarbs, fat: displayFat },
    };
    DB.set("tt_profile", updated);
    onSave(updated);
    onClose();
  };

  return (
    <div style={{ background: T.card, borderRadius: 14, padding: 28, width: "100%", maxWidth: 420, border: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <h2 style={{ fontWeight: 700, fontSize: 17, color: T.text, fontFamily: T.serif }}>Custom targets</h2>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}><Icon name="close" size={18} color={T.faint} /></button>
      </div>
      <p style={{ color: T.muted, fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
        Set your own targets. Leave carbs and fat blank to have TrueTrack fill them in automatically around your calorie goal.
      </p>

      <Field label="Daily calorie target" type="number" value={calories} onChange={setCalories} unit="kcal" placeholder={String(profile.calories)} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 6 }}>
        <Field label="Protein" type="number" value={protein} onChange={setProtein} unit="g" placeholder={String(profile.macros.protein)} />
        <Field label="Carbs"   type="number" value={carbs}   onChange={setCarbs}   unit="g" placeholder={String(autoCarbs)} />
        <Field label="Fat"     type="number" value={fat}     onChange={setFat}     unit="g" placeholder={String(autoFat)  } />
      </div>
      {(carbs === "" || fat === "") && (
        <div style={{ fontSize: 11, color: T.accent, marginBottom: 10, lineHeight: 1.5 }}>
          Leave any field blank to use the recommended value.
          Currently: {pro}g protein · {displayCarbs}g carbs · {displayFat}g fat = {fromMacros} kcal.
        </div>
      )}

      <div style={{ padding: "10px 12px", background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, marginBottom: 18, fontSize: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ color: T.muted }}>Calories from macros</span>
          <span style={{ color: T.text, fontWeight: 600 }}>{fromMacros} kcal</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: T.muted }}>Calorie target</span>
          <span style={{ color: T.text, fontWeight: 600 }}>{cal} kcal</span>
        </div>
        {Math.abs(diff) > 20 && (
          <div style={{ marginTop: 8, fontSize: 11, color: T.orange, lineHeight: 1.5 }}>
            {diff > 0
              ? `${diff} kcal unaccounted for — consider increasing a macro.`
              : `Macros exceed target by ${Math.abs(diff)} kcal — consider reducing a macro.`}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Btn v="ghost" onClick={onClose} full>Cancel</Btn>
        <Btn v="dark" onClick={handleSave} full>Save targets</Btn>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   APP SHELL
════════════════════════════════════════════════════════════ */
const NAV = [
  { id: "dashboard", icon: "dashboard", label: "Dashboard" },
  { id: "log",       icon: "log",       label: "Daily diary" },
  { id: "meals",     icon: "meals",     label: "Meal plan" },
  { id: "insights",  icon: "insights",  label: "Insights" },
];

function AppShell({ children, page, setPage, setModal, profile, onReset, onEditProfile, modal, modalContent }) {
  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: T.font, color: T.text, display: "flex", position: "relative" }}>
      <div style={{ width: 210, minHeight: "100vh", background: T.sidebar, padding: "20px 12px", flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "0 4px", marginBottom: 28 }}>
          <Logo variant="dark" size="sm" />
        </div>
        <div style={{ flex: 1 }}>
          {NAV.map(n => (
            <div key={n.id} onClick={() => setPage(n.id)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 7, cursor: "pointer", marginBottom: 2, background: page === n.id ? T.sidebarAct : "transparent", color: page === n.id ? "#9de89d" : "#4a6a4a", fontWeight: page === n.id ? 600 : 400, fontSize: 13, transition: "all 0.15s" }}>
              <Icon name={n.icon} size={15} color={page === n.id ? "#9de89d" : "#4a6a4a"} /> {n.label}
            </div>
          ))}
        </div>
        <div style={{ marginBottom: 12 }}>
          <div onClick={() => setModal("ateout")} style={{ padding: "8px 10px", borderRadius: 7, cursor: "pointer", background: "#2a1a0a", color: "#d4905a", fontWeight: 600, fontSize: 12, display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
            <Icon name="ateout" size={13} color="#d4905a" /> I ate out
          </div>
          <div onClick={() => setModal("planahead")} style={{ padding: "8px 10px", borderRadius: 7, cursor: "pointer", background: "#0a1a2a", color: "#6ab0da", fontWeight: 600, fontSize: 12, display: "flex", alignItems: "center", gap: 7 }}>
            <Icon name="planahead" size={13} color="#6ab0da" /> Plan ahead
          </div>
        </div>
        {profile && (
          <div style={{ padding: "9px 10px", borderRadius: 7, background: T.sidebarAct }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#c8e6c8" }}>{profile.name || "My account"}</div>
            <div style={{ color: "#4a6a4a", fontSize: 11, marginTop: 1 }}>{profile.calories} kcal target</div>
            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <div onClick={onEditProfile} style={{ color: "#6a9a6a", fontSize: 10, cursor: "pointer" }}>Edit profile</div>
              <div style={{ color: "#2a4a2a", fontSize: 10 }}>·</div>
              <div onClick={onReset} style={{ color: "#2a4a2a", fontSize: 10, cursor: "pointer" }}>Reset</div>
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 1, padding: "32px 36px", overflowY: "auto", boxSizing: "border-box" }}>
        {children}
      </div>

      {modal && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(26,46,26,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
          {modalContent}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   WEIGHT TIP — collapsible hint for daily weigh-in
════════════════════════════════════════════════════════════ */
function WeightTip() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
          cursor: "pointer", fontFamily: T.font, transition: "all 0.15s",
          background: open ? T.accentBg : T.bg,
          color: open ? T.accent : T.muted,
          border: `1px solid ${open ? T.accent + "50" : T.border}`,
        }}>
        <Icon name="info" size={12} color={open ? T.accent : T.muted} />
        How to weigh in
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0,
          width: 300, background: T.card, borderRadius: 10,
          border: `1px solid ${T.borderMid}`, padding: 16,
          zIndex: 50, boxShadow: "0 4px 16px rgba(26,46,26,0.10)",
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 10 }}>
            For accurate results
          </div>
          {[
            { icon: "sun",    text: "Weigh yourself first thing in the morning" },
            { icon: "log",    text: "After using the bathroom, before eating or drinking" },
            { icon: "check",  text: "Same time and same scale every day" },
            { icon: "insights", text: "Consistent daily entries unlock the 7-day trend and Learned TDEE" },
            { icon: "info",   text: "Even if you forget to log food, the weight entry alone keeps your trend accurate" },
          ].map((t, i) => (
            <div key={i} style={{ display: "flex", gap: 9, marginBottom: 9, alignItems: "flex-start" }}>
              <Icon name={t.icon} size={13} color={T.accent} style={{ marginTop: 1, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: T.muted, lineHeight: 1.55 }}>{t.text}</span>
            </div>
          ))}
          <div style={{ marginTop: 4, paddingTop: 10, borderTop: `1px solid ${T.border}`, fontSize: 11, color: T.faint, lineHeight: 1.5 }}>
            Daily weight fluctuates by 1–2 kg from water, food, and hormones. The 7-day rolling average is what actually matters — don't stress individual readings.
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   DASHBOARD
════════════════════════════════════════════════════════════ */
function Dashboard({ profile, logs, todayLog, onSave, onProfileUpdate, calAdjustment, onClearAdjustment, onApplyAdjustment }) {
  const trend = NE.weeklyTrend(logs);
  const adj = NE.adaptive(trend);
  const learned = NE.learnedTDEE(logs);
  const { macros } = profile;

  // Active calorie target — use adjustment if applied, else profile
  const activeCalories = calAdjustment ? calAdjustment.calories : profile.calories;

  const eaten = todayLog?.calories || 0;
  const remaining = activeCalories - eaten;

  const [weight, setWeight] = useState(todayLog?.weight || "");
  const [steps, setSteps] = useState(todayLog?.steps || "");
  const [notes, setNotes] = useState(todayLog?.notes || "");
  const [saved, setSaved] = useState(false);
  const [showCustom, setShowCustom] = useState(false);

  const handleSave = () => {
    onSave({
      ...(todayLog || { date: TODAY, meals: { breakfast: [], lunch: [], dinner: [], snacks: [] }, calories: 0, protein: 0, carbs: 0, fat: 0 }),
      date: TODAY,
      weight: +weight || 0,
      steps: +steps || 0,
      notes,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const STATUS = {
    optimal:  { label: "On track — optimal rate",       color: T.accent  },
    fast:     { label: "Losing too fast",                color: T.orange  },
    plateau:  { label: "Plateau detected",               color: T.blue    },
    gaining:  { label: "Weight trending up",             color: T.red     },
    tracking: { label: "Building data — keep logging",   color: T.muted   },
  };
  const si = STATUS[trend?.status || "tracking"];
  const hr = new Date().getHours();
  const greeting = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: T.text, letterSpacing: "-0.3px", marginBottom: 2, fontFamily: T.serif }}>
          {greeting}{profile.name ? `, ${profile.name}` : ""}
        </h1>
        <p style={{ color: T.muted, margin: 0, fontSize: 13 }}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
      </div>

      {trend && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: si.color === T.accent ? T.accentBg : si.color + "12", border: `1px solid ${si.color}30`, marginBottom: learned ? 10 : 20, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: si.color, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: si.color }}>{si.label}</span>
          <span style={{ fontSize: 12, color: T.muted }}>— {adj.msg}</span>
        </div>
      )}

      {learned && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: T.accentBg, border: `1px solid ${T.borderMid}`, marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Icon name="insights" size={15} color={T.accent} />
            <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>
              Learned TDEE: <span style={{ color: T.accent }}>{learned.tdee.toLocaleString()} kcal</span>
            </span>
            <span style={{ fontSize: 11, color: T.muted }}>
              · {learned.tdee > profile.tdee ? "+" : ""}{learned.tdee - profile.tdee} vs formula · {learned.confidence} confidence
            </span>
          </div>
          <span style={{ fontSize: 11, color: T.muted }}>Full breakdown in Insights →</span>
        </div>
      )}

      {/* Calorie adjustment banner */}
      {calAdjustment && (
        <div style={{ padding: "11px 14px", borderRadius: 8, background: T.orangeBg, border: `1px solid ${T.orange}30`, marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 9, flex: 1 }}>
            <Icon name="info" size={15} color={T.orange} style={{ marginTop: 1, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 2 }}>
                Adjusted target: <span style={{ color: T.orange }}>{calAdjustment.calories} kcal</span>
                <span style={{ color: T.muted, fontWeight: 400 }}> (was {calAdjustment.originalCalories})</span>
              </div>
              <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{calAdjustment.note}</div>
            </div>
          </div>
          <button onClick={onClearAdjustment}
            style={{ fontSize: 11, color: T.orange, fontWeight: 600, background: "none", border: `1px solid ${T.orange}40`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: T.font, whiteSpace: "nowrap", flexShrink: 0 }}>
            Restore {calAdjustment.originalCalories} kcal
          </button>
        </div>
      )}

      {/* Option C — yesterday over-budget recovery card (only shows if no active adjustment) */}
      {!calAdjustment && (() => {
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        const yDate = yesterday.toISOString().slice(0, 10);
        const dismissed = DB.get("tt_dismissed_recovery");
        if (dismissed === yDate) return null;
        const yLog = logs.find(l => l.date === yDate);
        if (!yLog || !yLog.calories) return null;
        const yOver = yLog.calories - profile.calories;
        if (yOver < 150) return null;
        const rec = NE.recovery(yOver, profile.calories);
        if (!rec) return null;
        return (
          <div style={{ padding: "12px 14px", borderRadius: 8, background: T.redBg, border: `1px solid ${T.red}20`, marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                  Yesterday you went {yOver} kcal over
                </div>
                <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.65, marginBottom: 8 }}>
                  Recovery plan: <b style={{ color: T.text }}>{rec.adjustedTarget} kcal/day</b> (−{rec.dailyReduction} kcal) for <b style={{ color: T.text }}>{rec.daysNeeded} {rec.daysNeeded === 1 ? "day" : "days"}</b>.
                </div>
                <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.65, padding: "8px 10px", background: T.bg, borderRadius: 6, border: `1px solid ${T.border}` }}>
                  <b style={{ color: T.muted }}>Why spread it out?</b> Trying to undo one over-budget day with a very low-calorie day the next day causes muscle breakdown, fatigue, and often leads to overeating again — creating a cycle. TrueTrack limits the daily reduction to 15% of your target so the recovery is gentle, sustainable, and doesn't harm muscle mass.{rec.glycogenNote && " " + rec.glycogenNote}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0, alignItems: "flex-end" }}>
                <Btn onClick={() => { onApplyAdjustment({ calories: rec.adjustedTarget, note: `Recovery: ${yOver} kcal over on ${yDate}. −${rec.dailyReduction} kcal/day for ${rec.daysNeeded} days.`, days: rec.daysNeeded, originalCalories: profile.calories }); }} v="dark" size="sm">
                  Apply
                </Btn>
                <button onClick={() => { DB.set("tt_dismissed_recovery", yDate); onClearAdjustment(); }}
                  style={{ fontSize: 11, color: T.muted, background: "#fff", border: `1px solid ${T.border}`, borderRadius: 5, padding: "4px 8px", cursor: "pointer", fontFamily: T.font }}>
                  Ignore
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Custom targets modal overlay */}
      {showCustom && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(26,46,26,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
          <CustomTargetsModal
            profile={profile}
            onSave={onProfileUpdate}
            onClose={() => setShowCustom(false)}
          />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        {/* Calorie target card — with custom targets button */}
        <Card style={{ padding: "14px 14px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ fontSize: 10, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 7 }}>
              Calorie target
              {(profile.customTargets || calAdjustment) && <span style={{ marginLeft: 5, color: calAdjustment ? T.orange : T.accent, fontSize: 8 }}>{calAdjustment ? "ADJUSTED" : "CUSTOM"}</span>}
            </div>
            <button onClick={() => setShowCustom(true)}
              style={{ fontSize: 9, color: T.accent, fontWeight: 600, background: T.accentBg, border: `1px solid ${T.accent}40`, borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontFamily: T.font, whiteSpace: "nowrap" }}>
              Edit
            </button>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: calAdjustment ? T.orange : T.accent }}>{activeCalories}</div>
          <div style={{ fontSize: 11, color: T.faint, marginTop: 2 }}>kcal / day</div>
        </Card>
        {[
          { l: "Eaten today",   v: eaten,             sub: remaining >= 0 ? `${remaining} remaining` : `${Math.abs(remaining)} over`, c: remaining < 0 ? T.red : T.text },
          { l: "Weight",        v: trend?.current ? trend.current + " kg" : "—", sub: trend?.change != null ? `${trend.change > 0 ? "+" : ""}${trend.change} kg/wk` : "log daily", c: T.text },
          { l: "Protein today", v: (todayLog?.protein || 0) + "g", sub: `target ${macros.protein}g`, c: (todayLog?.protein || 0) >= macros.protein * 0.9 ? T.accent : T.text },
        ].map((s, i) => (
          <Card key={i} style={{ padding: "14px 14px 12px" }}>
            <div style={{ fontSize: 10, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 7 }}>{s.l}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.c }}>{s.v}</div>
            <div style={{ fontSize: 11, color: T.faint, marginTop: 2 }}>{s.sub}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginBottom: 16 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Weight trend</div>
            {trend?.status && <Pill text={si.label} color={si.color} />}
          </div>
          <WeightChart logs={logs} />
          {adj.delta !== 0 && (
            <div style={{ marginTop: 12, padding: "9px 12px", background: T.accentBg, borderRadius: 7, fontSize: 12, color: T.muted, border: `1px solid ${T.border}` }}>
              Recommended: <b style={{ color: T.accent }}>{adj.delta > 0 ? "+" : ""}{adj.delta} kcal/day</b> → new target <b style={{ color: T.text }}>{profile.calories + adj.delta} kcal</b>
            </div>
          )}
        </Card>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 16 }}>Today's macros</div>
          <MBar label="Protein"       curr={todayLog?.protein || 0} target={macros.protein} color={T.accent} />
          <MBar label="Carbohydrates" curr={todayLog?.carbs   || 0} target={macros.carbs}   color="#7aba7a" />
          <MBar label="Fats"          curr={todayLog?.fat     || 0} target={macros.fat}      color="#4caf8a" />
          <div style={{ marginTop: 14, padding: "9px 12px", background: T.bg, borderRadius: 7, border: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: T.muted }}>Total calories</span>
              <span><b style={{ color: eaten > profile.calories ? T.red : T.text }}>{eaten}</b><span style={{ color: T.faint }}> / {profile.calories}</span></span>
            </div>
          </div>
        </Card>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Weight and activity</div>
          <WeightTip />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Body weight" type="number" value={weight} onChange={setWeight} unit="kg" step="0.1" placeholder="80.5" />
          <Field label="Steps" type="number" value={steps} onChange={setSteps} placeholder="8000" unit="steps" />
          <Field label="Notes" value={notes} onChange={setNotes} placeholder="Leg day, slept well…" />
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Btn onClick={handleSave} v="dark" size="sm">{saved ? "✓ Saved" : "Save"}</Btn>
          <span style={{ fontSize: 11, color: T.faint }}>Also visible in Daily diary</span>
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 16 }}>Activity targets</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {[
            { icon: "steps",  l: "Daily steps",         v: "8,000–10,000",    d: "Non-negotiable foundation for fat loss" },
            { icon: "weight", l: "Resistance training", v: "3–4× per week",   d: "Essential for preserving muscle in a deficit" },
            { icon: "fire",   l: "Optional cardio",     v: "20–30 min",       d: "Adds ~200 kcal burn without extra hunger" },
          ].map((a, i) => (
            <div key={i} style={{ padding: 14, background: T.bg, borderRadius: 8, border: `1px solid ${T.border}` }}>
              <Icon name={a.icon} size={18} color={T.accent} />
              <div style={{ fontSize: 10, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", margin: "8px 0 3px" }}>{a.l}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 3 }}>{a.v}</div>
              <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.5 }}>{a.d}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   FOOD SEARCH PANEL
════════════════════════════════════════════════════════════ */
function FoodSearchPanel({ mealKey, onAdd, onClose }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  const [qtyStr, setQtyStr] = useState("1");
  const [err, setErr] = useState(null);
  const syncQty = (val) => { const n = Math.max(0.25, +val || 0.25); setQty(n); setQtyStr(String(n)); };
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const doSearch = async () => {
    if (!query.trim()) return;
    setLoading(true); setErr(null); setResults([]); setSelected(null);
    try {
      const raw = await callAI(
        `Nutritional data for: "${query}". Return ONLY a JSON array of up to 5 foods: [{"name":"...","brand":"...","servingSize":100,"servingUnit":"g","calories":200,"protein":20,"carbs":10,"fat":8,"fiber":2}]. Realistic serving sizes. No markdown, start with [`,
        "You are a nutrition database. Output ONLY a raw JSON array starting with [ and ending with ]. No other text."
      );
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const s = cleaned.indexOf("["), e = cleaned.lastIndexOf("]");
      if (s === -1) throw new Error("No array");
      const arr = JSON.parse(cleaned.slice(s, e + 1));
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("Empty");
      setResults(arr);
    } catch {
      setErr("No results — try a more specific name");
    } finally { setLoading(false); }
  };

  const scaled = val => selected ? Math.round(val * qty) : 0;
  const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snacks: "Snacks" };

  const handleAdd = () => {
    if (!selected) return;
    onAdd({ id: Date.now().toString(), name: selected.name, brand: selected.brand || "", servingSize: selected.servingSize, servingUnit: selected.servingUnit, qty, calories: scaled(selected.calories), protein: scaled(selected.protein), carbs: scaled(selected.carbs), fat: scaled(selected.fat), fiber: scaled(selected.fiber || 0) });
    setQuery(""); setResults([]); setSelected(null); setQty(1);
  };

  return (
    <div style={{ background: T.accentBg, border: `1px solid ${T.border}`, borderRadius: 9, padding: 14, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: T.accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>Add to {MEAL_LABELS[mealKey]}</span>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}><Icon name="close" size={14} color={T.faint} /></button>
      </div>
      <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
        <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && doSearch()}
          placeholder="Search food... (e.g. 'Greek yogurt', 'Big Mac')"
          style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: "8px 11px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none" }} />
        <Btn onClick={doSearch} disabled={loading || !query.trim()} v="dark" size="sm">{loading ? <Spin size={12} /> : "Search"}</Btn>
      </div>
      {err && <div style={{ color: T.orange, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {results.length > 0 && !selected && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {results.map((f, i) => (
            <div key={i} onClick={() => { setSelected(f); setQty(1); }}
              style={{ padding: "9px 11px", background: T.card, borderRadius: 7, cursor: "pointer", border: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{f.name}</div>
                <div style={{ fontSize: 11, color: T.muted }}>{f.brand ? f.brand + " · " : ""}{f.servingSize} {f.servingUnit}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{f.calories} kcal</div>
                <div style={{ fontSize: 10, color: T.faint }}>P{f.protein}g C{f.carbs}g F{f.fat}g</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {selected && (
        <div style={{ background: T.card, borderRadius: 8, padding: 12, border: `1px solid ${T.borderMid}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: T.text }}>{selected.name}</div>
              <div style={{ fontSize: 11, color: T.muted }}>{selected.brand || "Generic"}</div>
            </div>
            <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: T.muted, fontFamily: T.font }}>← back</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: T.muted, width: 56 }}>Servings</span>
            <button onClick={() => { const n = Math.max(0.25, +(qty - 0.25).toFixed(2)); setQty(n); setQtyStr(String(n)); }} style={{ width: 26, height: 26, borderRadius: 5, background: T.bg, border: `1px solid ${T.border}`, color: T.text, cursor: "pointer", fontSize: 14 }}>−</button>
            <input type="number" value={qtyStr} min="0.25" step="0.25"
              onChange={e => setQtyStr(e.target.value)}
              onBlur={e => syncQty(e.target.value)}
              style={{ width: 50, textAlign: "center", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5, padding: "4px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none" }} />
            <button onClick={() => { const n = +(qty + 0.25).toFixed(2); setQty(n); setQtyStr(String(n)); }} style={{ width: 26, height: 26, borderRadius: 5, background: T.bg, border: `1px solid ${T.border}`, color: T.text, cursor: "pointer", fontSize: 14 }}>+</button>
            <span style={{ fontSize: 11, color: T.faint }}>× {selected.servingSize} {selected.servingUnit}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 10 }}>
            {[{ l: "Calories", v: scaled(selected.calories), c: T.accent }, { l: "Protein", v: scaled(selected.protein) + "g", c: T.accent }, { l: "Carbs", v: scaled(selected.carbs) + "g", c: "#7aba7a" }, { l: "Fat", v: scaled(selected.fat) + "g", c: "#4caf8a" }].map(s => (
              <div key={s.l} style={{ padding: "7px 8px", background: T.accentBg, borderRadius: 6, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{s.l}</div>
                <div style={{ fontWeight: 700, fontSize: 13, color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>
          <Btn onClick={handleAdd} v="dark" full size="sm">+ Add to {MEAL_LABELS[mealKey]}</Btn>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   MEAL SECTION
════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════
   FOOD LOG ITEM — logged food row with inline qty editing
════════════════════════════════════════════════════════════ */
function FoodLogItem({ food: f, onRemove, onUpdateQty }) {
  const [editing, setEditing] = useState(false);
  const [qtyStr,  setQtyStr]  = useState(String(f.qty));

  // Per-unit macros (to scale when qty changes)
  const perUnit = {
    calories: f.qty > 0 ? f.calories / f.qty : f.calories,
    protein:  f.qty > 0 ? f.protein  / f.qty : f.protein,
    carbs:    f.qty > 0 ? f.carbs    / f.qty : f.carbs,
    fat:      f.qty > 0 ? f.fat      / f.qty : f.fat,
  };

  const commitQty = (val) => {
    const n = Math.max(0.25, +val || 0.25);
    setQtyStr(String(n));
    setEditing(false);
    onUpdateQty({
      ...f,
      qty: n,
      calories: Math.round(perUnit.calories * n),
      protein:  Math.round(perUnit.protein  * n),
      carbs:    Math.round(perUnit.carbs    * n),
      fat:      Math.round(perUnit.fat      * n),
    });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", padding: "9px 16px", borderBottom: `1px solid ${T.border}`, gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
        {editing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 4 }}>
            <button onClick={() => { const n = Math.max(0.25, +(+qtyStr - 0.25).toFixed(2)); setQtyStr(String(n)); }}
              style={{ width: 20, height: 20, borderRadius: 4, background: T.bg, border: `1px solid ${T.border}`, cursor: "pointer", fontSize: 13, color: T.text, fontFamily: T.font }}>−</button>
            <input type="number" value={qtyStr} autoFocus
              onChange={e => setQtyStr(e.target.value)}
              onBlur={e => commitQty(e.target.value)}
              onKeyDown={e => e.key === "Enter" && commitQty(qtyStr)}
              style={{ width: 44, textAlign: "center", background: T.bg, border: `1px solid ${T.accent}`, borderRadius: 4, padding: "2px", color: T.text, fontFamily: T.font, fontSize: 12, outline: "none" }} />
            <button onClick={() => { const n = +(+qtyStr + 0.25).toFixed(2); setQtyStr(String(n)); }}
              style={{ width: 20, height: 20, borderRadius: 4, background: T.bg, border: `1px solid ${T.border}`, cursor: "pointer", fontSize: 13, color: T.text, fontFamily: T.font }}>+</button>
            <span style={{ fontSize: 10, color: T.muted }}>× {f.servingSize}{f.servingUnit}</span>
            <button onClick={() => commitQty(qtyStr)}
              style={{ fontSize: 10, color: T.accent, fontWeight: 700, background: "none", border: "none", cursor: "pointer", fontFamily: T.font, marginLeft: 2 }}>Save</button>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: T.muted, cursor: "pointer" }} onClick={() => { setQtyStr(String(f.qty)); setEditing(true); }}>
            {f.qty} × {f.servingSize} {f.servingUnit}{f.brand ? " · " + f.brand : ""}
            <span style={{ color: T.accent, marginLeft: 6, fontSize: 10, fontWeight: 600 }}>Edit</span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, fontSize: 11, flexShrink: 0 }}>
        <span style={{ color: T.accent, fontWeight: 700, minWidth: 48, textAlign: "right" }}>{f.calories} kcal</span>
        <span style={{ color: T.accent }}>P {f.protein}g</span>
        <span style={{ color: "#7aba7a" }}>C {f.carbs}g</span>
        <span style={{ color: "#4caf8a" }}>F {f.fat}g</span>
      </div>
      <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer" }}>
        <Icon name="close" size={13} color={T.faint} />
      </button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   SAVED MEAL PANEL — browse saved meals and log them
════════════════════════════════════════════════════════════ */
function SavedMealPanel({ mealKey, onAddFoods, onClose }) {
  const [meals, setMeals]     = useState(() => SM.get());
  const [creating, setCreating] = useState(false);
  const [logged, setLogged]   = useState({});
  const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snacks: "Snacks" };

  const deleteMeal = (id) => { SM.del(id); setMeals(SM.get()); };

  const logMeal = (meal) => {
    const now = Date.now();
    onAddFoods(meal.foods.map((f, i) => ({ ...f, id: (now + i).toString() })));
    setLogged(l => ({ ...l, [meal.id]: true }));
  };

  if (creating) {
    return <CreateMealPanel onSave={(meal) => { SM.add(meal); setMeals(SM.get()); setCreating(false); }} onClose={() => setCreating(false)} />;
  }

  return (
    <div style={{ background: T.accentBg, border: `1px solid ${T.borderMid}`, borderRadius: 10, padding: 14, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name="bookmark" size={14} color={T.accent} />
          <span style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>Saved meals</span>
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <Btn onClick={() => setCreating(true)} v="ghost" size="sm">+ Create meal</Btn>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <Icon name="close" size={14} color={T.faint} />
          </button>
        </div>
      </div>

      {meals.length === 0 ? (
        <div style={{ textAlign: "center", padding: "24px 0" }}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 12 }}>No saved meals yet.</div>
          <Btn onClick={() => setCreating(true)} v="dark" size="sm">Create your first meal</Btn>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {meals.map(meal => {
            const totals = meal.foods.reduce((a, f) => ({ cal: a.cal + f.calories, p: a.p + f.protein, c: a.c + f.carbs, f: a.f + f.fat }), { cal: 0, p: 0, c: 0, f: 0 });
            return (
              <div key={meal.id} style={{ background: T.card, borderRadius: 8, padding: "10px 12px", border: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{meal.name}</div>
                    <div style={{ fontSize: 11, color: T.muted }}>{meal.foods.length} item{meal.foods.length !== 1 ? "s" : ""} · {totals.cal} kcal · P{totals.p}g C{totals.c}g F{totals.f}g</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <Btn onClick={() => logMeal(meal)} disabled={!!logged[meal.id]} v={logged[meal.id] ? "ghost" : "dark"} size="sm">
                      {logged[meal.id] ? "✓ Added" : `Add to ${MEAL_LABELS[mealKey]}`}
                    </Btn>
                    <button onClick={() => deleteMeal(meal.id)}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
                      <Icon name="close" size={12} color={T.faint} />
                    </button>
                  </div>
                </div>
                {/* Food list */}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {meal.foods.map((f, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.faint, padding: "2px 0", borderTop: i === 0 ? `1px solid ${T.border}` : "none" }}>
                      <span>{f.qty} × {f.name}</span>
                      <span>{f.calories} kcal</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   CREATE MEAL PANEL — build a named meal from scratch
════════════════════════════════════════════════════════════ */
function CreateMealPanel({ onSave, onClose }) {
  const [name, setName]     = useState("");
  const [foods, setFoods]   = useState([]);
  const [adding, setAdding] = useState(false);

  const removeFood = (id) => setFoods(f => f.filter(x => x.id !== id));

  const totals = foods.reduce((a, f) => ({ cal: a.cal + f.calories, p: a.p + f.protein, c: a.c + f.carbs, f: a.f + f.fat }), { cal: 0, p: 0, c: 0, f: 0 });

  const handleSave = () => {
    if (!name.trim() || foods.length === 0) return;
    onSave({ id: Date.now().toString(), name: name.trim(), foods, createdAt: Date.now() });
  };

  return (
    <div style={{ background: T.accentBg, border: `1px solid ${T.borderMid}`, borderRadius: 10, padding: 14, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name="bookmark" size={14} color={T.accent} />
          <span style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>Create meal</span>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <Icon name="close" size={14} color={T.faint} />
        </button>
      </div>

      <Field label="Meal name" value={name} onChange={setName} placeholder="e.g. Post-workout shake, My go-to lunch" />

      {/* Added foods */}
      {foods.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
            Foods — {totals.cal} kcal · P{totals.p}g C{totals.c}g F{totals.f}g
          </div>
          {foods.map((f, i) => (
            <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: T.card, borderRadius: 6, marginBottom: 4, border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 12, color: T.text }}>{f.qty} × {f.name}</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: T.accent, fontWeight: 600 }}>{f.calories} kcal</span>
                <button onClick={() => removeFood(f.id)} style={{ background: "none", border: "none", cursor: "pointer" }}>
                  <Icon name="close" size={11} color={T.faint} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add food search */}
      {adding ? (
        <FoodSearchPanel
          mealKey="snacks"
          onAdd={f => { setFoods(prev => [...prev, { ...f, id: Date.now().toString() + Math.random() }]); setAdding(false); }}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button onClick={() => setAdding(true)}
          style={{ width: "100%", padding: "8px", borderRadius: 7, border: `1.5px dashed ${T.border}`, background: T.card, cursor: "pointer", fontSize: 12, color: T.muted, fontFamily: T.font, marginBottom: 10 }}>
          + Add food
        </button>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Btn v="ghost" onClick={onClose} full>Cancel</Btn>
        <Btn v="dark" onClick={handleSave} disabled={!name.trim() || foods.length === 0} full>Save meal</Btn>
      </div>
    </div>
  );
}

function MealSection({ mealKey, label, dotColor, foods, onRemove, onAddFood, onUpdateQty, onScanFood, scanOpen }) {
  const [open,        setOpen]        = useState(false);
  const [quickOpen,   setQuickOpen]   = useState(false);
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const [savedOpen,   setSavedOpen]   = useState(false);
  const [savingName,  setSavingName]  = useState("");
  const [showSaveAs,  setShowSaveAs]  = useState(false);
  const [savedConfirm,setSavedConfirm]= useState(false);
  const totals = foods.reduce((a, f) => ({ calories: a.calories + f.calories, protein: a.protein + f.protein, carbs: a.carbs + f.carbs, fat: a.fat + f.fat }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  const closeAll = () => { setOpen(false); setQuickOpen(false); setBarcodeOpen(false); setSavedOpen(false); setShowSaveAs(false); };

  const handleSaveAsMeal = () => {
    if (!savingName.trim() || foods.length === 0) return;
    SM.add({ id: Date.now().toString(), name: savingName.trim(), foods: foods.map(f => ({ ...f })), createdAt: Date.now() });
    setSavingName("");
    setShowSaveAs(false);
    setSavedConfirm(true);
    setTimeout(() => setSavedConfirm(false), 2000);
  };

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: (foods.length > 0 || open || quickOpen || barcodeOpen || scanOpen || savedOpen || showSaveAs) ? `1px solid ${T.border}` : "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: T.text }}>{label}</div>
            {foods.length > 0 && <div style={{ fontSize: 11, color: T.muted }}>{totals.calories} kcal · P{totals.protein}g C{totals.carbs}g F{totals.fat}g</div>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          {/* Photo scan */}
          <button onClick={() => { closeAll(); onScanFood(); }}
            style={{ padding: "4px 8px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", background: scanOpen ? T.accentBg : T.bg, color: scanOpen ? T.accent : T.muted, border: `1px solid ${scanOpen ? T.accent + "50" : T.border}`, fontFamily: T.font, display: "flex", alignItems: "center", gap: 4, transition: "all 0.15s" }}>
            <Icon name="camera" size={11} color={scanOpen ? T.accent : T.muted} />
          </button>
          {/* Barcode */}
          <button onClick={() => { const next = !barcodeOpen; closeAll(); setBarcodeOpen(next); }}
            style={{ padding: "4px 8px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", background: barcodeOpen ? T.accentBg : T.bg, color: barcodeOpen ? T.accent : T.muted, border: `1px solid ${barcodeOpen ? T.accent + "50" : T.border}`, fontFamily: T.font, display: "flex", alignItems: "center", gap: 4, transition: "all 0.15s" }}>
            <Icon name="barcode" size={11} color={barcodeOpen ? T.accent : T.muted} />
          </button>
          {/* Saved meals */}
          <button onClick={() => { const next = !savedOpen; closeAll(); setSavedOpen(next); }}
            style={{ padding: "4px 8px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", background: savedOpen ? T.accentBg : T.bg, color: savedOpen ? T.accent : T.muted, border: `1px solid ${savedOpen ? T.accent + "50" : T.border}`, fontFamily: T.font, display: "flex", alignItems: "center", gap: 4, transition: "all 0.15s" }}
            title="Saved meals">
            <Icon name="bookmark" size={11} color={savedOpen ? T.accent : T.muted} />
          </button>
          {/* Quick add */}
          <button onClick={() => { const next = !quickOpen; closeAll(); setQuickOpen(next); }}
            style={{ padding: "4px 9px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", background: quickOpen ? T.accentBg : T.bg, color: quickOpen ? T.accent : T.muted, border: `1px solid ${quickOpen ? T.accent + "50" : T.border}`, fontFamily: T.font, transition: "all 0.15s" }}>
            +1
          </button>
          {/* Food search */}
          <button onClick={() => { const next = !open; closeAll(); setOpen(next); }}
            style={{ padding: "4px 9px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", background: open ? T.accentBg : T.bg, color: open ? T.accent : T.muted, border: `1px solid ${T.border}`, fontFamily: T.font }}>
            {open ? "✕" : "+ Add"}
          </button>
        </div>
      </div>
      {open && (
        <div style={{ padding: "10px 16px", borderBottom: foods.length > 0 ? `1px solid ${T.border}` : "none" }}>
          <FoodSearchPanel mealKey={mealKey} onAdd={f => { onAddFood(f); }} onClose={() => setOpen(false)} />
        </div>
      )}
      {barcodeOpen && (
        <div style={{ padding: "10px 16px", borderBottom: foods.length > 0 ? `1px solid ${T.border}` : "none" }}>
          <BarcodeScanPanel mealKey={mealKey} onAdd={f => { onAddFood(f); setBarcodeOpen(false); }} onClose={() => setBarcodeOpen(false)} />
        </div>
      )}
      {quickOpen && (
        <div style={{ padding: "10px 16px", borderBottom: foods.length > 0 ? `1px solid ${T.border}` : "none" }}>
          <QuickAddPanel mealKey={mealKey} onAdd={f => { onAddFood(f); setQuickOpen(false); }} onClose={() => setQuickOpen(false)} />
        </div>
      )}
      {savedOpen && (
        <div style={{ padding: "10px 16px", borderBottom: foods.length > 0 ? `1px solid ${T.border}` : "none" }}>
          <SavedMealPanel
            mealKey={mealKey}
            onAddFoods={newFoods => { newFoods.forEach(f => onAddFood(f)); setSavedOpen(false); }}
            onClose={() => setSavedOpen(false)}
          />
        </div>
      )}
      {/* Save this meal — appears when foods are logged, not in other open states */}
      {foods.length > 0 && !open && !quickOpen && !barcodeOpen && !savedOpen && (
        <div style={{ padding: "6px 16px", borderBottom: `1px solid ${T.border}`, background: T.accentBg }}>
          {showSaveAs ? (
            <div style={{ display: "flex", gap: 7, alignItems: "center", paddingTop: 4, paddingBottom: 4 }}>
              <input value={savingName} onChange={e => setSavingName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSaveAsMeal()}
                placeholder="Name this meal…"
                autoFocus
                style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", color: T.text, fontFamily: T.font, fontSize: 12, outline: "none" }} />
              <Btn onClick={handleSaveAsMeal} disabled={!savingName.trim()} v="dark" size="sm">Save</Btn>
              <button onClick={() => setShowSaveAs(false)} style={{ background: "none", border: "none", cursor: "pointer" }}>
                <Icon name="close" size={12} color={T.faint} />
              </button>
            </div>
          ) : (
            <button onClick={() => setShowSaveAs(true)}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: savedConfirm ? T.accent : T.muted, fontFamily: T.font, padding: "4px 0", display: "flex", alignItems: "center", gap: 5 }}>
              <Icon name="bookmark" size={11} color={savedConfirm ? T.accent : T.muted} />
              {savedConfirm ? "✓ Meal saved" : "Save as meal"}
            </button>
          )}
        </div>
      )}
      {foods.map((f, i) => (
        <FoodLogItem key={f.id} food={f}
          onRemove={() => onRemove(f.id)}
          onUpdateQty={updatedFood => onUpdateQty && onUpdateQty(updatedFood)}
        />
      ))}
      {foods.length > 1 && (
        <div style={{ display: "flex", gap: 12, padding: "8px 16px", background: T.accentBg, fontSize: 11, fontWeight: 700 }}>
          <span style={{ color: T.muted, flex: 1 }}>Meal total</span>
          <span style={{ color: T.accent }}>{totals.calories} kcal</span>
          <span style={{ color: T.accent }}>P {totals.protein}g</span>
          <span style={{ color: "#7aba7a" }}>C {totals.carbs}g</span>
          <span style={{ color: "#4caf8a" }}>F {totals.fat}g</span>
          <span style={{ minWidth: 16 }} />
        </div>
      )}
      {foods.length === 0 && !open && <div style={{ padding: "12px 16px", fontSize: 12, color: T.faint, fontStyle: "italic" }}>Nothing logged yet</div>}
    </Card>
  );
}

/* ════════════════════════════════════════════════════════════
   LOG PAGE
════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════
   QUICK ADD PANEL — manually enter calories + macros
════════════════════════════════════════════════════════════ */
function QuickAddPanel({ mealKey, onAdd, onClose }) {
  const [name,     setName]     = useState("");
  const [calories, setCalories] = useState("");
  const [protein,  setProtein]  = useState("");
  const [carbs,    setCarbs]    = useState("");
  const [fat,      setFat]      = useState("");
  const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snacks: "Snacks" };

  // Auto-calculate calories from macros if calories field is empty
  const derivedCals = Math.round((+protein || 0) * 4 + (+carbs || 0) * 4 + (+fat || 0) * 9);
  const displayCals = calories ? +calories : derivedCals;

  const handleAdd = () => {
    if (!calories && !protein && !carbs && !fat) return;
    onAdd({
      id: Date.now().toString(),
      name: name.trim() || "Quick add",
      brand: "",
      servingSize: 1, servingUnit: "serving", qty: 1,
      calories: displayCals,
      protein:  +protein  || 0,
      carbs:    +carbs    || 0,
      fat:      +fat      || 0,
      fiber:    0,
    });
    onClose();
  };

  return (
    <div style={{ background: T.accentBg, border: `1px solid ${T.borderMid}`, borderRadius: 10, padding: 14, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name="quick" size={14} color={T.accent} />
          <span style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>Quick add to {MEAL_LABELS[mealKey]}</span>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <Icon name="close" size={14} color={T.faint} />
        </button>
      </div>

      <Field label="Name (optional)" value={name} onChange={setName} placeholder="e.g. Protein bar, Coffee with milk" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 11, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>Calories</div>
          <div style={{ position: "relative" }}>
            <input type="number" value={calories} onChange={e => setCalories(e.target.value)}
              placeholder={derivedCals > 0 ? String(derivedCals) + " (from macros)" : "0"}
              style={{ width: "100%", background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: "9px 40px 9px 12px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: T.dimmed, fontSize: 11, pointerEvents: "none" }}>kcal</span>
          </div>
          {!calories && derivedCals > 0 && (
            <div style={{ fontSize: 10, color: T.accent, marginTop: 3 }}>Auto: {derivedCals} kcal from macros</div>
          )}
        </div>
        <Field label="Protein" type="number" value={protein} onChange={setProtein} unit="g" placeholder="0" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        <Field label="Carbohydrates" type="number" value={carbs} onChange={setCarbs} unit="g" placeholder="0" />
        <Field label="Fat" type="number" value={fat} onChange={setFat} unit="g" placeholder="0" />
      </div>

      {/* Live preview */}
      {(displayCals > 0 || protein || carbs || fat) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 12 }}>
          {[
            { l: "Calories", v: displayCals,        c: T.accent  },
            { l: "Protein",  v: (+protein||0)+"g",  c: T.accent  },
            { l: "Carbs",    v: (+carbs||0)+"g",    c: "#7aba7a" },
            { l: "Fat",      v: (+fat||0)+"g",      c: "#4caf8a" },
          ].map(s => (
            <div key={s.l} style={{ textAlign: "center", padding: "6px 4px", background: T.card, borderRadius: 6, border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{s.l}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: s.c }}>{s.v}</div>
            </div>
          ))}
        </div>
      )}

      <Btn onClick={handleAdd} disabled={!displayCals && !protein && !carbs && !fat} v="dark" full size="sm">
        Add to diary
      </Btn>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   BARCODE SCAN PANEL — scan product barcode → Open Food Facts
   Uses Open Food Facts API (free, no key, 3M+ products)
════════════════════════════════════════════════════════════ */
function BarcodeScanPanel({ mealKey, onAdd, onClose }) {
  const [barcode,   setBarcode]   = useState("");
  const [result,    setResult]    = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [err,       setErr]       = useState(null);
  const [qty,       setQty]       = useState(1);
  const [qtyStr,    setQtyStr]    = useState("1");
  const [scanning,  setScanning]  = useState(false);
  const videoRef  = useRef(null);
  const streamRef = useRef(null);
  const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snacks: "Snacks" };

  // Lookup barcode in Open Food Facts
  const lookup = async (code) => {
    if (!code.trim()) return;
    setLoading(true); setErr(null); setResult(null);
    try {
      const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${code.trim()}.json`);
      const d = await r.json();
      if (d.status !== 1) throw new Error("Product not found");
      const p = d.product;
      const n = p.nutriments || {};
      // Open Food Facts stores per 100g — we use serving size if available
      const servingG = parseFloat(p.serving_size) || 100;
      const per100 = {
        calories: Math.round(n["energy-kcal_100g"] || n["energy-kcal"] || 0),
        protein:  Math.round(n["proteins_100g"]     || 0),
        carbs:    Math.round(n["carbohydrates_100g"] || 0),
        fat:      Math.round(n["fat_100g"]           || 0),
        fiber:    Math.round(n["fiber_100g"]         || 0),
      };
      // Scale to serving
      const scale = servingG / 100;
      setResult({
        name:        p.product_name || p.product_name_en || "Unknown product",
        brand:       p.brands || "",
        servingSize: servingG,
        servingUnit: "g",
        per100,
        serving: {
          calories: Math.round(per100.calories * scale),
          protein:  Math.round(per100.protein  * scale),
          carbs:    Math.round(per100.carbs    * scale),
          fat:      Math.round(per100.fat      * scale),
          fiber:    Math.round(per100.fiber    * scale),
        },
      });
    } catch (e) {
      setErr(e.message === "Product not found"
        ? "Product not found. Try entering the barcode manually."
        : "Lookup failed. Check your internet connection.");
    } finally { setLoading(false); }
  };

  // Camera barcode scanning using BarcodeDetector API (Chrome/Edge)
  const startCamera = async () => {
    if (!("BarcodeDetector" in window)) {
      setErr("Camera scanning requires Chrome on Android/desktop. On iPhone, type the barcode manually.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } } });
      streamRef.current = stream;
      setScanning(true);
      // Must wait for React to re-render the <video> element before assigning srcObject
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
      }, 60);
      const detector = new window.BarcodeDetector({ formats: ["ean_13","ean_8","upc_a","upc_e","code_128","code_39"] });
      const scan = async () => {
        if (!streamRef.current) return;
        try {
          if (videoRef.current?.readyState === 4) {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0) {
              stopCamera();
              setBarcode(codes[0].rawValue);
              lookup(codes[0].rawValue);
              return;
            }
          }
        } catch {}
        requestAnimationFrame(scan);
      };
      // Give the video time to start before scanning
      setTimeout(() => requestAnimationFrame(scan), 200);
    } catch {
      setErr("Camera permission denied. Type the barcode number manually.");
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setScanning(false);
  };

  useEffect(() => () => stopCamera(), []);

  const scaled = (val) => Math.round(val * qty);

  return (
    <div style={{ background: T.accentBg, border: `1px solid ${T.borderMid}`, borderRadius: 10, padding: 14, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name="barcode" size={14} color={T.accent} />
          <span style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>Barcode — {MEAL_LABELS[mealKey]}</span>
        </div>
        <button onClick={() => { stopCamera(); onClose(); }} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <Icon name="close" size={14} color={T.faint} />
        </button>
      </div>

      {/* Camera viewfinder */}
      {scanning && (
        <div style={{ position: "relative", marginBottom: 10, borderRadius: 8, overflow: "hidden", background: "#000" }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", maxHeight: 180, display: "block", objectFit: "cover" }} />
          <div style={{ position: "absolute", inset: 0, border: "2px solid " + T.accent, borderRadius: 8, pointerEvents: "none", opacity: 0.6 }} />
          <div style={{ position: "absolute", bottom: 8, left: 0, right: 0, textAlign: "center", fontSize: 11, color: "#fff", opacity: 0.8 }}>
            Point at barcode
          </div>
          <button onClick={stopCamera} style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.5)", border: "none", borderRadius: "50%", width: 24, height: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={12} color="#fff" />
          </button>
        </div>
      )}

      {/* Manual barcode input */}
      <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
        <input
          type="text" value={barcode} onChange={e => setBarcode(e.target.value)}
          onKeyDown={e => e.key === "Enter" && lookup(barcode)}
          placeholder="Type or scan barcode number..."
          style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: "8px 11px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none" }}
        />
        <Btn onClick={() => lookup(barcode)} disabled={loading || !barcode.trim()} v="dark" size="sm">
          {loading ? <Spin size={12} /> : "Look up"}
        </Btn>
      </div>

      {/* Scan button */}
      {!scanning && !result && (
        <button onClick={startCamera} style={{ width: "100%", padding: "9px", borderRadius: 7, border: `1.5px dashed ${T.border}`, background: T.card, cursor: "pointer", fontSize: 12, color: T.muted, fontFamily: T.font, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginBottom: 10 }}>
          <Icon name="camera" size={13} color={T.muted} /> Scan with camera
        </button>
      )}

      {err && <div style={{ color: T.red, fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>{err}</div>}

      {/* Product result */}
      {result && (
        <div style={{ background: T.card, borderRadius: 8, padding: 12, border: `1px solid ${T.border}` }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{result.name}</div>
            {result.brand && <div style={{ fontSize: 11, color: T.muted }}>{result.brand}</div>}
          </div>

          {/* Serving size + qty control */}
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: T.muted }}>Servings</span>
            <button onClick={() => { const n = Math.max(0.25, +(qty - 0.25).toFixed(2)); setQty(n); setQtyStr(String(n)); }}
              style={{ width: 26, height: 26, borderRadius: 5, background: T.bg, border: `1px solid ${T.border}`, cursor: "pointer", fontSize: 14, color: T.text, fontFamily: T.font }}>−</button>
            <input type="number" value={qtyStr} min="0.25" step="0.25"
              onChange={e => setQtyStr(e.target.value)}
              onBlur={e => { const n = Math.max(0.25, +e.target.value || 0.25); setQty(n); setQtyStr(String(n)); }}
              style={{ width: 50, textAlign: "center", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5, padding: "5px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none" }} />
            <button onClick={() => { const n = +(qty + 0.25).toFixed(2); setQty(n); setQtyStr(String(n)); }}
              style={{ width: 26, height: 26, borderRadius: 5, background: T.bg, border: `1px solid ${T.border}`, cursor: "pointer", fontSize: 14, color: T.text, fontFamily: T.font }}>+</button>
            <span style={{ fontSize: 11, color: T.faint }}>× {result.servingSize}{result.servingUnit}</span>
          </div>

          {/* Macros scaled to qty */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 12 }}>
            {[
              { l: "Calories", v: scaled(result.serving.calories),       c: T.accent  },
              { l: "Protein",  v: scaled(result.serving.protein) + "g",  c: T.accent  },
              { l: "Carbs",    v: scaled(result.serving.carbs)   + "g",  c: "#7aba7a" },
              { l: "Fat",      v: scaled(result.serving.fat)     + "g",  c: "#4caf8a" },
            ].map(s => (
              <div key={s.l} style={{ textAlign: "center", padding: "6px 4px", background: T.accentBg, borderRadius: 6 }}>
                <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{s.l}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: T.faint, marginBottom: 10 }}>Per 100g: {result.per100.calories} kcal · P{result.per100.protein}g · C{result.per100.carbs}g · F{result.per100.fat}g</div>

          <Btn onClick={() => {
            onAdd({
              id: Date.now().toString(),
              name: result.name,
              brand: result.brand,
              servingSize: result.servingSize,
              servingUnit: result.servingUnit,
              qty,
              calories: scaled(result.serving.calories),
              protein:  scaled(result.serving.protein),
              carbs:    scaled(result.serving.carbs),
              fat:      scaled(result.serving.fat),
              fiber:    scaled(result.serving.fiber),
            });
            onClose();
          }} v="dark" full size="sm">Add to diary</Btn>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   PHOTO SCAN PANEL — embedded inside the diary
════════════════════════════════════════════════════════════ */
function PhotoScanPanel({ onAdd, onClose, targetMealKey }) {
  const [image,    setImage]   = useState(null);
  const [context,  setContext] = useState("");
  const [result,   setResult]  = useState(null);
  const [loading,  setLoading] = useState(false);
  const [err,      setErr]     = useState(null);
  const [cameraOn, setCameraOn]= useState(false);
  const fileRef   = useRef(null);
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => () => stopCamera(), []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  };

  const startCamera = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      setCameraOn(true);
      setTimeout(() => {
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
      }, 60);
    } catch (e) {
      setErr(e.name === "NotAllowedError"
        ? "Camera permission denied. Allow camera access in your browser settings, or use Upload instead."
        : "Could not open camera. Use Upload instead.");
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current; const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    stopCamera();
    setImage({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg", url: dataUrl });
    setResult(null); setErr(null);
  };

  const fileToBase64 = (file) => new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result.split(",")[1]);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });

  const handleFile = async (file) => {
    if (!file) return;
    const base64 = await fileToBase64(file);
    const url = URL.createObjectURL(file);
    setImage({ base64, mimeType: file.type || "image/jpeg", url });
    setResult(null); setErr(null);
  };

  const analyze = async () => {
    if (!image) return;
    setLoading(true); setErr(null);
    try {
      const r = await analyzePhoto(image.base64, image.mimeType, context);
      setResult(r);
    } catch (e) {
      setErr(e.name === "AbortError" ? "Timed out — try a clearer photo." : (e.message || "Analysis failed. Check your server."));
    } finally { setLoading(false); }
  };

  // quantities: { [componentIndex]: integer qty } — defaults to AI-detected quantity (e.g. 3 tortillas)
  const [quantities, setQuantities] = useState({});
  useEffect(() => {
    if (result?.components) {
      // Pre-populate with AI-detected quantities (default = detected count)
      const init = {};
      result.components.forEach((c, i) => { init[i] = c.quantity ?? 1; });
      setQuantities(init);
    }
  }, [result]);

  // Build adjusted components using per-unit data
  const adjComponents = result?.components?.map((c, i) => {
    const qty = quantities[i] ?? (c.quantity ?? 1);
    const perCal  = c.caloriesPerUnit ?? (c.calories ?? 0);
    const perProt = c.proteinPerUnit  ?? (c.protein  ?? 0);
    const perCarb = c.carbsPerUnit    ?? (c.carbs    ?? 0);
    const perFat  = c.fatPerUnit      ?? (c.fat      ?? 0);
    return {
      ...c, qty,
      calories: Math.round(perCal  * qty),
      protein:  Math.round(perProt * qty),
      carbs:    Math.round(perCarb * qty),
      fat:      Math.round(perFat  * qty),
    };
  }) || [];

  const adjTotals = adjComponents.length > 0
    ? adjComponents.reduce((a, c) => ({ calories: a.calories + c.calories, protein: a.protein + c.protein, carbs: a.carbs + c.carbs, fat: a.fat + c.fat }), { calories: 0, protein: 0, carbs: 0, fat: 0 })
    : result ? { calories: result.totalCalories, protein: result.totalProtein, carbs: result.totalCarbs, fat: result.totalFat } : null;

  // Ingredient correction state: { index, input, loading, error }
  const [correctingIng, setCorrectingIng] = useState(null);

  const applyCorrection = async (i, inputName, qty, unit) => {
    if (!inputName.trim()) return;
    setCorrectingIng(s => ({ ...s, loading: true, error: false }));
    try {
      const data = await callAIJSON(`Look up accurate nutrition data for: "${inputName.trim()}", quantity: ${qty} ${unit !== "piece" ? unit : "serving"}. Return JSON: { name: string, calories: number, protein: number, carbs: number, fat: number } — values for exactly ${qty} ${unit !== "piece" ? unit : "serving"}.`);
      setResult(prev => {
        const components = prev.components.map((c, ci) => {
          if (ci !== i) return c;
          const perUnit = qty > 0 ? 1 / qty : 1;
          return {
            ...c,
            name: data.name || inputName.trim(),
            caloriesPerUnit: Math.round((data.calories || 0) * perUnit),
            proteinPerUnit:  Math.round((data.protein  || 0) * perUnit),
            carbsPerUnit:    Math.round((data.carbs    || 0) * perUnit),
            fatPerUnit:      Math.round((data.fat      || 0) * perUnit),
          };
        });
        return { ...prev, components };
      });
      setCorrectingIng(null);
    } catch {
      setCorrectingIng(s => ({ ...s, loading: false, error: true }));
    }
  };

  return (
    <div style={{ background: T.accentBg, border: `1px solid ${T.borderMid}`, borderRadius: 10, padding: 14, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name="camera" size={14} color={T.accent} />
          <span style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>Scan food</span>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <Icon name="close" size={14} color={T.faint} />
        </button>
      </div>

      {/* Live camera viewfinder */}
      {cameraOn && (
        <div style={{ position: "relative", marginBottom: 10, borderRadius: 8, overflow: "hidden", background: "#000" }}>
          <video ref={videoRef} autoPlay playsInline muted
            style={{ width: "100%", maxHeight: 220, display: "block", objectFit: "cover" }} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <div style={{ position: "absolute", bottom: 10, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 10 }}>
            <button onClick={capturePhoto}
              style={{ padding: "8px 22px", borderRadius: 20, background: T.accent, color: "#fff", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: T.font }}>
              Take photo
            </button>
            <button onClick={stopCamera}
              style={{ padding: "8px 14px", borderRadius: 20, background: "rgba(0,0,0,0.55)", color: "#fff", border: "none", cursor: "pointer", fontSize: 12, fontFamily: T.font }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Image preview */}
      {image && !cameraOn && (
        <div style={{ position: "relative", marginBottom: 10 }}>
          <img src={image.url} alt="Food" style={{ width: "100%", borderRadius: 7, maxHeight: 200, objectFit: "cover", display: "block" }} />
          <button onClick={() => { setImage(null); setResult(null); }}
            style={{ position: "absolute", top: 6, right: 6, background: "rgba(26,46,26,0.7)", border: "none", borderRadius: "50%", width: 24, height: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={12} color="#fff" />
          </button>
        </div>
      )}

      {!image && !cameraOn && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 10 }}>
          <button onClick={() => fileRef.current?.click()}
            style={{ padding: "10px", borderRadius: 7, border: `1.5px dashed ${T.border}`, background: T.card, cursor: "pointer", fontSize: 12, color: T.muted, fontFamily: T.font, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Icon name="add" size={13} color={T.muted} /> Upload photo
          </button>
          <button onClick={startCamera}
            style={{ padding: "10px", borderRadius: 7, border: `1.5px dashed ${T.border}`, background: T.card, cursor: "pointer", fontSize: 12, color: T.muted, fontFamily: T.font, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Icon name="camera" size={13} color={T.muted} /> Take photo
          </button>
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={e => handleFile(e.target.files[0])} />
      {!cameraOn && <canvas ref={canvasRef} style={{ display: "none" }} />}

      {/* Context + analyze */}
      {image && !result && !cameraOn && (
        <>
          <Field value={context} onChange={setContext} placeholder="Add context — e.g. restaurant steak tacos, large portion" />
          <Btn onClick={analyze} disabled={loading} v="dark" full size="sm" style={{ marginBottom: 0 }}>
            {loading ? <><Spin size={12} /> &nbsp;Analyzing…</> : "Analyze photo"}
          </Btn>
        </>
      )}

      {err && <div style={{ color: T.red, fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>{err}</div>}

      {/* Result */}
      {result && adjTotals && (
        <div style={{ marginTop: 10, background: T.card, borderRadius: 8, padding: 12, border: `1px solid ${T.border}` }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{result.dish}</div>
          </div>
          {/* Adjusted macro totals */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 10 }}>
            {[
              { l: "Calories", v: adjTotals.calories,      c: T.accent },
              { l: "Protein",  v: adjTotals.protein + "g", c: T.accent },
              { l: "Carbs",    v: adjTotals.carbs + "g",   c: "#7aba7a" },
              { l: "Fat",      v: adjTotals.fat + "g",     c: "#4caf8a" },
            ].map(s => (
              <div key={s.l} style={{ textAlign: "center", padding: "6px 4px", background: T.accentBg, borderRadius: 6 }}>
                <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{s.l}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>
          {result.notes && (
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginBottom: 10, padding: "7px 10px", background: T.bg, borderRadius: 6, border: `1px solid ${T.border}` }}>
              {result.notes}
            </div>
          )}
          {/* Editable component breakdown with portion controls */}
          {adjComponents.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 7 }}>
                Adjust portions
              </div>
              {adjComponents.map((c, i) => {
                const isCorrecting = correctingIng?.index === i;
                return (
                  <div key={i}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
                      <div style={{ flex: 1, fontSize: 11, color: T.text }}>{c.name}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button onClick={() => setQuantities(q => ({ ...q, [i]: Math.max(0, (q[i] ?? (c.quantity ?? 1)) - 1) }))}
                          style={{ width: 20, height: 20, borderRadius: 4, background: T.bg, border: `1px solid ${T.border}`, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", color: T.text, fontFamily: T.font }}>−</button>
                        <span style={{ fontSize: 11, minWidth: 36, textAlign: "center", color: T.text, fontWeight: 600 }}>
                          {c.qty}{c.unit && c.unit !== "piece" ? ` ${c.unit}` : ""}
                        </span>
                        <button onClick={() => setQuantities(q => ({ ...q, [i]: (q[i] ?? (c.quantity ?? 1)) + 1 }))}
                          style={{ width: 20, height: 20, borderRadius: 4, background: T.bg, border: `1px solid ${T.border}`, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", color: T.text, fontFamily: T.font }}>+</button>
                      </div>
                      <span style={{ color: T.accent, fontWeight: 600, fontSize: 11, minWidth: 48, textAlign: "right" }}>{c.calories} kcal</span>
                      <button onClick={() => isCorrecting ? setCorrectingIng(null) : setCorrectingIng({ index: i, input: "", loading: false, error: false })}
                        style={{ fontSize: 10, color: isCorrecting ? T.red : T.blue, fontWeight: 600, background: isCorrecting ? T.redBg : T.blueBg, border: `1px solid ${isCorrecting ? T.red + "30" : T.blue + "30"}`, borderRadius: 5, padding: "2px 8px", cursor: "pointer", fontFamily: T.font, flexShrink: 0 }}>
                        {isCorrecting ? "Cancel" : "Correct"}
                      </button>
                      <button onClick={() => setQuantities(q => ({ ...q, [i]: 0 }))}
                        style={{ width: 18, height: 18, borderRadius: 4, background: "none", border: `1px solid ${T.border}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, opacity: c.qty === 0 ? 0.35 : 1 }}>
                        <Icon name="close" size={10} color={T.red} />
                      </button>
                    </div>

                    {/* Correction input */}
                    {isCorrecting && (
                      <div style={{ padding: "8px 0 6px" }}>
                        <div style={{ fontSize: 11, color: T.muted, marginBottom: 6, lineHeight: 1.5 }}>
                          What is it actually? TrueTrack will look up the real macros.
                        </div>
                        <div style={{ display: "flex", gap: 7 }}>
                          <input
                            value={correctingIng.input}
                            onChange={e => setCorrectingIng(s => ({ ...s, input: e.target.value }))}
                            onKeyDown={e => { if (e.key === "Enter") applyCorrection(i, correctingIng.input, c.qty, c.unit || "piece"); }}
                            placeholder={`e.g. flour tortilla, 6 inch`}
                            autoFocus
                            style={{ flex: 1, fontSize: 12, color: T.text, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "7px 10px", fontFamily: T.font, outline: "none" }}
                          />
                          <Btn
                            onClick={() => applyCorrection(i, correctingIng.input, c.qty, c.unit || "piece")}
                            disabled={!correctingIng.input?.trim() || correctingIng.loading}
                            v="dark" size="sm">
                            {correctingIng.loading ? <Spin size={11} /> : "Look up"}
                          </Btn>
                        </div>
                        {correctingIng.error && <div style={{ fontSize: 11, color: T.red, marginTop: 5 }}>Lookup failed. Try again.</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <Btn onClick={() => {
            onAdd({
              id: Date.now().toString(),
              name: result.dish,
              brand: "Photo scan",
              servingSize: 1, servingUnit: "serving", qty: 1,
              calories: adjTotals.calories,
              protein:  adjTotals.protein,
              carbs:    adjTotals.carbs,
              fat:      adjTotals.fat,
              fiber:    0,
            });
            onClose();
          }} v="dark" full size="sm">
            Add to diary
          </Btn>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   LOG PAGE — weight & activity at top, food diary + photo scan
════════════════════════════════════════════════════════════ */
function LogPage({ profile, logs, todayLog, onSave, onApplyAdjustment }) {
  const [viewDate, setViewDate] = useState(TODAY);
  const isToday = viewDate === TODAY;

  // Get the log for the currently viewed date
  const viewLog = viewDate === TODAY ? todayLog : logs.find(l => l.date === viewDate) || null;

  const [meals, setMeals]   = useState(() => viewLog?.meals || { breakfast: [], lunch: [], dinner: [], snacks: [] });
  const [weight, setWeight] = useState(viewLog?.weight || "");
  const [steps, setSteps]   = useState(viewLog?.steps || "");
  const [notes, setNotes]   = useState(viewLog?.notes || "");
  const [saved, setSaved]   = useState(false);
  const [scanOpen, setScanOpen] = useState(null);
  const [recoveryIgnored, setRecoveryIgnored] = useState(false);

  // When date changes, load that day's data
  useEffect(() => {
    const log = viewDate === TODAY ? todayLog : logs.find(l => l.date === viewDate) || null;
    setMeals(log?.meals || { breakfast: [], lunch: [], dinner: [], snacks: [] });
    setWeight(log?.weight || "");
    setSteps(log?.steps || "");
    setNotes(log?.notes || "");
    setScanOpen(null);
  }, [viewDate]);

  const goToPrev = () => {
    const sorted = [...new Set([...logs.map(l => l.date), TODAY])].sort();
    const idx = sorted.indexOf(viewDate);
    if (idx > 0) setViewDate(sorted[idx - 1]);
  };
  const goToNext = () => {
    const sorted = [...new Set([...logs.map(l => l.date), TODAY])].sort();
    const idx = sorted.indexOf(viewDate);
    if (idx < sorted.length - 1) setViewDate(sorted[idx + 1]);
  };
  const hasNext = viewDate !== TODAY;
  const hasPrev = logs.some(l => l.date < viewDate); // which meal key has scan open

  const allFoods = [...meals.breakfast, ...meals.lunch, ...meals.dinner, ...meals.snacks];
  const totals = allFoods.reduce((a, f) => ({ calories: a.calories + f.calories, protein: a.protein + f.protein, carbs: a.carbs + f.carbs, fat: a.fat + f.fat }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const remaining = profile.calories - totals.calories;
  const calPct = Math.min(100, Math.round((totals.calories / Math.max(1, profile.calories)) * 100));

  const addFood    = (k, food) => { if (!isToday) return; setMeals(m => ({ ...m, [k]: [...m[k], food] })); };
  const removeFood = (k, id)   => { if (!isToday) return; setMeals(m => ({ ...m, [k]: m[k].filter(f => f.id !== id) })); };
  const updateFood = (k, updated) => { if (!isToday) return; setMeals(m => ({ ...m, [k]: m[k].map(f => f.id === updated.id ? updated : f) })); };

  useEffect(() => {
    if (!isToday) return;
    onSave({ date: TODAY, meals, weight: +weight || todayLog?.weight || 0, steps: +steps || todayLog?.steps || 0, notes: notes || todayLog?.notes || "", calories: totals.calories, protein: totals.protein, carbs: totals.carbs, fat: totals.fat });
  }, [meals]);

  const handleSaveActivity = () => {
    onSave({ date: viewDate, meals, weight: +weight || 0, steps: +steps || 0, notes, calories: totals.calories, protein: totals.protein, carbs: totals.carbs, fat: totals.fat });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const MEAL_DEFS = [
    { key: "breakfast", label: "Breakfast", dot: "#f59e0b" },
    { key: "lunch",     label: "Lunch",     dot: T.accent   },
    { key: "dinner",    label: "Dinner",    dot: T.blue     },
    { key: "snacks",    label: "Snacks",    dot: "#8b5cf6"  },
  ];

  const displayDate = viewDate === TODAY
    ? new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    : new Date(viewDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });

  return (
    <div>
      {/* Header with date navigation */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.text, letterSpacing: "-0.3px", marginBottom: 3, fontFamily: T.serif }}>
            Daily diary {!isToday && <span style={{ fontSize: 14, fontWeight: 400, color: T.muted }}>— past entry, read-only</span>}
          </h1>
          <p style={{ color: T.muted, fontSize: 13, margin: 0 }}>{displayDate}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={goToPrev} disabled={!hasPrev}
            style={{ width: 32, height: 32, borderRadius: 7, background: T.card, border: `1px solid ${T.border}`, cursor: hasPrev ? "pointer" : "not-allowed", opacity: hasPrev ? 1 : 0.3, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.font, color: T.text, fontSize: 16 }}>‹</button>
          {!isToday && (
            <button onClick={() => setViewDate(TODAY)}
              style={{ padding: "5px 12px", borderRadius: 7, background: T.accentBg, border: `1px solid ${T.accent}50`, color: T.accent, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: T.font }}>
              Today
            </button>
          )}
          <button onClick={goToNext} disabled={!hasNext}
            style={{ width: 32, height: 32, borderRadius: 7, background: T.card, border: `1px solid ${T.border}`, cursor: hasNext ? "pointer" : "not-allowed", opacity: hasNext ? 1 : 0.3, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.font, color: T.text, fontSize: 16 }}>›</button>
        </div>
      </div>

      {/* ── 1. WEIGHT & ACTIVITY — top ── */}
      <Card style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 14 }}>Weight and activity</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Body weight" type="number" value={weight} onChange={isToday ? setWeight : ()=>{}} unit="kg" step="0.1" placeholder="80.5" />
          <Field label="Steps"       type="number" value={steps}  onChange={isToday ? setSteps  : ()=>{}} placeholder="8000" unit="steps" />
          <Field label="Notes"       value={notes}  onChange={isToday ? setNotes  : ()=>{}} placeholder="Leg day, slept well…" />
        </div>
        {isToday && (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Btn onClick={handleSaveActivity} v="dark" size="sm">{saved ? "✓ Saved" : "Save"}</Btn>
            <span style={{ fontSize: 11, color: T.faint }}>Nutrition auto-saves when you add or remove foods</span>
          </div>
        )}
      </Card>

      {/* ── 2. CALORIE SUMMARY BAR ── */}
      <Card style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 13 }}>
            <b style={{ color: remaining < 0 ? T.red : T.text }}>{totals.calories}</b>
            <span style={{ color: T.faint }}> / {profile.calories} kcal</span>
            {remaining >= 0
              ? <span style={{ color: T.accent, marginLeft: 8, fontSize: 12 }}>{remaining} remaining</span>
              : <span style={{ color: T.red,    marginLeft: 8, fontSize: 12 }}>{Math.abs(remaining)} over</span>}
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
            {[{ l: "Protein", v: totals.protein, t: profile.macros.protein }, { l: "Carbs", v: totals.carbs, t: profile.macros.carbs }, { l: "Fat", v: totals.fat, t: profile.macros.fat }].map(s => (
              <div key={s.l} style={{ textAlign: "center" }}>
                <div style={{ fontWeight: 700, color: T.text }}>{s.v}g</div>
                <div style={{ color: T.faint, fontSize: 10 }}>{s.l} / {s.t}g</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ height: 6, background: T.bg, borderRadius: 99, overflow: "hidden", border: `1px solid ${T.border}` }}>
          <div style={{ width: `${calPct}%`, height: "100%", background: calPct > 100 ? T.red : T.accent, borderRadius: 99, transition: "width 0.4s ease" }} />
        </div>

        {/* Option B — over-budget recovery prompt, today only, threshold 100 kcal */}
        {isToday && remaining < -100 && !recoveryIgnored && (() => {
          const overage = Math.abs(remaining);
          const rec = NE.recovery(overage, profile.calories);
          if (!rec) return null;
          return (
            <div style={{ marginTop: 12, padding: "10px 12px", background: T.redBg, borderRadius: 8, border: `1px solid ${T.red}20` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 5 }}>
                    You're {overage} kcal over today's target
                  </div>
                  <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.65, marginBottom: 6 }}>
                    Recovery plan: <b style={{ color: T.text }}>{rec.adjustedTarget} kcal/day</b> (−{rec.dailyReduction} kcal) for <b style={{ color: T.text }}>{rec.daysNeeded} {rec.daysNeeded === 1 ? "day" : "days"}</b>.
                  </div>
                  <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.65, padding: "7px 9px", background: T.bg, borderRadius: 6, border: `1px solid ${T.border}` }}>
                    <b style={{ color: T.muted }}>Why {rec.daysNeeded} days?</b> Cutting too aggressively in one day causes muscle breakdown and intense hunger — both of which make things worse. A maximum reduction of 15% per day keeps your metabolism stable and the deficit sustainable. {rec.glycogenNote && rec.glycogenNote}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                  <Btn onClick={() => {
                    onApplyAdjustment({
                      calories: rec.adjustedTarget,
                      note: `Recovery plan: ${overage} kcal over on ${TODAY}. Reducing by ${rec.dailyReduction} kcal/day for ${rec.daysNeeded} days.`,
                      days: rec.daysNeeded,
                      originalCalories: profile.calories,
                    });
                  }} v="dark" size="sm">
                    Apply
                  </Btn>
                  <button onClick={() => setRecoveryIgnored(true)}
                    style={{ fontSize: 11, color: T.muted, background: "#fff", border: `1px solid ${T.border}`, borderRadius: 5, padding: "4px 8px", cursor: "pointer", fontFamily: T.font, textAlign: "center" }}>
                    Ignore
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </Card>

      {/* ── 3. MEAL SECTIONS with inline scan button ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
        {MEAL_DEFS.map(m => (
          <div key={m.key}>
            {/* Photo scan panel — opens per-meal */}
            {scanOpen === m.key && (
              <PhotoScanPanel
                targetMealKey={m.key}
                onAdd={food => { addFood(m.key, food); setScanOpen(null); }}
                onClose={() => setScanOpen(null)}
              />
            )}
            <MealSection
              mealKey={m.key}
              label={m.label}
              dotColor={m.dot}
              foods={meals[m.key]}
              onAddFood={f => addFood(m.key, f)}
              onRemove={id => removeFood(m.key, id)}
              onUpdateQty={updated => updateFood(m.key, updated)}
              onScanFood={() => setScanOpen(scanOpen === m.key ? null : m.key)}
              scanOpen={scanOpen === m.key}
            />
          </div>
        ))}
      </div>

      {/* ── 4. RECENT LOGS ── */}
      {logs.length > 0 && (
        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 14 }}>Recent logs</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Date", "Weight", "Calories", "Protein", "Carbs", "Fat", "Steps"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: T.muted, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...logs].reverse().slice(0, 10).map((l, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                    {[l.date, l.weight ? l.weight + " kg" : "—", l.calories ? l.calories + " kcal" : "—", l.protein ? l.protein + "g" : "—", l.carbs ? l.carbs + "g" : "—", l.fat ? l.fat + "g" : "—", l.steps || "—"].map((v, j) => (
                      <td key={j} style={{ padding: "7px 10px", color: j === 0 ? T.muted : T.text }}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   MEALS PAGE
════════════════════════════════════════════════════════════ */
function MealsPage({ profile, todayLog, onAddToDiary }) {
  const [meals, setMeals]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("balanced");
  const [mode, setMode]     = useState("full");
  const [err, setErr]       = useState(null);
  const [added, setAdded]   = useState({});
  const [exclusions, setExclusions] = useState(""); // ingredients to avoid

  const eaten     = todayLog?.calories || 0;
  const remCals   = Math.max(0, profile.calories - eaten);
  const remProtein= Math.max(0, profile.macros.protein - (todayLog?.protein || 0));
  const remCarbs  = Math.max(0, profile.macros.carbs   - (todayLog?.carbs   || 0));
  const remFat    = Math.max(0, profile.macros.fat     - (todayLog?.fat     || 0));
  const tCals = mode === "remaining" ? remCals : profile.calories;
  const tP    = mode === "remaining" ? remProtein : profile.macros.protein;
  const tC    = mode === "remaining" ? remCarbs   : profile.macros.carbs;
  const tF    = mode === "remaining" ? remFat     : profile.macros.fat;

  // Smart meal count — based on calories available
  const smartMealCount = (cals) => {
    if (cals < 250)  return 1;
    if (cals < 500)  return 1;
    if (cals < 700)  return 2;
    if (cals < 1000) return 2;
    if (cals < 1400) return 3;
    return 4;
  };
  const mealCount = mode === "remaining" ? smartMealCount(remCals) : 4;
  const mealSlots = ["breakfast","lunch","dinner","snack"].slice(0, mealCount);
  const mealSlotsStr = mealCount === 1 ? "one meal" : mealCount === 2 ? "two meals (e.g. lunch and dinner)" : mealCount === 3 ? "three meals (breakfast, lunch, dinner)" : "four meals (breakfast, lunch, dinner, snack)";

  const generate = async () => {
    if (mode === "remaining" && remCals < 100) { setErr("You've already hit your calorie target today."); return; }
    setLoading(true); setErr(null); setAdded({}); setCustomizing({});
    try {
      const ctx = mode === "remaining"
        ? `Already eaten: ${eaten} kcal. Only ${remCals} kcal remaining for the day. Generate exactly ${mealSlotsStr} to fit within this budget — do NOT generate more meals than the budget allows.`
        : "Generate a full day of meals (breakfast, lunch, dinner, snack).";
      const excl = exclusions.trim() ? `\nIngredients or foods to AVOID or substitute: ${exclusions.trim()}.` : "";
      const mealKeys = mealSlots.join(", ");
      const data = await callAIJSON(`${ctx}${excl}
Targets: ${tCals} kcal, P${tP}g C${tC}g F${tF}g. Style: ${filter}.
Return JSON with ONLY these meal keys: ${mealKeys}. Each: {name, description, calories, protein, carbs, fat, ingredients:[{name, amount, calories, protein, carbs, fat}]}.
Also include: totalCalories, totalProtein, totalCarbs, totalFat, tip.
Do NOT include meal keys that weren't requested.`);
      setMeals(data);
    } catch { setErr("Generation failed. Make sure your server is running."); }
    setLoading(false);
  };

  // Customize / swap state
  const [customizing, setCustomizing] = useState({});   // { [mealKey]: bool }
  const [swapState,   setSwapState]   = useState(null); // { mealKey, ingIndex, options, loading }

  const toggleCustomize = (k) => setCustomizing(c => ({ ...c, [k]: !c[k] }));

  const requestSwap = async (mealKey, ing, ingIndex) => {
    setSwapState({ mealKey, ingIndex, options: [], loading: true });
    try {
      const meal = meals[mealKey];
      const data = await callAIJSON(`Meal: "${meal.name}". Ingredient to swap: "${ing.name} (${ing.amount}, ${ing.calories} kcal, P${ing.protein}g C${ing.carbs}g F${ing.fat}g)". Suggest 3 alternatives that fit the same meal and have similar macros. Return JSON: { alternatives: [{name, amount, calories, protein, carbs, fat}] }`);
      setSwapState({ mealKey, ingIndex, options: data.alternatives || [], loading: false });
    } catch {
      setSwapState({ mealKey, ingIndex, options: [], loading: false, error: true });
    }
  };

  const applySwap = (alt) => {
    if (!swapState) return;
    const { mealKey, ingIndex } = swapState;
    setMeals(prev => {
      const meal = { ...prev[mealKey] };
      const oldIng = meal.ingredients[ingIndex];
      const newIngredients = meal.ingredients.map((ing, i) =>
        i === ingIndex ? { ...alt } : ing
      );
      // Adjust meal macros by the delta
      const calDelta  = (alt.calories || 0) - (oldIng.calories || 0);
      const protDelta = (alt.protein  || 0) - (oldIng.protein  || 0);
      const carbDelta = (alt.carbs    || 0) - (oldIng.carbs    || 0);
      const fatDelta  = (alt.fat      || 0) - (oldIng.fat      || 0);
      return {
        ...prev,
        [mealKey]: {
          ...meal,
          ingredients: newIngredients,
          calories: Math.max(0, (meal.calories || 0) + calDelta),
          protein:  Math.max(0, (meal.protein  || 0) + protDelta),
          carbs:    Math.max(0, (meal.carbs    || 0) + carbDelta),
          fat:      Math.max(0, (meal.fat      || 0) + fatDelta),
        },
      };
    });
    setSwapState(null);
  };

  const mealDots   = { breakfast: "#f59e0b", lunch: T.accent, dinner: T.blue, snack: "#8b5cf6" };
  // In "Fill remaining" mode, label meals as "Meal 1", "Meal 2" etc
  const mealLabel  = (slot, idx) => mode === "remaining" ? `Meal ${idx + 1}` : slot.charAt(0).toUpperCase() + slot.slice(1);
  const mealColor  = (slot, idx) => mode === "remaining"
    ? [T.accent, T.blue, "#8b5cf6", "#f59e0b"][idx % 4]
    : mealDots[slot];

  const allSlots   = ["breakfast","lunch","dinner","snack"];
  const activeSlots = meals ? allSlots.filter(k => meals[k]) : mealSlots;

  const addToDiary = (k, m) => {
    const dk = k === "snack" ? "snacks" : k;
    onAddToDiary(dk, { id: Date.now().toString() + k, name: m.name, brand: "Meal Plan", servingSize: 1, servingUnit: "serving", qty: 1, calories: m.calories || 0, protein: m.protein || 0, carbs: m.carbs || 0, fat: m.fat || 0, fiber: 0 });
    setAdded(a => ({ ...a, [k]: true }));
  };

  const addAll = () => ["breakfast","lunch","dinner","snack"].forEach(k => { if (meals[k] && !added[k]) addToDiary(k, meals[k]); });
  const computedTotals = meals ? ["breakfast","lunch","dinner","snack"].reduce((a, k) => { const m = meals[k]; if (!m) return a; return { cal: a.cal + (m.calories||0), p: a.p + (m.protein||0), c: a.c + (m.carbs||0), f: a.f + (m.fat||0) }; }, { cal:0, p:0, c:0, f:0 }) : null;

  return (
    <div>
      <SectionHead title="Meal plan" sub="AI meals calibrated to your exact targets" />

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 11, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", alignSelf: "center", marginRight: 4 }}>Mode</span>
          {[["full", "Full day plan", `${profile.calories} kcal total`], ["remaining", "Fill remaining", remCals > 0 ? `${remCals} kcal left` : "Target reached"]].map(([v, l, s]) => (
            <div key={v} onClick={() => { setMode(v); setMeals(null); setErr(null); }}
              style={{ flex: 1, padding: "9px 12px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${mode === v ? T.accent : T.border}`, background: mode === v ? T.accentBg : T.bg, transition: "all 0.15s" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: mode === v ? T.accent : T.text }}>{l}</div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 1 }}>{s}</div>
            </div>
          ))}
        </div>
        {mode === "remaining" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7, marginBottom: 12 }}>
            {[{ l: "Calories", v: remCals + " kcal", c: T.accent }, { l: "Protein", v: remProtein + "g", c: T.accent }, { l: "Carbs", v: remCarbs + "g", c: "#7aba7a" }, { l: "Fat", v: remFat + "g", c: "#4caf8a" }].map(s => (
              <div key={s.l} style={{ padding: "7px 9px", background: T.accentBg, borderRadius: 7, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{s.l}</div>
                <div style={{ fontWeight: 700, color: s.c, fontSize: 13 }}>{s.v}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Style</span>
          {[["balanced","Balanced"],["high-protein","High protein"],["quick","Quick meals"],["budget","Budget"]].map(([v, l]) => (
            <div key={v} onClick={() => setFilter(v)} style={{ padding: "5px 12px", borderRadius: 99, cursor: "pointer", border: `1px solid ${filter === v ? T.accent : T.border}`, background: filter === v ? T.accentBg : T.bg, color: filter === v ? T.accent : T.muted, fontSize: 12, fontWeight: filter === v ? 600 : 400, transition: "all 0.15s" }}>{l}</div>
          ))}
          <Btn onClick={generate} disabled={loading} v="dark" style={{ marginLeft: "auto" }}>
            {loading ? <><Spin size={12} /> &nbsp;Generating…</> : "Generate plan"}
          </Btn>
        </div>

        {/* Ingredient exclusions */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <Field
            label="Ingredients to avoid or substitute"
            value={exclusions}
            onChange={setExclusions}
            placeholder="e.g. no chicken, no dairy, no gluten — TrueTrack will find alternatives that fit your macros"
          />
        </div>
      </Card>

      {err && <div style={{ color: T.red, padding: 10, marginBottom: 14, background: T.redBg, borderRadius: 7, fontSize: 13, border: `1px solid ${T.red}30` }}>{err}</div>}

      {!meals && !loading && (
        <div style={{ textAlign: "center", padding: "56px 20px", color: T.faint }}>
          <Icon name="meals" size={36} color={T.faint} />
          <div style={{ fontSize: 15, marginTop: 12, marginBottom: 4, color: T.muted }}>No plan generated yet</div>
          <div style={{ fontSize: 13 }}>Select a mode and style above, then click Generate plan</div>
        </div>
      )}

      {meals && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            {activeSlots.map((meal, idx) => {
              const m = meals[meal];
              if (!m) return null;
              const isAdded   = added[meal];
              const isOpen    = customizing[meal];
              const dot       = mealColor(meal, idx);
              const label     = mealLabel(meal, idx);
              const isSwapping = swapState?.mealKey === meal;
              return (
                <Card key={meal} style={{ padding: 0, overflow: "hidden" }}>
                  {/* Header */}
                  <div style={{ padding: "12px 14px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: dot }} />
                        <span style={{ fontSize: 10, color: dot, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</span>
                      </div>
                      <button onClick={() => addToDiary(meal, m)} disabled={isAdded} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: isAdded ? "default" : "pointer", background: isAdded ? T.accentBg : T.bg, color: isAdded ? T.accent : T.muted, border: `1px solid ${isAdded ? T.accent + "40" : T.border}`, fontFamily: T.font, transition: "all 0.2s" }}>
                        <Icon name={isAdded ? "check" : "add"} size={10} color={isAdded ? T.accent : T.muted} />
                        {isAdded ? "Added" : "Add to diary"}
                      </button>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 4 }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: T.muted, marginBottom: 10, lineHeight: 1.55 }}>{m.description}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
                        <span style={{ color: dot, fontWeight: 700 }}>{m.calories} kcal</span>
                        <span style={{ color: T.muted }}>P {m.protein}g</span>
                        <span style={{ color: T.muted }}>C {m.carbs}g</span>
                        <span style={{ color: T.muted }}>F {m.fat}g</span>
                      </div>
                      {m.ingredients?.length > 0 && (
                        <button onClick={() => { toggleCustomize(meal); setSwapState(null); }}
                          style={{ fontSize: 10, color: isOpen ? dot : T.muted, fontWeight: 600, background: isOpen ? dot + "15" : T.bg, border: `1px solid ${isOpen ? dot + "50" : T.border}`, borderRadius: 5, padding: "3px 9px", cursor: "pointer", fontFamily: T.font, transition: "all 0.15s" }}>
                          {isOpen ? "✕ Close" : "⚙ Customize"}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Customize panel */}
                  {isOpen && (
                    <div style={{ borderTop: `1px solid ${T.border}`, padding: "10px 14px", background: T.bg }}>
                      <div style={{ fontSize: 10, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Ingredients — click Swap to substitute</div>
                      {m.ingredients.map((ing, ingIdx) => {
                        const isThisSwapping = isSwapping && swapState.ingIndex === ingIdx;
                        return (
                          <div key={ingIdx}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${T.border}` }}>
                              <div style={{ flex: 1 }}>
                                <span style={{ fontSize: 12, color: T.text }}>{ing.name}</span>
                                <span style={{ fontSize: 11, color: T.faint, marginLeft: 6 }}>{ing.amount}</span>
                              </div>
                              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <span style={{ fontSize: 11, color: T.accent, fontWeight: 600 }}>{ing.calories} kcal</span>
                                <button onClick={() => isThisSwapping ? setSwapState(null) : requestSwap(meal, ing, ingIdx)}
                                  style={{ fontSize: 10, color: isThisSwapping ? T.red : T.blue, fontWeight: 600, background: isThisSwapping ? T.redBg : T.blueBg, border: `1px solid ${isThisSwapping ? T.red + "30" : T.blue + "30"}`, borderRadius: 5, padding: "2px 8px", cursor: "pointer", fontFamily: T.font }}>
                                  {isThisSwapping ? "Cancel" : "Swap"}
                                </button>
                              </div>
                            </div>

                            {/* Swap options */}
                            {isThisSwapping && (
                              <div style={{ padding: "8px 0 4px", marginBottom: 4 }}>
                                {swapState.loading && (
                                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: T.muted, padding: "6px 0" }}>
                                    <Spin size={11} /> Finding alternatives…
                                  </div>
                                )}
                                {swapState.error && <div style={{ fontSize: 11, color: T.red }}>Failed to load alternatives.</div>}
                                {swapState.options?.map((alt, ai) => (
                                  <div key={ai} onClick={() => applySwap(alt)}
                                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px", marginBottom: 5, background: T.card, borderRadius: 7, border: `1px solid ${T.border}`, cursor: "pointer" }}>
                                    <div>
                                      <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{alt.name}</div>
                                      <div style={{ fontSize: 10, color: T.faint }}>{alt.amount}</div>
                                    </div>
                                    <div style={{ textAlign: "right" }}>
                                      <div style={{ fontSize: 11, color: T.accent, fontWeight: 600 }}>{alt.calories} kcal</div>
                                      <div style={{ fontSize: 10, color: T.faint }}>P{alt.protein}g C{alt.carbs}g F{alt.fat}g</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          <Card style={{ background: T.accentBg, border: `1px solid ${T.borderMid}` }}>
            <div style={{ fontSize: 10, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>
              {mode === "remaining" ? "Remaining meals total" : "Daily total"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 14 }}>
              {[{ l: "Calories", v: (meals.totalCalories || computedTotals?.cal || 0) + " kcal", t: tCals + " target", c: T.accent }, { l: "Protein", v: (meals.totalProtein || computedTotals?.p || 0) + "g", t: tP + "g target", c: T.accent }, { l: "Carbs", v: (meals.totalCarbs || computedTotals?.c || 0) + "g", t: tC + "g target", c: "#7aba7a" }, { l: "Fat", v: (meals.totalFat || computedTotals?.f || 0) + "g", t: tF + "g target", c: "#4caf8a" }].map(s => (
                <div key={s.l} style={{ padding: "10px 12px", background: T.card, borderRadius: 8, border: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{s.l}</div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: s.c }}>{s.v}</div>
                  <div style={{ fontSize: 10, color: T.faint }}>{s.t}</div>
                </div>
              ))}
            </div>
            {meals.fiber && <div style={{ fontSize: 11, color: T.muted, marginBottom: 12 }}>~{meals.fiber}g fiber · {meals.vegServings} vegetable servings</div>}
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {meals.tip && <div style={{ flex: 1, padding: "9px 12px", background: T.card, borderRadius: 7, fontSize: 12, color: T.muted, lineHeight: 1.6, border: `1px solid ${T.border}` }}>{meals.tip}</div>}
              {(() => {
                const keys = ["breakfast","lunch","dinner","snack"].filter(k => meals[k]);
                const allAdded = keys.every(k => added[k]);
                return <button onClick={addAll} disabled={allAdded} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: allAdded ? "default" : "pointer", background: allAdded ? T.accentBg : T.sidebar, color: allAdded ? T.accent : "#c8e6c8", border: `1px solid ${allAdded ? T.accent + "40" : "transparent"}`, fontFamily: T.font, whiteSpace: "nowrap" }}>
                  <Icon name={allAdded ? "check" : "add"} size={13} color={allAdded ? T.accent : "#c8e6c8"} />
                  {allAdded ? "All added" : "Add all to diary"}
                </button>;
              })()}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   INSIGHTS PAGE
════════════════════════════════════════════════════════════ */
function InsightsPage({ profile, logs }) {
  const [insight, setInsight] = useState(null);
  const [loading, setLoading] = useState(false);
  const trend = NE.weeklyTrend(logs);
  const adj = NE.adaptive(trend);
  const learned = NE.learnedTDEE(logs);
  const last7 = logs.slice(-7);
  const logged = last7.filter(l => l.calories > 0);
  const adherence = Math.round((logged.length / 7) * 100);
  const avgCals = logged.length ? Math.round(logged.reduce((s, l) => s + l.calories, 0) / logged.length) : 0;
  const calAdh = avgCals ? Math.round((avgCals / profile.calories) * 100) : 0;

  const getInsight = async () => {
    setLoading(true);
    const learnedContext = learned ? `Learned TDEE: ${learned.tdee} kcal (${learned.confidence} confidence, ${learned.pairedDays} days of data). Formula TDEE was ${profile.tdee}.` : "Insufficient data for learned TDEE.";
    const r = await callAI(`Weekly coaching report: Target ${profile.calories} kcal/day · Avg logged ${avgCals} · Days tracked ${logged.length}/7 · Weight trend: ${trend ? JSON.stringify(trend) : "insufficient data"} · ${learnedContext} · Adaptive: ${adj.msg}. Write 3-4 sentences: specific, motivating, actionable. One concrete next step.`);
    setInsight(r); setLoading(false);
  };

  const SI = {
    optimal:  { label: "Optimal fat loss rate",     color: T.accent, icon: "trending_dn" },
    fast:     { label: "Losing too fast",            color: T.orange, icon: "warning"     },
    plateau:  { label: "Plateau detected",           color: T.blue,   icon: "insights"    },
    gaining:  { label: "Weight trending up",         color: T.red,    icon: "trending_up" },
    tracking: { label: "Building data",              color: T.muted,  icon: "info"        },
  };
  const si = SI[trend?.status || "tracking"];

  // Confidence display config
  const confConfig = {
    high:   { color: T.accent, label: "High confidence",   bar: 100 },
    medium: { color: T.orange, label: "Medium confidence", bar: 60  },
    low:    { color: T.muted,  label: "Low confidence",    bar: 30  },
  };

  return (
    <div>
      <SectionHead title="Weekly insights" sub="Your 7-day performance analysis" />

      <Card style={{ marginBottom: 16, background: si.color === T.accent ? T.accentBg : si.color + "0d", border: `1px solid ${si.color}30` }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <Icon name={si.icon} size={32} color={si.color} />
          <div>
            <Pill text={si.label} color={si.color} />
            <div style={{ fontSize: 13, color: T.muted, marginTop: 8, lineHeight: 1.6 }}>{adj.msg}</div>
          </div>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 16 }}>
        {[
          { l: "Adherence",        v: adherence + "%",  sub: `${logged.length}/7 days logged`, c: adherence >= 80 ? T.accent : adherence >= 50 ? T.orange : T.red },
          { l: "Avg daily cals",   v: avgCals || "—",   sub: `Target: ${profile.calories}`,    c: Math.abs(avgCals - profile.calories) < 150 ? T.accent : T.orange },
          { l: "Calorie accuracy", v: calAdh ? calAdh + "%" : "—", sub: "vs your target",     c: calAdh >= 90 && calAdh <= 110 ? T.accent : T.orange },
        ].map((s, i) => (
          <Card key={i} style={{ padding: "14px" }}>
            <div style={{ fontSize: 10, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 7 }}>{s.l}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: s.c }}>{s.v}</div>
            <div style={{ fontSize: 11, color: T.faint, marginTop: 3 }}>{s.sub}</div>
          </Card>
        ))}
      </div>

      {/* ── LEARNED TDEE CARD ── */}
      <Card style={{ marginBottom: 16, border: `1px solid ${T.borderMid}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 2 }}>Learned TDEE</div>
            <div style={{ fontSize: 11, color: T.muted }}>Back-calculated from your actual intake + weight change</div>
          </div>
          {learned && (
            <Pill text={confConfig[learned.confidence].label} color={confConfig[learned.confidence].color} />
          )}
        </div>

        {!learned ? (
          <div style={{ padding: "16px 0" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
              <Icon name="info" size={16} color={T.faint} style={{ marginTop: 1, flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.65 }}>
                Need at least <b style={{ color: T.text }}>5 days</b> with both calories and weight logged on the same day.
                You have <b style={{ color: T.text }}>{logs.filter(l => l.calories > 0 && l.weight > 0).length}</b> so far.
              </div>
            </div>
            {/* Progress toward unlock */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.muted, marginBottom: 5 }}>
              <span>Progress to first estimate</span>
              <span>{logs.filter(l => l.calories > 0 && l.weight > 0).length} / 5 days</span>
            </div>
            <div style={{ height: 6, background: T.bg, borderRadius: 99, overflow: "hidden", border: `1px solid ${T.border}` }}>
              <div style={{ width: `${Math.min(100, (logs.filter(l => l.calories > 0 && l.weight > 0).length / 5) * 100)}%`, height: "100%", background: T.accent, borderRadius: 99 }} />
            </div>
          </div>
        ) : (
          <>
            {/* Main number comparison */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
              <div style={{ padding: "12px 14px", background: T.accentBg, borderRadius: 9, border: `1px solid ${T.borderMid}`, gridColumn: "span 1" }}>
                <div style={{ fontSize: 9, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Learned TDEE</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: T.accent }}>{learned.tdee.toLocaleString()}</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>kcal / day (real)</div>
              </div>
              <div style={{ padding: "12px 14px", background: T.bg, borderRadius: 9, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 9, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Formula TDEE</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: T.text }}>{profile.tdee.toLocaleString()}</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>kcal / day (estimate)</div>
              </div>
              <div style={{ padding: "12px 14px", background: T.bg, borderRadius: 9, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 9, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Difference</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: learned.tdee > profile.tdee ? T.accent : T.orange }}>
                  {learned.tdee > profile.tdee ? "+" : ""}{(learned.tdee - profile.tdee).toLocaleString()}
                </div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{learned.tdee > profile.tdee ? "higher than formula" : "lower than formula"}</div>
              </div>
            </div>

            {/* The math, explained */}
            <div style={{ background: T.bg, borderRadius: 9, padding: "12px 14px", border: `1px solid ${T.border}`, marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>How we calculated this</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {[
                  { label: "Avg daily intake", value: `${learned.avgCals.toLocaleString()} kcal/day`, sub: `over ${learned.daysUsed} days` },
                  { label: "Weight change", value: `${learned.weeklyChange > 0 ? "+" : ""}${learned.weeklyChange} kg/week`, sub: learned.weeklyChange < 0 ? "losing weight → positive deficit" : learned.weeklyChange > 0 ? "gaining weight → negative deficit" : "stable weight → at maintenance" },
                  { label: "Implied deficit", value: `${learned.deficitPerDay > 0 ? "+" : ""}${learned.deficitPerDay.toLocaleString()} kcal/day`, sub: `${Math.abs(learned.weeklyChange)} kg/wk × 7,700 ÷ 7` },
                  { label: "Real TDEE", value: `${learned.avgCals.toLocaleString()} + ${learned.deficitPerDay.toLocaleString()} = ${learned.tdee.toLocaleString()} kcal`, sub: "intake + implied deficit", hi: true },
                ].map((row, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < 3 ? `1px solid ${T.border}` : "none" }}>
                    <div>
                      <div style={{ fontSize: 12, color: row.hi ? T.text : T.muted, fontWeight: row.hi ? 600 : 400 }}>{row.label}</div>
                      <div style={{ fontSize: 10, color: T.faint }}>{row.sub}</div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: row.hi ? T.accent : T.text, textAlign: "right" }}>{row.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Confidence bar + range */}
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.muted, marginBottom: 4 }}>
                  <span>Confidence ({learned.pairedDays} days of data)</span>
                  <span>{confConfig[learned.confidence].label}</span>
                </div>
                <div style={{ height: 5, background: T.bg, borderRadius: 99, overflow: "hidden", border: `1px solid ${T.border}` }}>
                  <div style={{ width: `${confConfig[learned.confidence].bar}%`, height: "100%", background: confConfig[learned.confidence].color, borderRadius: 99, transition: "width 0.6s ease" }} />
                </div>
                <div style={{ fontSize: 10, color: T.faint, marginTop: 4 }}>
                  Likely range: {learned.range[0].toLocaleString()}–{learned.range[1].toLocaleString()} kcal
                  {learned.confidence !== "high" && " · Keep logging to narrow the range"}
                </div>
              </div>
            </div>

            {/* Actionable implication */}
            {Math.abs(learned.tdee - profile.tdee) > 100 && (
              <div style={{ marginTop: 14, padding: "10px 12px", background: T.accentBg, borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 12, color: T.text, lineHeight: 1.65 }}>
                <b>What this means:</b> Your real metabolism burns <b style={{ color: T.accent }}>{Math.abs(learned.tdee - profile.tdee)} kcal {learned.tdee > profile.tdee ? "more" : "less"}</b> than the formula predicted.
                {" "}Your ideal target based on what your body actually burns is <b style={{ color: T.accent }}>{Math.max(1200, NE.target(learned.tdee, profile.goal || "moderate")).toLocaleString()} kcal/day</b>.
              </div>
            )}
          </>
        )}
      </Card>

      {adj.delta !== 0 && (
        <Card style={{ marginBottom: 16, border: `1px solid ${(adj.delta < 0 ? T.blue : T.accent)}30`, background: adj.delta < 0 ? T.blueBg : T.accentBg }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 8 }}>Adaptive recommendation</div>
          <p style={{ color: T.muted, fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>{adj.msg}</p>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ padding: "8px 16px", borderRadius: 7, background: T.card, border: `1px solid ${T.border}`, fontWeight: 700, fontSize: 17, color: T.text }}>{profile.calories + adj.delta} kcal</div>
            <div style={{ fontSize: 12, color: T.muted }}>New daily target ({adj.delta > 0 ? "+" : ""}{adj.delta} kcal from {profile.calories})</div>
          </div>
        </Card>
      )}

      {trend?.change && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 12 }}>Fat loss breakdown</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            {[
              { l: "This week",    v: trend.change < 0 ? Math.abs(trend.change) + " kg" : "+0 kg", sub: "7-day avg vs prior week" },
              { l: "Safe range",   v: "0.3–1.0 kg",                                                sub: "per week (science-based)" },
              { l: "1-month proj", v: trend.change < 0 ? (Math.abs(trend.change) * 4).toFixed(1) + " kg" : "0 kg", sub: "at current rate" },
            ].map((s, i) => (
              <div key={i} style={{ padding: 12, background: T.accentBg, borderRadius: 8, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{s.l}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: T.text }}>{s.v}</div>
                <div style={{ fontSize: 10, color: T.faint }}>{s.sub}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>AI coach analysis</div>
          <Btn onClick={getInsight} disabled={loading} v="dark" size="sm">{loading ? <><Spin size={11} /> &nbsp;Analyzing…</> : "Get analysis"}</Btn>
        </div>
        {insight
          ? <div style={{ padding: "12px 14px", background: T.sidebar, borderRadius: 8, fontSize: 13, lineHeight: 1.75, color: "#c8e6c8" }}>{insight}</div>
          : <div style={{ color: T.faint, fontSize: 13, padding: "10px 0", textAlign: "center" }}>Click "Get analysis" for your personalized weekly coaching report</div>}
      </Card>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   PHOTO SCAN PAGE — camera / upload → AI vision → macro estimate
   Uses Anthropic's vision API: image sent as base64
════════════════════════════════════════════════════════════ */
async function analyzePhoto(base64, mimeType, context) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    let r;
    try {
      r = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: "You are a professional nutritionist and food analyst. When given a photo of food, you identify every component visible and estimate calories and macros accurately. You factor in cooking oils, sauces, dressings, and hidden ingredients typical for restaurant dishes. Be realistic and slightly generous with estimates to account for hidden fats. IMPORTANT: Return each component as a single unit — e.g. if there are 3 tortillas, return one entry named 'Flour tortilla' with quantity:3 and caloriesPerUnit for ONE tortilla, not the total. The user will adjust the quantity. Respond ONLY with valid JSON, no markdown, no preamble.",
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mimeType, data: base64 }
              },
              {
                type: "text",
                text: `Analyze this food photo. ${context ? `Context from user: "${context}".` : ""} Identify each component visible (including oils, sauces, sides). Return each as a SINGLE UNIT with quantity and unit fields.

Rules for quantity/unit:
- Countable items (tortillas, eggs, meatballs): quantity=count, unit="piece"
- Meat/fish by weight: quantity=weight in oz, unit="oz"  
- Liquid condiments (oil, sauce, dressing): quantity=amount in tbsp, unit="tbsp"
- Dry toppings (cheese, nuts): quantity=amount in tbsp or g, unit="tbsp" or "g"
- Vegetables by volume: quantity=amount, unit="cup" or "tbsp"
caloriesPerUnit = calories for exactly 1 of that unit.

Return JSON: { dish: string, components: [{name: string, quantity: number, unit: string, caloriesPerUnit: number, proteinPerUnit: number, carbsPerUnit: number, fatPerUnit: number}], totalCalories: number, totalProtein: number, totalCarbs: number, totalFat: number, confidence: "low"|"medium"|"high", notes: string }`
              }
            ]
          }]
        }),
      });
    } catch (fetchErr) {
      throw new Error("Cannot reach server. Make sure node server.cjs is running in your terminal.");
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const msg = body?.error?.message || body?.error || `HTTP ${r.status}`;
      throw new Error(`API error: ${msg}`);
    }
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || "API error");
    const raw = d.content?.[0]?.text || "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
    if (s === -1) throw new Error("No JSON in response");
    return JSON.parse(cleaned.slice(s, e + 1));
  } finally {
    clearTimeout(timeout);
  }
}

function PhotoPage({ profile, onAddToDiary }) {
  const [image,    setImage]   = useState(null);
  const [context,  setContext] = useState("");
  const [result,   setResult]  = useState(null);
  const [loading,  setLoading] = useState(false);
  const [err,      setErr]     = useState(null);
  const [logged,   setLogged]  = useState(false);
  const [mealKey,  setMealKey] = useState("snacks");
  const [cameraOn, setCameraOn]= useState(false);
  const fileRef   = useRef(null);
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => () => stopCamera(), []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  };

  const startCamera = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } } });
      streamRef.current = stream;
      setCameraOn(true);
      setTimeout(() => { if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); } }, 60);
    } catch (e) {
      setErr(e.name === "NotAllowedError" ? "Camera permission denied — allow camera access in browser settings." : "Could not open camera. Use Upload instead.");
    }
  };

  const capturePhoto = () => {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    const dataUrl = c.toDataURL("image/jpeg", 0.92);
    stopCamera();
    setImage({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg", url: dataUrl });
    setResult(null); setErr(null); setLogged(false);
  };

  const fileToBase64 = (file) => new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result.split(",")[1]);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });

  const handleFile = async (file) => {
    if (!file) return;
    const base64 = await fileToBase64(file);
    const url = URL.createObjectURL(file);
    setImage({ base64, mimeType: file.type || "image/jpeg", url });
    setResult(null); setErr(null); setLogged(false);
  };

  const analyze = async () => {
    if (!image) return;
    setLoading(true); setErr(null);
    try {
      const r = await analyzePhoto(image.base64, image.mimeType, context);
      setResult(r);
    } catch (e) {
      setErr(e.name === "AbortError" ? "Request timed out — try a clearer photo." : (e.message || "Analysis failed. Make sure your server is running."));
    } finally { setLoading(false); }
  };

  const logToDiary = () => {
    if (!result) return;
    onAddToDiary(mealKey, {
      id: Date.now().toString(),
      name: result.dish,
      brand: "Photo scan",
      servingSize: 1, servingUnit: "serving", qty: 1,
      calories: result.totalCalories,
      protein:  result.totalProtein,
      carbs:    result.totalCarbs,
      fat:      result.totalFat,
      fiber:    0,
    });
    setLogged(true);
  };

  const confColor = { high: T.accent, medium: T.orange, low: T.red };
  const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snacks: "Snacks" };

  return (
    <div>
      <SectionHead title="Scan food" sub="Take or upload a photo — TrueTrack estimates the calories and macros" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Left: upload / camera */}
        <div>
          <Card style={{ marginBottom: 14 }}>
            {/* Live camera viewfinder */}
            {cameraOn && (
              <div style={{ position: "relative", marginBottom: 14, borderRadius: 8, overflow: "hidden", background: "#000" }}>
                <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", maxHeight: 280, display: "block", objectFit: "cover" }} />
                <canvas ref={canvasRef} style={{ display: "none" }} />
                <div style={{ position: "absolute", bottom: 12, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 10 }}>
                  <button onClick={capturePhoto}
                    style={{ padding: "9px 24px", borderRadius: 20, background: T.accent, color: "#fff", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: T.font }}>
                    Take photo
                  </button>
                  <button onClick={stopCamera}
                    style={{ padding: "9px 16px", borderRadius: 20, background: "rgba(0,0,0,0.55)", color: "#fff", border: "none", cursor: "pointer", fontSize: 13, fontFamily: T.font }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Image preview */}
            {image && !cameraOn && (
              <div style={{ position: "relative", marginBottom: 14 }}>
                <img src={image.url} alt="Food" style={{ width: "100%", borderRadius: 8, maxHeight: 280, objectFit: "cover", display: "block" }} />
                <button onClick={() => { setImage(null); setResult(null); setLogged(false); }}
                  style={{ position: "absolute", top: 8, right: 8, background: "rgba(26,46,26,0.7)", border: "none", borderRadius: "50%", width: 28, height: 28, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon name="close" size={14} color="#fff" />
                </button>
              </div>
            )}

            {/* Upload prompt */}
            {!image && !cameraOn && (
              <div onClick={() => fileRef.current?.click()}
                style={{ border: `2px dashed ${T.border}`, borderRadius: 10, padding: "48px 20px", textAlign: "center", cursor: "pointer", marginBottom: 14 }}>
                <Icon name="camera" size={32} color={T.faint} />
                <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginTop: 12, marginBottom: 4 }}>Upload a photo</div>
                <div style={{ fontSize: 12, color: T.muted }}>or click "Take photo" to use your camera</div>
              </div>
            )}

            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={e => handleFile(e.target.files[0])} />
            {!cameraOn && <canvas ref={canvasRef} style={{ display: "none" }} />}

            {/* Upload / Camera buttons */}
            {!cameraOn && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                <Btn v="ghost" onClick={() => fileRef.current?.click()} full size="sm">
                  <Icon name="add" size={13} color={T.muted} /> &nbsp;Upload photo
                </Btn>
                <Btn v="ghost" onClick={startCamera} full size="sm">
                  <Icon name="camera" size={13} color={T.muted} /> &nbsp;Take photo
                </Btn>
              </div>
            )}

            {/* Optional context */}
            <Field
              label="Add context (optional)"
              value={context}
              onChange={setContext}
              placeholder="e.g. restaurant steak tacos, large portion"
            />
            <div style={{ fontSize: 11, color: T.faint, marginBottom: 14, lineHeight: 1.55 }}>
              Adding context helps the AI account for restaurant-style cooking — oils, sauces, portion sizes.
            </div>

            <Btn onClick={analyze} disabled={!image || loading} v="dark" full>
              {loading ? <><Spin size={13} /> &nbsp;Analyzing…</> : "Analyze photo"}
            </Btn>
          </Card>

          {/* Tips */}
          <Card style={{ background: T.accentBg, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 10 }}>For better accuracy</div>
            {[
              "Photograph from directly above where possible",
              "Include the whole plate, not just part of it",
              "Add context for restaurant meals — the AI factors in typical cooking methods",
              "Estimates are intentionally slightly generous to account for hidden oils and fats",
            ].map((t, i) => (
              <div key={i} style={{ fontSize: 12, color: T.muted, marginBottom: 7, paddingBottom: 7, borderBottom: i < 3 ? `1px solid ${T.border}` : "none", lineHeight: 1.5 }}>{t}</div>
            ))}
          </Card>
        </div>

        {/* Right: results */}
        <div>
          {err && (
            <Card style={{ border: `1px solid ${T.red}30`, background: T.redBg, marginBottom: 14 }}>
              <div style={{ fontSize: 13, color: T.red }}>{err}</div>
            </Card>
          )}

          {!result && !loading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 360, color: T.faint, textAlign: "center", gap: 12 }}>
              <Icon name="camera" size={40} color={T.faint} />
              <div style={{ fontSize: 14, color: T.muted }}>Upload a photo to see the analysis</div>
            </div>
          )}

          {result && (
            <>
              {/* Dish name + confidence */}
              <Card style={{ marginBottom: 14 }}>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 3 }}>{result.dish}</div>
                  <div style={{ fontSize: 12, color: T.muted }}>AI estimate</div>
                </div>

                {/* Macro totals */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 14 }}>
                  {[
                    { l: "Calories", v: result.totalCalories,           unit: "kcal", c: T.accent },
                    { l: "Protein",  v: result.totalProtein + "g",      unit: "",     c: T.accent },
                    { l: "Carbs",    v: result.totalCarbs + "g",        unit: "",     c: "#7aba7a" },
                    { l: "Fat",      v: result.totalFat + "g",          unit: "",     c: "#4caf8a" },
                  ].map(s => (
                    <div key={s.l} style={{ padding: "10px 12px", background: T.accentBg, borderRadius: 8, border: `1px solid ${T.border}` }}>
                      <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{s.l}</div>
                      <div style={{ fontSize: 17, fontWeight: 700, color: s.c }}>{s.v}</div>
                    </div>
                  ))}
                </div>

                {/* AI notes */}
                {result.notes && (
                  <div style={{ padding: "9px 12px", background: T.bg, borderRadius: 7, fontSize: 12, color: T.muted, lineHeight: 1.65, border: `1px solid ${T.border}`, marginBottom: 14 }}>
                    {result.notes}
                  </div>
                )}

                {/* Log to diary */}
                <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                  <select value={mealKey} onChange={e => setMealKey(e.target.value)}
                    style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "7px 10px", color: T.text, fontFamily: T.font, fontSize: 13, outline: "none", flex: 1 }}>
                    {Object.entries(MEAL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <Btn onClick={logToDiary} disabled={logged} v={logged ? "ghost" : "dark"} style={{ flexShrink: 0 }}>
                    {logged ? "✓ Logged" : "Add to diary"}
                  </Btn>
                </div>
              </Card>

              {/* Component breakdown */}
              {result.components?.length > 0 && (
                <Card>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 12 }}>Breakdown</div>
                  {result.components.map((c, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < result.components.length - 1 ? `1px solid ${T.border}` : "none" }}>
                      <div style={{ fontSize: 13, color: T.text }}>{c.name}</div>
                      <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                        <span style={{ color: T.accent, fontWeight: 700, minWidth: 48, textAlign: "right" }}>{c.calories} kcal</span>
                        <span style={{ color: T.muted }}>P {c.protein}g</span>
                        <span style={{ color: T.muted }}>C {c.carbs}g</span>
                        <span style={{ color: T.muted }}>F {c.fat}g</span>
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   ATE OUT MODAL
════════════════════════════════════════════════════════════ */
function AteOutModal({ profile, todayLog, onClose, onLogMeal, onApplyAdjustment }) {
  const [meal, setMeal] = useState("");
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applied, setApplied] = useState(false);

  const analyze = async () => {
    if (!meal.trim()) return;
    setLoading(true);
    try {
      const data = await callAIJSON(`User ate: "${meal}". Daily target: ${profile.calories} kcal. Already logged: ${todayLog?.calories || 0} kcal. Macros: P${profile.macros.protein}g C${profile.macros.carbs}g F${profile.macros.fat}g. Return: { estimatedCalories, estimatedProtein, estimatedCarbs, estimatedFat, totalToday, overBy, remainingCalories, todayAdvice, weeklyRecovery, suggestedDailyAdjustment, adjustmentDays, adjustmentReason }`);
      setRes(data);
    } catch { setRes({ error: true }); } finally { setLoading(false); }
  };

  const handleApply = () => {
    if (!res?.suggestedDailyAdjustment) return;
    onApplyAdjustment({
      calories: profile.calories + (res.suggestedDailyAdjustment || 0),
      note: res.adjustmentReason || `Recovery adjustment after eating out (${res.overBy > 0 ? "+" + res.overBy : res.overBy} kcal over)`,
      days: res.adjustmentDays || 2,
      originalCalories: profile.calories,
    });
    setApplied(true);
  };

  return (
    <div style={{ background: T.card, borderRadius: 14, padding: 28, width: "100%", maxWidth: 480, maxHeight: "88vh", overflowY: "auto", border: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Icon name="ateout" size={18} color={T.orange} />
          <h2 style={{ fontWeight: 700, fontSize: 17, color: T.text, fontFamily: T.serif }}>I ate out</h2>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}><Icon name="close" size={18} color={T.faint} /></button>
      </div>
      <p style={{ color: T.muted, fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>Describe what you ate and I'll estimate the macros and build a recovery plan.</p>
      <Field label="What did you eat?" value={meal} onChange={setMeal} rows={3} placeholder="e.g. McDonald's Big Mac meal, large fries, McFlurry" />
      <Btn onClick={analyze} disabled={loading || !meal.trim()} v="dark" full style={{ marginBottom: res ? 18 : 0 }}>
        {loading ? <><Spin size={13} /> &nbsp;Analyzing…</> : "Analyze + get recovery plan"}
      </Btn>

      {res && !res.error && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 12 }}>
            {[
              { l: "Meal estimate", v: res.estimatedCalories + " kcal" },
              { l: "Total today",   v: res.totalToday + " kcal",        c: res.overBy > 0 ? T.red : T.accent },
              { l: res.overBy > 0 ? "Over by" : "Status", v: res.overBy > 0 ? "+" + res.overBy + " kcal" : "Within target", c: res.overBy > 0 ? T.red : T.accent },
              { l: "Remaining",     v: (res.remainingCalories || 0) + " kcal" },
            ].map((s, i) => (
              <div key={i} style={{ padding: "10px 12px", background: T.bg, borderRadius: 8, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{s.l}</div>
                <div style={{ fontWeight: 700, color: s.c || T.text, fontSize: 14 }}>{s.v}</div>
              </div>
            ))}
          </div>
          {[{ k: "todayAdvice", l: "Today's plan", c: T.accent }, { k: "weeklyRecovery", l: "Weekly recovery", c: T.orange }].filter(x => res[x.k]).map(x => (
            <div key={x.k} style={{ padding: "10px 12px", background: T.bg, borderRadius: 8, marginBottom: 9, border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 9, color: x.c, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>{x.l}</div>
              <div style={{ fontSize: 13, color: T.text, lineHeight: 1.65 }}>{res[x.k]}</div>
            </div>
          ))}

          {/* Apply calorie adjustment to dashboard */}
          {res.suggestedDailyAdjustment && Math.abs(res.suggestedDailyAdjustment) > 0 && (
            <div style={{ padding: "12px 14px", background: T.orangeBg, borderRadius: 8, border: `1px solid ${T.orange}30`, marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 5 }}>
                Suggested adjustment: <span style={{ color: res.suggestedDailyAdjustment < 0 ? T.orange : T.accent }}>{res.suggestedDailyAdjustment > 0 ? "+" : ""}{res.suggestedDailyAdjustment} kcal/day</span>
                {res.adjustmentDays ? ` for ${res.adjustmentDays} days` : ""}
              </div>
              {res.adjustmentReason && <div style={{ fontSize: 11, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>{res.adjustmentReason}</div>}
              <Btn onClick={handleApply} disabled={applied} v={applied ? "ghost" : "dark"} full size="sm">
                {applied ? "✓ Applied to dashboard" : "Apply to dashboard"}
              </Btn>
            </div>
          )}

          <Btn onClick={() => { onLogMeal({ id: Date.now().toString(), name: meal, brand: "Ate Out", servingSize: 1, servingUnit: "meal", qty: 1, calories: res.estimatedCalories || 0, protein: res.estimatedProtein || 0, carbs: res.estimatedCarbs || 0, fat: res.estimatedFat || 0, fiber: 0 }); onClose(); }} v="ghost" full>+ Log this meal to diary</Btn>
        </>
      )}
      {res?.error && <div style={{ color: T.red, fontSize: 13, padding: 10, background: T.redBg, borderRadius: 7, marginTop: 12, border: `1px solid ${T.red}30` }}>Analysis failed. Check your server is running and try again.</div>}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   PLAN AHEAD MODAL
════════════════════════════════════════════════════════════ */
function PlanAheadModal({ profile, todayLog, onClose, onApplyAdjustment }) {
  const [meal, setMeal]     = useState("");
  const [timing, setTiming] = useState("dinner");
  const [res, setRes]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [applied, setApplied] = useState(false);

  const eaten     = todayLog?.calories || 0;
  const remaining = profile.calories - eaten;
  const isOver    = remaining <= 0;

  const plan = async () => {
    if (!meal.trim()) return;
    setLoading(true);
    try {
      // Always provide full context — including whether they're already over
      const context = isOver
        ? `Already eaten ${eaten} kcal today which is ${Math.abs(remaining)} kcal over the daily target of ${profile.calories} kcal. Despite being over, the user wants to plan for an upcoming meal. Provide realistic advice for minimising further damage and suggest the lightest possible option for the planned meal.`
        : `Already eaten ${eaten} kcal today. Daily target: ${profile.calories} kcal. Remaining budget: ${remaining} kcal.`;
      const data = await callAIJSON(`${context}
Upcoming meal: "${meal}" at ${timing}.
Macros target: P${profile.macros.protein}g C${profile.macros.carbs}g F${profile.macros.fat}g.
Return: { estimatedMealCalories, estimatedMealProtein, budgetForRestOfDay, morningMeals, afternoonMeals, proteinStrategy, weekImpact, overBudgetWarning }`);
      setRes(data);
    } catch { setRes({ error: true }); } finally { setLoading(false); }
  };

  return (
    <div style={{ background: T.card, borderRadius: 14, padding: 28, width: "100%", maxWidth: 480, maxHeight: "88vh", overflowY: "auto", border: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Icon name="planahead" size={18} color={T.blue} />
          <h2 style={{ fontWeight: 700, fontSize: 17, color: T.text, fontFamily: T.serif }}>Plan ahead</h2>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}><Icon name="close" size={18} color={T.faint} /></button>
      </div>

      {/* Show current calorie status so context is clear */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
        <div style={{ padding: "8px 12px", background: T.bg, borderRadius: 7, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>Eaten today</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: T.text }}>{eaten} kcal</div>
        </div>
        <div style={{ padding: "8px 12px", borderRadius: 7, border: `1px solid ${isOver ? T.red + "40" : T.border}`, background: isOver ? T.redBg : T.accentBg }}>
          <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{isOver ? "Over by" : "Remaining"}</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: isOver ? T.red : T.accent }}>{Math.abs(remaining)} kcal</div>
        </div>
      </div>

      {isOver && (
        <div style={{ padding: "9px 12px", background: T.orangeBg, borderRadius: 7, border: `1px solid ${T.orange}30`, marginBottom: 14, fontSize: 12, color: T.orange, lineHeight: 1.6 }}>
          You're already over your daily target. The plan below will focus on damage limitation and weekly recovery.
        </div>
      )}

      <p style={{ color: T.muted, fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>Describe the meal you're planning so TrueTrack can adjust your day around it.</p>
      <DropDown label="When is the meal?" value={timing} onChange={setTiming} options={[{ value: "lunch", label: "Lunch" }, { value: "dinner", label: "Dinner" }, { value: "late-night", label: "Late night" }]} />
      <Field label="Describe the meal" value={meal} onChange={setMeal} rows={2} placeholder="e.g. Birthday dinner — pasta, bread, wine, dessert" />
      <Btn onClick={plan} disabled={loading || !meal.trim()} v="dark" full style={{ marginBottom: res ? 18 : 0 }}>
        {loading ? <><Spin size={13} /> &nbsp;Building plan…</> : "Build my pre-plan"}
      </Btn>

      {res && !res.error && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 12 }}>
            <div style={{ padding: "10px 12px", background: T.bg, borderRadius: 8, border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>Meal estimate</div>
              <div style={{ fontWeight: 700, fontSize: 16, color: T.text }}>{res.estimatedMealCalories} kcal</div>
            </div>
            <div style={{ padding: "10px 12px", background: isOver ? T.orangeBg : T.accentBg, borderRadius: 8, border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{isOver ? "Suggested max" : "Budget before"}</div>
              <div style={{ fontWeight: 700, fontSize: 16, color: isOver ? T.orange : T.accent }}>{res.budgetForRestOfDay} kcal</div>
            </div>
          </div>
          {res.overBudgetWarning && (
            <div style={{ padding: "9px 12px", background: T.orangeBg, borderRadius: 7, border: `1px solid ${T.orange}30`, marginBottom: 10, fontSize: 12, color: T.orange, lineHeight: 1.6 }}>
              {res.overBudgetWarning}
            </div>
          )}
          {[{ k: "morningMeals", l: "Morning meals" }, { k: "afternoonMeals", l: "Afternoon meals" }, { k: "proteinStrategy", l: "Protein strategy" }, { k: "weekImpact", l: "Weekly impact" }].filter(x => res[x.k]).map(x => (
            <div key={x.k} style={{ padding: "10px 12px", background: T.bg, borderRadius: 8, marginBottom: 9, border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 9, color: T.accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>{x.l}</div>
              <div style={{ fontSize: 13, color: T.text, lineHeight: 1.65 }}>{res[x.k]}</div>
            </div>
          ))}

          {/* Apply calorie adjustment to dashboard */}
          {res.budgetForRestOfDay && (
            <div style={{ padding: "12px 14px", background: T.accentBg, borderRadius: 8, border: `1px solid ${T.borderMid}`, marginTop: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 5 }}>
                Apply pre-plan to dashboard
              </div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>
                Sets your calorie target for today to <b style={{ color: T.accent }}>{res.budgetForRestOfDay} kcal</b> so the diary reflects your pre-planned budget.
              </div>
              <Btn onClick={() => {
                onApplyAdjustment({
                  calories: res.budgetForRestOfDay,
                  note: `Pre-planned around "${meal}" at ${timing} — budget adjusted to ${res.budgetForRestOfDay} kcal`,
                  days: 1,
                  originalCalories: profile.calories,
                });
                setApplied(true);
              }} disabled={applied} v={applied ? "ghost" : "dark"} full size="sm">
                {applied ? "✓ Applied to dashboard" : "Apply to dashboard"}
              </Btn>
            </div>
          )}
        </>
      )}
      {res?.error && <div style={{ color: T.red, fontSize: 13, padding: 10, background: T.redBg, borderRadius: 7, marginTop: 12, border: `1px solid ${T.red}30` }}>Planning failed. Check your server and try again.</div>}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   ROOT APP
════════════════════════════════════════════════════════════ */
export default function TrueTrack() {
  const [screen, setScreen] = useState("landing");
  const [page, setPage] = useState("dashboard");
  const [profile, setProfile] = useState(null);
  const [logs, setLogs] = useState([]);
  const [modal, setModal] = useState(null);
  const [calAdjustment, setCalAdjustment] = useState(null); // { calories, note, originalCalories }

  useEffect(() => {
    const p = DB.get("tt_profile");
    const l = DB.get("tt_logs") || [];
    if (p) { setProfile(p); setScreen("app"); }
    setLogs(l);
    const s = document.createElement("style");
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      @keyframes spin { to { transform: rotate(360deg); } }
      html, body, #root { background: #f2f5f2; color: #1a2e1a; font-family: 'Outfit', system-ui, sans-serif; }
      input, select, textarea { font-family: inherit; color: #1a2e1a !important; background: #f2f5f2 !important; -webkit-text-fill-color: #1a2e1a !important; }
      input::placeholder, textarea::placeholder { color: #9aaa9a !important; -webkit-text-fill-color: #9aaa9a !important; }
      input:-webkit-autofill { -webkit-text-fill-color: #1a2e1a !important; -webkit-box-shadow: 0 0 0 1000px #f2f5f2 inset !important; }
      select option { background: #f2f5f2; color: #1a2e1a; }
      input:focus, select:focus, textarea:focus { border-color: #3a7d3a !important; outline: none; box-shadow: 0 0 0 3px rgba(58,125,58,0.12); }
      button:hover:not(:disabled) { opacity: 0.85; }
      ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #d8e8d8; border-radius: 3px; }
    `;
    document.head.appendChild(s);

    // Browser tab title
    document.title = "TrueTrack";

    // SVG favicon — the mark injected as data URI
    const favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    favicon.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%231a2e1a'/><line x1='4' y1='13' x2='14' y2='13' stroke='%236fcf6f' stroke-width='3.5' stroke-linecap='round'/><line x1='14' y1='13' x2='14' y2='27' stroke='%236fcf6f' stroke-width='3.5' stroke-linecap='round'/><path d='M14,13 C19,13 22,10 24,6' fill='none' stroke='%236fcf6f' stroke-width='3.5' stroke-linecap='round'/></svg>`;
    document.head.appendChild(favicon);
  }, []);

  const todayLog = logs.find(l => l.date === TODAY) || null;

  const saveLog = (data) => {
    const updated = [...logs.filter(l => l.date !== TODAY), data].sort((a, b) => a.date.localeCompare(b.date));
    setLogs(updated);
    DB.set("tt_logs", updated);
  };

  const reset = () => { DB.set("tt_profile", null); DB.set("tt_logs", []); setProfile(null); setLogs([]); setScreen("landing"); };
  const editProfile = () => setScreen("onboarding");

  const addMealToDiary = (mealKey, food) => {
    const existing = todayLog || { date: TODAY, meals: { breakfast: [], lunch: [], dinner: [], snacks: [] }, calories: 0, protein: 0, carbs: 0, fat: 0, weight: 0, steps: 0, notes: "" };
    const meals = existing.meals || { breakfast: [], lunch: [], dinner: [], snacks: [] };
    const updated = { ...existing, meals: { ...meals, [mealKey]: [...(meals[mealKey] || []), food] } };
    const all = [...updated.meals.breakfast, ...updated.meals.lunch, ...updated.meals.dinner, ...updated.meals.snacks];
    updated.calories = all.reduce((s, f) => s + f.calories, 0);
    updated.protein  = all.reduce((s, f) => s + f.protein, 0);
    updated.carbs    = all.reduce((s, f) => s + f.carbs, 0);
    updated.fat      = all.reduce((s, f) => s + f.fat, 0);
    saveLog(updated);
  };

  const logMealFromAteOut = (food) => { addMealToDiary("snacks", food); setPage("log"); };

  if (screen === "landing")    return <Landing onStart={() => setScreen("onboarding")} />;
  if (screen === "onboarding") return <Onboarding onComplete={p => { setProfile(p); setScreen("app"); }} />;
  if (!profile) return null;

  const modalContent = modal === "ateout"
    ? <AteOutModal profile={profile} todayLog={todayLog} onClose={() => setModal(null)} onLogMeal={logMealFromAteOut} onApplyAdjustment={adj => { setCalAdjustment(adj); setModal(null); }} />
    : modal === "planahead"
    ? <PlanAheadModal profile={profile} todayLog={todayLog} onClose={() => setModal(null)} onApplyAdjustment={adj => { setCalAdjustment(adj); setModal(null); }} />
    : null;

  return (
    <AppShell page={page} setPage={setPage} setModal={setModal} profile={profile} onReset={reset} onEditProfile={editProfile} modal={modal} modalContent={modalContent}>
      {page === "dashboard" && <Dashboard profile={profile} logs={logs} todayLog={todayLog} onSave={saveLog} onProfileUpdate={p => { setProfile(p); }} calAdjustment={calAdjustment} onClearAdjustment={() => setCalAdjustment(null)} onApplyAdjustment={adj => setCalAdjustment(adj)} />}
      {page === "log"       && <LogPage profile={profile} logs={logs} todayLog={todayLog} onSave={saveLog} onApplyAdjustment={adj => { setCalAdjustment(adj); setPage("dashboard"); }} />}
      {page === "meals"     && <MealsPage profile={profile} todayLog={todayLog} onAddToDiary={addMealToDiary} />}
      {page === "insights"  && <InsightsPage profile={profile} logs={logs} />}
    </AppShell>
  );
}
