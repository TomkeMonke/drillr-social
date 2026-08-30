// The house style, and the one function that enforces it.
//
// This module deliberately has NO npm dependencies. `copy.mjs` needs the
// Anthropic SDK and an API key; the manual path (`brief` -> write the copy
// yourself -> `import`) needs neither, and it only stays free if the rules it
// validates against can be loaded without pulling the SDK in. So the rules live
// here and both paths import them, rather than the manual path re-stating them
// and drifting from what `plan` actually asks for. node:fs is a builtin and
// costs nothing to import - it is only used to read the examples file.
//
// THE PROMPT IS DERIVED FROM THE CORPUS, NOT FROM TASTE. Every claim below
// about what works is a claim about `references/examples.json`, which holds 20
// slides of real posts. If you want to change the voice, change the corpus
// first and let the prompt follow. An earlier version of this file was written
// the other way round - from the brand deck - and it asked for
// position-specific conditioning in every item, which is the one thing the
// account has never posted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLES = path.join(ROOT, 'references', 'examples.json');

/**
 * The few-shot corpus. Missing or malformed is not fatal: the prompt still
 * carries every rule, it just loses the examples. A hard failure here would
 * take down the free path over a data file, which is the wrong trade.
 */
export function loadExamples() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EXAMPLES, 'utf8'));
    return Array.isArray(parsed.examples) ? parsed.examples : [];
  } catch {
    return [];
  }
}

function renderExamples(examples) {
  if (!examples.length) return '';

  const blocks = examples.map((ex) => {
    const lines = [`SHAPE: ${ex.shape}`, `HOOK: ${ex.hook}`];
    ex.items.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    lines.push(`CAPTION: ${ex.caption}`);
    return lines.join('\n');
  });

  return `

THE TARGET VOICE
These are real posts from this account, transcribed off the slides. Match their
rhythm, their register and their length. Do NOT reuse their topics - sleep,
junk food, motivation and comparing yourself have all been done. Note that
their item count may differ from what you have been asked for; the count in
your instructions wins.

${blocks.join('\n\n')}`;
}

