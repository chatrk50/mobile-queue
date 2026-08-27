// LINE Messaging API wrapper.
// Degrades gracefully: if no LINE_CHANNEL_ACCESS_TOKEN is set, push messages are
// logged to the console instead of sent, so the whole system runs locally without
// any LINE account. No magic — when unconfigured it tells you so in the logs.
import * as line from '@line/bot-sdk';
import { db } from './db.js';

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

/** Send a text push to a LINE user. Returns true if actually sent.
 *  `kind` tags the attempt in push_log (e.g. 'summary') so a silent failure is diagnosable
 *  later — before this, a failed owner summary left no trace anywhere the UI could show. */
export async function pushText(userId, text, kind = 'other') {
  if (!userId) return false;
  if (!LINE_ENABLED) {
    console.log(`\n[LINE-STUB] -> ${userId}\n${text}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
    _lastPushError = null;
    logPush(userId, kind, true);
    return true;
  } catch (err) {
    // Keep WHAT LINE actually said. "ล้มเหลว" with no reason sent the owner guessing between four
    // very different causes (not a friend / id from another provider / expired token / quota).
    const status = err?.status || err?.statusCode || err?.originalError?.response?.status || null;
    const detail = err?.body?.message || err?.originalError?.response?.data?.message
      || err?.statusMessage || err?.message || String(err);
    _lastPushError = { status, detail: String(detail).slice(0, 300), at: new Date().toISOString() };
    console.error('[LINE] push failed:', status || '', detail);
    logPush(userId, kind, false);
    return false;
  }
}
let _lastPushError = null;
/** What LINE said about the most recent failed push (null once one succeeds). */
export function lastPushError() { return _lastPushError; }

// ---- Identity checks. A LINE userId belongs to ONE channel: an id captured from the test OA can
// never be pushed to from the real OA, and vice-versa. That mismatch is invisible from the outside
// (add-friend looks fine, the id looks well-formed) so these two read-only calls make it visible.
// The token itself is NEVER returned — only which OA it belongs to.
/** Which OA is this server's token actually for? → { basicId:'@138dccus', displayName, ... } */
export async function botInfo() {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, detail: body?.message || '' };
    return { ok: true, basicId: body.basicId || null, displayName: body.displayName || null,
             userId: body.userId || null, premiumId: body.premiumId || null };
  } catch (e) { return { ok: false, reason: 'network', detail: String(e?.message || e) }; }
}
/** Is the OA's webhook set, switched on, and does LINE actually reach it? Typing "id" in the chat
 *  can only ever reply if all three are true — with webhook off, the message never leaves LINE. */
export async function webhookInfo() {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, detail: body?.message || '' };
    return { ok: true, endpoint: body.endpoint || null, active: body.active === true };
  } catch (e) { return { ok: false, reason: 'network', detail: String(e?.message || e) }; }
}
/** Ask LINE to POST a test event to the configured webhook and report what came back. */
export async function webhookTest() {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/channel/webhook/test',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, detail: body?.message || '' };
    return { ok: true, success: body.success === true, statusCode: body.statusCode ?? null,
             reason: body.reason || null, detail: body.detail || null };
  } catch (e) { return { ok: false, reason: 'network', detail: String(e?.message || e) }; }
}
/** Point the OA's webhook at this server. Owner-triggered only — it changes the LINE channel's
 *  own configuration, so it is never called automatically. */
export async function setWebhook(url) {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: url }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, detail: body?.message || '' };
    return { ok: true };
  } catch (e) { return { ok: false, detail: String(e?.message || e) }; }
}
/** Is this userId a friend of THIS channel? 404/403 = not this channel's user (or not a friend). */
export async function friendCheck(userId) {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  if (!userId) return { ok: false, reason: 'no_id' };
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, friend: true, displayName: body.displayName || null };
    return { ok: true, friend: false, status: r.status, detail: body?.message || '' };
  } catch (e) { return { ok: false, reason: 'network', detail: String(e?.message || e) }; }
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

/** Order-status Flex card with a LINE-MAN-style progress bar. A LIFF web app cannot create an
 *  iOS Live Activity (that needs a native App Store app), so this is the closest equivalent:
 *  the lock screen shows the alt-text status line, and the chat shows a progress card.
 *  stage: 1 = รับออเดอร์แล้ว · 2 = กำลังทำ/ใกล้ถึงคิว · 3 = พร้อมรับ. Costs the SAME one message
 *  as the plain push it replaces. */
// No emoji anywhere by owner request: the state is carried by the bar, the colour and the words.
// Emoji rendered at a different size on every device and made the card read as a chat message
// rather than an order status.
const STAGE_LABELS = ['รับออเดอร์', 'กำลังทำ', 'พร้อมรับ'];
const ON = '#1ab3ce', DONE = '#2fc2a6', OFF = '#E4ECF1', INK = '#284B63', MUT = '#8A9299';
function buildStageMessage({ stage, title, subtitle, code, link, label }) {
  // One column per step: a 4px rail above its label. Done = mint, current = teal, later = grey.
  const step = (i) => {
    const state = i < stage - 1 ? 'done' : (i === stage - 1 ? 'now' : 'next');
    const c = state === 'done' ? DONE : state === 'now' ? ON : OFF;
    return {
      type: 'box', layout: 'vertical', flex: 1, spacing: 'sm',
      contents: [
        { type: 'box', layout: 'vertical', height: '4px', backgroundColor: c, cornerRadius: '2px', contents: [{ type: 'filler' }] },
        { type: 'text', text: STAGE_LABELS[i], size: 'xxs', align: 'center',
          color: state === 'next' ? MUT : INK, weight: state === 'now' ? 'bold' : 'regular' },
      ],
    };
  };
  const body = [
    { type: 'text', text: title, weight: 'bold', size: 'lg', color: INK, wrap: true },
    ...(subtitle ? [{ type: 'text', text: subtitle, size: 'sm', color: MUT, wrap: true, margin: 'xs' }] : []),
  ];
  // The queue number is the one thing the customer looks for — give it its own quiet panel.
  if (code) body.push({
    type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '14px', cornerRadius: '12px',
    backgroundColor: '#F4FAFC', alignItems: 'center',
    contents: [
      { type: 'text', text: 'หมายเลขคิว', size: 'xxs', color: MUT },
      { type: 'text', text: code, size: '3xl', weight: 'bold', color: INK, align: 'center' },
    ],
  });
  body.push({ type: 'box', layout: 'horizontal', margin: 'lg', spacing: 'sm', contents: [step(0), step(1), step(2)] });
  return {
    type: 'flex',
    altText: `${title}${code ? ` · คิว ${code}` : ''}`,
    contents: {
      type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: '#FFFFFF', contents: body },
      ...(link ? {
        footer: {
          type: 'box', layout: 'vertical', paddingAll: '14px', paddingTop: '0px',
          contents: [{ type: 'button', style: 'primary', color: ON, height: 'sm', action: { type: 'uri', label: label || 'ดูคิวของฉัน', uri: link } }],
        },
      } : {}),
    },
  };
}
/** Push an order-status progress card (falls back to plain text like pushQueue). */
export async function pushStage(userId, opts, kind = 'queue') {
  if (!userId) return false;
  const fallbackText = `${opts.title}${opts.code ? `\nหมายเลขคิว ${opts.code}` : ''}${opts.subtitle ? `\n${opts.subtitle}` : ''}`;
  if (!LINE_ENABLED) {
    console.log(`\n[LINE-STUB stage${opts.stage}] -> ${userId}\n${fallbackText}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [buildStageMessage(opts)] });
    logPush(userId, kind, true);
    return true;
  } catch (err) {
    console.error('[LINE] stage flex failed, falling back:', err?.statusMessage || err?.message || err);
    try {
      const t = opts.link ? `${fallbackText}\n\n👉 ${opts.link}` : fallbackText;
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: t }] });
      logPush(userId, kind, true); return true;
    } catch (e) { logPush(userId, kind, false); return false; }
  }
}
/** The coupon card a customer receives in LINE (win-back / birthday / targeted sends). Phase 4A
 *  design: a teal YO-DEE hero with the value, a congrats/message line + expiry, and one button into
 *  the LIFF. `msg` (optional) lets a campaign carry its own line instead of the generic congrats, so
 *  the whole thing is ONE Flex message — no extra LINE cost over the old text push. */
