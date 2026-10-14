'use strict';
/*
 * Zimam (زمام) server
 *  - WhatsApp attendance from the check-in group (first message of the day = in, "خروج" = out)
 *  - Employee task flow on WhatsApp: tasks list -> duration per task -> timer -> "أنجزت / مشكلة / بدي وقت"
 *  - Problems and unfinished tasks become "issues" the manager decides on in the web app
 *  - Admin API for the web app (send, QR link, attendance, feed, state sync)
 *  - Automatic reminders (morning tasks, missing check-in, evening summary)
 * Storage: JSON files in DATA_DIR. No Airtable, no external database.
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3030);
const WAHA_URL = String(process.env.WAHA_URL || 'http://waha:3000').replace(/\/+$/, '');
const WAHA_KEY = process.env.WAHA_API_KEY || '';
const HOOK_SECRET = process.env.WAHA_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const SELF_URL = String(process.env.SELF_URL || 'http://zimam:3030').replace(/\/+$/, '');
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const TZ = process.env.TZ_NAME || process.env.TZ || 'Asia/Riyadh';
const DATA = process.env.DATA_DIR || '/data';
const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const SESSION = 'default';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const WH = () => ({ 'X-Api-Key': WAHA_KEY });
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.message) || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.message) || e));

/* ---------------- storage ---------------- */
function jload(f, d) { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } }
function jsave(f, v) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const p = path.join(DATA, f);
    fs.writeFileSync(p + '.tmp', JSON.stringify(v));
    fs.renameSync(p + '.tmp', p);
  } catch (e) { console.error('[data] save', f, e.message); }
}
const ST = {
  group: jload('group.json', { id: null }),
  att: jload('attendance.json', []),
  team: jload('team.json', []),
  state: jload('state.json', null),      // the web app's whole state (tasks, settings, rules...)
  wtasks: jload('wtasks.json', []),      // tasks employees reported on WhatsApp
  issues: jload('issues.json', []),      // things the manager must decide on
  convo: jload('convo.json', {}),        // per-employee conversation state
  sent: jload('sent.json', {}),
  seen: {},
};
const DEF = { start: '09:00', grace: 30, workdays: [0, 1, 2, 3, 4], summaryAt: '18:00', eod: '19:30', followups: 'group', remindTasks: true, remindCheckin: true, remindSummary: true, company: '' };
function settings() { const s = (ST.state && ST.state.settings) || {}; return Object.assign({}, DEF, s); }
function appTasks() { return (ST.state && Array.isArray(ST.state.tasks)) ? ST.state.tasks : []; }

