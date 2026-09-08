// Drafts carousel copy with Claude.
//
// Structured output via a strict tool rather than "reply with JSON": strict
// tool use validates the shape server-side, so the script never has to regex a
// JSON object out of prose or retry a malformed reply. The tool is never
// executed - it exists purely as the schema.
//
// Everything the brand cares about is in `houserules.mjs`, and it is
// deliberately long. The failure mode for auto-generated marketing copy is not
// incoherence, it is plausible-but-off-brand: the model writes "unlock your
// potential" and six weeks of posts drift away from the one thing Drillr
// actually sells. That file is shared with the manual path, so copy written by
// hand is held to the same rules and cleaned by the same function.
//
// Cost is not a reason to downgrade the model. One post is roughly 1.5K input
// and 400 output tokens - a fraction of a cent on claude-opus-5 - and the copy
// IS the product here. Everything else in the pipeline just moves pixels.

import Anthropic from '@anthropic-ai/sdk';

// The house style and its enforcement are shared with the manual path
// (`brief` + `import`), which must load them without the SDK present.
import { systemFor, buildAsk, normalise } from './houserules.mjs';

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
 * `recentHooks` are fed back in every time. Without them the model converges
 * hard - ask for five carousels across five separate calls and you get five
 * variations on "5 things holding you back", which is exactly the drift the
 * queue exists to catch. Whether they read as context or as a prohibition is
 * `repeatHooks`; see config.copy.repeatHooks.
 *
 * Hooks alone do not stop the items converging - they are one of seven slides,
 * and the one config.copy.repeatHooks lets repeat. A system that fed back the
 * items too, and steered each carousel onto a fresh subject, was built and then
 * removed on 2026-09-08 because it made the copy worse; the note above buildAsk
 * in houserules.mjs says how, and the code is in git at 78d31ba.
 */
export async function draftPosts({ count, itemCount, topic, recentHooks, repeatHooks, model, effort }) {
  const client = new Anthropic();

  // The shared half comes from houserules so it cannot drift from what `brief`
  // prints; only the output-format tail differs between the two paths, and here
  // that tail is the tool call.
  const ask =
    buildAsk({ count, topic, recentHooks, repeatHooks }) +
    `\n\nCall submit_carousel once per carousel - ${count} tool call${count === 1 ? '' : 's'} ` +
    `in total, each with exactly ${itemCount} items.`;

  // max_tokens has to scale with the ask. It was a flat 16000, which is the
  // right default for one response and quietly wrong for a batch: ten carousels
  // is ten tool calls plus adaptive thinking for each, and the run does not
  // fail when it runs out - it just stops early and returns fewer carousels
  // than were asked for, which reads like the model being lazy.
  //
  // Opus 5 allows up to 128000 output tokens, so the ceiling below is the
  // model's, not ours. Streaming is what makes that usable: the SDK needs it
  // for large max_tokens or a long generation trips the HTTP timeout, and a
  // batch of ten is already long enough to matter.
  const stream = client.messages.stream({
    model,
    max_tokens: Math.min(128000, 16000 + count * 2000),
    system: systemFor(itemCount),
    thinking: { type: 'adaptive' },
    output_config: { effort },
    tools: [SUBMIT_TOOL],
    messages: [{ role: 'user', content: ask }],
  });
  const response = await stream.finalMessage();

  const drafts = response.content
    .filter((block) => block.type === 'tool_use' && block.name === 'submit_carousel')
    .map((block) => block.input);

  // Short of the ask rather than empty: the batch hit the output ceiling part
  // way through. Worth saying out loud, because the drafts that DID arrive are
  // fine and get queued - silence here looks like the model ignoring the count.
  if (drafts.length && drafts.length < count) {
    console.log(
      `  ! asked for ${count} but got ${drafts.length} (stop_reason: ${response.stop_reason}) - ` +
        `queueing what arrived. A smaller --count comes back more reliably.`
    );
  }

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
