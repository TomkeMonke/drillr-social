// The post queue: one JSON file that every verb reads and writes.
//
// A post moves draft -> approved -> rendered -> posted, and each verb only ever
// touches posts in the one state it owns. That is deliberate: the review gate
// (`approve`) is the whole reason the pipeline is not one command, and a state
// machine makes the gate impossible to skip by accident. `publish` refuses to
// look at anything that is not `rendered`, so an unreviewed draft cannot reach
// TikTok even if the cron fires at the wrong moment.
//
// Flat file rather than Firestore because every write happens on this machine,
// one process at a time. The CI job only ever reads posts that were rendered
// and committed here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const QUEUE = path.join(DIR, 'state', 'queue.json');

export const STATES = ['draft', 'approved', 'rendered', 'posted'];

export function load() {
  if (!fs.existsSync(QUEUE)) return { posts: [] };
  return JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
}

export function save(queue) {
  fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
  fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2) + '\n');
}

/** Stable, sortable, readable id. The date prefix makes `ls out/` chronological. */
export function makeId(hook, existing) {
  const slug = hook
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  const date = new Date().toISOString().slice(0, 10);
  let id = `${date}-${slug}`;
  // Two posts drafted the same day on the same theme would otherwise collide
  // and silently overwrite each other's render directory.
  let n = 2;
  const taken = new Set(existing.map((p) => p.id));
  while (taken.has(id)) id = `${date}-${slug}-${n++}`;
  return id;
}

export function byState(queue, state) {
  return queue.posts.filter((p) => p.status === state);
}

export function find(queue, id) {
  return queue.posts.find((p) => p.id === id);
}

/**
 * Resolve the post a verb should act on: an explicit id, or the oldest post in
 * `state`. Oldest-first is what makes the scheduled publish behave like a
 * queue rather than a stack - drafts written today should not jump ahead of a
 * post that has been waiting a week.
 */
export function pick(queue, state, id) {
  if (id) {
    const post = find(queue, id);
    if (!post) throw new Error(`no post with id ${id}`);
    if (post.status !== state) {
      throw new Error(`post ${id} is ${post.status}, expected ${state}`);
    }
    return post;
  }
  const candidates = byState(queue, state);
  return candidates.length ? candidates[0] : null;
}
