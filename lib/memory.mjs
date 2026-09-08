// What the account has already said, compressed enough to fit in a prompt.
//
// THE PROBLEM THIS SOLVES
// The queue is the only record of what has been posted, and the brief used to
// feed back exactly one field from it: the hook. Items - five of the seven
// slides, the entire body of the post - were never fed back at all, so the
// model had no idea it had written "Not getting enough sleep" eleven times.
// Worse, hooks are the one thing config.copy.repeatHooks says may repeat, so
// the prompt spent up to forty lines on the thing nobody is policing and none
// on the thing that actually goes stale.
//
// THE RULE THIS MODULE IS BUILT ON
// The tool remembers everything. The prompt carries only what changed.
//
// Two channels, and the split is the whole trick:
//
//   the prompt channel   expensive, has to stay pasteable into a chat window.
//                        Gets a SIGNAL - a dozen worn words, a handful of
//                        angles - never a transcript.
//   the validator channel  free and unbounded. `similar` reads every item ever
//                        written and warns at the review gate. History never
//                        has to enter the prompt for it to be checked.
//
// So history can grow to a thousand posts and the brief does not grow with it.
// At forty posts the old brief was 210 lines; the compressed one is shorter
// than that while saying strictly more.
//
// NOTHING HERE IS A PROHIBITION. Every signal is phrased as fatigue, not as a
// ban, and the duplicate check warns rather than rejects. Banning a word does
// not make the model write something better, it makes it write around the word
// - "sleep" comes back as "the hours you spend horizontal" and the copy stops
// sounding like a person. Variety comes from giving the model somewhere new to
// go, which is what the angle pool is for; the worn list is only a nudge.
//
// No npm dependencies, for the same reason houserules.mjs has none: the free
// path must work without the SDK installed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as queueLib from './queue.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ANGLES = path.join(ROOT, 'references', 'angles.json');
const ANGLES_USED = path.join(ROOT, 'state', 'angles-used.json');

