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

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: systemFor(itemCount),
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
