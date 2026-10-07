// Rex phone/desktop console (PWA). Talks to the Rex cloud brain (Supabase Edge Function)
// and live-updates from Supabase Realtime. Voice: Web Speech recognition + speechSynthesis.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://vxhzbvwkiwhqqzaesffg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_zhCONuGjbQlrXlJCBF2qdQ_Ay-GHK_e'; // publishable (public) key; data is protected by RLS
const OWNER = 'isaiahburgei5@gmail.com';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let busy = false;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- auth ----------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $('#signin').classList.remove('hidden'); return; }
  if (session.user.email?.toLowerCase() !== OWNER) { await sb.auth.signOut(); $('#signin').classList.remove('hidden'); return; }
  $('#app').classList.remove('hidden');
  start();
}
$('#signinBtn').onclick = async () => {
  $('#signinBtn').disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email: OWNER, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
  $('#signinMsg').textContent = error ? `Couldn't send: ${error.message}` : `Check ${OWNER} and tap the link on this device.`;
  $('#signinBtn').disabled = false;
};
sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' && $('#app').classList.contains('hidden')) location.reload(); });

// ---------- UI helpers ----------
function msg(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`; el.textContent = text;
  const t = $('#transcript'); t.append(el); t.scrollTop = t.scrollHeight;
  $('#tab-talk').scrollTop = $('#tab-talk').scrollHeight;
  return el;
}
function setState(s) { $('#state').textContent = s; orb.mode = s; }
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === `tab-${b.dataset.tab}`));
});

// ---------- speech out ----------
let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  voice = vs.find((v) => /premium|enhanced/i.test(v.name) && /Evan|Reed|Daniel|Aaron|Nathan|Tom/i.test(v.name))
    || vs.find((v) => /Daniel|Aaron|Evan|Reed|Nathan|Tom|Alex/i.test(v.name)) || vs[0] || null;
}
speechSynthesis.onvoiceschanged = pickVoice; pickVoice();
let unlocked = false;
function unlockAudio() { if (unlocked) return; unlocked = true; const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
function speak(text) {
  if (!text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/https?:\/\/\S+/g, 'the link').replace(/[*_#`]/g, ''));
  if (voice) u.voice = voice;
  u.rate = 1.05;
  u.onstart = () => { orb.level = 0.6; setState('speaking'); };
  u.onboundary = () => { orb.level = 0.4 + Math.random() * 0.5; };
  u.onend = () => { orb.level = 0; setState(busy ? 'working' : 'tap & hold to talk'); };
  speechSynthesis.speak(u);
}

// ---------- talk to Rex ----------
async function ask(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true; msg('isaiah', text); setState('thinking');
  const ack = setTimeout(() => { if (busy) speak(['On it.', 'Let me check.', 'Give me a second.'][Math.floor(Math.random() * 3)]); }, 1500);
  try {
    const { data, error } = await sb.functions.invoke('rex/chat', { body: { text } });
    clearTimeout(ack);
    const reply = error ? `I couldn't reach my brain: ${error.message}` : data.reply;
    msg('rex', reply); speak(reply);
  } catch (e) { clearTimeout(ack); msg('sys', 'Network problem — try again.'); }
  finally { busy = false; if (!speechSynthesis.speaking) setState('tap & hold to talk'); }
}
$('#chatForm').onsubmit = (e) => { e.preventDefault(); unlockAudio(); const v = $('#chatInput').value; $('#chatInput').value = ''; $('#chatInput').blur(); ask(v); };

// Hold-to-talk with the browser's speech recognition (iOS Safari/Chrome). Falls back to keyboard dictation.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, heard = '', holding = false;
function micDown(e) {
  e.preventDefault(); unlockAudio(); speechSynthesis.cancel();
  if (!SR) { $('#chatInput').focus(); msg('sys', 'Voice input isn’t available here — use the keyboard mic to dictate.'); return; }
  holding = true; heard = '';
  rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true;
  rec.onresult = (ev) => { heard = Array.from(ev.results).map((r) => r[0].transcript).join(' '); $('#chatInput').value = heard; orb.level = 0.5; };
  rec.onerror = (ev) => { if (ev.error === 'not-allowed') msg('sys', 'Microphone blocked — allow it in Settings for this app.'); };
  rec.onend = () => { $('#mic').classList.remove('rec'); orb.level = 0; if (!holding && heard.trim()) { $('#chatInput').value = ''; ask(heard); } else if (!holding) setState('tap & hold to talk'); };
  try { rec.start(); $('#mic').classList.add('rec'); setState('listening'); } catch {}
}
function micUp(e) { e.preventDefault(); if (!holding) return; holding = false; try { rec?.stop(); } catch {} }
$('#mic').addEventListener('pointerdown', micDown);
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => $('#mic').addEventListener(t, micUp));

