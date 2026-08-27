// TikTok Content Posting API - photo carousel direct post.
//
// Verified against developers.tiktok.com (2026-08-27). The four things that
// bite, in the order they bite:
//
//  1. PULL_FROM_URL ONLY. There is no upload path for photos - TikTok fetches
//     each image from a URL you give it, and that URL must sit under a prefix
//     you have verified in the developer portal. A Firebase Storage or S3 link
//     is rejected no matter how public it is, because you cannot prove you own
//     googleapis.com. This is why `stage` pushes slides to drillr.app.
//
//  2. UNAUDITED CLIENTS POST PRIVATELY. Until the app passes TikTok's audit,
//     every post lands as SELF_ONLY regardless of what you ask for. That is not
//     a bug to work around; it is the sandbox. Asking for PUBLIC_TO_EVERYONE
//     before audit fails the request outright, so config pins SELF_ONLY.
//
//  3. ACCESS TOKENS LIVE 24 HOURS AND REFRESH TOKENS ROTATE. Every refresh
//     returns a NEW refresh token and invalidates the old one. A cron job that
//     refreshes and forgets to persist the new token works exactly once and
//     then locks itself out. `refreshAccessToken` returns the new token and the
//     caller MUST store it - see README 'Rotating the refresh token'.
//
//  4. SIX REQUESTS PER MINUTE per access token. One post is 3 calls
//     (creator_info, init, status), so the practical ceiling is ~2 posts/min.
//     Not a constraint at one post a day; it is a constraint if you ever
//     backfill.
//
// Nothing here runs unless config.tiktok.enabled is true AND --commit is
// passed. Both gates on purpose: the flag is the standing setting, --commit is
// the per-run intent, and the scheduled job supplies only one of them.

const API = 'https://open.tiktokapis.com/v2';
const OAUTH = 'https://open.tiktokapis.com/v2/oauth/token/';

async function call(url, { token, body, form }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: form
      ? { 'Content-Type': 'application/x-www-form-urlencoded' }
      : {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
    body: form ? new URLSearchParams(form).toString() : JSON.stringify(body),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`TikTok ${url} returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
  }

  // TikTok answers 200 with an error object rather than an HTTP error code for
  // most failures, so the status line alone is not a success check.
  const err = json.error;
  if (err && err.code && err.code !== 'ok') {
    throw new Error(`TikTok ${err.code}: ${err.message || ''} (log_id ${err.log_id || 'n/a'})`);
  }
  if (!response.ok) {
    throw new Error(`TikTok ${url} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

/**
 * Trade the stored refresh token for an access token.
 *
 * Returns { accessToken, refreshToken, expiresIn }. The refreshToken in the
 * reply REPLACES the one you sent - persist it or the next run fails auth.
 */
export async function refreshAccessToken({ clientKey, clientSecret, refreshToken }) {
  const json = await call(OAUTH, {
    form: {
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
  });
  if (!json.access_token) {
    throw new Error(`TikTok refresh returned no access_token: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
  };
}

/**
 * Which privacy levels this creator may use, and whether they are rate-limited
 * right now.
 *
 * Called before every post because TikTok's UX guidelines require the posting
 * surface to reflect the creator's real options, and the audit checks for it.
 * It is also the cheapest way to find out you are in a posting cooldown before
 * you burn an init call.
 */
export async function creatorInfo(token) {
  const json = await call(`${API}/post/publish/creator_info/query/`, { token, body: {} });
  return json.data;
}

/**
 * Direct-post a photo carousel. Returns the publish_id.
 *
 * `photoUrls` must all sit under the verified prefix; `title` is the on-post
 * caption (90 UTF-16 runes max, which the caller is expected to have honoured).
 */
export async function postCarousel({ token, title, photoUrls, config }) {
  if (!photoUrls.length || photoUrls.length > 35) {
    throw new Error(`carousel needs 1-35 images, got ${photoUrls.length}`);
  }
  const offenders = photoUrls.filter((url) => !url.startsWith(config.urlPrefix));
  if (offenders.length) {
    throw new Error(
      `these URLs are outside the verified prefix ${config.urlPrefix} and TikTok will reject them:\n  ` +
        offenders.join('\n  ')
    );
  }

  const json = await call(`${API}/post/publish/content/init/`, {
    token,
    body: {
      media_type: 'PHOTO',
      post_mode: 'DIRECT_POST',
      post_info: {
        title,
        privacy_level: config.privacyLevel,
        disable_comment: Boolean(config.disableComment),
        auto_add_music: Boolean(config.autoAddMusic),
        // Both required booleans. False on both: these are our own posts, not
        // paid promotion and not a branded-content deal.
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_images: photoUrls,
        photo_cover_index: 0,
      },
    },
  });

  return json.data.publish_id;
}

/** Poll once. TikTok downloads the images async, so init succeeding is not posted. */
export async function publishStatus({ token, publishId }) {
  const json = await call(`${API}/post/publish/status/fetch/`, {
    token,
    body: { publish_id: publishId },
  });
  return json.data;
}
