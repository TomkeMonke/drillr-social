// Has this line been written before?
//
// The prompt can only carry so much history before it stops being pasteable
// into a chat window, and what it carries is the hook list. This runs locally
// against every ITEM the account has ever written, which the prompt cannot
// afford to include, and it costs the brief nothing because it never touches
// the brief - it runs at the review gate, on copy that already exists.
//
// A WARNING, NEVER A REJECTION, exactly like `lint` in houserules.mjs: a
// repeat is sometimes deliberate, and only the person reading the gate can
// tell that from laziness.
//
// This is what survived the angle/worn-word experiment of 2026-09-08 (see
// README, "The repetition problem"). That system tried to fix repetition from
// inside the prompt and made the copy worse; this half never went near the
// prompt, so it stayed.
//
// No npm dependencies, for the same reason houserules.mjs has none: the free
// path has to work without the SDK installed.

// Function words plus the scaffolding this account leans on in every item
// ("you only train when you feel like it"). Without the second half, two
// items match on "you" and "when" and every comparison looks like a repeat.
const STOPWORDS = new Set(
  `a an and are as at be been being but by can cant do does doing dont for from
   get gets getting go goes going had has have how i if in into is it its just
   like me more most much my no not of off on only or our out over own so some
   still than that the their them then there these they this to too up us very
   was we were what when where which who why will with without you your youre
   yours always never every all any even ever thing things way ways make makes
   made take takes put puts keep keeps let lets got give gives lot lots bit
   football`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Crude suffix stripping, deliberately not a real stemmer. It exists so that
 * train/training/trains and stretch/stretching compare equal. Over-merging is
 * cheap here - the output is a warning a human reads - and a dependency is not.
 */
function stem(word) {
  let w = word;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

/** The comparable core of an item: content words, stemmed, order thrown away. */
function fingerprint(line) {
  return new Set(
    String(line ?? '')
      .toLowerCase()
      .replace(/['’]/g, '') // you're -> youre, so the stoplist catches it
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
      .map(stem)
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * The closest previous item over the threshold, or null.
 *
 * 0.6 is loose on purpose. "Not getting enough sleep" against "You are not
 * getting enough sleep" trips it; against "You stay up too late scrolling" it
 * does not, and that second one is a rewrite worth having even though the
 * subject is the same. Tightening this would start flagging good copy.
 */
export function similar(item, history, threshold = 0.6) {
  const target = fingerprint(item);
  if (target.size < 2) return null;

  let best = null;
  for (const previous of history) {
    const score = jaccard(target, fingerprint(previous));
    if (score >= threshold && (!best || score > best.score)) best = { item: previous, score };
  }
  return best;
}

/** Every item the account has ever written, for `similar` to compare against. */
export function allItems(posts) {
  return posts.flatMap((post) => post.items ?? []).filter(Boolean);
}