function buildCouponFlex(c, link, msg) {
  const NAVY = '#284B63', MUTED = '#5C7187', TEAL = '#00B5D8', HAIR = '#EEF1F5';
  const isReward = c.isReward || c.disc_type === 'reward';
  const kind = c.couponKind || c.kind || (isReward ? 'reward' : 'discount');
  // Per-kind gradient hero, mirroring the in-app .cpn / .cw-ticket value stub.
  const GRAD = {
    birthday: ['#F68CAE', '#E0608F'], winback: ['#F7C458', '#EF9C2A'],
    reward: ['#33C9AC', '#10A582'], discount: ['#00B5D8', '#2FC2A6'],
  };
  const [g0, g1] = GRAD[kind] || GRAD.discount;
  const big = isReward ? 'ฟรี 1 แก้ว'
    : (c.disc_type === 'percent' ? `ส่วนลด ${c.disc_value}%` : `ส่วนลด ฿${c.disc_value ?? c.amount ?? c.cap ?? ''}`);
  const cond = isReward ? `ไม่เกิน ฿${c.freeCap || c.cap || 49}` : (c.min_spend > 0 ? `ขั้นต่ำ ฿${c.min_spend}` : 'ไม่มีขั้นต่ำ · ทุกเมนู');
  // A card that isn't announcing a NEW coupon (the expiry reminder) overrides the hero kicker and
  // the notification preview, so it never reads as "you've won something" for a coupon already held.
  const kicker = c.kicker || (kind === 'birthday' ? '🎂 ของขวัญวันเกิด' : kind === 'winback' ? '💛 ยินดีต้อนรับกลับ' : kind === 'reward' ? '🎁 รางวัลสะสมครบ' : '🎟️ คูปองส่วนลด');
  const bodyLine = (msg && String(msg).trim()) || 'ยินดีด้วย! 🎉 คุณได้รับคูปองจาก YO-DEE';
  return {
    type: 'flex', altText: (c.altText || `🎁 คุณได้รับคูปอง YO-DEE — ${big}${c.expiresAt ? ` · ใช้ได้ถึง ${c.expiresAt}` : ''}`).slice(0, 390),
    contents: {
      type: 'bubble', size: 'mega',
      body: {
        type: 'box', layout: 'vertical', paddingAll: '0px', backgroundColor: '#FFFFFF',
        contents: [
          { type: 'box', layout: 'horizontal', paddingStart: '20px', paddingEnd: '20px', paddingTop: '18px', paddingBottom: '10px',
            contents: [
              { type: 'text', text: 'YO-DEE Yogurt', size: 'sm', weight: 'bold', color: NAVY, flex: 1, gravity: 'center' },
              { type: 'text', text: 'คูปอง', size: 'xs', color: '#8A9299', align: 'end', gravity: 'center' },
            ] },
          { type: 'box', layout: 'vertical', paddingAll: '22px',
            background: { type: 'linearGradient', angle: '135deg', startColor: g0, endColor: g1 },
            contents: [
              { type: 'text', text: kicker, size: 'xs', color: '#FFFFFF', weight: 'bold' },
              { type: 'text', text: big, size: '3xl', color: '#FFFFFF', weight: 'bold', margin: 'sm' },
              { type: 'text', text: cond, size: 'xxs', color: '#FFFFFF', margin: 'sm' },
            ] },
          { type: 'box', layout: 'vertical', paddingAll: '18px',
            contents: [
              { type: 'text', text: bodyLine, weight: 'bold', size: 'md', color: NAVY, wrap: true },
              { type: 'text', text: c.label || big, size: 'sm', color: MUTED, wrap: true, margin: 'sm' },
              { type: 'separator', margin: 'lg', color: HAIR },
              ...(c.expiresAt ? [{ type: 'box', layout: 'baseline', margin: 'lg', contents: [
                { type: 'text', text: '⏳', flex: 0, size: 'sm' },
                { type: 'text', text: `ใช้ได้ถึง ${c.expiresAt}`, size: 'xs', color: '#8A9299', margin: 'sm' },
              ] }] : []),
              { type: 'button', style: 'primary', color: TEAL, margin: 'lg', height: 'sm',
                action: { type: 'uri', label: 'เปิดคูปอง · ใช้เลย', uri: link || 'https://line.me' } },
            ] },
        ] },
    },
  };
}
export async function pushCouponFlex(userId, coupon, link, msg, kind = 'coupon') {
  if (!userId) return false;
  const big = (coupon.isReward || coupon.disc_type === 'reward') ? 'ฟรี 1 แก้ว'
    : (coupon.disc_type === 'percent' ? `ส่วนลด ${coupon.disc_value}%` : `ส่วนลด ฿${coupon.disc_value ?? coupon.amount ?? coupon.cap ?? ''}`);
  const fallback = `${coupon.emoji || '🎁'} ${(msg && String(msg).trim()) || 'คุณได้รับคูปองจาก YO-DEE'}\n${big}${coupon.label ? ` — ${coupon.label}` : ''}${coupon.expiresAt ? `\nใช้ได้ถึง ${coupon.expiresAt}` : ''}${link ? `\n👉 ${link}` : ''}`;
  if (!LINE_ENABLED) { console.log(`\n[LINE-STUB coupon] -> ${userId}\n${fallback}\n`); return false; }
  try {
    await client.pushMessage({ to: userId, messages: [buildCouponFlex(coupon, link, msg)] });
    logPush(userId, kind, true); return true;
  } catch (err) {
    console.error('[LINE] coupon flex failed, falling back to text:', err?.statusMessage || err?.message || err);
    try { await client.pushMessage({ to: userId, messages: [{ type: 'text', text: fallback }] }); logPush(userId, kind, true); return true; }
    catch (e) { logPush(userId, kind, false); return false; }
  }
}
/** The owner's end-of-day summary as a Flex card. The plain-text version was a wall of 15+ emoji
 *  lines that had to be re-read every night to find the two numbers that matter; this leads with
 *  ยอดขาย/กำไร, groups the rest, and always carries the same text as altText so a notification
 *  preview (and any client that cannot render Flex) still says everything. */
