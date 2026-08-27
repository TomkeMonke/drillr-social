// Background pool: picks images for a post and remembers what it used.
//
// The pool is backgrounds/<category>/, gitignored, filled by
// hand. Two rules do all the work:
//
//   1. Never repeat a background inside one carousel. Seven slides that cycle
//      three wallpapers reads as broken, not as a style.
//   2. Prefer the least-recently-used image, and treat anything used inside
//      cooldownDays as a last resort. TikTok's own feed shows a creator's posts
//      back to back, so the same Pogba shot twice in a week is visible in a way
//      it never is on a website.
//
// Rule 2 degrades instead of failing: if the pool is smaller than the cooldown
// can honour, it still returns the oldest images rather than throwing. A thin
// pool should produce a slightly repetitive post and a warning, not a dead
// scheduler at 6am.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.join(DIR, 'backgrounds');
const LEDGER = path.join(DIR, 'state', 'backgrounds-used.json');

const IMAGE = /\.(jpe?g|png|webp)$/i;

function readLedger() {
  if (!fs.existsSync(LEDGER)) return {};
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
}

function writeLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
}

export function poolDir(category) {
  return path.join(ROOT, category);
}

export function listPool(category) {
  const dir = poolDir(category);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => IMAGE.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Choose `count` images from `category`, least-recently-used first.
 *
 * Returns absolute paths. Does NOT record the use - call `record()` only once
 * the render actually succeeded, so a crashed render does not burn the pool.
 */
export function choose(category, count, cooldownDays = 45) {
  const pool = listPool(category);
  if (pool.length === 0) {
    throw new Error(
      `background pool "${category}" is empty.\n` +
        `  Drop wallpapers into ${poolDir(category)}\n` +
        `  (jpg/png/webp, portrait or larger-than-1080x1920 landscape both work)`
    );
  }

  const ledger = readLedger();
  const cutoff = Date.now() - cooldownDays * 86400_000;

  const ranked = pool
    .map((file) => {
      const entry = ledger[path.basename(file)];
      const lastUsed = entry ? Date.parse(entry.lastUsed) : 0;
      return { file, lastUsed, uses: entry ? entry.uses : 0 };
    })
    // Oldest first; ties broken by total uses so a fresh image always wins.
    .sort((a, b) => a.lastUsed - b.lastUsed || a.uses - b.uses);

  const picked = ranked.slice(0, count);
  const warnings = [];

  if (picked.length < count) {
    warnings.push(
      `pool "${category}" has ${pool.length} image(s) but the post needs ${count} - ` +
        `slides will reuse backgrounds. Add more to ${poolDir(category)}`
    );
  }
  const tooRecent = picked.filter((p) => p.lastUsed > cutoff);
  if (tooRecent.length) {
    warnings.push(
      `${tooRecent.length} background(s) in "${category}" were used inside the ` +
        `${cooldownDays}-day cooldown - the pool is too thin to rotate properly`
    );
  }

  // Cycle rather than throw when the pool is short (rule 2's degrade path).
  const files = [];
  for (let i = 0; i < count; i += 1) files.push(picked[i % picked.length].file);

  return { files, warnings };
}

/** Mark these files as used now. Called after a successful render. */
export function record(files) {
  const ledger = readLedger();
  const now = new Date().toISOString();
  for (const file of new Set(files)) {
    const key = path.basename(file);
    const prev = ledger[key];
    ledger[key] = { lastUsed: now, uses: (prev ? prev.uses : 0) + 1 };
  }
  writeLedger(ledger);
}

export function stats() {
  const ledger = readLedger();
  const categories = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT).filter((n) => fs.statSync(path.join(ROOT, n)).isDirectory())
    : [];
  return categories.map((category) => {
    const pool = listPool(category);
    const used = pool.filter((f) => ledger[path.basename(f)]).length;
    return { category, total: pool.length, used, unused: pool.length - used };
  });
}
