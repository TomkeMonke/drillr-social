// Drillr TikTok carousel pipeline.
//
//   node slideshow.mjs go                  # the whole free loop, one command
//
//   node slideshow.mjs doctor              # is everything wired up
//   node slideshow.mjs fonts               # fetch candidate fonts (one-off)
//   node slideshow.mjs plan --count 3      # Claude drafts 3 carousels (API key)
//   node slideshow.mjs brief --count 3     # copy that same ask to the clipboard (free)
//   node slideshow.mjs brief --raw         # print it bare, for a script to pipe
//   node slideshow.mjs import              # queue the reply from the clipboard (free)
//   node slideshow.mjs import --from x.json  # ... or from a file, or stdin
//   node slideshow.mjs list                # what is in the queue
//   node slideshow.mjs edit <id>           # print one draft for editing
//   node slideshow.mjs approve <id|all>    # the review gate
//   node slideshow.mjs render [id|all]     # approved -> JPGs in out/
//   node slideshow.mjs publish [id]        # rendered -> TikTok (dry run)
//   node slideshow.mjs publish [id] --commit
//
// A post walks draft -> approved -> rendered -> posted and cannot skip a step.
// The gate that matters is `approve`: nothing renders, and therefore nothing
// can be posted, until a human has read the copy. That is the whole reason
// `plan` does not just render.
//
// `go` does NOT weaken that gate. It walks the same state machine and stops on
// every draft to print the copy and wait for a keystroke - the gate moves from
// "run a second command" to "press y", and a set nobody looks at still cannot
// render. Non-interactive shells are refused outright so CI can never drive it.
//
// `plan` is the only verb that calls the API and the only one that costs
// anything. `brief` + `import` are the same step done by hand: `brief` puts the
// exact ask on your clipboard, you paste it into whatever assistant you already
// have, and `import` reads the reply back off the clipboard through the same
// clean-up and the same gate. The pipeline cannot tell the two paths apart
// downstream.
//
// Install (one-off, not saved to package.json, matching the other scripts here):
//   npm i --no-save @anthropic-ai/sdk   # `plan` only - `import` needs nothing
//   pip install Pillow
//
// See README.md for setup and for turning auto-post on.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as queueLib from './lib/queue.mjs';
import * as pool from './lib/backgrounds.mjs';
import * as clipboard from './lib/clipboard.mjs';
// Safe to import at the top level: houserules.mjs has no dependencies, unlike
// copy.mjs, which is loaded lazily inside `plan` so the SDK stays optional.
import { systemFor, normalise, lint } from './lib/houserules.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = DIR; // standalone repo: the tool root IS the repo root
const OUT = path.join(DIR, 'out');
const CONFIG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));

const args = process.argv.slice(2);
const verb = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

// Flags that consume the next argument, so `--topic recovery` does not leave
// "recovery" looking like a post id.
const VALUED = new Set(['count', 'topic', 'from']);
const positional = [];
for (let i = 1; i < args.length; i += 1) {
  if (args[i].startsWith('--')) {
    if (VALUED.has(args[i].slice(2))) i += 1;
    continue;
  }
  positional.push(args[i]);
}

// ---------------------------------------------------------------- fonts

// ArchivoBlack is THE font, not a candidate - it is what the reference
// carousels were set in. The rest stay only so `--font-sample` has something to
// compare against if the look is ever revisited.
const FONT_SOURCES = {
  'ArchivoBlack.ttf': 'Archivo+Black',
  'Nunito.ttf': 'Nunito:wght@900',
  'Baloo2.ttf': 'Baloo+2:wght@800',
  'Fredoka.ttf': 'Fredoka:wght@700',
  'Poppins.ttf': 'Poppins:wght@800',
};

async function fonts() {
  const dir = path.join(DIR, 'fonts');
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, family] of Object.entries(FONT_SOURCES)) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) {
      console.log(`  have ${file}`);
      continue;
    }
    // The CSS endpoint hands back a woff2 for modern UAs; Pillow needs a ttf,
    // and the legacy UA string is what still gets one.
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${family}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64)' },
    }).then((r) => r.text());
    const url = css.match(/https:\/\/[^)]*\.ttf/)?.[0];
    if (!url) {
      console.log(`  ! no ttf for ${family}, skipped`);
      continue;
    }
    const buffer = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()));
    fs.writeFileSync(target, buffer);
    console.log(`  got  ${file}  (${(buffer.length / 1024).toFixed(0)} KB)`);
  }
  console.log('\nCompare them:  python render.py --font-sample');
  console.log('Then set "font" in config.json');
}