/* ---------------- time ---------------- */
function local(ts) {
  const n = Number(ts);
  const d = n ? new Date(n > 1e12 ? n : n * 1000) : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => (parts.find((x) => x.type === t) || {}).value || '00';
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g('weekday')];
  return { date: g('year') + '-' + g('month') + '-' + g('day'), time: g('hour') + ':' + g('minute'), dow: wd };
}
const toMin = (hm) => { const [h, m] = String(hm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const digits = (x) => String(x || '').replace(/\D/g, '');
const latin = (s) => String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
const dur = (m) => (m >= 60 ? (m % 60 === 0 ? (m === 60 ? 'ساعة' : m === 120 ? 'ساعتين' : (m / 60) + ' ساعات') : Math.floor(m / 60) + ' ساعة و' + (m % 60) + ' دقيقة') : m + ' دقيقة');

/* ---------------- WAHA ---------------- */
async function wahaSession() {
  try {
    const r = await axios.get(WAHA_URL + '/api/sessions/' + SESSION, { headers: WH(), timeout: 8000 });
    const me = r.data && r.data.me ? String(r.data.me.id || '').replace(/@.*/, '') : null;
    return { status: (r.data && r.data.status) || 'UNKNOWN', me, config: (r.data && r.data.config) || {} };
  } catch (e) { return { status: e.response && e.response.status === 404 ? 'MISSING' : 'UNREACHABLE', me: null, config: {} }; }
}
function webhookConfig() {
  const hook = { url: SELF_URL + '/inbound', events: ['message.any', 'session.status'], retries: { policy: 'linear', delaySeconds: 2, attempts: 3 } };
  if (HOOK_SECRET) hook.hmac = { key: HOOK_SECRET };
  return [hook];
}
async function ensureSession() {
  for (let i = 0; i < 60; i++) {
    const w = await wahaSession();
    if (w.status === 'UNREACHABLE') { await sleep(5000); continue; }
    try {
      if (w.status === 'MISSING') {
        await axios.post(WAHA_URL + '/api/sessions', { name: SESSION, start: true, config: { webhooks: webhookConfig() } }, { headers: WH(), timeout: 20000 });
        log('[waha] session created');
      } else {
        const hooks = (w.config && w.config.webhooks) || [];
        const ok = hooks.some((h) => h.url === SELF_URL + '/inbound' && (h.events || []).includes('message.any'));
        if (!ok) {
          await axios.put(WAHA_URL + '/api/sessions/' + SESSION, { name: SESSION, config: Object.assign({}, w.config, { webhooks: webhookConfig() }) }, { headers: WH(), timeout: 30000 });
          log('[waha] webhook configured');
        }
        if (w.status === 'STOPPED') await axios.post(WAHA_URL + '/api/sessions/' + SESSION + '/start', {}, { headers: WH(), timeout: 20000 }).catch(() => {});
      }
      return;
    } catch (e) { log('[waha] setup retry', e.response ? e.response.status : e.message); await sleep(5000); }
  }
}
async function sendText(chatId, text, replyTo) {
  const body = { session: SESSION, chatId, text };
  if (replyTo) body.reply_to = replyTo;
  return axios.post(WAHA_URL + '/api/sendText', body, { headers: WH(), timeout: 20000 });
}
async function react(messageId, emoji) {
  try { await axios.put(WAHA_URL + '/api/reaction', { session: SESSION, messageId, reaction: emoji }, { headers: WH(), timeout: 8000 }); } catch (e) { /* nicety */ }
}
const lidCache = {};
async function lidToPhone(id) {
  const lid = String(id).split('@')[0];
  if (lidCache[lid]) return lidCache[lid];
  for (const key of [lid + '@lid', lid]) {
    try {
      const r = await axios.get(WAHA_URL + '/api/' + SESSION + '/lids/' + encodeURIComponent(key), { headers: WH(), timeout: 8000 });
      const pn = r.data && (r.data.pn || r.data.phone);
      if (pn) { lidCache[lid] = digits(String(pn).split('@')[0]); return lidCache[lid]; }
    } catch (e) { /* next */ }
  }
  return null;
}

/* ---------------- team ---------------- */
function team() {
  if (ST.state && Array.isArray(ST.state.team) && ST.state.team.length) {
    return ST.state.team.filter((m) => !m.deleted).map((m) => ({ id: String(m.id), name: m.name, short: m.short || m.name, names: [m.name, m.short].concat(m.aliases || []).filter(Boolean), phone: digits(m.phone), manager: !!m.manager, active: m.active !== false, start: m.start || '', female: !!m.female }));
  }
  return ST.team;
}
function matchTeam(phone, name) {
  const T = team().filter((m) => m.active !== false);
  if (phone && phone.length >= 9) {
    const t = phone.slice(-9);
    const h = T.find((m) => digits(m.phone).length >= 9 && digits(m.phone).slice(-9) === t);
    if (h) return h;
  }
  const n = String(name || '').trim().toLowerCase();
  if (n.length >= 2) {
    const toks = n.split(/\s+/);
    const h = T.find((m) => (m.names || [m.name]).filter(Boolean).some((x) => { x = String(x).trim().toLowerCase(); return x.length >= 2 && (n === x || toks.includes(x)); }));
    if (h) return h;
  }
  return null;
}
const manager = () => team().find((m) => m.manager && digits(m.phone).length >= 9);

/* ---------------- parsing ---------------- */
const BIND_RE = /^\s*(زمام\s*[-_]?\s*حضور|#حضور)\s*[.!]*\s*$/;
const IN_RE = /(دخول|صباح|مسا|وصلت|واصل|حضور|موجود|بدأت|بديت|check ?in)|\d{1,2}\s*:\s*\d{2}/i;
const OUT_RE = /(خروج|مغادر|انصراف|روحت|روّحت|مروح|مروّح|طالع|طلعت|انتهى الدوام|خلص الدوام|باي|bye|check ?out)/i;
const DONE_RE = /^(1|أنجزت|انجزت|خلصت|خلّصت|تم|تمت|انتهيت|done)(?=$|\s|[،,.!؟])/i;
const PROBLEM_RE = /^(2|مشكلة|مشكله|صار معي مشكلة|صار معي مشكله|في مشكلة|problem)/i;
const MORE_RE = /^(3|بدي وقت|بدي وقت زيادة|وقت|محتاج وقت|محتاجة وقت|زيادة|more)/i;
const HEAD_RE = /(مهام|مهمات|مهماتي|مهامي|خطة اليوم|خطتي|شغلي اليوم|اليوم (رح|بدي|راح|بشتغل|حشتغل)|بشتغل على|برنامجي|tasks?)/i;
const NUM_LINE = /^\s*(\d+|[٠-٩]+)\s*[\)\-\.:،]/;
const BULLET = /^\s*[-•*–]\s*/;
function stripItem(l) {
  return latin(l).replace(/^\s*(\d+)\s*[\)\-\.:،]\s*/, '').replace(BULLET, '').replace(/^\s*(مهمة|المهمة)\s*(\d+)?\s*[:\-]?\s*/, '').replace(/[.。]+$/, '').trim();
}
function parseTasks(raw) {
  const txt = latin(raw);
  const lines = txt.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const numbered = lines.filter((l) => NUM_LINE.test(l) || BULLET.test(l)).length;
  const head = HEAD_RE.test(txt);
  if (!head && numbered < 2) return [];
  let items = [];
  if (lines.length >= 2) {
    for (const l of lines) {
      if (/^(صباح|مساء|وصلت|دخول|هلا|مرحبا|السلام)/.test(l)) continue;
      if (HEAD_RE.test(l) && !NUM_LINE.test(l) && !BULLET.test(l) && stripItem(l).length < 70 && !/[:：]\s*\S/.test(l)) continue;
      let s = stripItem(l);
      if (HEAD_RE.test(l) && /[:：]/.test(l)) s = stripItem(l.split(/[:：]/).slice(1).join(':'));
      if (s.length >= 3) items.push(s);
    }
  }
  if (!items.length && head) {
    const after = /[:：]/.test(txt) ? txt.split(/[:：]/).slice(1).join(':') : txt.replace(HEAD_RE, '');
    items = after.split(/[،,؛;\n]/).map(stripItem).filter((s) => s.length >= 3);
  }
  return items.slice(0, 10);
}
function parseDuration(raw) {
  const s = latin(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/يوم|بكرا|بكرة/.test(s)) return 480;
  if (/ساعة ونص|ساعه ونص|ساعة و نص/.test(s)) return 90;
  if (/نص ساعة|نصف ساعة|نص ساعه/.test(s)) return 30;
  if (/ربع ساعة|ربع ساعه/.test(s)) return 15;
  if (/ساعتين/.test(s)) return 120;
  if (/ثلاث ساعات|3 ساعات/.test(s)) return 180;
  let m = s.match(/(\d+(?:[.,]\d+)?)\s*(ساعة|ساعه|ساعات|س(?=$|\s)|h|hr|hours?)/i);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
  m = s.match(/(\d+)\s*(دقيقة|دقيقه|دقايق|دقائق|د(?=$|\s)|m(?=$|\s)|min)/i);
  if (m) return parseInt(m[1], 10);
  if (/^ساعة|^ساعه/.test(s)) return 60;
  m = s.match(/^(\d+(?:[.,]\d+)?)$/);
  if (m) { const n = parseFloat(m[1].replace(',', '.')); return n <= 12 ? Math.round(n * 60) : Math.round(n); }
  return null;
}
// "1 ساعة، 2 نص ساعة، 3 ساعتين" -> {1:60,2:30,3:120}; "ساعة" -> {cur:60}
function parseDurations(raw, cur) {
  const segs = latin(raw).split(/[،,؛;\n]+/).map((x) => x.trim()).filter(Boolean);
  const out = {}; let any = false;
  for (const seg of segs) {
    const m = seg.match(/^(?:المهمة\s*)?(\d{1,2})\s*[\)\-\.:]?\s+(.+)$/);
    if (m && segs.length >= 1 && parseDuration(m[2]) != null) { out[Number(m[1])] = parseDuration(m[2]); any = true; continue; }
    const d = parseDuration(seg);
    if (d != null && segs.length === 1) { out[cur] = d; any = true; }
  }
  if (!any && /كلهم|كلها|الكل/.test(raw)) { const d = parseDuration(raw.replace(/كلهم|كلها|الكل/g, '')); if (d != null) return { all: d }; }
  return any ? out : null;
}

