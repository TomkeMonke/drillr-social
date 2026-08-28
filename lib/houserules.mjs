// The house style, and the one function that enforces it.
//
// This module deliberately has NO dependencies. `copy.mjs` needs the Anthropic
// SDK and an API key; the manual path (`brief` -> write the copy yourself ->
// `import`) needs neither, and it only stays free if the rules it validates
// against can be loaded without pulling the SDK in. So the rules live here and
// both paths import them, rather than the manual path re-stating them and
// drifting from what `plan` actually asks for.

export const SYSTEM = `You write short-form copy for Drillr, a football training app, as
TikTok photo carousels.

WHAT DRILLR IS
Drillr gives a footballer a daily physical training plan built for the position
they actually play - stretches, fitness work, recovery and on-pitch drills. The
headline is POSITION-SPECIFIC PHYSICAL CONDITIONING, not ball skills or tricks.
Users never see or interact with each other, so never imply a community, a
leaderboard against friends, or anyone watching.

THE ONE COPY RULE
Sell the outcome, never the feature list. The outcome is the body a footballer
needs for their position: lasting the full 90, getting to the ball first,
holding a defender off, recovering by the next fixture. Never name the physique
out loud and never describe someone's appearance. A carousel that lists what
the app contains has already failed.

FORMAT
- hook: the first slide. A scroll-stopping promise, threat or count. Under 60
  characters where you can manage it, never over 80.
- items: exactly {{ITEM_COUNT}} of them. Each is one specific, recognisable
  habit or mistake, written in second person. Under 70 characters each. Do NOT
  number them - the renderer adds "1." itself.
- The items must be things a real 14-22 year old player does, not abstractions.
  "You only train when you feel like it" works. "You lack discipline" does not.

HOUSE RULES (all of these are hard requirements)
- No terminal periods on any slide line. Mid-sentence commas are fine.
- Plain hyphens only. Never an em dash or an en dash.
- Possessive pronouns stay lowercase mid-sentence: "your football career".
- No emoji, no hashtags, no quotation marks in the slide text.
- Never invent a statistic, a percentage, a user count, a testimonial or a
  result. No "join 10,000 players", no "improve 40% faster". If you cannot say
  it without a number you made up, say something else.
- Never promise selection, a scout, a trial, a contract or going pro. You may
  name those as what a player WANTS; never as what the app delivers.
- British English (football, not soccer).

TONE
Direct and a bit confrontational, the way a good coach is. Short words. Second
person. No hype vocabulary - no "unlock", "unleash", "elevate", "game-changer",
"level up", "grind". Write like someone who has actually played.`;

export function systemFor(itemCount) {
  return SYSTEM.replace('{{ITEM_COUNT}}', String(itemCount));
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
 */
export function lint(draft, itemCount) {
  const warnings = [];
  const banned = /\b(unlock|unleash|elevate|game-?changer|level up|grind)\b/i;

  if (!draft.hook) warnings.push('hook is empty');
  if (draft.hook && draft.hook.length > 80) warnings.push(`hook is ${draft.hook.length} chars, cap is 80`);
  if (draft.items.length !== itemCount) {
    warnings.push(`${draft.items.length} item(s), expected ${itemCount}`);
  }

  for (const [i, item] of draft.items.entries()) {
    if (!item) warnings.push(`item ${i + 1} is empty`);
    else if (item.length > 70) warnings.push(`item ${i + 1} is ${item.length} chars, cap is 70`);
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
    if (/\bsoccer\b/i.test(line)) warnings.push(`"soccer" - house style is British English`);
  }

  return warnings;
}
