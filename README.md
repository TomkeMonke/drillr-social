# TikTok carousel pipeline

Generates the 7-slide photo carousels the
[@drillr_app](https://www.tiktok.com/@drillr_app) account posts, and (once
TikTok's audit clears) posts them on a schedule.

Handing this to someone who has not seen it before? Point them at
`TUTORIAL.html` - a self-contained page, opened straight from the folder in any
browser, no server and no hosting anywhere. It walks the whole loop, and covers
the two things that stop every Windows machine before the first command even
runs.

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

node slideshow.mjs fonts        # fetch the fonts
python render.py --font-sample  # compare them -> out/font-sample.png
```

The font is **Archivo Black** - what the reference carousels were set in, and
what `config.json` ships pointing at. The other four are only there so
`--font-sample` has something to hold it against if the look is ever revisited.

Then fill the background pool - see `backgrounds/README.md`. Nothing downloads
images; you choose them, the pipeline rotates them and remembers what it used.
Aim for 20+ in `players/` and 6+ in `stadiums/`.

`ANTHROPIC_API_KEY` in the environment, for `plan` only - and `plan` is
optional. See [Writing the copy without an API key](#writing-the-copy-without-an-api-key).

Check the lot:

```bash
node slideshow.mjs doctor
```

## Matching the reference look

The type is not eyeballed. `render.py --calibrate <folder-of-slides>` measures
outline thickness and line spacing off finished JPEGs and prints them beside
what the renderer is currently doing:

```bash
python render.py --calibrate ~/Downloads/reference-slides
python render.py --calibrate out/<id>          # and the same for fresh output
```

Both numbers are normalised against **stem width**, not line height. Line
height was the obvious choice and it is wrong: a line of text measures shorter
when its words happen to have no descender, so the identical template reads
differently depending on whether the copy says "recovery" or "recover". Stem
width is on every line of every slide.

Against the 32 reference slides the ratios are `outline/stem 0.429` and
`advance/stem 7.714`; Archivo Black's stem is `0.1950em`, which is what turns
those into `STROKE_RATIO` and `LINE_SPACING` at the top of `render.py`. Current
output measures within 1.5% of both.

One thing does not match and cannot: Archivo Black's stems are about 7% heavier
than the reference face relative to line height. That is the font, not the
settings - which is also why `EMBOLDEN_RATIO` is 0 rather than adding faux-bold
on top.

### The promo slide

The app mention carries two overlays, both positioned off the reference promo
slide rather than by eye:

    assets/app-home.jpg        the phone shot, large, low right
    assets/store-listing.jpg   the store card, small, mid left

`cta.overlays` in `config.json` holds them. `xPct`/`yPct` are the CENTRE of each
overlay as a fraction of the frame, later entries paste over earlier ones, and
all of it sits UNDER the text. An overlay may hang off the frame - `render.py`
trims to the visible rectangle instead of refusing, which is how the phone can
bleed past an edge if you move it.

Both assets are stored exactly as supplied, black margins and all. That is what
`radiusPct: 0.115` on the phone is for: it rounds the OUTER rectangle by the
device's own corner radius plus its margin, so the rounding stays concentric
with the screen instead of cutting a second curve inside the first. Re-crop
either file and those numbers stop meaning anything - move the position instead.

### The hook slide renders 5% small

`textScale: 0.95` on the hook, set in `slideshow.mjs`. The hook is the cover, so
TikTok re-crops it for the feed and the profile grid, and type sized to the full
frame loses its first and last words. The scale is applied after wrapping, so
the line breaks someone approved do not move - the text just gets smaller.

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
node slideshow.mjs brief --count 3            # paste this into any assistant you use
#                                             # -> save the JSON reply as drafts.json
node slideshow.mjs import --from drafts.json  # queue the reply
node slideshow.mjs approve all                # same gate as always
```

Paste the brief into whichever assistant you already have open - Claude, ChatGPT,
Gemini, whatever. It carries all of its own context, so nothing depends on which
one, and a free tier is fine.

**`drafts.json` is a file you create.** The repo does not ship one and `import`
will not invent it - `--from drafts.json` on a folder without it just fails with
`ENOENT`. Save the JSON array the assistant replies with to the **repo root**,
next to `slideshow.mjs`:

```
drillr-social/drafts.json
```

The name is only a convention: `--from` takes any path, resolved against the repo
root. The file is not gitignored, so it will show as untracked until you delete it.

`import` also reads stdin, so `... | node slideshow.mjs import` works - that skips
the file entirely. It does not
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

    TUTORIAL.html     the walkthrough to hand to someone new - open in a browser
    slideshow.mjs     the CLI - every verb
    assets/           the two promo-slide overlays
    render.py         Pillow renderer; the whole look lives here
    config.json       template tuning, CTA text, hashtags, TikTok settings
    lib/copy.mjs      Claude drafting + the brand prompt
    lib/queue.mjs     the draft->approved->rendered->posted state machine
    lib/backgrounds.mjs   pool rotation + the used-image ledger
    lib/tiktok.mjs    Content Posting API
    backgrounds/      wallpapers you supply (gitignored)
    state/            queue.json + backgrounds-used.json (committed - this is the memory)
    out/              rendered slides (gitignored)

