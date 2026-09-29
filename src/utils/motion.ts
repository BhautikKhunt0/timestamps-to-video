// ---------------------------------------------------------------------------
// Pro-Camera motion planner — ONE source of truth for the "camera moves".
//
// server.ts renders every shot from a ShotMotion produced here; App.tsx draws
// cut-map badges from the same plan (same inputs => same plan => preview
// matches the rendered output). Pure module: no I/O, browser-safe.
//
// Ken Burns grammar (by VISIBLE shot length, before half-transition extensions):
//   < 1.2s  => null  (static — fast cutting rhythm carries the shot)
//   *       => gentle zoom (push in / pull out) or slight LEFT-RIGHT pan,
//              breathing 8-15% scaled by shot length and style (short ~8%,
//              long ~15% mixed; subtle ~6-9%, dynamic ~11-18%). Below ~8% the
//              mid-curve motion is subpixel and only quantization shimmer
//              survives — so the planner never emits less.
// Rules: ONE continuous eased move per shot — never a mid-shot cut. Vertical is
// ALWAYS locked to exact center (whole image top/bottom stays visible); zoom-outs
// are centered with a tiny lateral drift so the fixation region never sits at
// exact-zero velocity; lateral motion is slight left-right only. All moves use
// a LIFTED-cosine ease (pure cosine leaves ~0.3-0.5s frozen at each end, which
// reads as frozen-then-jump under 1px quantization) and are seeded
// (mulberry32) with a randomized mix of all five moves across the intro —
// never repeating the previous move, preferring family changes. Across a
// rendered dissolve the shot mirrors the neighbour (pan-r<->pan-l,
// push<->pull) with 50% seeded probability so blends alternate between
// invisible handoffs and fresh moves; forcing the mirror every time collapsed
// whole timelines into one alternating pair (push,pull,push,pull…).
// Only the first ~60s moves (see MOTION_INTRO_SECONDS); the tail is static.
//
// Transition half-extensions are WHOLE-FRAME quantized (odd-frame transitions
// split floor/ceil) so planner curve domains and server xfade offsets share
// the exact frame grid — no 0.5-frame blend/curve misalignment.
//
// Geometry: cover canvas 2560x1440; the window lives near full-frame
// (2560 = whole canvas visible) and only breathes 8-15%, so top/bottom stay
// visible and the sides give the left-right headroom. Rendered by 4x
// supersampled `zoompan` (zoom) / crop (pan) with fixed 1920x1080 output,
// no per-frame scaler reinit — see motionOps.
// ---------------------------------------------------------------------------

export const RENDER_FPS = 30;
export const MOTION_CW = 2560; // oversampled cover canvas (pan/zoom headroom)
export const MOTION_CH = 1440;
export const MOTION_FW = 1920; // output frame
export const MOTION_FH = 1080;
export const MOTION_SEGMENT_SIZE = 20; // must mirror server SEGMENT_SIZE
// Intro-only motion: the first ~60s of visible timeline moves (randomized
// moves across every shot in that span). Everything after renders as straight
// cuts on the fast static path — no zoompan/supersample cost, no xfade
// re-encodes. The planner is the single source of truth, so server output
// and client badges agree.
export const MOTION_INTRO_SECONDS = 60;
/** Index of the first static (tail) shot: shots starting at/after 60s. */
export function introCutoff(rawDurs: number[], opts: PlanOptions = {}): number {
  let durs = rawDurs.map((d) => (Number.isFinite(d) && d > 0 ? d : 5));
  if (opts.imageCount && opts.imageCount > 0) {
    while (durs.length < opts.imageCount) durs.push(durs[durs.length - 1] || 5);
    durs = durs.slice(0, opts.imageCount);
  }
  const q = quantizeTimelineToFrames(durs);
  let t = 0;
  for (let i = 0; i < q.length; i++) {
    if (t >= MOTION_INTRO_SECONDS) return i;
    t += q[i];
  }
  return q.length;
}
export const MOTION_ASPECT = MOTION_FH / MOTION_FW; // 0.5625