function buildSummaryFlex(s, fallbackText) {
  const NAVY = '#284B63', MUTED = '#8A9299', TEAL = '#1ab3ce', GREEN = '#0f6b57', RED = '#b3283a', WARN = '#946f00';
  const money = (n) => '฿' + Number(n || 0).toLocaleString('en-US');
  const row = (label, value, color, bold) => ({
    type: 'box', layout: 'horizontal', margin: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: MUTED, flex: 5, wrap: true },
      { type: 'text', text: String(value), size: 'sm', color: color || NAVY, align: 'end', flex: 4,
        weight: bold ? 'bold' : 'regular', wrap: true },
    ],
  });
  const sep = (m) => ({ type: 'separator', margin: m || 'lg', color: '#EAF0F4' });
  const head = (t) => ({ type: 'text', text: t, size: 'xs', color: MUTED, weight: 'bold', margin: 'lg' });
  const body = [
    { type: 'text', text: 'สรุปยอดวันนี้', size: 'xs', color: MUTED, weight: 'bold' },
    { type: 'text', text: s.shopName || 'ร้าน', size: 'lg', color: NAVY, weight: 'bold', margin: 'xs', wrap: true },
    { type: 'text', text: s.dateTh || '', size: 'xs', color: MUTED, margin: 'xs' },
    // The two numbers the owner actually opens this for.
    { type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '14px', cornerRadius: '12px',
      backgroundColor: '#F4FAFC',
      contents: [
        { type: 'text', text: 'ยอดขาย', size: 'xs', color: MUTED },
        { type: 'text', text: money(s.revenue), size: 'xxl', weight: 'bold', color: NAVY },
        { type: 'box', layout: 'horizontal', margin: 'md', contents: [
          { type: 'text', text: `${s.cups || 0} ${s.unit || 'แก้ว'}`, size: 'sm', color: MUTED, flex: 4 },
          { type: 'text', text: (s.netProfit >= 0 ? 'กำไร ' : 'ขาดทุน ') + money(Math.abs(s.netProfit || 0)),
            size: 'sm', weight: 'bold', align: 'end', flex: 5, color: s.netProfit >= 0 ? GREEN : RED },
        ] },
      ] },
  ];
  if (s.cancelled || s.refunded || s.wasteCups) {
    body.push(head('ยกเลิก / คืนเงิน / ของเสีย'));
    body.push(row('ยกเลิก', `${s.cancelled || 0} ออเดอร์`, s.cancelled ? WARN : NAVY));
    body.push(row('คืนเงิน', `${s.refunded || 0} ออเดอร์`, s.refunded ? WARN : NAVY));
    body.push(row('ของเสีย', `${s.wasteCups || 0} ${s.unit || 'แก้ว'}`, s.wasteCups ? RED : NAVY));
  }
  if (s.rating || s.cashLine) {
    body.push(sep());
    if (s.rating) body.push(row('รีวิวเฉลี่ย', `★ ${s.rating}${s.ratingCount ? ` (${s.ratingCount})` : ''}`, '#d9a520'));
    if (s.cashLine) body.push(row('เงินสด', s.cashLine.text, s.cashLine.ok ? GREEN : RED, true));
  }
  if (s.lowCount || s.expiringCount || (s.buyList || []).length) {
    body.push(head('สต๊อก'));
    if (s.lowCount) body.push(row('ใกล้หมด', `${s.lowCount} รายการ`, WARN));
    if (s.expiringCount) body.push(row('ใกล้/หมดอายุ', `${s.expiringCount} ล็อต`, s.expired ? RED : WARN));
    if ((s.buyList || []).length) {
      body.push(row('ควรสั่งซื้อ', `${s.buyCount} รายการ${s.buyCost ? ` · ~${money(s.buyCost)}` : ''}`, NAVY, true));
      // EVERY line, not a preview: the owner reads this standing in the shop with no browser open.
      // 60 is a safety stop far above a real shopping list (a bubble caps at 10KB).
      const items = s.buyList.slice(0, 60);
      body.push({ type: 'box', layout: 'vertical', margin: 'sm', paddingAll: '10px', cornerRadius: '10px',
        backgroundColor: '#FFFBEA',
        contents: items.map((t) => ({ type: 'text', text: '• ' + t, size: 'xs', color: '#7a5c00', wrap: true }))
          .concat(s.buyList.length > items.length
            ? [{ type: 'text', text: `…และอีก ${s.buyList.length - items.length} รายการ (เปิดใบสั่งซื้อเพื่อดูครบ)`, size: 'xs', color: MUTED, margin: 'sm', wrap: true }] : []) });
    }
  }
  return {
    type: 'flex', altText: fallbackText.slice(0, 400),
    contents: {
      type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: '#FFFFFF', contents: body },
      // Two doors, both deep links: straight to the draft purchase order when there is one to
      // approve (that is what the owner acts on while out buying), and to the day's report.
      footer: (s.link || s.poLink) ? {
        type: 'box', layout: 'vertical', paddingAll: '14px', paddingTop: '0px', spacing: 'sm',
        contents: [
          ...(s.poLink && (s.buyList || []).length ? [{ type: 'button', style: 'primary', height: 'sm', color: TEAL,
            action: { type: 'uri', label: 'เปิดใบสั่งซื้อ', uri: s.poLink } }] : []),
          ...(s.link ? [{ type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'uri', label: 'เปิดรายงานวันนี้', uri: s.link } }] : []),
        ],
      } : undefined,
    },
  };
}
/** Send the owner summary as a card; falls back to the plain text on any Flex error. */
export async function pushSummary(userId, summary, fallbackText, kind = 'summary') {
  if (!userId) return false;
  if (!LINE_ENABLED) { console.log(`\n[LINE-STUB summary] -> ${userId}\n${fallbackText}\n`); return false; }
  try {
    await client.pushMessage({ to: userId, messages: [buildSummaryFlex(summary, fallbackText)] });
    _lastPushError = null; logPush(userId, kind, true); return true;
  } catch (err) {
    console.error('[LINE] summary flex failed, falling back to text:', err?.statusMessage || err?.message || err);
    return pushText(userId, fallbackText, kind);
  }
}
// Every REAL push (LINE enabled) is counted in push_log — LINE OA bills by message volume, and
// before this the owner had no way to see how many messages a month the shop was paying for.
// The UAT stub is NOT logged (it costs nothing). Best-effort: logging never blocks a push.
function logPush(userId, kind, ok) {
  try { db.prepare('INSERT INTO push_log (user_id, kind, ok) VALUES (?,?,?)').run(userId || null, kind || 'other', ok ? 1 : 0); }
  catch { /* push_log may not exist on very old DBs */ }
}
/** Push a queue update with an optional "check queue" button (URL hidden behind it).
 *  Falls back to a plain-text message (with the link) if the card can't be sent.
 *  `kind` tags the message purpose for the monthly cost report (push_log). */