// ---------------------------------------------------------------- plan

async function plan() {
  const count = Number(flag('count', '3'));
  const topic = flag('topic');
  const queue = queueLib.load();

  // Feed back everything we have ever written, not just what is pending -
  // a hook that went out in June is exactly the one the model wants to write
  // again in August.
  const recentHooks = queue.posts.slice(-40).map((p) => p.hook);

  const { draftPosts } = await import('./lib/copy.mjs');
  console.log(`Drafting ${count} carousel(s) with ${CONFIG.copy.model}...`);
  const drafts = await draftPosts({
    count,
    itemCount: CONFIG.itemCount,
    topic,
    recentHooks,
    model: CONFIG.copy.model,
    effort: CONFIG.copy.effort,
  });

  // Queued through exactly the same path as the free import, so the API path
  // and the hand-carried one cannot drift - including the lint, which used to
  // run on imported copy only. A house-rule breach is a house-rule breach
  // whoever typed it.
  const queued = queueDrafts(drafts);
  for (const post of queued) {
    console.log('');
    showPost(post);
  }

  console.log(`\n${queued.length} draft(s) queued. Review them, then:`);
  console.log('  node slideshow.mjs approve all');
}

// ---------------------------------------------------------------- list / edit / approve

function list() {
  const queue = queueLib.load();
  if (!queue.posts.length) return console.log('queue is empty - run `go` (free) or `plan` (API key)');
  for (const state of queueLib.STATES) {
    const posts = queueLib.byState(queue, state);
    if (!posts.length) continue;
    console.log(`\n${state.toUpperCase()} (${posts.length})`);
    for (const post of posts) console.log(`  ${post.id}\n    ${post.hook}`);
  }
}

function edit() {
  const queue = queueLib.load();
  const post = queueLib.find(queue, positional[0]);
  if (!post) throw new Error(`no post with id ${positional[0]}`);
  console.log(JSON.stringify(post, null, 2));
  console.log(
    `\nEdit it in ${path.relative(REPO, path.join(DIR, 'state', 'queue.json'))} - hook, items, cta and caption are all free text.`
  );
}

function approve() {
  const queue = queueLib.load();
  const target = positional[0];
  const posts =
    target === 'all' ? queueLib.byState(queue, 'draft') : [queueLib.pick(queue, 'draft', target)].filter(Boolean);

  if (!posts.length) return console.log('nothing in draft');
  for (const post of posts) {
    post.status = 'approved';
    post.approvedAt = new Date().toISOString();
    console.log(`  approved ${post.id}`);
  }
  queueLib.save(queue);
  console.log('\n  node slideshow.mjs render');
}

// ---------------------------------------------------------------- brief / import

/**
 * The free path, half one: print exactly what `plan` would have asked Claude,
 * for pasting into a Claude session you are already paying for.
 *
 * This is a straight lift of the `plan` request - same system prompt, same
 * do-not-repeat list, same shape - because the moment the two drift, copy
 * written by hand stops matching copy written by the API and the feed reads
 * like two different accounts.
 */
function buildBrief({ count, topic }) {
  const queue = queueLib.load();
  const recentHooks = queue.posts.slice(-40).map((p) => p.hook);

  const parts = [systemFor(CONFIG.itemCount), '\n---\n'];

  parts.push(
    `Draft ${count} distinct carousel${count === 1 ? '' : 's'}. ` +
      (topic ? `Theme: ${topic}. ` : '') +
      `Vary the shape across the set - a mistakes list, a habits list, a signs ` +
      `list and a reasons list all read differently in the feed.`
  );

  if (recentHooks.length) {
    parts.push(
      `\nAlready posted or queued - do not repeat these angles, and do not write a near-synonym of one:\n` +
        recentHooks.map((h) => `- ${h}`).join('\n')
    );
  }

  parts.push(
    `\nReply with nothing but a JSON array of ${count} object(s), each exactly:\n` +
      `  { "hook": "...", "items": [${Array.from({ length: CONFIG.itemCount }, () => '"..."').join(', ')}], "caption": "..." }\n` +
      `caption is two to four casual words for the post text, before the hashtags.`
  );

  return parts.join('\n');
}