export type MotionStyle = "subtle" | "mixed" | "dynamic";
export interface MotionConfig { enabled: boolean; style: MotionStyle; seed: number }
export type ShotMove = "none" | "push" | "pull" | "pan-l" | "pan-r" | "tilt-u" | "tilt-d" | "drift";

export interface PunchMove {
  at: number;                     // curve-seconds of the punch cut (frame-quantized)
  w0: number; w1: number;         // sub-shot-2 window width start/end (px)
  cx0: number; cy0: number;       // sub-shot-2 window center start (px)
  cx1: number; cy1: number;       // sub-shot-2 window center end (px)
}

export interface ShotMotion {
  move: ShotMove;
  D: number;                      // full curve seconds = visible + left/right half-extensions
  extL: number;                   // seconds of xfade overlap BEFORE the visible start
  w0: number; w1: number;         // crop window width start/end (px)
  cx0: number; cy0: number;       // window CENTER start (px)
  cx1: number; cy1: number;       // window CENTER end (px)
  punch?: PunchMove;
}

export type MotionPlan = (ShotMotion | null)[];

export interface PlanOptions {
  segmentSize?: number;
  imageCount?: number; // pad durs to this length (client badge parity)
}

// ---- shared helpers ---------------------------------------------------------

export const toFrames = (sec: number) => Math.round(sec * RENDER_FPS);
export const toSeconds = (frames: number) => frames / RENDER_FPS;

// Identical to server quantizeTimelineToFrames (cumulative; idempotent for
// already-quantized input — the server passes quantized durs through unchanged).
export const quantizeTimelineToFrames = (durs: number[]): number[] => {
  let prevFrames = 0;
  let cumSec = 0;
  return durs.map((d) => {
    cumSec += Number.isFinite(d) && d > 0 ? d : 0;
    let f = toFrames(cumSec) - prevFrames;
    if (f < 1) f = 1;
    prevFrames += f;
    return toSeconds(f);
  });
};

// Cosine ease-in-out — the shape both the planner math and the ffmpeg crop
// expressions use (0.5-0.5*cos(PI*x)). Never linear: linear reads mechanical.
export const easeCos = (x: number): number => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
};

// Lifted-cosine pedestal: pure cosine has ZERO velocity at both ends, so with
// 1px-quantized rendering the first/last ~5-8 frames all round to the same
// crop (0.3-0.5s frozen at every shot boundary — frozen-then-jump). Blending
// 35% linear keeps end velocity at ~35% of average: caps stay soft, every
// frame advances, and dissolve handoffs still match (both sides share it).
export const EASE_PEDESTAL = 0.35;
export const easeLift = (x: number): number => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return (1 - EASE_PEDESTAL) * easeCos(t) + EASE_PEDESTAL * t;
};

export function normalizeMotionConfig(raw: any): MotionConfig {
  const style: MotionStyle = raw?.style === "subtle" || raw?.style === "dynamic" ? raw.style : "mixed";
  const seedNum = Number(raw?.seed);
  const seed = Number.isFinite(seedNum) ? Math.abs(Math.floor(seedNum)) % 2147483646 : 1;
  return { enabled: raw?.enabled === true, style, seed };
}

function mulberry32(a: number) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ---- planner ----------------------------------------------------------------

const familyOf = (m: ShotMove): string =>
  m === "push" || m === "pull" ? "zoom"
  : m === "pan-l" || m === "pan-r" ? "lat"
  : m === "tilt-u" || m === "tilt-d" ? "vert"
  : m === "drift" ? "diag" : "none";

/**
 * Plan camera motion for every shot. Deterministic for identical inputs.
 * `durs` must be the timeline durations (frame-quantized by the caller on the
 * server; raw is fine — this quantizes internally, idempotent).
 * `trans`/`transDurs` are the per-join transition type/duration arrays
 * (index i = join between shot i and i+1) — used only to derive the
 * half-transition extensions so a move spans the WHOLE branch (motion flows
 * continuously through crossfades).
 *
 * INTRO-ONLY: shots starting at/after MOTION_INTRO_SECONDS stay null
 * (static). The gate sits before any rng() draw, so the head plan is
 * bit-identical with or without the tail — preview badges and server output
 * always agree.
 */
