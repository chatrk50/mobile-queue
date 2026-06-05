// LINE Messaging API wrapper.
// Degrades gracefully: if no LINE_CHANNEL_ACCESS_TOKEN is set, push messages are
// logged to the console instead of sent, so the whole system runs locally without
// any LINE account. No magic — when unconfigured it tells you so in the logs.
import * as line from '@line/bot-sdk';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const secret = process.env.LINE_CHANNEL_SECRET || '';
export const LINE_ENABLED = Boolean(token && secret);

let client = null;
if (LINE_ENABLED) {
  client = new line.messagingApi.MessagingApiClient({ channelAccessToken: token });
}

export const lineMiddleware = LINE_ENABLED
  ? line.middleware({ channelSecret: secret })
  : (req, res, next) => next(); // no-op when not configured

/** Send a text push to a LINE user. Returns true if actually sent. */
export async function pushText(userId, text) {
  if (!userId) return false;
  if (!LINE_ENABLED) {
    console.log(`\n[LINE-STUB] -> ${userId}\n${text}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
    return true;
  } catch (err) {
    console.error('[LINE] push failed:', err?.statusMessage || err?.message || err);
    return false;
  }
}

/** Reply to a webhook event (used for follow / message events). */
export async function replyText(replyToken, text) {
  if (!LINE_ENABLED || !replyToken) return false;
  try {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
    return true;
  } catch (err) {
    console.error('[LINE] reply failed:', err?.message || err);
    return false;
  }
}
