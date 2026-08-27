// Drillr TikTok carousel pipeline.
//
//   node slideshow.mjs doctor              # is everything wired up
//   node slideshow.mjs fonts               # fetch candidate fonts (one-off)
//   node slideshow.mjs plan --count 3      # Claude drafts 3 carousels
//   node slideshow.mjs list                # what is in the queue
//   node slideshow.mjs edit <id>           # print one draft for editing
//   node slideshow.mjs approve <id|all>    # the review gate
//   node slideshow.mjs render [id]         # approved -> JPGs in out/
//   node slideshow.mjs publish [id]        # rendered -> TikTok (dry run)
//   node slideshow.mjs publish [id] --commit
//
// A post walks draft -> approved -> rendered -> posted and cannot skip a step.
// The gate that matters is `approve`: nothing renders, and therefore nothing
// can be posted, until a human has read the copy. That is the whole reason
// `plan` does not just render.
//
// Install (one-off, not saved to package.json, matching the other scripts here):
//   npm i --no-save @anthropic-ai/sdk
//   pip install Pillow
//
// See README.md for setup and for turning auto-post on.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as queueLib from './lib/queue.mjs';
import * as pool from './lib/backgrounds.mjs';

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
const VALUED = new Set(['count', 'topic']);
const positional = [];
for (let i = 1; i < args.length; i += 1) {
  if (args[i].startsWith('--')) {
    if (VALUED.has(args[i].slice(2))) i += 1;
    continue;
  }
  positional.push(args[i]);
}

// ---------------------------------------------------------------- fonts

const FONT_SOURCES = {
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

  for (const draft of drafts) {
    if (draft.items.length !== CONFIG.itemCount) {
      console.log(
        `  ! "${draft.hook}" came back with ${draft.items.length} items, expected ${CONFIG.itemCount} - queued anyway, fix it in review`
      );
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
    console.log(`\n  ${post.id}`);
    console.log(`    ${post.hook}`);
    post.items.forEach((item, i) => console.log(`    ${i + 1}. ${item}`));
  }

  queueLib.save(queue);
  console.log(`\n${drafts.length} draft(s) queued. Review them, then:`);
  console.log('  node slideshow.mjs approve all');
}

// ---------------------------------------------------------------- list / edit / approve

function list() {
  const queue = queueLib.load();
  if (!queue.posts.length) return console.log('queue is empty - run `plan`');
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

// ---------------------------------------------------------------- render

function render() {
  const queue = queueLib.load();
  const post = queueLib.pick(queue, 'approved', positional[0]);
  if (!post) return console.log('nothing approved - run `approve` first');

  const slideCount = 1 + post.items.length; // hook + items (the CTA takes the stadium)
  const players = pool.choose(CONFIG.backgrounds.player, slideCount, CONFIG.backgrounds.cooldownDays);
  const stadiums = pool.choose(CONFIG.backgrounds.stadium, 1, CONFIG.backgrounds.cooldownDays);
  for (const warning of [...players.warnings, ...stadiums.warnings]) console.log(`  ! ${warning}`);

  const overlayPath = path.resolve(REPO, CONFIG.cta.overlay.path);
  if (!fs.existsSync(overlayPath)) {
    console.log(`  ! CTA overlay missing: ${CONFIG.cta.overlay.path} - the CTA slide will render without the app shot`);
  }

  // No tighter line cap on the hook than on the items. Capping it at 3 lines
  // makes the autofit shrink it BELOW the item slides, which inverts the
  // hierarchy - the one slide that has to stop a thumb ends up the smallest.
  const hookSlide = { text: post.hook, background: players.files[0], layout: 'center' };

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
    overlays: [{ ...CONFIG.cta.overlay, path: overlayPath }],
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

  ok('ANTHROPIC_API_KEY (needed by `plan` only)', Boolean(process.env.ANTHROPIC_API_KEY), 'setx ANTHROPIC_API_KEY ...');

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

  ok(`CTA overlay ${CONFIG.cta.overlay.path}`, fs.existsSync(path.resolve(REPO, CONFIG.cta.overlay.path)));

  console.log(`\n  auto-post: ${CONFIG.tiktok.enabled ? 'ENABLED' : 'off (config.tiktok.enabled=false)'}`);
  const queue = queueLib.load();
  console.log(
    `  queue: ${queueLib.STATES.map((s) => `${queueLib.byState(queue, s).length} ${s}`).join(', ')}`
  );
  console.log(bad ? `\n${bad} thing(s) to fix before this runs.` : '\nReady.');
}

// ---------------------------------------------------------------- main

const VERBS = { fonts, plan, list, edit, approve, render, publish, doctor };

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