export function planMotion(
  rawDurs: number[],
  trans: string[],
  rawTransDurs: number[],
  cfg: MotionConfig,
  opts: PlanOptions = {}
): MotionPlan {
  if (!cfg.enabled) return [];
  const segSize = opts.segmentSize ?? MOTION_SEGMENT_SIZE;

  // Mirror the server's padding rule (repeat last) when the client knows the
  // image count; the server passes an already-sized array.
  let durs = rawDurs.map((d) => (Number.isFinite(d) && d > 0 ? d : 5));
  if (opts.imageCount && opts.imageCount > 0) {
    while (durs.length < opts.imageCount) durs.push(durs[durs.length - 1] || 5);
    durs = durs.slice(0, opts.imageCount);
  }
  durs = quantizeTimelineToFrames(durs);

  // Visible-start time of each shot; the intro covers starts < 60s.
  let _acc = 0;
  const startAt = durs.map((d) => { const s = _acc; _acc += d; return s; });

  const n = durs.length;
  if (n === 0) return [];
  const rng = mulberry32(cfg.seed || 1);
  const scale = cfg.style === "subtle" ? 0.6 : cfg.style === "dynamic" ? 1.35 : 1;
  const plan: MotionPlan = new Array(n).fill(null);

  const CW = MOTION_CW, CH = MOTION_CH;
  const cX = CW / 2, cY = CH / 2;

  // Transition half-extensions — MUST mirror renderXfadeRun's math:
  // inDurs[i] = qDurs[i] + ceilHalf(qTrans[i-1]) + floorHalf(qTrans[i]) (only
  // for joins that actually render as xfades: same segment, type != "none").
  // Halves are WHOLE-FRAME quantized (floor right / ceil left, summing to the
  // full transition) so curve domains sit exactly on the frame grid the
  // server's xfade offsets use — a raw qTrans/2 lands mid-frame for odd-frame
  // transitions (0.5s = 15 frames -> 7.5) and misaligns every blend by 0.5f.
  const qT = (i: number): number => {
    if (i < 0 || i >= n - 1) return 0;
    const t = Number(rawTransDurs[i]);
    if (!Number.isFinite(t) || t <= 0) return 0;
    if (!trans[i] || trans[i] === "none") return 0;
    return Math.max(toSeconds(1), toSeconds(toFrames(t)));
  };
  const halfDown = (frames: number) => Math.floor(frames / 2);
  const sameSeg = (a: number, b: number) => Math.floor(a / segSize) === Math.floor(b / segSize);
  const extFor = (i: number): [number, number] => {
    const left = i > 0 && sameSeg(i, i - 1) && trans[i - 1] && trans[i - 1] !== "none"
      ? toSeconds(toFrames(qT(i - 1)) - halfDown(toFrames(qT(i - 1)))) : 0;
    const right = i < n - 1 && sameSeg(i, i + 1) && trans[i] && trans[i] !== "none"
      ? toSeconds(halfDown(toFrames(qT(i)))) : 0;
    return [left, right];
  };

  // Keep window center endpoints inside the canvas for a given window width.
  // Full-frame windows (w ~= CW) have no slack — snap those to exact center
  // (otherwise x/y would clamp out of bounds and crop would fail/black-edge).
  const clampCX = (c: number, w: number) => {
    const lo = w / 2 + 8, hi = CW - w / 2 - 8;
    return lo >= hi ? cX : clamp(c, lo, hi);
  };
  const clampCY = (c: number, w: number) => {
    const h = w * MOTION_ASPECT, lo = h / 2 + 8, hi = CH - h / 2 - 8;
    return lo >= hi ? cY : clamp(c, lo, hi);
  };
  const jit = (amp: number) => (rng() - 0.5) * 2 * amp;

  // Linear span inside [lo, hi] with a given direction and travel (px).
  const linSpan = (lo: number, hi: number, sign: number, travel: number): [number, number] => {
    const range = hi - lo;
    const t = Math.min(travel, range * 0.7);
    const end = lo + range * (0.2 + rng() * 0.6);
    let start = end - sign * t;
    start = clamp(start, lo + 6, hi - 6);
    const fin = clamp(start + sign * t, lo + 6, hi - 6);
    return [start, fin];
  };

  let prevMove: ShotMove = "none";
  let prevFam = "none";
  let prevIdx = -1;      // index of the last MOVING shot (statics don't move)
  let prevEndCX = cX;    // its curve-end center (for dissolve handoffs)

  // Mirror handoff across a rendered dissolve, taken with 50% seeded
  // probability: the shot that STARTS where the previous shot ENDED blends
  // invisibly (measured on identical content: same-direction blend spikes
  // 2.6x solo motion, mirror blend sits at 0.7x). pan-r<->pan-l and
  // push<->pull are exact mirrors; drift mirrors by the side it ended on.
  // The other 50% takes a fresh (variety-preferring) move so timelines
  // stay randomized instead of collapsing into one alternating pair.
  const MIRROR: Record<string, ShotMove> = { push: "pull", pull: "push", "pan-l": "pan-r", "pan-r": "pan-l" };

  for (let i = 0; i < n; i++) {
    const vis = durs[i];
    if (startAt[i] >= MOTION_INTRO_SECONDS) continue; // intro-only tail: static cuts
    if (vis < 1.2) continue; // fast shot: static — the cut rhythm carries it

    const [extL, extR] = extFor(i);
    const D = vis + extL + extR;

    const pick = (pool: ShotMove[]): ShotMove => {
      // Left join renders as a dissolve AND the neighbour actually moves:
      // mirror its curve with 50% seeded probability (position + matched
      // pedestal velocity both continue, invisible blend). Otherwise — and on
      // hard cuts — take a fresh move (contrast reads well on cuts, and
      // timelines stay randomized instead of push,pull,push,pull… forever).
      if (extL > 0 && prevIdx === i - 1 && prevMove !== "none" && rng() < 0.5) {
        const key = prevMove === "drift" ? (prevEndCX >= cX ? "pan-r" : "pan-l") : prevMove;
        const m = MIRROR[key];
        if (m && pool.includes(m)) return m;
      }
      let p = pool.filter((m) => m !== prevMove);
      if (p.length > 1) {
        const q = p.filter((m) => familyOf(m) !== prevFam);
        if (q.length) p = q;
      }
      return p[Math.floor(rng() * p.length)] || pool[0];
    };

    // No vertical motion anywhere: tilt retired — top/bottom stay visible.
    // Every moving shot (1.2s+) draws from the full pool, so the intro mixes
    // push/pull/pan/drift in seeded-random order across the whole first
    // minute instead of locking to one alternating pair.
    const isMicro = vis < 3;
    const move: ShotMove = pick(["push", "pull", "pan-l", "pan-r", "drift"]);

    const speed = (isMicro ? 40 : 55) * scale; // px/s
    // Zoom breathes 8-15% mixed (short ~8%, long ~15%): below ~8% the
    // mid-curve edge motion is subpixel and only quantization shimmer
    // survives. Broadcast Ken Burns runs 10-20% — this floor keeps every
    // shot readable as glide. Subtle ~6-9%, dynamic ~11-18%.
    const mag = clamp((0.08 + 0.07 * clamp((vis - 1.2) / 5.8, 0, 1)) * scale, 0.06, 0.18);
    const fullW = CW; // entire canvas visible
    const zoomW = (m: number) => fullW / (1 + m);
    let w0: number, w1: number;
    let cx0: number, cy0: number, cx1: number, cy1: number;

    if (move === "push") {
      // Zoom-in from the full frame with a tiny lateral drift (3-5 canvas px):
      // pure center-locked zoom holds the fixation region at exact-zero
      // velocity, so the eye sees only edge shimmer ("shake"). The drift keeps
      // every pixel advancing and breaks coherent aliasing; the full-frame
      // start stays pinned (no slack) and the dissolve mirror still lands
      // within a few px (vs 108px for a direction mismatch).
      w0 = fullW; w1 = zoomW(mag);
      const drift = (rng() < 0.5 ? -1 : 1) * (3 + rng() * 2) * scale;
      cx0 = cX; cy0 = cy1 = cY;
      cx1 = cX + drift;
    } else if (move === "pull") {
      // Zoom-out landing on the full frame — mirror of push.
      w0 = zoomW(mag); w1 = fullW;
      const drift = (rng() < 0.5 ? -1 : 1) * (3 + rng() * 2) * scale;
      cx0 = cX + drift; cx1 = cX; cy0 = cy1 = cY;
    } else {
      // pan-l / pan-r / drift = slight LEFT-RIGHT drift across a lightly
      // zoomed frame. The window size is CONSTANT, because that is what the
      // crop-based render path requires: one fixed scale + animated crop x/y
      // gives true 1px pan steps with no per-frame scaler reinit (measured 0
      // spikes, smooth to 12s), whereas animating the size re-rasterises
      // coarsely. A constant window also keeps the whole top/bottom in frame
      // while the sides provide the travel.
      //
      // Travel is sized in FRAMES, not seconds: crop x rounds to whole pixels,
      // so a pan slower than ~0.5px/frame leaves every other frame frozen and
      // reads as stepping. We ask for ~0.55px/frame and deepen the pan's
      // constant zoom on long shots so the extra travel has room to land.
      // Floor raised with the zoom band (mixed 9-15%) so pans stay readable.
      const panZoom = clamp((0.09 + 0.06 * clamp((vis - 1.2) / 5.8, 0, 1)) * scale, 0.07, 0.17);
      w0 = w1 = zoomW(panZoom);
      const roomScaled = (CW * MOTION_FW) / w0 - MOTION_FW; // travel room in FRAME px
      const wantScaled = Math.max(24, vis * RENDER_FPS * 0.8);
      const travelScaled = Math.min(wantScaled, Math.max(20, roomScaled * 0.7));
      const travel = (travelScaled * w0) / CW;       // -> canvas px
      const sign = move === "pan-l" ? -1 : move === "pan-r" ? 1 : (rng() < 0.5 ? 1 : -1);
      cx0 = clampCX(cX - (sign * travel) / 2, w0);
      cx1 = clampCX(cX + (sign * travel) / 2, w1);
      cy0 = cy1 = cY;                                // whole image top/bottom visible
    }

    const shot: ShotMotion = {
      move, D, extL, w0, w1,
      cx0: clampCX(cx0, w0), cy0: clampCY(cy0, w0),
      cx1: clampCX(cx1, w1), cy1: clampCY(cy1, w1),
    };

    // NO PUNCH: the mid-shot "reframe" (a hard cut to a tighter framing) is
    // retired — it reads as a sudden cut. Every shot is now ONE continuous
    // eased move from end to end. `ShotMotion.punch` stays in the type (and
    // buildMotionBranch still handles it) so the capability can be re-enabled
    // without touching the render path, but the planner never emits one.

    plan[i] = shot;
    prevMove = move;
    prevFam = familyOf(move);
    prevIdx = i;
    prevEndCX = shot.cx1;
  }

  return plan;
}