export const SYSTEM = `You write short-form copy for Drillr, a football training app, as TikTok photo
carousels for the @drillr_app account.

WHAT DRILLR IS
Drillr gives a footballer a daily physical training plan built for the position
they actually play - stretches, fitness work, recovery and on-pitch drills.
Users never see or interact with each other, so never imply a community, a
leaderboard against friends, or anyone watching.

HOW THIS ACCOUNT ACTUALLY WORKS - read this before the rules
The content slides are BROAD. They are about what decides whether a young
player makes it: sleep, food, motivation, recovery, work ethic, fear, comparing
yourself to everyone else. They are not product content and they are not
position-specific. The app mention is a separate fixed slide spliced into the
middle of the carousel, and that slide does all of the positioning work:

    content slides  ->  reach. Broad, blunt, about the player's own habits
    the app slide   ->  the pitch. Fixed copy, you do not write it

This split is deliberate. A carousel where every item is about position-specific
conditioning is off-voice for this account however on-brand it sounds.

WHO YOU ARE WRITING TO
A 14-22 year old who plays properly - club, academy, decent Sunday league - and
who is quietly scared of not making it. Every carousel that has worked points at
that fear from one of two directions: here is what is stopping you, or here is
what the ones who make it do. Nothing else has landed.

THE ONE COPY RULE
Sell the outcome, never the feature list. Never name the physique out loud and
never describe someone's appearance. A carousel that lists what the app contains
has already failed - and note that the corpus goes further than that: the
content slides do not mention the app at all.

THE HOOK
Slide 1, and the only slide that has to earn the swipe. Two formulas, both
career-stakes, nothing else:

    the threat   5 things that will kill your football career
                 5 reasons you will never go pro in football
                 Small habits that are holding you back from improving
    the proof    5 signs that you will go pro in football

A count plus a career consequence is the whole formula. No tips, no how-tos, no
"here is how to". Aim under 50 characters, never over 80.

THE ITEMS
Exactly {{ITEM_COUNT}} of them. Do NOT number them - the renderer adds "1."
itself. One shape only: a bare habit, no punctuation holding two halves
together. Run them anywhere from 22 to 52 characters and make them differ from
each other - see LENGTH below, which is a hard requirement and not a style note.

    You only train when you feel like it
    You blame everyone else for your mistakes
    Not getting enough sleep
    Comparing yourself to others
    You always play it safe because you're scared

NEVER put a colon in an item. Do not write "<habit>: <what it costs>" and do not
explain the consequence at all - the habit alone is the slide. An earlier
version of this prompt allowed that longer shape and it is gone:

    YES  Not warming up properly
    NO   Not warming up properly: You risk getting an injury

Mixing gerunds ("Eating junk food") with second person ("You skip stretching")
inside one set is fine - the account does it constantly and it reads as voice,
not as sloppiness. That is variety in grammar, not in shape.

Items may be moral and abstract. "You have talent but no work ethic" and "You
always play it safe because you're scared" are real posts and they work. Do not
hunt for a clever concrete scene when the blunt version is truer. The one line
never to cross is the bare TRAIT label - always name a behaviour:
    YES  You only train when you feel like it
    NO   You lack discipline
    YES  You blame everyone else for your mistakes
    NO   You have a bad attitude

LENGTH: VARY IT
The renderer holds every item slide at the same type size until the copy runs
long, so length is a rhythm decision and not a size decision. Measured on the
real template: anything up to about 52 characters renders at exactly the same
size. Past 55 the type starts shrinking, and by 70 it is a quarter smaller.

So anywhere in 22-52 characters costs you nothing, and you must USE that range.
Do not write five items of the same length. Real posts hold a spread of about
14 characters inside a single carousel:

    22, 24, 28, 34, 36     a terse set
    32, 33, 36, 41, 45     a middling set
    37, 38, 44, 49, 51     a long set

Two things follow from that. Inside one carousel, include at least one item
under 28 characters and at least one over 42 - a set where every line is 34-38
reads as filler, because the rhythm never changes. And across carousels, vary
the register: some posts are clipped the whole way through, others run long.
Do not converge on a single house length.

THE LAST ITEM
The app slide is spliced in before the final item, so the carousel ends on
content rather than on an ad. That makes the last item the one people finish on.
Make it the most uncomfortable of the set. Never save the weakest for last.

THE CAPTION
Two to four words for the post text, before the hashtags. Lowercase-ish, casual,
no period. A nudge, not a summary - "sound familiar", "lock in", "fix it",
"be honest". Never restate the hook.

HOUSE RULES (all of these are hard requirements)
- No terminal periods on any slide line. Mid-sentence commas are fine.
- No colons in an item, ever. (The fixed app slide has one; you do not write it.)
- Plain hyphens only. Never an em dash or an en dash.
- Possessive pronouns stay lowercase mid-sentence: "your football career".
- No emoji, no hashtags, no quotation marks in the slide text.
- Never invent a statistic, a percentage, a user count, a testimonial or a
  result. No "join 10,000 players", no "improve 40% faster". If you cannot say
  it without a number you made up, say something else.
- Never promise selection, a scout, a trial, a contract or going pro. Naming
  those as what a player WANTS is the whole point of the hook formulas and is
  fine; promising the app delivers one is not.
- British English (football, not soccer; analyse, not analyze).

TONE
Direct and a bit confrontational, the way a good coach is. Short words. No hype
vocabulary - no "unlock", "unleash", "elevate", "game-changer", "level up",
"grind". Write like someone who has actually played.`;

export function systemFor(itemCount) {
  return SYSTEM.replace(/\{\{ITEM_COUNT\}\}/g, String(itemCount)) + renderExamples(loadExamples());
}

/**
 * The request itself - everything after the system prompt.
 *
 * Shared by both drafting paths on purpose. `plan` sends it as the user turn
 * and `brief` prints it for pasting, and the two used to hold their own copies
 * of this text. That is the drift the whole houserules module exists to stop:
 * the moment the wording diverges, copy written through the API stops matching
 * copy carried by hand and the feed reads like two different accounts.
 *
 * Each path appends its own output-format tail - a tool call for `plan`, a JSON
 * array for `brief` - because that part genuinely does differ.
 *
 * `repeatHooks` decides whether previous hooks are context or a prohibition.
 * See config.copy.repeatHooks.
 */
export function buildAsk({ count, topic, recentHooks = [], repeatHooks = true }) {
  const parts = [
    `Draft ${count} distinct carousel${count === 1 ? '' : 's'}. ` +
      (topic ? `Theme: ${topic}. ` : '') +
      `Vary the shape across the set - a mistakes list, a habits list, a signs ` +
      `list and a reasons list all read differently in the feed.`,
  ];

  if (recentHooks.length) {
    const list = recentHooks.map((h) => `- ${h}`).join('\n');
    parts.push(
      repeatHooks
        ? `\nHooks already used, oldest first. Reusing a strong hook with a different ` +
            `set of items is fine - the account has done exactly that - but prefer a ` +
            `fresh angle where you have one, and never write several variations on the ` +
            `same idea inside one batch:\n${list}`
        : `\nAlready posted or queued - do not repeat these angles, and do not write a ` +
            `near-synonym of one:\n${list}`
    );
  }

  return parts.join('\n');
}

