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

/** Build a LINE message: a Flex card (text + a tappable button that hides the URL
 *  behind a label) when a link is given; otherwise a plain text message. */
function buildQueueMessage(text, link, label) {
  if (!link) return { type: 'text', text };
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return {
    type: 'flex',
    altText: lines[0] || 'อัปเดตคิว',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: lines.map((t, i) => ({
          type: 'text', text: t, wrap: true,
          size: i === 0 ? 'lg' : 'sm',
          weight: i === 0 ? 'bold' : 'regular',
          color: i === 0 ? '#1e3a5f' : '#555555',
        })),
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'button', style: 'primary', color: '#1ab3ce', height: 'sm',
          action: { type: 'uri', label: label, uri: link },
        }],
      },
    },
  };
}

/** Push a queue update with an optional "check queue" button (URL hidden behind it).
 *  Falls back to a plain-text message (with the link) if the card can't be sent. */
export async function pushQueue(userId, text, link = null, label = 'ดูคิวของฉัน') {
  if (!userId) return false;
  if (!LINE_ENABLED) {
    console.log(`\n[LINE-STUB] -> ${userId}\n${text}${link ? `\n[button: "${label}" -> ${link}]` : ''}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [buildQueueMessage(text, link, label)] });
    return true;
  } catch (err) {
    console.error('[LINE] flex push failed, falling back to text:', err?.statusMessage || err?.message || err);
    try {
      const fallback = link ? `${text}\n\n👉 ${link}` : text;
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: fallback }] });
      return true;
    } catch (e) { return false; }
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