/* ---------------- attendance ---------------- */
const done = new Set();
async function senderPhone(p) {
  const s0 = p.participant || p.author || (p._data && (p._data.author || (p._data.id && p._data.id.participant))) || p.from || '';
  const sid = String((s0 && (s0._serialized || s0)) || '');
  let phone = /@c\.us$|@s\.whatsapp\.net$/.test(sid) ? digits(sid.split('@')[0]) : null;
  if (!phone && sid.includes('@lid')) phone = await lidToPhone(sid);
  return { sid, phone };
}
function recordAttendance(key, member, nameFallback, phone, t, txt, force) {
  let rec = ST.att.find((r) => r.date === t.date && r.emp === key);
  if (!rec) {
    rec = { date: t.date, emp: key, name: member ? member.name : (nameFallback || phone || key.slice(1)), phone: phone || null, in: t.time, out: null, msgIn: txt.slice(0, 80), known: !!member };
    ST.att.push(rec);
    log('[attendance] in', rec.name, t.date, t.time);
  } else if (OUT_RE.test(txt) && !(rec.out && rec.out >= t.time)) {
    rec.out = t.time; rec.msgOut = txt.slice(0, 80);
    log('[attendance] out', rec.name, t.time);
  } else return null;
  const cut = addDays(local().date, -120);
  ST.att = ST.att.filter((r) => r.date >= cut);
  jsave('attendance.json', ST.att);
  return rec;
}