export async function pushQueue(userId, text, link = null, label = 'ดูคิวของฉัน', kind = 'other') {
  if (!userId) return false;
  if (!LINE_ENABLED) {
    console.log(`\n[LINE-STUB] -> ${userId}\n${text}${link ? `\n[button: "${label}" -> ${link}]` : ''}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [buildQueueMessage(text, link, label)] });
    logPush(userId, kind, true);
    return true;
  } catch (err) {
    console.error('[LINE] flex push failed, falling back to text:', err?.statusMessage || err?.message || err);
    try {
      const fallback = link ? `${text}\n\n👉 ${link}` : text;
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: fallback }] });
      logPush(userId, kind, true);
      return true;
    } catch (e) { logPush(userId, kind, false); return false; }
  }
}

/** Ask LINE who a LIFF access token really belongs to. Returns the userId, or null when the token
 *  is missing/expired/forged. This is the only proof of identity a claim can trust: the LINE id
 *  format itself is trivially fabricated, so a script could otherwise drain a campaign's quota
 *  with synthetic "customers". With LINE stubbed (UAT/dev) there is no LINE to ask — callers skip
 *  the check there, which also keeps local testing possible. */
export async function verifyLiffToken(accessToken) {
  if (!accessToken) return null;
  try {
    const r = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return null;
    const p = await r.json();
    return p && p.userId ? p.userId : null;
  } catch { return null; }
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
