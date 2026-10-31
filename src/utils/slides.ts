// ---------------------------------------------------------------------------
// Slide compositor — professional multi-card slides (1/2/3 images per slide).
//
// Each slide pre-renders to a CFR-30 clip: paper-gray background, bold
// headline, and cards that enter ONE BY ONE (staggered directional
// slide+fade). The clip then flows through the normal timeline pipeline
// (holds, xfades, intro Ken Burns) like any other timeline unit.
//
// Pure module: filter-graph math only, no I/O, browser-safe. No rounded
// corners, no drop shadows (rectangles only — see spec).
// ---------------------------------------------------------------------------

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;
export const SLIDE_FPS = 30;
export const SLIDE_BG = "0xF2F1EF"; // warm paper gray (matches reference frames)
// Bold geometric headline font. fontfile= (absolute path) is REQUIRED — a
// bogus fontconfig `font=` name fails SILENTLY (falls back to a default
// face), so never use bare names here.
export const SLIDE_FONT_FILE = "C\\:/Windows/Fonts/arialbd.ttf";

export type SlideEnter = "up" | "down" | "left" | "right" | "none";
export type SlideLayout = 1 | 2 | 3;

export interface SlideSpec {
  /** card count = images.length (1..3); layout is normalized to match */
  images: number[];
  layout: SlideLayout;
  enter: SlideEnter;
  title: string;
  /** visible seconds (animation is time-scaled to fit) */
  duration: number;
}

export interface CardBox { x: number; y: number; w: number; h: number }
export interface SlideGeom {
  cards: CardBox[];
  /** title overlay placement (full-width transparent box overlaid at y) */
  title: { y: number; boxH: number; fontSize: number } | null;
}

// Entrance choreography (seconds, scaled by ts when the slide is short).
export const TITLE_ST = 0;
export const TITLE_D = 0.45;
const TITLE_RISE = 24; // px the headline rises while fading in
const CARD_BASE = 0.35; // first card starts after the title is underway
const CARD_STAGGER = 0.2; // strictly one-by-one: never two cards at once
const CARD_ANIM = 0.55;
const CARD_TRAVEL = 56; // px each card slides along its entrance direction

/** Escape user text for drawtext=text='...' inside filter_complex. */
export function escapeDrawText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/;/g, "\\;")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize a raw spec: clamp count to 1..3, match layout, trim title. */
export function normalizeSlideSpec(raw: any): SlideSpec | null {
  const imgs = Array.isArray(raw?.images) ? raw.images.filter((v: any) => Number.isInteger(v) && v >= 0) : [];
  if (imgs.length === 0) return null;
  const n = Math.min(3, imgs.length);
  const images = imgs.slice(0, n);
  const layout = (n === 1 ? 1 : n === 2 ? 2 : 3) as SlideLayout;
  const enter: SlideEnter =
    raw?.enter === "up" || raw?.enter === "down" || raw?.enter === "left" ||
    raw?.enter === "right" || raw?.enter === "none" ? raw.enter : "up";
  const title = typeof raw?.title === "string" ? raw.title.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const d = Number(raw?.duration);
  const duration = Number.isFinite(d) && d > 0 ? Math.min(d, 30) : 4;
  return { images, layout, enter, title, duration };
}

/**
 * Card + title geometry. Deterministic boxes (content cover-crops into
 * them): 1up hero card centered with headline below; 2up/3up rows centered
 * with headline above. All boxes stay strictly inside 1920x1080.
 */
export function layoutSlide(spec: SlideSpec): SlideGeom {
  const n = spec.images.length;
  const hasTitle = spec.title.length > 0;
  if (n <= 1) {
    if (hasTitle) {
      const w = 860, h = 700;
      return {
        cards: [{ x: Math.round((SLIDE_W - w) / 2), y: 107, w, h }],
        title: { y: 843, boxH: 130, fontSize: 104 },
      };
    }
    const w = 900, h = 760;
    return {
      cards: [{ x: Math.round((SLIDE_W - w) / 2), y: Math.round((SLIDE_H - h) / 2), w, h }],
      title: null,
    };
  }
  if (n === 2) {
    const w = 816, h = 459, y = 340;
    const total = 2 * w + 28;
    const x0 = Math.round((SLIDE_W - total) / 2);
    return {
      cards: [
        { x: x0, y, w, h },
        { x: x0 + w + 28, y, w, h },
      ],
      title: hasTitle ? { y: 120, boxH: 180, fontSize: 88 } : null,
    };
  }
  const w = 534, h = 700, y = 300;
  const total = 3 * w + 2 * 28;
  const x0 = Math.round((SLIDE_W - total) / 2);
  return {
    cards: [
      { x: x0, y, w, h },
      { x: x0 + w + 28, y, w, h },
      { x: x0 + 2 * (w + 28), y, w, h },
    ],
    title: hasTitle ? { y: 100, boxH: 170, fontSize: 88 } : null,
  };
}