// ---- ffmpeg branch builders -------------------------------------------------

const f = (x: number) => (Math.round(x * 10000) / 10000).toString();

// Cover normalize: fill a 2560x1440 canvas (center-crop overflow). Runs ONCE
// per image before the loop filter (single decode). yuv444p is forced first so
// every source (png=rgb, jpg=yuv420) takes the same path — and so the animated
// crop's x/y may land on ANY integer without chroma subsample misalignment
// (yuv420 would need even x/y => 2px pan granularity).
export const MOTION_COVER =
  `format=yuv444p,scale=w=${MOTION_CW}:h=${MOTION_CH}:force_original_aspect_ratio=increase,crop=w=${MOTION_CW}:h=${MOTION_CH}`;

type WindowCurve = { w0: number; w1: number; cx0: number; cy0: number; cx1: number; cy1: number };

/**
 * Animated Ken Burns for one curve segment. Two paths, each measured smooth
 * and crash-free on this ffmpeg build, chosen by whether the window SIZE
 * animates:
 *
 * 1. ZOOM (w0 != w1) — 4x-supersampled `zoompan`, output size fixed at
 *    1920x1080 so swscale is never re-initialised. An animated `scale` size
 *    re-inits swscale EVERY FRAME and faults (0xC0000005) whenever the scale
 *    SHRINKS over time — i.e. every pull / zoom-out. zoompan: 0 crashes to
 *    10s, frame counts exact. Its x/y/w snap to whole INPUT pixels
 *    (vf_zoompan.c: int truncation), so the crop steps 0.78 out-px/frame at
 *    1x (0.44px rms sawtooth), 0.39 at 2x (0.22), 0.19 at 4x (0.11), 0.13 at
 *    6x (0.074) — exactly 1/sqrt(3) of the step, halving per doubling. 4x is
 *    the ceiling: position sinks to ~0.11px rms against an irreducible ~0.16
 *    scale-resampling floor, and 6x buys 0.02px for 2.25x pixels.
 *
 * 2. PAN (w0 == w1) — 4x-supersampled lateral drift: ONE constant pre-scale
 *    (4x) + animated `crop` x/y in the 4x domain + ONE constant downscale to
 *    1920x1080. All sizes fixed per shot, so zero scaler reinit; 1 crop step
 *    in 4x blends to 0.25 out-px, so every mid-curve frame advances
 *    (posJitter ~0.07px rms, moved ~95%+, no frozen-frame stepping).
 *    zoompan cannot do this job: it re-rasterises coarsely when x moves with
 *    the zoom held still (10-27 spikes of ~100 MAD), and gets WORSE the slower
 *    the move (12px travel => 63 spikes).
 *
 * Ease is LIFTED-cosine (35% linear pedestal): pure cosine freezes ~5-8
 * frames at each end under 1px quantization (frozen-then-jump at the cut);
 * the pedestal keeps end velocity at ~35% of average with soft caps, and
 * both dissolve sides share it so mirror handoffs still match.
 *
 * Mapping: the window is `w(t)` px wide on the 2560x1440 canvas, centred at
 * (cx(t), cy(t)). `D` = curve domain seconds, `tb` = branch-local offset
 * (mode-A slices). The planner clamps endpoints so the window stays inside
 * the canvas (cx/w are linear in e, so endpoints bound all t).
 * zoompan has no `t` (it counts `on`); crop uses `t`.
 */
