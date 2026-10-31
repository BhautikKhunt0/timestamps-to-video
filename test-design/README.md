# test-design — Fluxcut Studio (Static Design Mockup)

A **non-functional, four-page** design concept. No logic, no state, no API — just
the look, so you can review the direction before any real code changes.
The production app (`src/`, `index.html`) is untouched.

## The flow — one job per page

| # | Page | Job |
| --- | --- | --- |
| 01 | `index.html` — **Footage** | Import only: oversized drop hero, imported frame grid, soundtrack rows, session/ready-check side panels |
| 02 | `timeline.html` — **Timeline** | Add & time clips: horizontal clip strip with transition markers, millisecond script block, default-duration + runtime + ordering panels |
| 03 | `motion.html` — **Motion** | Transitions only: 4 preview cards (cut / fade / slide L / slide R), per-cut map with diamonds, global duration + rules |
| 04 | `editor.html` — **Editor** | The final, clutter-free page |

Every page has the same **minimal top bar**: the Fluxcut mark, the shared
progress stepper (each step is a link), and on the right a **Previous** button
plus the primary **Continue** button (page 01 shows Continue only — there is no
previous step). No menus, no status pills, no bottom action bar, no status bar —
the page body gets the full height.

## The final Editor page — zero clutter

Everything setup-related lives on pages 01–03. The editor contains only:

- **Program monitor** — 16:9 frame, safe-area guides, scrubber with cut markers, timecode
- **Transport** — timecode, transport buttons, speed, volume, fullscreen
- **Slim timeline** — ruler + V1 clips + A1 waveform + playhead (display only)
- **One right panel: Export** — deliver-as (one film / chapters), container, codec,
  resolution, frame rate, bitrate quality, est. size, toggles, destination,
  a compact progress block, and the export button

No media bin, no transition picker, no timing stats, no inspector sections —
export settings only. The bottom status bar is gone here too; render progress
lives inside the Export panel.

## Design language

- Near-black noir surfaces, hairline borders, inset highlights — depth from borders, not glow
- Ember-orange `#ff5a1f` reserved for progress, selection and active states
- JetBrains Mono for all data/timecodes · Inter for UI · Fraunces for display headings
- Restrained motion: sheen on progress bars, pulse ring on the active step —
  disabled under `prefers-reduced-motion`

## View it

A static server may already be running:

```
http://127.0.0.1:8099/index.html        → 01 Footage
http://127.0.0.1:8099/timeline.html     → 02 Timeline
http://127.0.0.1:8099/motion.html       → 03 Motion
http://127.0.0.1:8099/editor.html       → 04 Editor
```

Or serve it yourself:

```bash
python -m http.server 8099 --directory test-design
```

Best viewed around **1440 × 900** or larger.

## Files

- `index.html`, `timeline.html`, `motion.html`, `editor.html` — the four pages
- `styles.css` — the whole design system (tokens → shared → per-page → editor)
- `README.md` — this file

> **Next step:** once you finalize this direction, the layout can be ported into
> the real React app as routed steps ending in the clean editor.