export interface SlideTiming {
  /** global time-scale (1 = full choreography fits) */
  ts: number;
  titleD: number;
  cards: { st: number; d: number }[];
}

/** Entrance timing for k cards in a D-second slide (time-scaled to fit). */
export function timingFor(D: number, k: number): SlideTiming {
  const needed = CARD_BASE + Math.max(0, k - 1) * CARD_STAGGER + CARD_ANIM;
  const ts = D >= needed ? 1 : Math.max(D / needed, 0.35);
  return {
    ts,
    titleD: TITLE_D * ts,
    cards: Array.from({ length: k }, (_, i) => ({
      st: (CARD_BASE + i * CARD_STAGGER) * ts,
      d: (CARD_ANIM) * ts,
    })),
  };
}

const f2 = (x: number) => (Math.round(x * 100) / 100).toString();

/**
 * Build the filter_complex body for one slide.
 *
 * Input contract:
 *   [0:v] background color stream, length == totalLen seconds (CFR 30)
 *   [1..k:v] card stills (looped to totalLen by the caller)
 *   [k+1:v] title transparent stream (only when the slide has a title)
 * Output label: [slide] (CFR 30, yuv420p, 1920x1080).
 */
export function buildSlideFilter(
  spec: SlideSpec,
  geom: SlideGeom,
  totalLen: number,
  fontFile: string = SLIDE_FONT_FILE
): { filter: string; inputs: number } {
  const k = spec.images.length;
  const T = timingFor(spec.duration, k);
  const parts: string[] = [];

  for (let i = 0; i < k; i++) {
    const b = geom.cards[i];
    const { st, d } = T.cards[i];
    const fadeD = spec.enter === "none" ? Math.min(0.3, d) : d;
    parts.push(
      `[${i + 1}:v]scale=w=${b.w}:h=${b.h}:force_original_aspect_ratio=increase,` +
      `crop=w=${b.w}:h=${b.h},format=rgba,` +
      `fade=t=in:st=${f2(st)}:d=${f2(fadeD)}:alpha=1,setpts=PTS-STARTPTS[c${i}]`
    );
  }

  let next = k + 1;
  let titleLbl = "";
  if (geom.title && spec.title) {
    const t = geom.title;
    parts.push(
      // Zero alpha FIRST (callers may feed opaque stills): the box must be
      // genuinely transparent — lavfi `color=c=black@0` outputs yuv420p and
      // would render as an opaque black bar. drawtext then inks opaque text.
      `[${next}:v]format=rgba,colorchannelmixer=aa=0,` +
      `drawtext=fontfile='${fontFile}':text='${escapeDrawText(spec.title)}':` +
      `fontsize=${t.fontSize}:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2,` +
      `fade=t=in:st=${f2(TITLE_ST * T.ts)}:d=${f2(T.titleD)}:alpha=1,` +
      `setpts=PTS-STARTPTS[ct]`
    );
    titleLbl = "[ct]";
    next++;
  }

  // Composite in order: title first (under cards), then cards left-to-right.
  // Cards never overlap each other; title zone never overlaps card boxes.
  let cur = "0:v";
  if (titleLbl) {
    const t = geom.title!;
    const rise = `y='${t.y}+${TITLE_RISE}*max(0\\,1-(t-${f2(TITLE_ST * T.ts)})/${f2(T.titleD)})'`;
    parts.push(`[${cur}]${titleLbl}overlay=x=0:${rise}[bT]`);
    cur = "bT";
  }
  for (let i = 0; i < k; i++) {
    const b = geom.cards[i];
    const { st, d } = T.cards[i];
    const prog = `max(0\\,1-(t-${f2(st)})/${f2(d)})`;
    let pos: string;
    switch (spec.enter) {
      case "up": pos = `x=${b.x}:y='${b.y}+${CARD_TRAVEL}*${prog}'`; break; // from bottom, rises
      case "down": pos = `x=${b.x}:y='${b.y}-${CARD_TRAVEL}*${prog}'`; break; // from top, descends
      case "left": pos = `x='${b.x}-${CARD_TRAVEL}*${prog}':y=${b.y}`; break; // from left
      case "right": pos = `x='${b.x}+${CARD_TRAVEL}*${prog}':y=${b.y}`; break; // from right
      default: pos = `x=${b.x}:y=${b.y}`; break;
    }
    parts.push(`[${cur}][c${i}]overlay=${pos}:enable='gte(t\\,${f2(st)})'[b${i}]`);
    cur = `b${i}`;
  }
  parts.push(`[${cur}]format=yuv420p[slide]`);
  return { filter: parts.join(";"), inputs: next };
}
