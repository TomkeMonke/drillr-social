# TikTok carousel pipeline

Generates the 7-slide photo carousels the
[@drillr_app](https://www.tiktok.com/@drillr_app) account posts, and (once
TikTok's audit clears) posts them on a schedule.

The template is copied from post `7656186846942203169`: 1080x1920, full-bleed
wallpaper, heavy white type with a thick black outline auto-fitted to the frame.
Slide order is

    hook -> 1 -> 2 -> 3 -> 4 -> app mention -> 5

**The app mention is slide 6, not slide 7.** The plug lands while people are
still swiping and the carousel closes on content rather than an ad. That is
`cta.afterItem` in `config.json` - set it to `itemCount` if you ever want the
CTA last instead.

## The shape

    plan  ->  approve  ->  render  ->  publish
    Claude    you        Pillow      TikTok API

Four steps rather than one command, because of the middle one. `approve` is a
human reading the copy before anything is drawn, and the state machine in
`lib/queue.mjs` makes it unskippable: `render` only looks at `approved` posts
and `publish` only looks at `rendered` ones, so an unreviewed draft cannot reach
TikTok even if the cron fires at the wrong moment.

## One-time setup

```bash
npm i --no-save @anthropic-ai/sdk     # only `plan` needs it
pip install Pillow                    # only `render` needs it

node slideshow.mjs fonts        # fetch the candidate fonts
python render.py --font-sample  # compare them -> out/font-sample.png
```

Set `font` in `config.json` to whichever matches best. The reference posts use
TikTok's own built-in font, which is not redistributable, so this picks the
closest Google Font. `Fredoka.ttf` is the current default.

Then fill the background pool - see `backgrounds/README.md`. Nothing downloads
images; you choose them, the pipeline rotates them and remembers what it used.
Aim for 20+ in `players/` and 6+ in `stadiums/`.

`ANTHROPIC_API_KEY` in the environment, for `plan` only - and `plan` is
optional. See [Writing the copy without an API key](#writing-the-copy-without-an-api-key).

Check the lot:

```bash
node slideshow.mjs doctor
```

## The loop

```bash
node slideshow.mjs plan --count 3    # Claude drafts 3 carousels
node slideshow.mjs list              # see the queue
node slideshow.mjs approve all       # the gate
node slideshow.mjs render            # -> out/<id>/01.jpg .. 07.jpg + caption.txt
```

Edit any draft directly in `state/queue.json` before approving - `hook`,
`items`, `cta` and `caption` are all free text. `slideshow.mjs edit <id>` prints
one post if you just want to read it.

Until auto-post is on, upload `out/<id>/` by hand and close the loop so the hook
joins the do-not-repeat list:

```bash
node slideshow.mjs publish <id> --manual
```

`--topic` steers a batch: `plan --count 2 --topic recovery`.

## Writing the copy without an API key

`plan` is the only verb that calls the Anthropic API, and it is the only thing
here that costs money. An API key bills from a **console.anthropic.com** balance,
which is a separate pool from a Claude.ai subscription - a Pro or Max plan grants
no API credit, and usage credits on claude.ai cannot be spent by a key.

So there is a second path that costs nothing. `brief` prints the exact request
`plan` would have sent - same system prompt, same do-not-repeat list, same output
shape - and `import` queues whatever comes back:

```bash
node slideshow.mjs brief --count 3            # paste this into any Claude you already pay for
node slideshow.mjs import --from drafts.json  # queue the reply
node slideshow.mjs approve all                # same gate as always
```

`import` also reads stdin, so `... | node slideshow.mjs import` works. It does not
mind a reply wrapped in prose or a ```` ```json ```` fence - it pulls the array out.
Imported copy goes through the same `normalise` clean-up as `plan` (smart quotes,
em dashes, terminal periods, stray `1.` numbering) plus a lint pass that flags
hype vocabulary, invented statistics, emoji and Americanisms.

Two deliberate limits:

- Everything lands as `draft`, never `approved`. Pasting a model's reply into a
  file is not a human reading the copy - it is the same unreviewed output `plan`
  produces, carried by hand. The gate still has to be walked through.
- The house rules live in `lib/houserules.mjs`, imported by both paths. That file
  has no dependencies on purpose: the free path must not need the SDK installed.
  Change the style there and both paths change together.

## Turning on auto-post

The generator works today. Posting does not, and the blocker is TikTok's, not
ours. In order:

1. **Create the TikTok developer app** and request the `video.publish` scope.
   Photo carousels go through the same scope as video.
2. **Verify a URL prefix.** `PULL_FROM_URL` is the *only* way to supply photos -
   there is no upload endpoint for carousels - and TikTok fetches them from a
   domain you have proven you own. A Firebase Storage or S3 link is rejected
   however public it is, because nobody can verify `googleapis.com`. Verify
   `https://drillr.app/social/` and serve the slides from there.
3. **Host the slides.** `render` writes them locally; something has to put
   `out/<id>/NN.jpg` at `https://drillr.app/social/<id>/NN.jpg` before the post
   fires. Not built yet - the obvious route is a route in drillr-website that
   streams from a bucket.
4. **Pass the audit.** Until then every post lands `SELF_ONLY` no matter what
   you ask for, which is why `config.tiktok.privacyLevel` is pinned to it.
   Asking for `PUBLIC_TO_EVERYONE` before audit fails the request outright.
5. **Set the secrets**: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`,
   `TIKTOK_REFRESH_TOKEN`, and `TIKTOK_TOKEN_PAT` (a PAT with secrets write -
   see below).
6. **Flip `tiktok.enabled` to `true`** in `config.json`.

`.github/workflows/tiktok-carousel.yml` already runs daily at 17:00 UTC. While
`enabled` is false it dry-runs and prints what it would have posted, so the
cron and the queue are proven before real credentials exist.

### Rotating the refresh token

Every refresh returns a **new** refresh token and kills the old one. A job that
refreshes and forgets to persist the new one works exactly once, then locks the
account out - and it fails on the *next* run, not the one that caused it.

`publish --commit` writes the rotated token to `state/.refresh-token`
(gitignored) and the workflow pushes it back into the repo secret with
`gh secret set`. That needs `TIKTOK_TOKEN_PAT`, because `GITHUB_TOKEN` cannot
update secrets. Without the PAT the workflow fails loudly rather than silently
leaving a dead token in place.

## Gotchas

- **Six API requests per minute** per access token. One post is three calls, so
  the ceiling is about two posts a minute. Irrelevant daily, relevant if you
  ever backfill.
- **`init` succeeding is not `posted`.** TikTok downloads the images
  asynchronously; `publish` polls the status once and records it, but a bad
  image URL surfaces there, not at init.
- **Backgrounds are only spent on a successful render.** `record()` runs after
  `render.py` exits 0, so a crashed render does not burn the pool.
- **A thin pool degrades, it does not throw.** Fewer images than slides means
  repeats plus a warning, not a dead scheduler at 5pm.
- **The hook slide has no tighter line cap than the items.** It used to, and the
  autofit made the one slide that has to stop a thumb the *smallest* in the set.
- **Item numbering is assigned before the CTA is spliced in**, so the trailing
  item after the app mention still reads "5." and not "6.".
- **Copyright.** The pipeline never sources images, deliberately. Press
  photography of named players is somebody's copyright, and a bot republishing
  it on a schedule on a commercial account is a different risk from picking one
  by hand - TikTok's own audit reviews the content too. What goes in
  `backgrounds/` is a decision, not a default.

## Files

    slideshow.mjs     the CLI - every verb
    render.py         Pillow renderer; the whole look lives here
    config.json       template tuning, CTA text, hashtags, TikTok settings
    lib/copy.mjs      Claude drafting + the brand prompt
    lib/queue.mjs     the draft->approved->rendered->posted state machine
    lib/backgrounds.mjs   pool rotation + the used-image ledger
    lib/tiktok.mjs    Content Posting API
    backgrounds/      wallpapers you supply (gitignored)
    state/            queue.json + backgrounds-used.json (committed - this is the memory)
    out/              rendered slides (gitignored)