// ---------- data ----------
const KIND = { email_draft: 'Reply draft', task: 'Build task', merge: 'Merge', proposal: 'Decision', suspicious: 'Flagged' };
async function loadQueue() {
  const { data } = await sb.from('approvals').select('*').eq('status', 'pending').order('ts', { ascending: false });
  $('#qCount').textContent = data?.length ?? 0;
  $('#queue').innerHTML = data?.length ? data.map((a) => `
    <div class="item ${a.kind}"><div class="k">${KIND[a.kind] || a.kind} · #${a.id}</div>
      <div class="t">${esc(a.title)}</div>${a.detail ? `<div class="d">${esc(a.detail)}</div>` : ''}
      <div class="actions">${a.kind === 'suspicious' ? '' : `<button class="ok" data-id="${a.id}" data-a="approve">Approve</button>`}
        <button class="no" data-id="${a.id}" data-a="reject">${a.kind === 'suspicious' ? 'Dismiss' : 'Reject'}</button>
        ${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">Open</a>` : ''}</div></div>`).join('')
    : '<div class="empty">Nothing needs you. Rex is on it.</div>';
}
$('#queue').onclick = async (e) => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  b.disabled = true;
  const { data } = await sb.functions.invoke('rex/decide', { body: { id: Number(b.dataset.id), action: b.dataset.a } });
  if (data?.message) msg('sys', data.message);
  if (data?.open) window.open(data.open, '_blank');
  loadQueue();
};
async function loadBrief() {
  const { data } = await sb.from('briefs').select('*').order('ts', { ascending: false }).limit(1);
  if (data?.[0]) $('#briefText').textContent = data[0].text;
}
$('#playBrief').onclick = () => { unlockAudio(); speak($('#briefText').textContent); };
function feedItem(e, prepend = true) {
  const el = document.createElement('div'); el.className = `ev ${e.kind}`;
  el.innerHTML = `<div class="w">${new Date(e.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${esc(e.agent || 'rex')} · ${esc(e.kind)}</div>${esc(e.title)}`;
  prepend ? $('#feed').prepend(el) : $('#feed').append(el);
}
async function loadFeed() {
  const { data } = await sb.from('events').select('*').order('ts', { ascending: false }).limit(60);
  $('#feed').innerHTML = ''; (data || []).forEach((e) => feedItem(e, false));
}
async function loadHistory() {
  const { data } = await sb.from('messages').select('*').order('ts', { ascending: false }).limit(20);
  (data || []).reverse().forEach((m) => msg(m.role, m.text));
}

function start() {
  loadHistory(); loadQueue(); loadBrief(); loadFeed();
  sb.channel('rex-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'approvals' }, loadQueue)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'briefs' }, (p) => { $('#briefText').textContent = p.new.text; })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (p) => feedItem(p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
      if (p.new.role === 'rex' && p.new.channel === 'task') { msg('rex', p.new.text); speak(p.new.text); }
    })
    .subscribe((s) => { $('#status').classList.toggle('off', s !== 'SUBSCRIBED'); $('#statusText').textContent = s === 'SUBSCRIBED' ? 'ONLINE' : 'RECONNECTING'; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadQueue(); loadBrief(); } });
}

// ---------- orb ----------
const orb = { level: 0, mode: 'idle' };
(function drawOrb() {
  const c = $('#orb'), g = c.getContext('2d');
  const t0 = performance.now(); let sm = 0;
  (function frame(now) {
    const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = c.clientHeight * devicePixelRatio;
    const t = (now - t0) / 1000; sm += (orb.level - sm) * 0.15;
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.26 * (1 + sm * 0.25);
    const col = /think|work/.test(orb.mode) ? '255,181,71' : /listen/.test(orb.mode) ? '76,195,255' : '54,230,200';
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
    grd.addColorStop(0, `rgba(${col},.9)`); grd.addColorStop(.35, `rgba(${col},.35)`); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, R * 1.9, 0, 7); g.fill();
    g.strokeStyle = `rgba(${col},.5)`; g.lineWidth = 1.5 * devicePixelRatio;
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      for (let a = 0; a <= 6.3; a += 0.05) {
        const r = R * (1.25 + i * 0.22) + Math.sin(a * (3 + i) + t * (1.2 + i * .4)) * R * (0.04 + sm * 0.12);
        const x = cx + Math.cos(a + t * (i % 2 ? -.3 : .3)) * r, y = cy + Math.sin(a + t * (i % 2 ? -.3 : .3)) * r * 0.92;
        a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath(); g.stroke();
    }
    requestAnimationFrame(frame);
  })(t0);
})();

boot();
