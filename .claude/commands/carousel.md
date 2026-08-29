---
description: Draft and queue @drillr_app TikTok carousels - no API key, no copy-paste
argument-hint: [count] [--topic <theme>]
allowed-tools: Bash(node slideshow.mjs:*), Bash(rm drafts.json), Read, Write
---

Draft carousels for the Drillr TikTok account and queue them. Arguments: $ARGUMENTS
(first token is the count, default 3; an optional `--topic <theme>` steers the batch).

This is the third drafting path. `plan` bills an Anthropic API key; `brief` +
`import` bounces a prompt off a chat window by hand; this one is you, in the
session that is already open, writing the copy directly into the queue. It costs
nothing extra and there is no clipboard round trip.

## Steps

1. Run `node slideshow.mjs brief --raw --count <N>` (append `--topic <theme>` if
   one was given). That prints the complete brief: the house rules, the real
   corpus of past posts as few-shot examples, the do-not-repeat list of every
   hook already used, and the exact JSON shape.

2. **Follow that brief as if it had been sent to you as a system prompt** - it
   is the same text `plan` sends the API. Do not improvise a different format
   and do not soften the house rules. Pay particular attention to:
   - the two hook formulas (the threat / the proof) - nothing else
   - picking ONE item shape and holding it for the whole carousel
   - the do-not-repeat list, which is the whole reason this is generated fresh
     each time rather than from a static prompt

3. Write the JSON array to `drafts.json` in the repo root. Nothing else may go
   in that file - array in, array out.

4. Run `node slideshow.mjs import --from drafts.json`. It normalises the copy
   (smart quotes, em dashes, terminal periods, stray numbering) and lints it.

5. Read the lint warnings back. If any fired, fix the copy in `drafts.json`,
   delete the bad drafts from `state/queue.json`, and import again rather than
   leaving a warned draft in the queue.

6. `rm drafts.json` once it has imported cleanly.

7. Show the user what got queued and stop. Tell them:
   `node slideshow.mjs go` to review and render, or `approve` then `render`.

## Do not

- **Do not approve anything.** `approve` is a human reading the copy, and you
  wrote the copy - you cannot also be the gate on it. Leave every post in
  `draft`. This is the one rule in the repo that the whole pipeline is built
  around.
- Do not render, publish, or touch `config.json`.
- Do not edit `references/examples.json` to make your drafts look consistent
  with it. That file is a record of what actually ran on the account.