const motionOps = (s: WindowCurve, D: number, tb: number): string => {
  const Dq = Math.max(0.1, D);
  const A = EASE_PEDESTAL;
  const ease = (timeVar: string) => {
    const term = tb === 0 ? timeVar : `${timeVar}${tb < 0 ? "-" : "+"}${f(Math.abs(tb))}`;
    const cos = `(0.5-0.5*cos(PI*clip(${term},0,${f(Dq)})/${f(Dq)}))`;
    const lin = `(clip(${term},0,${f(Dq)})/${f(Dq)})`;
    return `(${f(1 - A)}*${cos}+${f(A)}*${lin})`;
  };
  const cxE = (E: string) => `(${f(s.cx0)}+${f(s.cx1 - s.cx0)}*${E})`;
  const cyE = (E: string) => `(${f(s.cy0)}+${f(s.cy1 - s.cy0)}*${E})`;

  if (s.w0 === s.w1) {
    // ---- PAN: 4x-supersampled lateral drift, zero reinit, subpixel ----
    // Integer crop x/y can only step whole pixels: at ~0.6px/frame true travel
    // every third frame froze (moved 68%) and the pan visibly stepped. Doing
    // the animated crop in a 4x domain (fixed pre-scale, fixed 7680x4320 crop,
    // fixed downscale) makes 1 crop step = 0.25 out-px blended by the
    // downscaler, so every mid-curve frame advances (posJitter ~0.07px rms).
    // All three sizes are CONSTANT per shot — no per-frame scaler reinit.
    const SS = 4;
    const sw = Math.round((MOTION_CW * MOTION_FW * SS) / s.w0);
    const sh = Math.round((MOTION_CH * MOTION_FW * SS) / s.w0);
    const cw = MOTION_FW * SS, ch = MOTION_FH * SS;
    const E = ease("t");
    const xs = `${cxE(E)}*${sw}/${MOTION_CW}-${cw / 2}`;
    const ys = `${cyE(E)}*${sh}/${MOTION_CH}-${ch / 2}`;
    // yuv444p so crop's x/y may land on any integer (yuv420 would round to
    // even => 2px steps in 2x = 1px out). Sizes never change, only x/y.
    return `scale=w=${sw}:h=${sh},format=yuv444p,crop=w='${cw}':h='${ch}':x='${xs}':y='${ys}',scale=w=${MOTION_FW}:h=${MOTION_FH}`;
  }

  // ---- ZOOM (push/pull): 4x-supersampled zoompan — crash-free + subpixel ----
  // The old animated-scale path (`scale eval=frame` shrinking over time)
  // segfaults this ffmpeg build on EVERY pull (zoom-out), so half the shots
  // silently fell back to stills. zoompan keeps a fixed 1920x1080 output with
  // no scaler reinit — but its x/y/w snap to whole input pixels
  // (vf_zoompan.c truncates the expressions to int), so a centered 7%-over-5s
  // zoom steps its crop 0.6px/frame and shimmers. Feeding zoompan a fixed 4x
  // pre-scale (10240x5760) quarters the step to ~0.19 out-px: every frame
  // ticks in 4x and blends to subpixel out (posJitter 0.44->0.11px rms).
  // `on` counts output frames 0..F-1, so `on/30` samples the same curve times
  // as the pan path's `t` (last frame at D-1/30 — the next shot's boundary).
  const SS2 = 4;
  const CW2 = MOTION_CW * SS2, CH2 = MOTION_CH * SS2;
  const E = ease("on/30");
  const w2 = `(${f(s.w0 * SS2)}+${f((s.w1 - s.w0) * SS2)}*${E})`;
  const cx2 = `(${f(s.cx0 * SS2)}+${f((s.cx1 - s.cx0) * SS2)}*${E})`;
  const cy2 = `(${f(s.cy0 * SS2)}+${f((s.cy1 - s.cy0) * SS2)}*${E})`;
  // h = w * 9/16 (output aspect); y = cy - h/2 = cy - w*0.28125 (in 2x px).
  return `scale=w=${CW2}:h=${CH2},zoompan=z='(${CW2}/(${w2}))':x='(${cx2}-(${w2})/2)':y='(${cy2}-(${w2})*0.28125)':d=1:s=${MOTION_FW}x${MOTION_FH}:fps=${RENDER_FPS}`;
};