// Function words plus the scaffolding this account leans on in every item
// ("you only train when you feel like it"). Without the second half the worn
// list comes back as "you, your, when, that" and says nothing.
const STOPWORDS = new Set(
  `a an and are as at be been being but by can cant do does doing dont for from
   get gets getting go goes going had has have how i if in into is it its just
   like me more most much my no not of off on only or our out over own so some
   still than that the their them then there these they this to too up us very
   was we were what when where which who why will with without you your youre
   yours always never every all any even ever thing things way ways make makes
   made take takes put puts keep keeps let lets got give gives lot lots bit
   football`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Crude suffix stripping, deliberately not a real stemmer. It exists to merge
 * train/training/trains and stretch/stretching into one bucket so the worn list
 * does not spend three of its twelve slots on the same idea. Over-merging is
 * cheap here (the output is a soft hint) and a dependency would not be.
 */
function stem(word) {
  let w = word;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

function words(line) {
  return String(line ?? '')
    .toLowerCase()
    .replace(/['\u2019]/g, '') // you're -> youre, so the stoplist catches it
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * The words this account has leaned on, most-used first.
 *
 * Computed from items and captions only, never from hooks. Hook vocabulary is
 * the formula itself - "career", "pro", "signs", "reasons" - and flagging it
 * would be telling the model to stop writing the one hook shape that works.
 *
 * Grouped by stem, displayed as whichever surface form was actually used most,
 * so the line reads as English rather than as stemmer output.
 */
export function wornWords(posts, limit = 12) {
  const groups = new Map();

  for (const post of posts) {
    for (const line of [...(post.items ?? []), post.caption]) {
      for (const word of words(line)) {
        const key = stem(word);
        const group = groups.get(key) ?? { total: 0, forms: new Map() };
        group.total += 1;
        group.forms.set(word, (group.forms.get(word) ?? 0) + 1);
        groups.set(key, group);
      }
    }
  }

  return [...groups.values()]
    .filter((g) => g.total >= 2) // used once is not a habit
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map((g) => [...g.forms.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

/**
 * Hooks as unique lines with a use count, newest last.
 *
 * The old list was `posts.slice(-40).map(p => p.hook)`, which on a real queue
 * is forty lines carrying maybe six distinct facts - the account reuses hooks
 * on purpose, so the same string repeats down the whole block. Collapsing to
 * unique-plus-count is lossless for the model's purposes, shrinks as the
 * account repeats itself, and adds the one thing the flat list threw away:
 * WHICH hooks are worn out.
 */
export function hookHistory(posts, limit = 20) {
  const counts = new Map();
  for (const post of posts) {
    if (!post.hook) continue;
    const key = post.hook.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .slice(-limit) // insertion order is chronological, so this keeps the recent ones
    .map(([hook, uses]) => ({ hook, uses }));
}

/** Captions converge harder than anything else - the corpus is 2/3 "lock in". */
export function captionHistory(posts, limit = 10) {
  const seen = [];
  for (const post of posts) {
    const caption = (post.caption ?? '').trim();
    if (caption && !seen.includes(caption)) seen.push(caption);
  }
  return seen.slice(-limit);
}

// ---------------------------------------------------------------- angles

function loadAngles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ANGLES, 'utf8'));
    return Array.isArray(parsed.angles) ? parsed.angles.filter(Boolean) : [];
  } catch {
    // Same trade houserules makes about its examples file: a missing or broken
    // data file costs the prompt a section, it does not take down the free path.
    return [];
  }
}

function loadUsed() {
  try {
    return JSON.parse(fs.readFileSync(ANGLES_USED, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Draw `count` angles, least-recently-offered first.
 *
 * Offered, not used. An angle is marked the moment it goes into a brief, even
 * if that brief is never pasted anywhere - which sounds wasteful and is not,
 * because this is a rotation and not a budget. A burned angle goes to the back
 * of the queue and comes round again; nothing is ever consumed. Trying to mark
 * them at import time instead would mean asking the model to echo the angle
 * back, which is a new failure mode in exchange for nothing.
 */
export function pickAngles(count) {
  const pool = loadAngles();
  if (!pool.length) return [];

  const used = loadUsed();
  const ranked = [...pool].sort((a, b) => {
    const seenA = used[a] ?? '';
    const seenB = used[b] ?? '';
    if (seenA === seenB) return pool.indexOf(a) - pool.indexOf(b);
    return seenA < seenB ? -1 : 1; // never offered ('') sorts first
  });

  return ranked.slice(0, Math.min(count, pool.length));
}

/** For `doctor`: how big the pool is and how much of it is still untouched. */
export function angleStats() {
  const pool = loadAngles();
  const used = loadUsed();
  return { total: pool.length, fresh: pool.filter((a) => !used[a]).length };
}

export function markAnglesOffered(angles) {
  if (!angles.length) return;
  const used = loadUsed();
  const now = new Date().toISOString();
  for (const angle of angles) used[angle] = now;
  fs.mkdirSync(path.dirname(ANGLES_USED), { recursive: true });
  fs.writeFileSync(ANGLES_USED, JSON.stringify(used, null, 2) + '\n');
}

// ---------------------------------------------------------------- duplicates

/** The comparable core of an item: content words, stemmed, order thrown away. */
function fingerprint(line) {
  return new Set(words(line).map(stem));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Has this item been written before?
 *
 * This is the validator channel: it reads every item the account has ever
 * posted, which the prompt cannot afford to. Returns the closest previous item
 * over the threshold, or null.
 *
 * A WARNING, NEVER A REJECTION. Same reasoning as `lint` in houserules: the
 * gate is a human reading the copy, and only that human can tell a lazy repeat
 * from a deliberate one. 0.6 is loose on purpose - "Not getting enough sleep"
 * against "You are not getting enough sleep" trips it, "Not getting enough
 * sleep" against "You stay up too late scrolling" does not, and the second one
 * is a rewrite worth having even though the subject is the same.
 */
export function similar(item, history, threshold = 0.6) {
  const target = fingerprint(item);
  if (target.size < 2) return null;

  let best = null;
  for (const previous of history) {
    const score = jaccard(target, fingerprint(previous));
    if (score >= threshold && (!best || score > best.score)) best = { item: previous, score };
  }
  return best;
}

/** Every item the account has ever written, for `similar` to compare against. */
export function allItems(posts) {
  return posts.flatMap((post) => post.items ?? []).filter(Boolean);
}

/**
 * Everything the prompt needs to know about the past, in one call.
 *
 * Shared by `plan` and `brief` for the same reason buildAsk is: the two paths
 * used to compute their own history slices, and the moment those drift, copy
 * drafted through the API stops matching copy carried by hand.
 */
export function recall({ count, topic, settings = {} }) {
  const queue = queueLib.load();
  const posts = queue.posts;
  const enabled = settings.enabled === true;

  // OFF is the default, and it is not a degraded mode - it is the ask the
  // account was actually drafted against: the last 40 hooks, flat, as context.
  // See the note above buildAsk in houserules.mjs for what the memory path
  // did to the copy, which is why this is the way round it is.
  if (!enabled) {
    return { enabled: false, hooks: posts.slice(-40).map((p) => p.hook), worn: [], captions: [], angles: [] };
  }

  // A topic on the command line IS the steering. Drawing angles on top of it
  // would just be two instructions fighting.
  const angles = topic || settings.angles === false ? [] : pickAngles(count);

  return {
    enabled: true,
    hooks: hookHistory(posts, settings.hooks ?? 20),
    worn: wornWords(posts, settings.wornWords ?? 12),
    captions: captionHistory(posts),
    angles,
  };
}
