// ---------------------------------------------------------------------------
// Image ordering — UPLOAD ORDER IS THE ONLY ORDER.
//
// Filenames must never decide timeline position. Re-sorting the accumulated
// list by name on every add made same-named files from different folders jump
// around (localeCompare returns 0 for identical names, so ties depended on
// sort internals), and adding a late "img.jpg" pushed itself in front of
// earlier "photo.jpg" entries. Users pick images in a sequence — we keep it.
//
// Each picked file gets a monotonic sequence number once, on first sight;
// ordering is a stable sort by that number, so it is deterministic even if
// the array is rebuilt (regrouping into slides, removals, re-adds).
// Pure module: no React, no I/O.
// ---------------------------------------------------------------------------

const seq = new WeakMap<object, number>();
let counter = 0;

/** Stable per-file sequence number, assigned on first sight. */
export function seqOf(file: object): number {
  let v = seq.get(file);
  if (v === undefined) {
    v = counter++;
    seq.set(file, v);
  }
  return v;
}

/**
 * Append files, preserving the order they were picked in.
 * First picked = first rendered, always — regardless of filename, folder or
 * file type.
 */
export function appendInUploadOrder<T extends File | object>(prev: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return prev;
  const all = [...prev, ...incoming];
  all.forEach(seqOf);
  return all.sort((a, b) => seqOf(a) - seqOf(b));
}