/**
 * Belt and braces on the house rules. The system prompt asks for these and
 * mostly gets them, but "mostly" is not good enough for text that auto-posts:
 * a stray em dash renders as a visible artefact on a 1080px slide, and a
 * terminal period is the single most common drift.
 *
 * Hand-written copy goes through exactly the same clean-up. A human typing in
 * an editor produces smart quotes and em dashes far more readily than the
 * model does, so the manual path needs this more, not less.
 */
export function normalise(draft) {
  return {
    hook: clean(draft.hook),
    // Strip any numbering that came in anyway - the renderer owns that.
    items: (draft.items || []).map((item) => clean(item).replace(/^\d+[.)]\s*/, '')),
    caption: clean(draft.caption),
  };
}

export function clean(value) {
  return String(value ?? '')
    .replace(/[\u2013\u2014]/g, '-') // en/em dash -> hyphen
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '') // no terminal period on a slide line
    .trim();
}

/**
 * What `normalise` cannot fix silently. These are warnings rather than errors
 * because the review gate is a human reading the copy - the tool's job is to
 * point at the line, not to refuse the post and make someone re-run a draft
 * they can fix in ten seconds.
 *
 * The length warnings carry the rendered consequence rather than just the cap,
 * because "72 chars" means nothing and "renders about half the size" is the
 * actual reason to care. See LENGTH in the system prompt.
 */
export function lint(draft, itemCount) {
  const warnings = [];
  const banned = /\b(unlock|unleash|elevate|game-?changer|level up|grind)\b/i;

  if (!draft.hook) warnings.push('hook is empty');
  if (draft.hook && draft.hook.length > 80) {
    warnings.push(`hook is ${draft.hook.length} chars, cap is 80`);
  } else if (draft.hook && draft.hook.length > 60) {
    warnings.push(`hook is ${draft.hook.length} chars - over 60 it starts rendering small on the cover slide`);
  }
  if (draft.items.length !== itemCount) {
    warnings.push(`${draft.items.length} item(s), expected ${itemCount}`);
  }

  for (const [i, item] of draft.items.entries()) {
    if (!item) {
      warnings.push(`item ${i + 1} is empty`);
      continue;
    }
    // Item slides carry the bare habit and nothing else. A colon is the tell
    // for the "<habit>: <what it costs>" shape, which the account used once and
    // which is now out - the consequence half doubles the line length and
    // halves the type. The fixed app slide keeps its own colon; it is not an
    // item and never reaches this function.
    if (item.includes(':')) {
      warnings.push(`item ${i + 1} has a colon - items are the bare habit, no "<habit>: <consequence>"`);
    }
    // Thresholds track where MAX_FONT_PCT stops binding. Under ~52 chars every
    // item renders at the same size, so length is free; past 55 the fitter has
    // to shrink the type and the slide stops matching the rest of the set.
    if (item.length > 70) {
      warnings.push(`item ${i + 1} is ${item.length} chars - renders about a quarter smaller than the rest of the set`);
    } else if (item.length > 55) {
      warnings.push(`item ${i + 1} is ${item.length} chars - past 55 the type shrinks below the other slides`);
    }
  }

  // A set where every line is the same length reads as filler: the rhythm never
  // changes across five slides. The real posts hold a spread of about 14
  // characters, and since anything under 52 renders at the same size, that
  // variation is free. Cheapest possible check for the most common dullness.
  const lengths = draft.items.filter(Boolean).map((i) => i.length);
  if (lengths.length >= 3) {
    const spread = Math.max(...lengths) - Math.min(...lengths);
    if (spread < 10) {
      warnings.push(
        `every item is ${Math.min(...lengths)}-${Math.max(...lengths)} chars (spread ${spread}) - ` +
          `the real posts spread about 14, mix a short one in with a long one`
      );
    }
  }

  for (const line of [draft.hook, ...draft.items]) {
    if (!line) continue;
    if (banned.test(line)) warnings.push(`hype vocabulary in "${line}"`);
    // A digit next to a % or a scale word is the fabricated-stat shape. Plain
    // counts ("5 signs", "the full 90") are fine and must not trip this.
    if (/\d+\s*%|\b\d[\d,]{2,}\+?\s*(players|users|footballers)\b/i.test(line)) {
      warnings.push(`possible invented statistic in "${line}"`);
    }
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line)) warnings.push(`emoji in "${line}"`);
    if (line.includes('#')) warnings.push(`hashtag in slide text: "${line}"`);
    if (/\bsoccer\b/i.test(line)) warnings.push('"soccer" - house style is British English');
    if (/\b(analyze|customize|optimize|program)\b/i.test(line)) {
      warnings.push(`Americanism in "${line}" - house style is British English`);
    }
    // The content slides never mention the app. That is the app slide's job,
    // and an item that plugs it burns a slide people came for content on.
    if (/\b(drillr|the app|download)\b/i.test(line)) {
      warnings.push(`"${line}" mentions the app - the content slides never do, that is the CTA slide's job`);
    }
  }

  return warnings;
}