const outTail = `setsar=1,format=yuv420p`;

export interface BranchOpts {
  /** filter_complex mode labels inputs/outputs; vf mode returns a bare chain. */
  mode: "vf" | "fc";
  inputIdx?: number;
  outLabel?: string;
  /** total frames the caller will loop (must equal the caller's loop= count) */
  loopFrames: number;
  /** offset into the curve domain for this slice (mode-A chunk splits) */
  tOff?: number;
}

/**
 * Build the encode branch for one motion shot (punch-aware).
 *
 * - No punch: single chain  [in] trim,cover,loop,crop,scale [out]
 * - Punch:    split into sub-shot 1 (curve [0..at]) and sub-shot 2 (own eased
 *             push [at..D]) then concat — the punch lands exactly at
 *             round((at - tOff)*30) frames into the branch.
 *
 * The loop filter must run BEFORE crop: duplicated frames carry advancing
 * pts, so crop's eval=frame `t` advances and the window actually moves.
 */
export function buildMotionBranch(shot: ShotMotion, opts: BranchOpts): string {
  const F = Math.max(1, Math.round(opts.loopFrames));
  const tOff = opts.tOff ?? 0;
  const fc = opts.mode === "fc";
  const head = `${fc ? `[${opts.inputIdx ?? 0}:v]` : ""}trim=end_frame=1,setpts=PTS-STARTPTS,settb=1/30,${MOTION_COVER}`;

  // One sub-shot chain: loop the still frame FIRST (advancing pts), then the
  // animated scale+crop reads t per duplicated frame. fc mode ends with
  // settb=AVTB so downstream xfade/concat see the same timebase as static
  // branches. Output is fixed 1920x1080 (crop guarantees it).
  const chain = (curve: WindowCurve, frames: number, D: number, tb: number, outRef: string): string =>
    `loop=loop=${Math.max(0, frames - 1)}:size=1,${motionOps(curve, D, tb)},${outTail}` +
    (fc ? `,settb=AVTB${outRef}` : "");

  const p = shot.punch;
  if (!p || !fc) {
    // No punch (or defensive vf mode): single chain over the whole branch.
    // vf callers are static-path only — punch always runs in fc mode.
    return `${head},${chain(shot, F, shot.D, tOff, `[${opts.outLabel ?? "vout"}]`)}` + (fc ? ";" : "");
  }

  // Punch: split the branch at the punch frame (clamped inside this slice).
  const f1 = clamp(Math.round((p.at - tOff) * RENDER_FPS), 0, F);
  const o = opts.outLabel ?? "vout";

  if (f1 <= 0) {
    // Slice lives entirely inside sub-shot 2: single chain on curve 2.
    const curve2: WindowCurve = { w0: p.w0, w1: p.w1, cx0: p.cx0, cy0: p.cy0, cx1: p.cx1, cy1: p.cy1 };
    const D2 = Math.max(0.1, shot.D - p.at);
    return `${head},${chain(curve2, F, D2, tOff - p.at, `[${o}]`)};`;
  }
  if (f1 >= F) {
    // Slice ends before the punch: single chain on curve 1.
    return `${head},${chain(shot, F, shot.D, tOff, `[${o}]`)};`;
  }
  const f2 = F - f1;
  const curve2: WindowCurve = { w0: p.w0, w1: p.w1, cx0: p.cx0, cy0: p.cy0, cx1: p.cx1, cy1: p.cy1 };
  const D2 = Math.max(0.1, shot.D - p.at);
  // Curve-time where sub-shot 2's local t=0 sits (slice may start mid-sub2).
  const tb2 = tOff + f1 / RENDER_FPS - p.at;
  return `${head},split=2[s1][s2];` +
    `[s1]${chain(shot, f1, shot.D, tOff, "[c1]")};` +
    `[s2]${chain(curve2, f2, D2, tb2, "[c2]")};` +
    `[c1][c2]concat=n=2:v=1:a=0,settb=AVTB[${o}];`;
}

// ---- badge text (client) ------------------------------------------------------

const MOVE_LABEL: Record<string, string> = {
  "pan-l": "pan \u2190", "pan-r": "pan \u2192",
  "tilt-u": "tilt \u2191", "tilt-d": "tilt \u2193",
  push: "push", pull: "pull", drift: "drift", none: "",
};

/** Short human badge for the cut map; null = nothing to show. */
export function motionBadge(s: ShotMotion | null | undefined): string | null {
  if (!s) return null;
  if (s.punch) return "punch-in";
  if (s.move === "none") return null;
  const name = MOVE_LABEL[s.move] || s.move;
  const pct =
    s.move === "pull" ? Math.round((s.w1 / s.w0 - 1) * 100)
    : Math.round((1 - s.w1 / s.w0) * 100);
  return pct > 0 ? `${name} ${pct}%` : name;
}