/**
 * The free path, half one: hand over exactly what `plan` would have asked
 * Claude, for pasting into a session you are already paying for.
 *
 * This is a straight lift of the `plan` request - same system prompt, same
 * do-not-repeat list, same shape - because the moment the two drift, copy
 * written by hand stops matching copy written by the API and the feed reads
 * like two different accounts.
 *
 * It goes to the clipboard rather than only to stdout. Selecting ~120 lines out
 * of a terminal without catching the shell prompt is the single most annoying
 * step in the whole loop, and it is the step someone new hits first.
 */
function brief() {
  const count = Number(flag('count', '3'));
  const topic = flag('topic');
  const text = buildBrief({ count, topic });

  // --raw: the machine contract. Nothing but the prompt on stdout, so a script
  // (or the /carousel slash command) can pipe it straight into an assistant.
  if (has('raw')) {
    process.stdout.write(text + '\n');
    return;
  }

  console.log(text);
  console.log(`\n---\n`);

  const copied = !has('no-copy') && clipboard.write(text);
  if (copied) {
    console.log('^ all of that is now on your CLIPBOARD.');
    console.log('');
    console.log('  1. paste it into any assistant - Claude, ChatGPT, Gemini, a free tier is fine');
    console.log('  2. copy its whole reply');
    console.log('  3. node slideshow.mjs import        (reads your clipboard)');
    console.log('');
    console.log('Or let one command walk you through all of it:  node slideshow.mjs go');
    return;
  }

  console.log('Paste everything above into any assistant you already use - Claude,');
  console.log('ChatGPT, Gemini, whichever. The brief carries all of its own context,');
  console.log('so nothing depends on which one, and a free tier is fine.');
  console.log('');
  console.log('Then feed the reply back in any of these ways:');
  console.log('  node slideshow.mjs import                      (clipboard)');
  console.log('  node slideshow.mjs import --from drafts.json   (a file you create)');
  console.log('  ... | node slideshow.mjs import                (stdin)');
}

/**
 * The free path, half two: queue drafts that came from anywhere.
 *
 * Everything lands as `draft`, never `approved`. The point of the gate is that
 * a human has read the copy in the queue, and pasting a model's reply into a
 * file is not that - it is the same unreviewed output `plan` produces, just
 * carried by hand. Skipping ahead here would quietly remove the one control
 * the whole pipeline is built around.
 */
/**
 * Where the reply is coming from. Order matters:
 *
 *   --from <file>   explicit, always wins
 *   --paste         explicit clipboard
 *   piped stdin     a script or a shell pipeline
 *   clipboard       the interactive default, because it is what someone who
 *                   just copied a reply out of a chat window actually wants
 *
 * The old default was a bare `readFileSync(0)`, which blocks forever on an
 * interactive terminal with no pipe - the tool looked hung when it was waiting
 * for a stdin that was never coming.
 */
function readDraftSource() {
  const from = flag('from');
  if (from) {
    const resolved = path.resolve(REPO, from);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `no such file: ${resolved}\n` +
          `  Nothing ships a drafts.json - you create it, or skip the file entirely:\n` +
          `    node slideshow.mjs import          (reads your clipboard)`
      );
    }
    return { raw: fs.readFileSync(resolved, 'utf8'), source: path.relative(REPO, resolved) };
  }

  if (!has('paste') && !process.stdin.isTTY) {
    return { raw: fs.readFileSync(0, 'utf8'), source: 'stdin' };
  }

  const text = clipboard.read();
  if (text === null) {
    throw new Error(
      'no clipboard available on this machine - pass --from <file> or pipe the JSON in'
    );
  }
  return { raw: text, source: 'clipboard' };
}

