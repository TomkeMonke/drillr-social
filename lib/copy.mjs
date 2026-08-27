// Drafts carousel copy with Claude.
//
// Structured output via a strict tool rather than "reply with JSON": strict
// tool use validates the shape server-side, so the script never has to regex a
// JSON object out of prose or retry a malformed reply. The tool is never
// executed - it exists purely as the schema.
//
// Everything the brand cares about is in SYSTEM below, and it is deliberately
// long. The failure mode for auto-generated marketing copy is not incoherence,
// it is plausible-but-off-brand: the model writes "unlock your potential" and
// six weeks of posts drift away from the one thing Drillr actually sells. The
// house rules are also carried here (no terminal periods, plain hyphens,
// lowercase possessives) because slide text is copy like any other.
//
// Cost is not a reason to downgrade the model. One post is roughly 1.5K input
// and 400 output tokens - a fraction of a cent on claude-opus-5 - and the copy
// IS the product here. Everything else in the pipeline just moves pixels.

import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You write short-form copy for Drillr, a football training app, as
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

const SUBMIT_TOOL = {
  name: 'submit_carousel',
  description: 'Submit one finished carousel draft.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      hook: {
        type: 'string',
        description: 'Slide 1. The scroll-stopper. No terminal period.',
      },
      items: {
        type: 'array',
        description: 'The numbered slides, unnumbered. One habit or mistake each.',
        items: { type: 'string' },
      },
      caption: {
        type: 'string',
        description:
          'Two to four words for the post caption, before the hashtags. Lowercase-ish, casual, no period.',
      },
    },
    required: ['hook', 'items', 'caption'],
    additionalProperties: false,
  },
};

/**
 * Draft `count` carousels.
 *
 * `recentHooks` are fed back in as a do-not-repeat list. Without it the model
 * converges hard - ask for five carousels across five separate calls and you
 * get five variations on "5 things holding you back", which is exactly the
 * drift the queue exists to catch.
 */
export async function draftPosts({ count, itemCount, topic, recentHooks, model, effort }) {
  const client = new Anthropic();

  const avoid = recentHooks.length
    ? `\n\nAlready posted or queued - do not repeat these angles, and do not write a near-synonym of one:\n${recentHooks
        .map((h) => `- ${h}`)
        .join('\n')}`
    : '';

  const ask =
    `Draft ${count} distinct carousel${count === 1 ? '' : 's'}. ` +
    (topic ? `Theme: ${topic}. ` : '') +
    `Call submit_carousel once per carousel - ${count} tool call${count === 1 ? '' : 's'} in total, ` +
    `each with exactly ${itemCount} items. Vary the shape: a mistakes list, a habits list, ` +
    `a signs list and a reasons list all read differently in the feed.${avoid}`;

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM.replace('{{ITEM_COUNT}}', String(itemCount)),
    thinking: { type: 'adaptive' },
    output_config: { effort },
    tools: [SUBMIT_TOOL],
    messages: [{ role: 'user', content: ask }],
  });

  const drafts = response.content
    .filter((block) => block.type === 'tool_use' && block.name === 'submit_carousel')
    .map((block) => block.input);

  if (!drafts.length) {
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    throw new Error(
      `Claude returned no carousels (stop_reason: ${response.stop_reason}).` +
        (text ? `\nIt said: ${text.slice(0, 400)}` : '')
    );
  }

  return drafts.map(normalise);
}

/**
 * Belt and braces on the house rules. The system prompt asks for these and
 * mostly gets them, but "mostly" is not good enough for text that auto-posts:
 * a stray em dash renders as a visible artefact on a 1080px slide, and a
 * terminal period is the single most common drift.
 */
function normalise(draft) {
  const clean = (value) =>
    String(value)
      .replace(/[–—]/g, '-') // en/em dash -> hyphen
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.]+$/, '') // no terminal period on a slide line
      .trim();

  return {
    hook: clean(draft.hook),
    // Strip any numbering the model added anyway - the renderer owns that.
    items: (draft.items || []).map((item) => clean(item).replace(/^\d+[.)]\s*/, '')),
    caption: clean(draft.caption),
  };
}