/* ---------------- employee task flow ---------------- */
function convoOf(id) { const d = local().date; let c = ST.convo[id]; if (!c || c.day !== d) { c = { day: d, state: 'idle', chat: '', idx: 0, askedAt: 0 }; ST.convo[id] = c; } return c; }
function saveFlow() { jsave('convo.json', ST.convo); jsave('wtasks.json', ST.wtasks); jsave('issues.json', ST.issues); }
const todays = (emp, date) => ST.wtasks.filter((x) => x.emp === emp && x.date === date);
const openIssue = (o) => { ST.issues.push(Object.assign({ id: 'I-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: new Date().toISOString(), status: 'open' }, o)); const cut = addDays(local().date, -60); ST.issues = ST.issues.filter((i) => i.at.slice(0, 10) >= cut); };
function chatFor(member, c) {
  const s = settings();
  if (s.followups === 'dm' && digits(member.phone).length >= 9) return digits(member.phone) + '@c.us';
  return c.chat || ST.group.id || (digits(member.phone) + '@c.us');
}
const nameOf = (m) => m.short || m.name;
const g = (m, male, female) => (m && m.female ? female : male);
function startTask(member, c, task) {
  const minutes = task.minutes || 60;
  task.status = 'active'; task.startedAt = Date.now(); task.dueAt = Date.now() + minutes * 60000;
  c.state = 'working'; c.askedAt = 0;
  return g(member,'ابدأ','ابدئي') + ' بالمهمة ' + task.n + ': ' + task.title + '\nبرجعلك بعد ' + dur(minutes) + '. لو خلصت قبل الوقت ' + g(member,'ابعت','ابعتي') + ' «أنجزت».';
}
function nextPending(member, c, date) { return todays(member.id, date).find((x) => x.status === 'pending'); }
function finishOrNext(member, c, date) {
  const nxt = nextPending(member, c, date);
  if (nxt) return startTask(member, c, nxt);
  c.state = 'idle';
  const all = todays(member.id, date);
  const doneN = all.filter((x) => x.status === 'done').length;
  return 'خلصنا مهام اليوم: ' + doneN + ' من ' + all.length + ' أُنجزت. يعطيك العافية 👏';
}
function reportTask(t) { return t.status === 'done' ? 'أُنجزت' : t.status === 'skipped' ? 'ما أُنجزت' : t.status === 'problem' ? 'فيها مشكلة' : t.status === 'active' ? 'جارية' : 'بالانتظار'; }

async function handleFlow(member, c, txt, msgId, chatId, t) {
  const text = latin(txt).trim();
  const tasks = todays(member.id, t.date);
  const active = tasks.find((x) => x.status === 'active');
  const name = nameOf(member);
  const say = async (msg) => { try { await sendText(chatId, (chatId.endsWith('@g.us') ? name + '، ' : '') + msg, msgId); } catch (e) { log('[flow] send failed', e.response ? e.response.status : e.message); } };

  if (c.state === 'ask_dur') {
    const pend = tasks.filter((x) => x.minutes == null);
    const cur = pend.length ? pend[0].n : 1;
    const d = parseDurations(text, cur);
    if (!d) { await say('ما فهمت الوقت. ' + g(member,'اكتب','اكتبي') + ' مثلاً: ساعة، أو 30 دقيقة، أو ساعتين'); return true; }
    if (d.all != null) tasks.forEach((x) => { if (x.minutes == null) x.minutes = d.all; });
    else for (const k of Object.keys(d)) { const task = tasks.find((x) => x.n === Number(k)); if (task) task.minutes = d[k]; }
    const still = tasks.filter((x) => x.minutes == null);
    if (still.length) { await say('المهمة ' + still[0].n + ': ' + still[0].title + '\nكم بدك وقت؟'); return true; }
    const first = tasks.find((x) => x.status === 'pending');
    const plan = tasks.map((x) => x.n + ') ' + x.title + ' — ' + dur(x.minutes)).join('\n');
    await say('تمام، هذا برنامجك:\n' + plan + '\n\n' + (first ? startTask(member, c, first) : ''));
    return true;
  }
  if (c.state === 'ask_problem' && active) {
    active.problem = text.slice(0, 300); active.status = 'problem';
    openIssue({ emp: member.id, name: member.name, taskId: active.id, task: active.title, kind: 'problem', text: active.problem, date: t.date });
    c.state = 'ask_next';
    await say('سجّلت المشكلة ووصلت للإدارة. شو القرار؟\n1 أنتقل للمهمة الجاية\n2 أكمل فيها وبدي وقت');
    return true;
  }
  if (c.state === 'ask_next') {
    const act = tasks.find((x) => x.status === 'problem') || active;
    if (/^(1|أنتقل|انتقل|التالية|الجاية)/.test(text)) {
      if (act) { act.status = 'skipped'; act.endedAt = Date.now(); if (!ST.issues.some((i) => i.taskId === act.id && i.kind === 'not_done')) openIssue({ emp: member.id, name: member.name, taskId: act.id, task: act.title, kind: 'not_done', text: act.problem || '', date: t.date }); }
      await say(finishOrNext(member, c, t.date));
      return true;
    }
    if (/^(2|أكمل|اكمل|بكمل)/.test(text)) { if (act) act.status = 'active'; c.state = 'ask_more'; await say('كم بدك وقت زيادة؟'); return true; }
    await say(g(member,'ردّ','ردّي') + ' بـ 1 (أنتقل للمهمة الجاية) أو 2 (أكمل فيها)'); return true;
  }
  if (c.state === 'ask_more' && active) {
    const d = parseDuration(text);
    if (d == null) { await say(g(member,'اكتب','اكتبي') + ' الوقت مثلاً: 30 دقيقة أو ساعة'); return true; }
    active.extensions = (active.extensions || []).concat({ minutes: d, at: Date.now() });
    active.dueAt = Date.now() + d * 60000; active.status = 'active'; c.state = 'working'; c.askedAt = 0;
    await say('تمام، برجعلك بعد ' + dur(d) + '.');
    return true;
  }
  if (active && DONE_RE.test(text)) {
    active.status = 'done'; active.doneAt = Date.now();
    await say('ممتاز 👏 ' + finishOrNext(member, c, t.date));
    return true;
  }
  if (c.state === 'await_status' && active) {
    if (PROBLEM_RE.test(text)) { c.state = 'ask_problem'; await say('شو المشكلة؟ ' + g(member,'اكتبها','اكتبيها') + ' بسطر واحد'); return true; }
    if (MORE_RE.test(text)) { c.state = 'ask_more'; await say('كم بدك وقت زيادة؟'); return true; }
    await say(g(member,'ردّ','ردّي') + ' برقم:\n1 أنجزت\n2 صار معي مشكلة\n3 بدي وقت');
    return true;
  }
  if (active && (PROBLEM_RE.test(text))) { c.state = 'ask_problem'; await say('شو المشكلة؟ ' + g(member,'اكتبها','اكتبيها') + ' بسطر واحد'); return true; }
  // new task list?
  const items = parseTasks(text);
  if (items.length) {
    const existing = tasks.length;
    const base = existing;
    items.forEach((title, i) => ST.wtasks.push({ id: 'W-' + t.date.replace(/-/g, '') + '-' + member.id + '-' + (base + i + 1), n: base + i + 1, emp: member.id, date: t.date, title, minutes: null, status: 'pending', createdAt: Date.now(), chat: chatId }));
    const cut = addDays(t.date, -60); ST.wtasks = ST.wtasks.filter((x) => x.date >= cut);
    c.state = 'ask_dur'; c.chat = chatId;
    const list = items.map((x, i) => (base + i + 1) + ') ' + x).join('\n');
    const first = todays(member.id, t.date).find((x) => x.minutes == null);
    await say('سجّلت ' + items.length + ' مهام:\n' + list + '\n\nكم بدك وقت لكل وحدة؟ ' + g(member,'ابدأ','ابدئي') + ' بالمهمة ' + first.n + ': ' + first.title + '\n(مثلاً: ساعة، 30 دقيقة، ساعتين. أو ' + g(member,'ردّ','ردّي') + ' عليهم كلهم مرة وحدة: 1 ساعة، 2 نص ساعة)');
    return true;
  }
  return false;
}

async function flowTick() {
  const s = settings();
  const t = local();
  const now = Date.now();
  for (const task of ST.wtasks) {
    if (task.status !== 'active' || task.date !== t.date) continue;
    const member = team().find((m) => m.id === task.emp); if (!member) continue;
    const c = convoOf(member.id);
    const chat = chatFor(member, c);
    const name = nameOf(member);
    const pre = chat.endsWith('@g.us') ? name + '، ' : '';
    if (c.state === 'working' && task.dueAt && now >= task.dueAt) {
      c.state = 'await_status'; c.askedAt = now; c.chat = c.chat || chat;
      try { await sendText(chat, pre + 'خلص وقت المهمة ' + task.n + ': ' + task.title + '\nشو صار؟\n1 أنجزت\n2 صار معي مشكلة\n3 بدي وقت'); } catch (e) { log('[flow] ask failed', e.message); }
      continue;
    }
    if (c.state === 'await_status' && c.askedAt) {
      const waited = now - c.askedAt;
      if (waited > 40 * 60000 && !c.nudged) { c.nudged = true; try { await sendText(chat, pre + 'لسا بانتظار ردك عن المهمة ' + task.n + ' (' + task.title + '): 1 أنجزت، 2 مشكلة، 3 بدي وقت'); } catch (e) { /* ignore */ } }
      if (waited > 100 * 60000 && !c.flagged) { c.flagged = true; openIssue({ emp: member.id, name: member.name, taskId: task.id, task: task.title, kind: 'no_reply', text: 'ما ردّت على سؤال المتابعة لأكثر من ساعة ونص', date: t.date }); }
    }
  }
  // end of day: close what is left
  if (toMin(t.time) >= toMin(s.eod) && toMin(t.time) < toMin(s.eod) + 30) {
    for (const task of ST.wtasks) {
      if (task.date !== t.date || !['active', 'pending', 'problem'].includes(task.status)) continue;
      task.status = 'skipped'; task.endedAt = now;
      const member = team().find((m) => m.id === task.emp);
      if (!ST.issues.some((i) => i.taskId === task.id)) openIssue({ emp: task.emp, name: member ? member.name : task.emp, taskId: task.id, task: task.title, kind: 'not_done', text: 'انتهى اليوم والمهمة ما أُنجزت', date: t.date });
      if (member) convoOf(member.id).state = 'idle';
    }
  }
  saveFlow();
}

/* ---------------- Claude answers (optional) ---------------- */
async function claudeReply(member, txt) {
  if (!CLAUDE_KEY) return null;
  const s = settings();
  const t = local();
  const mine = todays(member.id, t.date).map((x) => x.n + ') ' + x.title + ' — ' + reportTask(x)).join('\n') || 'ما سجّل مهام اليوم';
  const assigned = appTasks().filter((x) => x.emp === member.id && x.status !== 'done').map((x) => '- ' + x.title + ' (الموعد ' + x.due + ')').join('\n') || 'لا شيء';
  const sys = 'أنت «زمام»، المدير الذكي لفريق ' + (s.company || 'الشركة') + '. تكلم بالعامية الفلسطينية ببساطة وإيجاز (سطرين أو ثلاثة). الموظف اسمه ' + member.name + '. دوامه يبدأ ' + (member.start || s.start) + '. مهامه اليوم من القروب:\n' + mine + '\nمهام مسندة له من المدير:\n' + assigned + '\nلو سألك عن شيء خارج الشغل جاوب باختصار ورجّعه لمهامه. لا تخترع قرارات إدارية؛ قل إنك بترفعها للمدير.';
  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-haiku-4-5', max_tokens: 300, system: sys, messages: [{ role: 'user', content: txt.slice(0, 1000) }] }, { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 });
    const out = (r.data && r.data.content || []).map((c) => c.text || '').join('').trim();
    return out || null;
  } catch (e) { log('[claude]', e.response ? e.response.status : e.message); return null; }
}

/* ---------------- inbound ---------------- */
async function handleGroup(p) {
  const gid = String(p.from || '');
  const mid = String((p.id && (p.id._serialized || p.id)) || '');
  if (mid) { if (done.has(mid)) return; done.add(mid); if (done.size > 5000) done.clear(); }
  const txt = String(p.body || '').trim();
  if (p.fromMe && !BIND_RE.test(txt)) return;
  ST.seen[gid] = { id: gid, at: new Date().toISOString(), text: txt.slice(0, 40) };
  if (BIND_RE.test(txt) && (!ST.group.id || ST.group.id === gid)) {
    ST.group = { id: gid, boundAt: new Date().toISOString() };
    jsave('group.json', ST.group);
    log('[group] bound', gid);
    try { await sendText(gid, 'تمام. من هلأ بسجّل الحضور من هالقروب تلقائياً: أول رسالة لكل واحد بالصبح = دخول، ورسالة فيها «خروج» = خروج.\nولما تكتبوا مهامكم بنقاط، بسألكم كم بدكم وقت لكل وحدة وبتابع معكم.'); } catch (e) { /* ignore */ }
    return;
  }
  if (!ST.group.id || gid !== ST.group.id) return;
  const { sid, phone } = await senderPhone(p);
  const pushName = p.notifyName || (p._data && p._data.notifyName) || '';
  const member = matchTeam(phone, pushName);
  const t = local(p.timestamp);
  const key = member ? member.id : '?' + (phone || digits(sid) || pushName || 'x');
  let handled = false;
  if (member && !member.manager) { const c = convoOf(member.id); handled = await handleFlow(member, c, txt, mid, gid, t); saveFlow(); }
  const exists = ST.att.find((r) => r.date === t.date && r.emp === key);
  const isIn = IN_RE.test(txt) || handled || ['image', 'location', 'live_location'].includes(String(p.type || (p._data && p._data.type) || ''));
  if (!exists && !isIn) return;
  const rec = recordAttendance(key, member, pushName, phone, t, txt);
  if (rec && member && mid && !p._noReact && !handled) react(mid, '✅');
}
async function handleDirect(p) {
  if (p.fromMe) return;
  const mid = String((p.id && (p.id._serialized || p.id)) || '');
  if (mid) { if (done.has(mid)) return; done.add(mid); }
  const txt = String(p.body || '').trim();
  if (!txt) return;
  const { phone } = await senderPhone(p);
  const member = matchTeam(phone, p.notifyName || '');
  if (!member || member.manager) return;
  const t = local(p.timestamp);
  const chat = String(p.from || '');
  const c = convoOf(member.id);
  const handled = await handleFlow(member, c, txt, mid, chat, t);
  saveFlow();
  const exists = ST.att.find((r) => r.date === t.date && r.emp === member.id);
  if (!exists && (IN_RE.test(txt) || handled)) { const rec = recordAttendance(member.id, member, '', phone, t, txt); if (rec && mid && !handled) react(mid, '✅'); return; }
  if (exists && OUT_RE.test(txt)) { const rec = recordAttendance(member.id, member, '', phone, t, txt); if (rec && mid) react(mid, '✅'); return; }
  if (!handled && txt.length > 6) { const a = await claudeReply(member, txt); if (a) { try { await sendText(chat, a); } catch (e) { /* ignore */ } } }
}
async function onEvent(ev) {
  if (!ev || !ev.event) return;
  if (ev.event === 'session.status') { log('[waha] status', ev.payload && ev.payload.status); return; }
  if (ev.event !== 'message' && ev.event !== 'message.any') return;
  const p = ev.payload || {};
  const from = String(p.from || '');
  if (from.endsWith('@g.us')) return handleGroup(p);
  if (from.endsWith('@c.us') || from.endsWith('@lid') || from.endsWith('@s.whatsapp.net')) return handleDirect(p);
}

/* ---------------- reminders ---------------- */
function markSent(k, date) { ST.sent[k] = date; const cut = addDays(local().date, -10); for (const x of Object.keys(ST.sent)) if (ST.sent[x] < cut) delete ST.sent[x]; jsave('sent.json', ST.sent); }
const within = (now, target, span) => now >= target && now < target + span;
const dayWord = (n) => (n === 1 ? 'يوم' : n === 2 ? 'يومين' : n + ' أيام');
async function remindTick() {
  const s = settings();
  const t = local();
  if (!(s.workdays || DEF.workdays).includes(t.dow)) return;
  const now = toMin(t.time);
  const staff = team().filter((m) => m.active !== false && !m.manager && digits(m.phone).length >= 9);
  const jobs = [];
  for (const m of staff) {
    const start = toMin(m.start || s.start);
    if (s.remindTasks !== false && within(now, start, 45) && ST.sent['tasks:' + m.id] !== t.date) {
      const mine = appTasks().filter((x) => x.emp === m.id && x.status !== 'done' && x.due && x.due <= t.date).sort((a, b) => (a.due < b.due ? -1 : 1)).slice(0, 8);
      if (mine.length) {
        const lines = mine.map((x, i) => { const late = Math.round((Date.parse(t.date) - Date.parse(x.due)) / 864e5); return (i + 1) + ') ' + x.title + (late > 0 ? ' (متأخرة ' + dayWord(late) + ')' : ''); });
        jobs.push({ key: 'tasks:' + m.id, to: m.phone, text: 'صباح الخير ' + nameOf(m) + '، مهامك من المدير لليوم:\n' + lines.join('\n') + '\n\n' + g(m,'اكتب','اكتبي') + ' مهامك اليوم بنقاط في قروب الحضور وبتابع معك وحدة وحدة.' });
      } else ST.sent['tasks:' + m.id] = t.date;
    }
    const due = start + Number(s.grace || 0);
    if (s.remindCheckin !== false && within(now, due, 45) && ST.sent['checkin:' + m.id] !== t.date) {
      const rec = ST.att.find((r) => r.date === t.date && r.emp === m.id);
      if (!rec) jobs.push({ key: 'checkin:' + m.id, to: m.phone, text: 'صباح الخير ' + nameOf(m) + '، ما وصلنا تسجيل دخولك اليوم. لما ' + g(m,'توصل ابعت','توصلي ابعتي') + ' «وصلت» في قروب الحضور.' });
      else ST.sent['checkin:' + m.id] = t.date;
    }
  }
  const mgr = manager();
  if (mgr && s.remindSummary !== false && within(now, toMin(s.summaryAt), 45) && ST.sent.summary !== t.date) {
    const present = staff.filter((m) => ST.att.some((r) => r.date === t.date && r.emp === m.id));
    const absent = staff.filter((m) => !present.includes(m));
    const wt = ST.wtasks.filter((x) => x.date === t.date);
    const open = ST.issues.filter((i) => i.status === 'open');
    const text = 'ملخص اليوم من زمام\n' +
      'الحضور: ' + present.length + ' من ' + staff.length + (absent.length ? ' (ما سجّلوا: ' + absent.map(nameOf).join('، ') + ')' : '') +
      '\nمهام الفريق اليوم: ' + wt.length + ' (أُنجزت ' + wt.filter((x) => x.status === 'done').length + '، ما أُنجزت ' + wt.filter((x) => x.status === 'skipped').length + ')' +
      (open.length ? '\nبانتظار قرارك: ' + open.length + '\n' + open.slice(0, 5).map((i) => '- ' + i.name + ': ' + i.task + (i.text ? ' (' + i.text.slice(0, 60) + ')' : '')).join('\n') : '\nما في شي بانتظار قرارك.') +
      (PUBLIC_URL ? '\n\n' + PUBLIC_URL : '');
    jobs.push({ key: 'summary', to: mgr.phone, text });
  }
  if (!jobs.length) { jsave('sent.json', ST.sent); return; }
  const w = await wahaSession();
  if (w.status !== 'WORKING') return;
  for (const j of jobs) {
    try { await sendText(digits(j.to) + '@c.us', j.text); markSent(j.key, t.date); log('[remind] sent', j.key); }
    catch (e) { log('[remind] failed', j.key, e.response ? e.response.status : e.message); }
    await sleep(1500);
  }
}

/* ---------------- HTTP ---------------- */
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });

app.post('/inbound', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (HOOK_SECRET) {
    const got = String(req.get('x-webhook-hmac') || '');
    const want = crypto.createHmac('sha512', HOOK_SECRET).update(raw).digest('hex');
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });
  let ev = null;
  try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
  setImmediate(() => onEvent(ev).catch((e) => console.error('[inbound]', e.message)));
});

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '600' };
app.options(/^\/admin\/.*/, (req, res) => res.set(CORS).sendStatus(204));
function auth(req, res) {
  res.set(CORS);
  if (!ADMIN_SECRET) { res.status(503).json({ ok: false, error: 'ADMIN_SECRET_NOT_SET' }); return false; }
  const got = String(req.get('X-Admin-Secret') || '');
  if (got.length !== ADMIN_SECRET.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(ADMIN_SECRET))) { res.status(401).json({ ok: false, error: 'BAD_SECRET' }); return false; }
  return true;
}
const json = express.json({ limit: '2mb' });
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect('/app'));
app.get(['/app', '/app/'], (req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'X-Frame-Options': 'SAMEORIGIN' });
  const custom = path.join(DATA, 'app.html');
  res.sendFile(fs.existsSync(custom) ? custom : path.join(PUBLIC, 'index.html'), (e) => { if (e) res.status(404).type('text/plain').send('app not found'); });
});
app.get('/admin/ping', async (req, res) => { if (!auth(req, res)) return; const w = await wahaSession(); res.json({ ok: true, whatsapp: w.status, me: w.me, time: new Date().toISOString(), v: 24 }); });
app.post('/admin/wa/start', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const w = await wahaSession();
    if (w.status === 'MISSING') await axios.post(WAHA_URL + '/api/sessions', { name: SESSION, start: true, config: { webhooks: webhookConfig() } }, { headers: WH(), timeout: 20000 });
    else if (w.status === 'FAILED') {
      try { await axios.post(WAHA_URL + '/api/sessions/' + SESSION + '/logout', {}, { headers: WH(), timeout: 20000 }); } catch (e) { /* ignore */ }
      await sleep(3000);
      const w2 = await wahaSession();
      if (w2.status === 'STOPPED' || w2.status === 'FAILED') await axios.post(WAHA_URL + '/api/sessions/' + SESSION + '/start', {}, { headers: WH(), timeout: 20000 });
    } else if (w.status === 'STOPPED') await axios.post(WAHA_URL + '/api/sessions/' + SESSION + '/start', {}, { headers: WH(), timeout: 20000 });
    await sleep(4000);
    const after = await wahaSession();
    res.json({ ok: true, whatsapp: after.status });
  } catch (e) { res.status(500).json({ ok: false, error: (e.response && JSON.stringify(e.response.data).slice(0, 200)) || e.message }); }
});
app.get('/admin/wa/qr', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const r = await axios.get(WAHA_URL + '/api/' + SESSION + '/auth/qr?format=image', { headers: Object.assign({ Accept: 'image/png' }, WH()), responseType: 'arraybuffer', timeout: 15000 });
    res.set('Cache-Control', 'no-store').type('image/png').send(Buffer.from(r.data));
  } catch (e) { res.status(409).json({ ok: false, error: 'NO_QR' }); }
});
app.post('/admin/send', json, async (req, res) => {
  if (!auth(req, res)) return;
  const body = req.body || {};
  const to = (Array.isArray(body.to) ? body.to : [body.to]).map(digits).filter((p) => p.length >= 9);
  const text = String(body.text || '').trim();
  if (!text || !to.length) return res.status(400).json({ ok: false, error: 'TO_AND_TEXT_REQUIRED' });
  const w = await wahaSession();
  if (w.status !== 'WORKING') return res.status(409).json({ ok: false, error: 'WHATSAPP_' + w.status });
  let sent = 0; const failed = [];
  for (const phone of to) { try { await sendText(phone + '@c.us', text); sent++; } catch (e) { failed.push(phone); } if (to.length > 1) await sleep(1500); }
  res.json({ ok: failed.length === 0, sent, failed });
});
function fixUnknown() {
  let fix = 0;
  for (const r of ST.att) if (String(r.emp).startsWith('?') && r.phone) { const m = matchTeam(r.phone, ''); if (m) { r.emp = m.id; r.name = m.name; r.known = true; fix++; } }
  if (fix) jsave('attendance.json', ST.att);
}
app.get('/admin/attendance', (req, res) => {
  if (!auth(req, res)) return;
  fixUnknown();
  const from = String(req.query.from || '0000-00-00'), to = String(req.query.to || '9999-99-99');
  res.json({ ok: true, today: local().date, group: ST.group.id ? { id: ST.group.id, boundAt: ST.group.boundAt } : null, records: ST.att.filter((r) => r.date >= from && r.date <= to) });
});
app.get('/admin/feed', (req, res) => {
  if (!auth(req, res)) return;
  fixUnknown();
  const from = String(req.query.from || addDays(local().date, -35));
  res.json({ ok: true, today: local().date, time: local().time, group: ST.group.id ? { id: ST.group.id, boundAt: ST.group.boundAt } : null,
    records: ST.att.filter((r) => r.date >= from), wtasks: ST.wtasks.filter((x) => x.date >= from), issues: ST.issues.filter((i) => i.status === 'open' || i.at.slice(0, 10) >= from),
    convo: Object.fromEntries(Object.entries(ST.convo).map(([k, c]) => [k, { state: c.state, day: c.day }])), stateAt: ST.state ? ST.state.updatedAt || 0 : 0 });
});
app.post('/admin/issue', json, async (req, res) => {
  if (!auth(req, res)) return;
  const b = req.body || {};
  const it = ST.issues.find((i) => i.id === String(b.id));
  if (!it) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  it.status = 'resolved'; it.decision = String(b.decision || 'none'); it.penalty = b.penalty || null; it.note = String(b.note || '').slice(0, 300); it.resolvedAt = new Date().toISOString();
  jsave('issues.json', ST.issues);
  res.json({ ok: true });
});
app.get('/admin/state', (req, res) => { if (!auth(req, res)) return; res.json({ ok: true, state: ST.state || null }); });
app.put('/admin/state', json, (req, res) => {
  if (!auth(req, res)) return;
  const st = req.body && req.body.state;
  if (!st || typeof st !== 'object' || !Array.isArray(st.team)) return res.status(400).json({ ok: false, error: 'BAD_STATE' });
  if (st.db) st.db = { botUrl: st.db.botUrl || '' };   // never store the admin key or Airtable tokens on disk
  st.updatedAt = Number(st.updatedAt) || Date.now();
  if (ST.state && Number(ST.state.updatedAt) > st.updatedAt) return res.json({ ok: true, stale: true, updatedAt: ST.state.updatedAt });
  ST.state = st; jsave('state.json', ST.state);
  res.json({ ok: true, updatedAt: st.updatedAt });
});
app.post('/admin/team', json, (req, res) => {
  if (!auth(req, res)) return;
  const inc = (req.body && req.body.team) || [];
  if (!Array.isArray(inc) || !inc.length) return res.status(400).json({ ok: false, error: 'TEAM_REQUIRED' });
  const old = ST.team;
  ST.team = inc.map((m) => {
    const o = old.find((x) => x.id === String(m.id)) || {};
    let ph = digits(m.phone); if (ph.length < 10) ph = o.phone || '';
    const names = Array.from(new Set([m.name, m.short].concat(m.aliases || [], o.names || []).filter(Boolean).map(String)));
    return { id: String(m.id), name: String(m.name || o.name || ''), short: String(m.short || o.short || ''), names, phone: ph, manager: !!m.manager, active: m.active !== false, start: m.start || '', female: !!m.female };
  });
  jsave('team.json', ST.team);
  res.json({ ok: true, team: ST.team.map((m) => ({ id: m.id, phone: m.phone })) });
});
app.get('/admin/groups', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const r = await axios.get(WAHA_URL + '/api/' + SESSION + '/groups', { headers: WH(), timeout: 60000 });
    const arr = Array.isArray(r.data) ? r.data : Object.values(r.data || {});
    res.json({ ok: true, bound: ST.group.id || null, groups: arr.map((g) => ({ id: String((g.id && (g.id._serialized || g.id)) || g.JID || ''), name: g.name || g.subject || (g.groupMetadata && g.groupMetadata.subject) || '' })).filter((g) => g.id.endsWith('@g.us')) });
  } catch (e) { res.status(502).json({ ok: false, error: 'GROUPS_FAILED' }); }
});
app.post('/admin/group/bind', json, async (req, res) => {
  if (!auth(req, res)) return;
  const id = String((req.body && req.body.id) || '');
  if (!id.endsWith('@g.us')) return res.status(400).json({ ok: false, error: 'BAD_ID' });
  ST.group = { id, boundAt: new Date().toISOString() }; jsave('group.json', ST.group);
  res.json({ ok: true, group: ST.group });
});
app.post('/admin/group/reset', (req, res) => { if (!auth(req, res)) return; ST.group = { id: null }; jsave('group.json', ST.group); res.json({ ok: true }); });
app.post('/admin/test/inbound', json, async (req, res) => {   // lets the manager app simulate a message (used by tests)
  if (!auth(req, res)) return;
  if (!req.body || req.body.allow !== 'test') return res.status(400).json({ ok: false });
  await onEvent(req.body.event); res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => {
    log('zimam v24 listening on :' + PORT, '| tz', TZ, '| claude', CLAUDE_KEY ? 'on' : 'off');
    if (!ADMIN_SECRET) log('WARNING: ADMIN_SECRET is empty, the admin API is disabled');
    ensureSession().catch((e) => log('[waha] setup failed', e.message));
    setInterval(() => flowTick().catch((e) => log('[flow] error', e.message)), 30 * 1000);
    setInterval(() => remindTick().catch((e) => log('[remind] error', e.message)), 60 * 1000);
  });
}
module.exports = { app, onEvent, flowTick, remindTick, ST, local, settings, parseTasks, parseDuration, parseDurations };