function parseDrafts(raw, source = 'input') {
  if (!raw.trim()) {
    // Naming the source matters more than it looks. stdin wins over the
    // clipboard whenever there is no TTY, so anything that wraps this tool -
    // CI, a task runner, another agent - silently takes the stdin branch. An
    // error that says "the clipboard is empty" while it is actually reading an
    // empty pipe sends you looking in entirely the wrong place.
    throw new Error(
      `nothing to import - ${source} was empty.` +
        (source === 'stdin'
          ? '\n  Nothing was piped in. To read your clipboard instead:\n    node slideshow.mjs import --paste'
          : '\n  Copy the assistant reply first, then run this again.')
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A pasted reply often arrives wrapped in prose or a ```json fence. Pull
    // the outermost array out rather than making someone hand-trim the file.
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error(
        'could not find JSON in that input.\n' +
          '  Expected an array like [{ "hook": "...", "items": [...], "caption": "..." }]\n' +
          `  Got instead: ${raw.trim().slice(0, 120)}${raw.trim().length > 120 ? '...' : ''}`
      );
    }
    return JSON.parse(match[0]);
  }
}

/**
 * Queue drafts from anywhere. Shared by `import` and `go`.
 *
 * Everything lands as `draft`, never `approved`. The point of the gate is that
 * a human has read the copy in the queue, and pasting a model's reply into a
 * file is not that - it is the same unreviewed output `plan` produces, just
 * carried by hand. Skipping ahead here would quietly remove the one control
 * the whole pipeline is built around.
 */
function queueDrafts(parsed) {
  const incoming = Array.isArray(parsed) ? parsed : parsed.posts || [parsed];
  const queue = queueLib.load();
  const seen = new Set(queue.posts.map((p) => p.hook.toLowerCase()));
  const queued = [];

  for (const entry of incoming) {
    const draft = normalise(entry);
    if (!draft.hook) {
      console.log('  ! skipped an entry with no hook');
      continue;
    }
    if (seen.has(draft.hook.toLowerCase())) {
      console.log(`  ! skipped "${draft.hook}" - that hook is already in the queue`);
      continue;
    }

    const post = {
      id: queueLib.makeId(draft.hook, queue.posts),
      status: 'draft',
      createdAt: new Date().toISOString(),
      hook: draft.hook,
      items: draft.items,
      cta: CONFIG.cta.text,
      caption: draft.caption || CONFIG.caption.lead,
    };
    queue.posts.push(post);
    seen.add(draft.hook.toLowerCase());
    queued.push(post);
  }

  if (queued.length) queueLib.save(queue);
  return queued;
}

/** Print one post the way the review gate wants to read it. */
function showPost(post, indent = '  ') {
  console.log(`${indent}${post.id}`);
  console.log(`${indent}  ${post.hook}`);
  post.items.forEach((item, i) => console.log(`${indent}  ${i + 1}. ${item}`));
  console.log(`${indent}  caption: ${post.caption}`);
  for (const warning of lint(post, CONFIG.itemCount)) console.log(`${indent}  ! ${warning}`);
}

function importDrafts() {
  const { raw, source } = readDraftSource();
  const queued = queueDrafts(parseDrafts(raw, source));

  if (!queued.length) return console.log('\nnothing queued');
  console.log(`\nread from ${source}`);
  for (const post of queued) {
    console.log('');
    showPost(post);
  }
  console.log(`\n${queued.length} draft(s) queued. Review them, then:`);
  console.log('  node slideshow.mjs approve all');
}

// ---------------------------------------------------------------- render

function renderPost(queue, post) {
  const slideCount = 1 + post.items.length; // hook + items (the CTA takes the stadium)
  const players = pool.choose(CONFIG.backgrounds.player, slideCount, CONFIG.backgrounds.cooldownDays);
  const stadiums = pool.choose(CONFIG.backgrounds.stadium, 1, CONFIG.backgrounds.cooldownDays);
  for (const warning of [...players.warnings, ...stadiums.warnings]) console.log(`  ! ${warning}`);

  // Resolved here rather than in render.py so a missing file is one warning at
  // the top of the run, not a surprise on the sixth image.
  const ctaOverlays = (CONFIG.cta.overlays ?? []).map((o) => ({
    ...o,
    path: path.resolve(REPO, o.path),
  }));
  for (const overlay of ctaOverlays) {
    if (!fs.existsSync(overlay.path)) {
      console.log(`  ! CTA overlay missing: ${path.relative(REPO, overlay.path)} - the CTA slide will render without it`);
    }
  }

  // No tighter line cap on the hook than on the items. Capping it at 3 lines
  // makes the autofit shrink it BELOW the item slides, which inverts the
  // hierarchy - the one slide that has to stop a thumb ends up the smallest.
  // textScale: the hook is the slide TikTok is most likely to crop into - it is
  // the cover, so it gets shown at other aspect ratios in the feed and on a
  // profile grid. 5% of headroom costs nothing and stops the first and last
  // words losing their edges.
  const hookSlide = {
    text: post.hook,
    background: players.files[0],
    layout: 'center',
    textScale: 0.95,
  };

  const itemSlides = post.items.map((item, i) => ({
    text: `${i + 1}. ${item}`,
    background: players.files[i + 1],
    layout: 'center',
  }));

  const ctaSlide = {
    text: post.cta,
    background: stadiums.files[0],
    layout: 'top',
    maxLines: 5,
    overlays: ctaOverlays,
  };

  // The app mention is NOT last. It goes after `cta.afterItem` items, so the
  // carousel ends on content and the plug lands mid-swipe - that is how the
  // reference posts are built, and it is the whole reason this is a splice and
  // not an append. Numbering is assigned before the splice, so the trailing
  // item keeps its real number.
  const at = Math.max(0, Math.min(CONFIG.cta.afterItem ?? itemSlides.length, itemSlides.length));
  const slides = [hookSlide, ...itemSlides.slice(0, at), ctaSlide, ...itemSlides.slice(at)];

  const outDir = path.join(OUT, post.id);
  const specPath = path.join(outDir, 'spec.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    specPath,
    JSON.stringify({ outDir, width: CONFIG.width, height: CONFIG.height, font: CONFIG.font, slides }, null, 2)
  );

  console.log(`Rendering ${post.id}`);
  const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [path.join(DIR, 'render.py'), specPath], {
    stdio: 'inherit',
  });
  if (python.status !== 0) throw new Error('render.py failed - see output above');

  // Caption file sits beside the slides so the manual upload is copy-paste.
  const caption = `${post.caption} ${CONFIG.caption.hashtags.map((h) => `#${h}`).join(' ')}`;
  fs.writeFileSync(path.join(outDir, 'caption.txt'), caption + '\n');

  // Only now, once the render actually succeeded, do the backgrounds count as
  // spent. A crashed render must not burn the pool.
  pool.record([...players.files, ...stadiums.files]);

  post.status = 'rendered';
  post.renderedAt = new Date().toISOString();
  post.outDir = path.relative(REPO, outDir);
  post.caption_full = caption;
  post.backgrounds = [...players.files, ...stadiums.files].map((f) => path.basename(f));
  queueLib.save(queue);

  console.log(`\n  ${slides.length} slides -> ${post.outDir}`);
  console.log(`  caption: ${caption}`);
  console.log('\nUpload those by hand, then mark it done:');
  console.log(`  node slideshow.mjs publish ${post.id} --manual`);
}

function render() {
  const queue = queueLib.load();
  const target = positional[0];
  const posts =
    target === 'all'
      ? queueLib.byState(queue, 'approved')
      : [queueLib.pick(queue, 'approved', target)].filter(Boolean);

  if (!posts.length) return console.log('nothing approved - run `approve` first');
  for (const post of posts) renderPost(queue, post);
}

// ---------------------------------------------------------------- publish

async function publish() {
  const queue = queueLib.load();
  const post = queueLib.pick(queue, 'rendered', positional[0]);
  if (!post) return console.log('nothing rendered - run `render` first');

  // --manual: you uploaded it yourself, this just closes the loop so the post
  // stops showing up as pending and its hook joins the do-not-repeat list.
  if (has('manual')) {
    post.status = 'posted';
    post.postedAt = new Date().toISOString();
    post.postedVia = 'manual';
    queueLib.save(queue);
    return console.log(`  marked ${post.id} posted (manual)`);
  }

  const tk = CONFIG.tiktok;
  const slides = fs
    .readdirSync(path.join(REPO, post.outDir))
    .filter((f) => /^\d+\.jpg$/.test(f))
    .sort();
  const urls = slides.map((f) => `${tk.urlPrefix}${post.id}/${f}`);

  if (!tk.enabled || !has('commit')) {
    console.log(`DRY RUN - ${post.id}`);
    console.log(`  caption: ${post.caption_full}`);
    console.log(`  ${urls.length} images:`);
    urls.forEach((u) => console.log(`    ${u}`));
    console.log(
      `\n  tiktok.enabled=${tk.enabled}  --commit=${has('commit')}` +
        '\n  Both must be true to post. See README "Turning on auto-post".'
    );
    return;
  }

  const { refreshAccessToken, creatorInfo, postCarousel, publishStatus } = await import('./lib/tiktok.mjs');
  const need = ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REFRESH_TOKEN'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);

  const auth = await refreshAccessToken({
    clientKey: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    refreshToken: process.env.TIKTOK_REFRESH_TOKEN,
  });
  // TikTok rotates the refresh token on every refresh and invalidates the old
  // one, so a run that forgets to persist this succeeds now and locks the
  // account out on the NEXT run - the hardest kind of failure to trace back.
  // Written to a file as well as stdout so the workflow can push it straight
  // back into the repo secret without anyone reading a log.
  const tokenFile = path.join(DIR, 'state', '.refresh-token');
  fs.writeFileSync(tokenFile, auth.refreshToken);
  console.log('\n  ROTATED REFRESH TOKEN - the old one is now dead.');
  console.log(`  Written to ${path.relative(REPO, tokenFile)}; update TIKTOK_REFRESH_TOKEN from it.\n`);

  const info = await creatorInfo(auth.accessToken);
  console.log(`  posting as @${info.creator_username} (${info.privacy_level_options?.join(', ')})`);

  const publishId = await postCarousel({
    token: auth.accessToken,
    title: post.caption_full,
    photoUrls: urls,
    config: tk,
  });
  const status = await publishStatus({ token: auth.accessToken, publishId });

  post.status = 'posted';
  post.postedAt = new Date().toISOString();
  post.postedVia = 'api';
  post.publishId = publishId;
  queueLib.save(queue);
  console.log(`  posted ${post.id}  publish_id=${publishId}  status=${status.status}`);
}

// ---------------------------------------------------------------- go

/** Blocking problems only - the things that make a render impossible. */
function preflight() {
  const problems = [];

  if (!fs.existsSync(path.join(DIR, 'fonts', CONFIG.font))) {
    problems.push(`font ${CONFIG.font} missing - run: node slideshow.mjs fonts`);
  }
  const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import PIL'], {
    stdio: 'ignore',
  });
  if (python.status !== 0) problems.push('Pillow missing - run: pip install Pillow');

  for (const key of ['player', 'stadium']) {
    const category = CONFIG.backgrounds[key];
    if (!pool.listPool(category).length) {
      problems.push(`backgrounds/${category} is empty - drop wallpapers into ${path.relative(REPO, pool.poolDir(category))}`);
    }
  }
  return problems;
}

/**
 * The whole free loop in one command.
 *
 * This does NOT weaken the review gate. It walks the same state machine every
 * other verb does and stops on each draft to print the copy and wait for a
 * keystroke - the gate moves from "run a second command" to "press y", which
 * is the same human reading the same words. What it removes is the four-verb
 * ceremony and the drafts.json round trip, not the reading.
 *
 * Interactive only, on purpose. A non-TTY caller is refused rather than
 * defaulted, so no cron or CI job can ever end up auto-approving by inheriting
 * a pipe.
 */
async function go() {
  if (!process.stdin.isTTY) {
    throw new Error(
      '`go` needs a real terminal - it is the interactive path and will not auto-approve.\n' +
        '  In a script: node slideshow.mjs brief --raw   ->  import  ->  approve  ->  render'
    );
  }

  const problems = preflight();
  if (problems.length) {
    console.log('Cannot render yet:\n');
    for (const problem of problems) console.log(`  ! ${problem}`);
    console.log('\nFull check: node slideshow.mjs doctor');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question) => (await rl.question(question)).trim().toLowerCase();

  try {
    let queue = queueLib.load();
    let drafts = queueLib.byState(queue, 'draft');

    if (drafts.length) {
      console.log(`${drafts.length} draft(s) already waiting - reviewing those.`);
      console.log('(to draft more first, empty the queue or use `brief` + `import`)\n');
    } else {
      const count = Number(flag('count', '3'));
      const topic = flag('topic');
      const text = buildBrief({ count, topic });

      if (clipboard.write(text)) {
        console.log(`Brief for ${count} carousel(s) is on your CLIPBOARD.\n`);
      } else {
        console.log(text);
        console.log('\n---\n(could not reach the clipboard, so the brief is printed above)\n');
      }
      console.log('  1. paste it into any assistant - Claude, ChatGPT, Gemini, a free tier is fine');
      console.log('  2. copy its whole reply');
      console.log('  3. come back here\n');

      await rl.question('press Enter once the reply is copied...');

      const raw = clipboard.read();
      if (raw !== null && raw.trim() === text.trim()) {
        throw new Error('the clipboard still holds the brief - copy the assistant REPLY, then run `go` again');
      }
      if (raw === null || !raw.trim()) {
        throw new Error('clipboard is empty - copy the assistant reply, then run `go` again');
      }

      const queued = queueDrafts(parseDrafts(raw, 'clipboard'));
      if (!queued.length) throw new Error('nothing new to queue - every hook in that reply is already in the queue');
      console.log(`\n${queued.length} draft(s) queued.\n`);

      queue = queueLib.load();
      drafts = queueLib.byState(queue, 'draft');
    }

    console.log('Review. Nothing renders until you say so.\n');
    const approved = [];
    for (const post of drafts) {
      console.log('');
      showPost(post);
      const answer = await ask('\n  approve?  [y]es   [Enter] skip   [q]uit: ');
      if (answer === 'q') break;
      if (answer !== 'y' && answer !== 'yes') {
        console.log('  left as a draft');
        continue;
      }
      post.status = 'approved';
      post.approvedAt = new Date().toISOString();
      approved.push(post);
      console.log('  approved');
    }
    queueLib.save(queue);

    if (!approved.length) {
      console.log('\nNothing approved. The drafts are still in the queue - `go` again when you want them.');
      return;
    }

    console.log(`\nRendering ${approved.length} post(s)...\n`);
    for (const post of approved) renderPost(queue, post);

    console.log('\nDone. Upload each out/<id>/ folder, then close the loop so the hooks');
    console.log('join the do-not-repeat list:');
    for (const post of approved) console.log(`  node slideshow.mjs publish ${post.id} --manual`);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- doctor

function doctor() {
  let bad = 0;
  const ok = (label, good, hint) => {
    console.log(`  ${good ? 'ok  ' : 'MISS'} ${label}${good || !hint ? '' : `\n         ${hint}`}`);
    if (!good) bad += 1;
  };

  const fontPath = path.join(DIR, 'fonts', CONFIG.font);
  ok(`font ${CONFIG.font}`, fs.existsSync(fontPath), 'node slideshow.mjs fonts');

  const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import PIL'], {
    stdio: 'ignore',
  });
  ok('Pillow', python.status === 0, 'pip install Pillow');

  // Not counted as a failure: `plan` is the only verb that needs a key, and
  // `brief` + `import` do the same job without one. Reporting this as MISS
  // would say the pipeline is broken when it is merely on the free path.
  console.log(
    process.env.ANTHROPIC_API_KEY
      ? '  ok   ANTHROPIC_API_KEY - `plan` will work'
      : '  --   ANTHROPIC_API_KEY unset - use `brief` + `import` (free), or setx ANTHROPIC_API_KEY ...'
  );

  for (const stat of pool.stats()) {
    ok(
      `backgrounds/${stat.category}: ${stat.total} image(s), ${stat.unused} unused`,
      stat.total > 0,
      `drop wallpapers into ${path.relative(REPO, pool.poolDir(stat.category))}`
    );
  }
  for (const key of ['player', 'stadium']) {
    const dir = pool.poolDir(CONFIG.backgrounds[key]);
    if (!fs.existsSync(dir)) ok(`backgrounds/${CONFIG.backgrounds[key]} exists`, false, `mkdir ${path.relative(REPO, dir)}`);
  }

  for (const overlay of CONFIG.cta.overlays ?? []) {
    ok(`CTA overlay ${overlay.path}`, fs.existsSync(path.resolve(REPO, overlay.path)));
  }

  console.log(`\n  auto-post: ${CONFIG.tiktok.enabled ? 'ENABLED' : 'off (config.tiktok.enabled=false)'}`);
  const queue = queueLib.load();
  console.log(
    `  queue: ${queueLib.STATES.map((s) => `${queueLib.byState(queue, s).length} ${s}`).join(', ')}`
  );
  console.log(bad ? `\n${bad} thing(s) to fix before this runs.` : '\nReady.');
}

// ---------------------------------------------------------------- main

const VERBS = { go, fonts, plan, brief, import: importDrafts, list, edit, approve, render, publish, doctor };

if (!verb || !VERBS[verb]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n\n')[0]);
  process.exit(verb ? 1 : 0);
}

try {
  await VERBS[verb]();
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}
