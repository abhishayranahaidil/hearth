/* Hearth — household app
   Offline-first. The Sheet is the truth; the phone always holds a copy.
   Writes go to a queue on the phone and leave when there is signal. */

const VERSION = '0.2.0';
const TABS = ['subjects','obligations','payments','activities','events',
              'documents','readings','contacts','vocab'];

/* ------------------------------------------------------------ settings */

const cfg = {
  get endpoint(){ return localStorage.getItem('hearth.endpoint') || ''; },
  set endpoint(v){ localStorage.setItem('hearth.endpoint', v.trim()); },
  get token(){ return localStorage.getItem('hearth.token') || ''; },
  set token(v){ localStorage.setItem('hearth.token', v.trim()); },
  get who(){ return localStorage.getItem('hearth.who') || ''; },
  set who(v){ localStorage.setItem('hearth.who', v); },
  get ready(){ return !!(this.endpoint && this.token); }
};

/* ------------------------------------------------------------ storage */

let db;
function openDB(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('hearth', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      TABS.forEach(t => { if(!d.objectStoreNames.contains(t)) d.createObjectStore(t,{keyPath:'id'}); });
      if(!d.objectStoreNames.contains('queue')) d.createObjectStore('queue',{autoIncrement:true});
      if(!d.objectStoreNames.contains('meta'))  d.createObjectStore('meta',{keyPath:'k'});
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
const tx = (store, mode='readonly') => db.transaction(store, mode).objectStore(store);
const done = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function putAll(store, rows){
  const t = db.transaction(store,'readwrite').objectStore(store);
  t.clear();
  (rows||[]).forEach(r => { if(r && r.id) t.put(r); });
  return new Promise(res => t.transaction.oncomplete = res);
}
const getAll = store => done(tx(store).getAll());
const putOne = (store, row) => done(tx(store,'readwrite').put(row));
const dropOne = (store, id) => done(tx(store,'readwrite').delete(id));

/* ------------------------------------------------------------ bridge */

async function call(action, payload = {}){
  if(!cfg.ready) throw new Error('Not set up yet.');
  const res = await fetch(cfg.endpoint, {
    method:'POST',
    // text/plain avoids a CORS preflight Apps Script cannot answer
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body: JSON.stringify({ ...payload, action, token: cfg.token })
  });
  const out = await res.json();
  if(!out.ok) throw new Error(out.message || out.error || 'The bridge refused that.');
  return out;
}

/* ------------------------------------------------------------ state */

const S = {};
TABS.forEach(t => S[t] = []);
let queueLen = 0;

async function loadLocal(){
  for(const t of TABS) S[t] = await getAll(t);
  queueLen = await done(tx('queue').count());
}

async function sync({quiet = false} = {}){
  if(!cfg.ready){ setStatus('off','Not set up'); return; }
  if(!navigator.onLine){ setStatus('off', queueLen ? queueLen+' waiting' : 'Offline'); return; }
  setStatus('busy','Syncing');
  try{
    await flush();
    const out = await call('pull');
    for(const t of TABS) await putAll(t, out.data[t]);
    if(out.who) cfg.who = out.who;
    await done(tx('meta','readwrite').put({k:'lastSync', v: Date.now()}));
    await loadLocal();
    setStatus('ok','Synced');
    render();
  }catch(e){
    setStatus('err', e.message.slice(0,28));
    if(!quiet) toast(e.message);
  }
}

async function enqueue(action, payload){
  await done(tx('queue','readwrite').add({action, payload, at: Date.now()}));
  queueLen++;
  updateBadge();
  flush().catch(()=>{});
}

async function flush(){
  const store = db.transaction('queue','readwrite').objectStore('queue');
  const keys = await done(store.getAllKeys());
  const items = await done(store.getAll());
  for(let i = 0; i < items.length; i++){
    try{
      await call(items[i].action, items[i].payload);
      await done(tx('queue','readwrite').delete(keys[i]));
      queueLen = Math.max(0, queueLen - 1);
    }catch(e){
      if(/auth/i.test(e.message)) throw e;
      break;   // no signal, or the bridge is unhappy — try again later
    }
  }
  updateBadge();
}

/* Optimistic local write, then queue. Capture must never fail. */
async function save(tab, row){
  const now = new Date().toISOString();
  if(!row.id){
    row.id = 'tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    row.created_at = now;
    row._pending = 'new';
  }
  row.updated_at = now;
  row.who = row.who || cfg.who || 'me';
  await putOne(tab, row);
  S[tab] = await getAll(tab);
  const clean = {...row}; delete clean._pending;
  if(String(clean.id).startsWith('tmp_')) delete clean.id;
  await enqueue('upsert', {tab, row: clean});
  return row;
}

async function remove(tab, id){
  await dropOne(tab, id);
  S[tab] = await getAll(tab);
  if(!String(id).startsWith('tmp_')) await enqueue('remove', {tab, id});
}

/* ------------------------------------------------------------ dates */

const iso = d => { const p = n => ('0'+n).slice(-2);
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); };
const today = () => iso(new Date());
function parse(s){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s||'').trim());
  return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
}
function daysTo(s){
  const d = parse(s); if(!d) return null;
  const t = parse(today());
  return Math.round((d - t) / 86400000);
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function pretty(s){
  const d = parse(s); if(!d) return '—';
  return d.getDate()+' '+MON[d.getMonth()]+
    (d.getFullYear() !== new Date().getFullYear() ? ' '+d.getFullYear() : '');
}
function markOf(n){
  if(n === null) return {b:'—', s:'', cls:''};
  if(n < 0)   return {b:String(-n), s: -n===1?'day late':'days late', cls:'past'};
  if(n === 0) return {b:'today',    s:'', cls:'past'};
  if(n < 31)  return {b:String(n),  s: n===1?'day':'days', cls: n<=7?'soon':''};
  const d = parse(dateOfDays(n));
  return {b:String(d.getDate()), s: MON[d.getMonth()], cls:''};
}
function dateOfDays(n){ const d = parse(today()); d.setDate(d.getDate()+n); return iso(d); }

/* ------------------------------------------------------------ money */

const PER_MONTH = { weekly:52/12, fortnightly:26/12, monthly:1, quarterly:1/3,
                    'half-yearly':1/6, yearly:1/12, '2-yearly':1/24, once:0 };
function monthly(o){
  const a = parseFloat(o.amount);
  if(isNaN(a)) return 0;
  const f = PER_MONTH[o.cadence];
  return f === undefined ? 0 : a * f;
}
const money = n => '£' + (Math.round(n*100)/100).toLocaleString('en-GB',
  {minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2});

const liveObligations = () => S.obligations.filter(o => o.status !== 'finished');
const subjectOf = id => S.subjects.find(s => s.id === id);
const nameOf = id => (subjectOf(id) || {}).name || '';
const vocabList = list => S.vocab.filter(v => v.list === list && v.active !== 'no')
  .sort((a,b) => (+a.sort||0) - (+b.sort||0)).map(v => v.value);

/* ------------------------------------------------------------ shell */

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

let screen = 'today';
let subjectOpen = null;
let datesView = 'month';
let datesAnchor = null;      // set on first render, once today() is available
let daySelected = null;

function setStatus(kind, text){
  $('#dot').className = 'dot ' + ({ok:'',busy:'busy',err:'err',off:'off'}[kind] ?? 'off');
  $('#syncTxt').textContent = text;
}
function updateBadge(){
  if(queueLen > 0) setStatus('busy', queueLen + ' waiting');
}
let toastTimer;
function toast(msg){
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openSheet(html){
  $('#panel').innerHTML = '<div class="grab"></div>' + html;
  $('#sheet').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheet(){
  $('#sheet').classList.remove('open');
  document.body.style.overflow = '';
}

/* ------------------------------------------------------------ rows */

function rowHTML(mark, title, meta, right, attrs = ''){
  return `<button class="row" ${attrs}>
    <span class="mark ${mark.cls}"><b class="num">${esc(mark.b)}</b><s>${esc(mark.s)}</s></span>
    <span class="body">
      ${right ? `<span class="amt num">${esc(right)}</span>` : ''}
      <h3>${esc(title)}</h3>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
    </span>
  </button>`;
}
const eyebrow = (label, count, right) =>
  `<div class="eyebrow">${esc(label)}${count !== undefined ? `<span class="count num">${count}</span>` : ''}${right ? `<span class="right">${esc(right)}</span>` : ''}</div>`;

/* ------------------------------------------------------------ screens */

function render(){
  if(!cfg.ready) return renderSetup();
  if(!datesAnchor) datesAnchor = today();
  const el = $('#screen');
  if(subjectOpen) el.innerHTML = viewSubject(subjectOpen);
  else if(screen === 'today')  el.innerHTML = viewToday();
  else if(screen === 'dates')  el.innerHTML = viewDates();
  else if(screen === 'money')  el.innerHTML = viewMoney();
  else if(screen === 'things') el.innerHTML = viewThings();
  document.querySelectorAll('nav button').forEach(b =>
    b.setAttribute('aria-current', String(b.dataset.screen === screen)));
}

/* --- upcoming, merged --- */
function upcoming(){
  const out = [];
  liveObligations().forEach(o => {
    if(!o.next_due) return;
    out.push({ date:o.next_due, kind:'obligation', id:o.id,
      title:o.title + ' due', sub:[o.provider, nameOf(o.subject_id)].filter(Boolean).join(' · '),
      amount:o.amount, review:o.review === 'true' || o.review === 'yes' });
    const n = parseInt(o.notice_days || 0, 10);
    if(n > 0){
      const d = parse(o.next_due); d.setDate(d.getDate() - n);
      const nd = iso(d);
      if(daysTo(nd) >= 0) out.push({ date:nd, kind:'notice', id:o.id,
        title:o.title + ' in ' + n + ' days',
        sub:[o.provider,'heads-up'].filter(Boolean).join(' · ') });
    }
  });
  S.events.forEach(e => { if(e.on_date) out.push({ date:e.on_date, kind:'event', id:e.id,
    title:e.title, sub:[e.start_time, e.venue, nameOf(e.subject_id)].filter(Boolean).join(' · ') }); });
  S.documents.forEach(d => { if(d.expires_on) out.push({ date:d.expires_on, kind:'document', id:d.id,
    title:d.title + ' expires', sub:nameOf(d.subject_id) }); });
  return out.sort((a,b) => a.date < b.date ? -1 : 1);
}

function thisWeek(){
  const t = today();
  return S.activities.filter(a => {
    if(a.term_start && a.term_start > t) return false;
    if(a.term_end && a.term_end < t) return false;
    return !!a.day_of_week;
  }).sort((a,b) => {
    const d = DAYS.indexOf(String(a.day_of_week).toLowerCase()) -
              DAYS.indexOf(String(b.day_of_week).toLowerCase());
    return d || String(a.start_time).localeCompare(String(b.start_time));
  });
}

function viewToday(){
  const up = upcoming();
  const late = up.filter(i => daysTo(i.date) < 0);
  const soon = up.filter(i => { const d = daysTo(i.date); return d >= 0 && d <= 30; });
  const week = thisWeek();

  const committed = liveObligations().reduce((s,o) => s + monthly(o), 0);
  const m = today().slice(0,7);
  const spent = S.payments.filter(p => String(p.paid_on).startsWith(m))
    .reduce((s,p) => s + (parseFloat(p.amount)||0), 0);

  if(!S.obligations.length && !S.events.length){
    return `<div class="empty" style="padding-top:40px">
      <b>Nothing in here yet.</b>
      Tap + and say something like “car insurance renews 14 March, Admiral,
      six hundred and twenty pounds, remind me a month before”.</div>`;
  }

  let h = '';
  if(late.length) h += eyebrow('Overdue', late.length) +
    late.map(i => rowHTML(markOf(daysTo(i.date)), i.title, i.sub,
      i.amount ? money(+i.amount) : '', `data-open="${i.kind}:${i.id}"`)).join('');

  h += eyebrow('Next 30 days', soon.length);
  h += soon.length
    ? soon.map(i => rowHTML(markOf(daysTo(i.date)), i.title, i.sub,
        i.amount ? money(+i.amount) : '', `data-open="${i.kind}:${i.id}"`)).join('')
    : '<div class="empty">Clear month. Nothing falls due.</div>';

  if(week.length){
    h += eyebrow('Every week', week.length);
    h += week.map(a => rowHTML(
      {b: String(a.day_of_week).slice(0,3), s: a.start_time || '', cls:''},
      a.title, [nameOf(a.subject_id), a.venue].filter(Boolean).join(' · '),
      '', `data-open="activity:${a.id}"`)).join('');
  }

  h += eyebrow('Money', undefined, 'this month');
  h += `<div class="card">
    <div class="tot"><b class="num">${money(committed)}</b><span>committed each month</span></div>
    <div class="meta" style="margin-top:8px">${money(spent)} paid so far in ${MON[new Date().getMonth()]}</div>
  </div>`;
  return h;
}

/* --- everything happening on one day, including the weekly classes --- */
function itemsOn(dateStr){
  const out = [];
  const dow = DAYS[parse(dateStr).getDay()];

  liveObligations().forEach(o => {
    if(o.next_due === dateStr)
      out.push({kind:'obligation', id:o.id, title:o.title + ' due',
                sub:[o.provider, nameOf(o.subject_id)].filter(Boolean).join(' · '),
                amount:o.amount});
    const n = parseInt(o.notice_days || 0, 10);
    if(n > 0 && o.next_due){
      const nd = parse(o.next_due); nd.setDate(nd.getDate() - n);
      if(iso(nd) === dateStr)
        out.push({kind:'notice', id:o.id, title:o.title + ' in ' + n + ' days',
                  sub:[o.provider, 'heads-up'].filter(Boolean).join(' · ')});
    }
  });
  S.events.forEach(e => { if(e.on_date === dateStr)
    out.push({kind:'event', id:e.id, title:e.title,
              sub:[e.start_time, e.venue, nameOf(e.subject_id)].filter(Boolean).join(' · ')}); });
  S.activities.forEach(a => {
    if(String(a.day_of_week).toLowerCase() !== dow) return;
    if(a.term_start && a.term_start > dateStr) return;
    if(a.term_end && a.term_end < dateStr) return;
    out.push({kind:'activity', id:a.id, title:a.title,
              sub:[a.start_time, nameOf(a.subject_id), a.venue].filter(Boolean).join(' · ')});
  });
  S.documents.forEach(d => { if(d.expires_on === dateStr)
    out.push({kind:'document', id:d.id, title:d.title + ' expires',
              sub:nameOf(d.subject_id)}); });

  return out;
}

const KIND_ORDER = {notice:0, obligation:1, event:2, activity:3, document:4};
const dayItems = d => itemsOn(d).sort((a,b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

function shiftMonth(anchor, by){
  const d = parse(anchor);
  const n = new Date(d.getFullYear(), d.getMonth() + by, 1);
  return iso(n);
}
function startOfWeek(anchor){
  const d = parse(anchor);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // Monday first
  return iso(d);
}

function viewDates(){
  const seg = ['month','week','list'].map(v =>
    `<button class="seg${datesView === v ? ' on' : ''}" data-datesview="${v}">${v}</button>`).join('');
  let h = `<div class="segbar">${seg}</div>`;
  if(datesView === 'month') h += monthView();
  else if(datesView === 'week') h += weekView();
  else h += listView();
  return h;
}

function monthView(){
  const a = parse(datesAnchor);
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  const start = parse(iso(first));
  start.setDate(1 - ((first.getDay() + 6) % 7));

  let cells = '';
  for(let i = 0; i < 42; i++){
    const d = new Date(start.getTime()); d.setDate(start.getDate() + i);
    const ds = iso(d);
    const items = dayItems(ds);
    const out = d.getMonth() !== a.getMonth();
    const isToday = ds === today();
    const overdue = items.some(x => x.kind === 'obligation' && ds < today());
    const dots = items.slice(0,4).map(x =>
      `<i class="d-${overdue && x.kind === 'obligation' ? 'late' : x.kind}"></i>`).join('');
    cells += `<button class="cell${out?' out':''}${isToday?' today':''}${ds===daySelected?' sel':''}"
      data-day="${ds}"><b class="num">${d.getDate()}</b><span class="dots">${dots}</span></button>`;
  }

  const sel = daySelected || today();
  const list = dayItems(sel);

  return `
  <div class="calnav">
    <button class="btn ghost" data-month="-1" aria-label="Previous month">‹</button>
    <span class="caltitle">${MON[a.getMonth()]} ${a.getFullYear()}</span>
    <button class="btn ghost" data-month="1" aria-label="Next month">›</button>
  </div>
  <div class="calhead"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
  <div class="cal">${cells}</div>
  ${eyebrow(pretty(sel), list.length)}
  ${list.length ? list.map(i => rowHTML(
      {b: i.kind === 'activity' ? '◷' : i.kind === 'event' ? '◆' : i.kind === 'notice' ? '◇' : '£',
       s: i.kind, cls: i.kind === 'obligation' && sel < today() ? 'past' : ''},
      i.title, i.sub, i.amount ? money(+i.amount) : '',
      `data-open="${i.kind}:${i.id}"`)).join('')
    : '<div class="empty">Nothing on this day.</div>'}`;
}

function weekView(){
  const start = parse(startOfWeek(datesAnchor));
  let h = `<div class="calnav">
    <button class="btn ghost" data-week="-1" aria-label="Previous week">‹</button>
    <span class="caltitle">Week of ${pretty(iso(start))}</span>
    <button class="btn ghost" data-week="1" aria-label="Next week">›</button>
  </div>`;

  for(let i = 0; i < 7; i++){
    const d = new Date(start.getTime()); d.setDate(start.getDate() + i);
    const ds = iso(d);
    const items = dayItems(ds);
    const isToday = ds === today();
    h += `<div class="wk${isToday ? ' now' : ''}">
      <div class="wkday">
        <b class="num">${d.getDate()}</b>
        <s>${DAYS[d.getDay()].slice(0,3)}</s>
      </div>
      <div class="wkitems">${
        items.length ? items.map(i =>
          `<button class="pill p-${i.kind}" data-open="${i.kind}:${i.id}">
             ${esc(i.title)}${i.amount ? ' · ' + money(+i.amount) : ''}
           </button>`).join('')
        : '<span class="wkfree">—</span>'}</div>
    </div>`;
  }
  return h;
}

function listView(){
  const up = upcoming().filter(i => daysTo(i.date) >= -365);
  if(!up.length) return '<div class="empty" style="padding-top:30px"><b>No dates yet.</b>Add anything with a renewal or a deadline and it appears here, and on the calendar.</div>';
  let h = '', month = '';
  up.forEach(i => {
    const d = parse(i.date);
    const key = MON[d.getMonth()] + ' ' + d.getFullYear();
    if(key !== month){ month = key; h += eyebrow(month); }
    h += rowHTML(markOf(daysTo(i.date)), i.title, i.sub,
      i.amount ? money(+i.amount) : '', `data-open="${i.kind}:${i.id}"`);
  });
  return h;
}

function viewMoney(){
  const live = liveObligations().filter(o => monthly(o) > 0);
  const total = live.reduce((s,o) => s + monthly(o), 0);

  const group = (keyFn, labelFn) => {
    const m = {};
    live.forEach(o => { const k = keyFn(o) || '—'; m[k] = (m[k]||0) + monthly(o); });
    return Object.entries(m).sort((a,b) => b[1]-a[1])
      .map(([k,v]) => ({label: labelFn ? labelFn(k) : k, v}));
  };
  const bars = rows => rows.map(r => `<div class="barrow">
      <span class="t">${esc(r.label)}</span>
      <span class="v">${money(r.v)}</span>
      <span class="track"><span class="bar" style="width:${total ? Math.max(2, r.v/total*100) : 0}%"></span></span>
    </div>`).join('');

  const m = today().slice(0,7);
  const paid = S.payments.filter(p => String(p.paid_on).startsWith(m))
    .reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
  const recent = S.payments.slice().sort((a,b) => a.paid_on < b.paid_on ? 1 : -1).slice(0,12);

  let h = `<div class="card" style="margin-top:18px">
    <div class="tot"><b class="num">${money(total)}</b><span>committed each month</span></div>
    <div class="meta" style="margin-top:6px">${money(total*12)} a year · ${live.length} regular commitments</div>
    <div class="meta">${money(paid)} actually paid in ${MON[new Date().getMonth()]}</div>
  </div>`;

  if(!live.length) return h + '<div class="empty">Add an amount and how often it repeats, and everything here fills in by itself.</div>';

  h += eyebrow('Where it goes', undefined, 'per month') +
       `<div class="card">${bars(group(o => o.category))}</div>`;
  h += eyebrow('What it is for') +
       `<div class="card">${bars(group(o => o.subject_id, id => nameOf(id) || 'Unassigned'))}</div>`;

  if(recent.length){
    h += eyebrow('Paid recently', recent.length);
    h += recent.map(p => {
      const o = S.obligations.find(x => x.id === p.obligation_id);
      return rowHTML({b:String(parse(p.paid_on)?.getDate() ?? '—'),
                      s: MON[parse(p.paid_on)?.getMonth() ?? 0], cls:''},
        (o && o.title) || p.category || 'Payment',
        [p.method, p.who].filter(Boolean).join(' · '),
        money(+p.amount || 0), '');
    }).join('');
  }
  return h;
}

function viewThings(){
  const groups = {person:'People', vehicle:'Vehicles', property:'Property', household:'Household'};
  let h = '';
  Object.keys(groups).forEach(kind => {
    const list = S.subjects.filter(s => s.kind === kind);
    if(!list.length) return;
    h += eyebrow(groups[kind], list.length);
    h += list.map(s => {
      const obs = liveObligations().filter(o => o.subject_id === s.id);
      const perMonth = obs.reduce((a,o) => a + monthly(o), 0);
      const next = upcoming().find(i => {
        const o = S.obligations.find(x => x.id === i.id);
        return (o && o.subject_id === s.id) || false;
      });
      return rowHTML(
        {b: String(obs.length), s: obs.length === 1 ? 'item' : 'items', cls:''},
        s.name,
        [perMonth ? money(perMonth)+'/mo' : '', next ? 'next: '+pretty(next.date) : '']
          .filter(Boolean).join(' · '),
        '', `data-subject="${s.id}"`);
    }).join('');
  });
  h += `<div class="btnrow"><button class="btn" data-new="subject">Add a person, car or property</button>
        <button class="btn ghost" data-settings="1">Settings</button></div>`;
  return h || '<div class="empty" style="padding-top:40px"><b>No subjects yet.</b>Add the car, the house and each person. Everything else attaches to one of them.</div>';
}

function viewSubject(id){
  const s = subjectOf(id);
  if(!s){ subjectOpen = null; return viewThings(); }
  const obs = S.obligations.filter(o => o.subject_id === id);
  const acts = S.activities.filter(a => a.subject_id === id);
  const evs = S.events.filter(e => e.subject_id === id && daysTo(e.on_date) >= -30);
  const docs = S.documents.filter(d => d.subject_id === id);
  const reads = S.readings.filter(r => r.subject_id === id)
    .sort((a,b) => a.taken_on < b.taken_on ? 1 : -1);
  const cons = S.contacts.filter(c => c.subject_id === id);
  const perMonth = obs.filter(o => o.status !== 'finished').reduce((a,o) => a + monthly(o), 0);

  let h = `<div class="btnrow" style="margin:16px 0 0">
      <button class="btn ghost" data-back="1">← All things</button></div>
    <h2 style="margin:6px 0 0;font-size:23px;letter-spacing:-.02em">${esc(s.name)}</h2>
    <div class="meta">${esc(s.kind)}${perMonth ? ' · ' + money(perMonth) + ' a month' : ''}</div>`;

  if(obs.length){
    h += eyebrow('Dates & payments', obs.length);
    h += obs.map(o => rowHTML(
      o.status === 'finished' ? {b:'✓', s:'done', cls:''} : markOf(daysTo(o.next_due)),
      o.title, [o.provider, o.cadence, o.account_ref].filter(Boolean).join(' · '),
      o.amount ? money(+o.amount) : '', `data-open="obligation:${o.id}"`)).join('');
  }
  if(acts.length){
    h += eyebrow('Classes', acts.length);
    h += acts.map(a => rowHTML({b:String(a.day_of_week||'').slice(0,3), s:a.start_time||'', cls:''},
      a.title, [a.venue, a.provider].filter(Boolean).join(' · '), '',
      `data-open="activity:${a.id}"`)).join('');
  }
  if(evs.length){
    h += eyebrow('Coming up', evs.length);
    h += evs.map(e => rowHTML(markOf(daysTo(e.on_date)), e.title,
      [e.start_time, e.venue].filter(Boolean).join(' · '), '',
      `data-open="event:${e.id}"`)).join('');
  }
  if(reads.length){
    h += eyebrow('Records', reads.length);
    h += reads.slice(0,20).map(r => rowHTML(
      {b: r.value ? String(r.value) : '—', s: r.unit || '', cls:''},
      r.label || r.kind, [r.kind, pretty(r.taken_on)].filter(Boolean).join(' · '), '', '')).join('');
  }
  if(docs.length){
    h += eyebrow('Documents', docs.length);
    h += docs.map(d => rowHTML({b:'▤', s:'', cls:''}, d.title,
      [d.category, pretty(d.doc_date)].filter(Boolean).join(' · '), '',
      `data-doc="${d.id}"`)).join('');
  }
  if(cons.length){
    h += eyebrow('Contacts', cons.length);
    h += cons.map(c => rowHTML({b:'☎', s:'', cls:''}, c.name,
      [c.relation, c.phone].filter(Boolean).join(' · '), '', `data-tel="${esc(c.phone)}"`)).join('');
  }
  h += `<div class="btnrow"><button class="btn" data-new="obligation" data-subject-id="${id}">Add a date or payment</button>
        <button class="btn" data-new="document" data-subject-id="${id}">Photograph a letter</button></div>`;
  return h;
}

function renderSetup(){
  $('#screen').innerHTML = `
  <h2 style="margin:26px 0 4px;font-size:22px;letter-spacing:-.02em">Connect to your Sheet</h2>
  <p class="meta">Paste the web app address from Apps Script, and the token for whoever is using this phone. Entered once, stored on the device — never put either in the address bar.</p>
  <label for="ep">Web app address</label>
  <input id="ep" type="url" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.endpoint)}">
  <label for="tk">Your token</label>
  <input id="tk" type="password" autocomplete="off" placeholder="the long string from Script Properties">
  <div class="btnrow"><button class="btn primary" id="connect">Connect</button></div>`;
  $('#connect').onclick = async () => {
    cfg.endpoint = $('#ep').value; cfg.token = $('#tk').value;
    try{
      const out = await call('ping');
      cfg.who = out.who;
      toast('Connected as ' + out.who);
      await sync();
    }catch(e){ toast(e.message); }
  };
}

/* ------------------------------------------------------------ capture */

function captureSheet(){
  openSheet(`
    <h2>What is it?</h2>
    <p class="sub">Say it plainly. Tap the microphone on your keyboard.</p>
    <textarea id="say" placeholder="Car insurance renews 14th March, Admiral, £620, remind me a month before"></textarea>
    <div class="btnrow">
      <button class="btn primary" id="read">Read it</button>
      <button class="btn ghost" data-close="1">Cancel</button>
    </div>
    <div class="eyebrow">Or enter it yourself</div>
    <div class="btnrow">
      <button class="btn" data-new="obligation">Date or payment</button>
      <button class="btn" data-new="event">One-off event</button>
      <button class="btn" data-new="activity">Weekly class</button>
      <button class="btn" data-new="document">Photograph</button>
      <button class="btn" data-new="reading">Record a result</button>
      <button class="btn" data-new="contact">Contact</button>
    </div>`);
  setTimeout(() => $('#say').focus(), 120);
  $('#read').onclick = async () => {
    const text = $('#say').value.trim();
    if(!text) return toast('Say or type something first.');
    const btn = $('#read'); btn.disabled = true; btn.textContent = 'Reading…';
    try{
      const out = await call('parse', { text, today: today() });
      confirmParsed(out.parsed, text);
    }catch(e){
      toast(e.message);
      btn.disabled = false; btn.textContent = 'Read it';
    }
  };
}

function confirmParsed(p, original){
  const type = p.type === 'event' ? 'event' : p.type === 'activity' ? 'activity' : 'obligation';
  const guess = { note: p.note || '', review: p.review ? 'true' : '', confidence: p.confidence || '' };

  if(type === 'obligation') Object.assign(guess, {
    title: p.title || '', provider: p.provider || '', category: p.category || '',
    amount: p.amount ?? '', cadence: p.cadence || 'yearly',
    next_due: p.next_due || p.on_date || '', notice_days: p.notice_days ?? 14,
    calendar: 'household', subject_id: guessSubject(p.subject_hint)
  });
  if(type === 'event') Object.assign(guess, {
    title: p.title || '', on_date: p.on_date || p.next_due || '',
    start_time: p.start_time || '', venue: p.venue || '',
    category: p.category || '', calendar: 'family',
    subject_id: guessSubject(p.subject_hint)
  });
  if(type === 'activity') Object.assign(guess, {
    title: p.title || '', provider: p.provider || '', venue: p.venue || '',
    day_of_week: p.day_of_week || '', start_time: p.start_time || '',
    subject_id: guessSubject(p.subject_hint)
  });

  const flag = p.review || (p.confidence && +p.confidence < 0.75)
    ? `<span class="chip review">check this</span>` : '';
  formSheet(type, guess, `<p class="sub">${flag}Heard: “${esc(original.slice(0,120))}”. Correct anything that is wrong.</p>`);
}

function guessSubject(hint){
  if(!hint) return '';
  const h = String(hint).toLowerCase();
  const hit = S.subjects.find(s => h.includes(String(s.name).toLowerCase()) ||
                                   String(s.name).toLowerCase().includes(h));
  return hit ? hit.id : '';
}

/* ------------------------------------------------------------ forms */

const field = (label, name, value = '', type = 'text', extra = '') =>
  `<label for="f_${name}">${label}</label>
   <input id="f_${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`;

const select = (label, name, value, options, allowBlank = true) =>
  `<label for="f_${name}">${label}</label>
   <select id="f_${name}" name="${name}">
     ${allowBlank ? '<option value=""></option>' : ''}
     ${options.map(o => { const v = o.v ?? o, t = o.t ?? o;
       return `<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(t)}</option>`;
     }).join('')}
   </select>`;

const subjectOptions = () => S.subjects.map(s => ({v:s.id, t:s.name}));

const FORMS = {
  obligation: {
    tab:'obligations', title:'Date or payment',
    sub:'Anything with a renewal, an expiry or a bill.',
    body: r => `
      ${field('What is it', 'title', r.title)}
      ${select('What it is for', 'subject_id', r.subject_id, subjectOptions())}
      ${field('Who with', 'provider', r.provider)}
      ${field('Reference (never the full number)', 'account_ref', r.account_ref, 'text', 'placeholder="Barclays joint — 4471"')}
      <div class="grid2">
        <div>${field('Amount £', 'amount', r.amount, 'number', 'step="0.01" inputmode="decimal"')}</div>
        <div>${select('How often', 'cadence', r.cadence || 'yearly', vocabList('cadence'), false)}</div>
      </div>
      <div class="grid2">
        <div>${field('Next due', 'next_due', r.next_due, 'date')}</div>
        <div>${field('Warn me (days before)', 'notice_days', r.notice_days ?? 14, 'number', 'inputmode="numeric"')}</div>
      </div>
      ${select('Category', 'category', r.category, vocabList('category'))}
      ${select('Which calendar', 'calendar', r.calendar || 'household',
        [{v:'household',t:'Household — just the two of you'},
         {v:'family',t:'Family — everyone sees it'},
         {v:'none',t:'None — automatic, no need to be told'}], false)}
      ${field('Note', 'note', r.note)}`
  },
  event: {
    tab:'events', title:'One-off event',
    sub:'Appointments, parties, exams, term dates.',
    body: r => `
      ${field('What is it', 'title', r.title)}
      ${select('Who is it for', 'subject_id', r.subject_id, subjectOptions())}
      <div class="grid2">
        <div>${field('Date', 'on_date', r.on_date, 'date')}</div>
        <div>${field('Time', 'start_time', r.start_time, 'time')}</div>
      </div>
      ${field('Where', 'venue', r.venue)}
      ${select('Category', 'category', r.category, vocabList('event_category'))}
      ${select('Which calendar', 'calendar', r.calendar || 'family',
        [{v:'family',t:'Family — everyone sees it'},{v:'household',t:'Household — just the two of you'}], false)}
      ${field('Note', 'note', r.note)}`
  },
  activity: {
    tab:'activities', title:'Weekly class',
    sub:'Repeats through the term, and goes on the family calendar.',
    body: r => `
      ${field('What is it', 'title', r.title, 'text', 'placeholder="Piano"')}
      ${select('Whose', 'subject_id', r.subject_id, subjectOptions())}
      ${field('Who runs it', 'provider', r.provider)}
      ${field('Where', 'venue', r.venue)}
      <div class="grid2">
        <div>${select('Day', 'day_of_week', r.day_of_week,
          DAYS.map(d => ({v:d, t:d[0].toUpperCase()+d.slice(1)})))}</div>
        <div>${field('Starts', 'start_time', r.start_time, 'time')}</div>
      </div>
      <div class="grid2">
        <div>${field('Term from', 'term_start', r.term_start, 'date')}</div>
        <div>${field('Term to', 'term_end', r.term_end, 'date')}</div>
      </div>
      ${field('Note', 'note', r.note)}`
  },
  subject: {
    tab:'subjects', title:'A person, car or property',
    sub:'Everything else attaches to one of these.',
    body: r => `
      ${field('Name', 'name', r.name)}
      ${select('What is it', 'kind', r.kind || 'person', vocabList('subject_kind'), false)}
      ${field('Note', 'note', r.note)}`
  },
  contact: {
    tab:'contacts', title:'Contact',
    sub:'A friend’s parent, a garage, a class teacher.',
    body: r => `
      ${field('Name', 'name', r.name)}
      ${select('Connected to', 'subject_id', r.subject_id, subjectOptions())}
      ${field('Relation', 'relation', r.relation)}
      ${field('Phone', 'phone', r.phone, 'tel')}
      ${field('Email', 'email', r.email, 'email')}
      ${field('Address', 'address', r.address)}`
  },
  reading: {
    tab:'readings', title:'A result worth keeping',
    sub:'Blood tests, school grades, anything you want to see a trend in.',
    body: r => `
      ${select('Whose', 'subject_id', r.subject_id, subjectOptions())}
      ${select('Kind', 'kind', r.kind, vocabList('reading_kind'))}
      ${field('What was measured', 'label', r.label, 'text', 'placeholder="Haemoglobin"')}
      <div class="grid2">
        <div>${field('Value', 'value', r.value)}</div>
        <div>${field('Unit', 'unit', r.unit)}</div>
      </div>
      <div class="grid2">
        <div>${field('Normal from', 'ref_low', r.ref_low)}</div>
        <div>${field('Normal to', 'ref_high', r.ref_high)}</div>
      </div>
      ${field('Taken on', 'taken_on', r.taken_on || today(), 'date')}
      ${field('Note', 'note', r.note)}`
  }
};

function formSheet(type, row = {}, intro = ''){
  const f = FORMS[type];
  const existing = row.id ? ' data-id="' + row.id + '"' : '';
  openSheet(`
    <h2>${f.title}</h2>
    ${intro || `<p class="sub">${f.sub}</p>`}
    <div id="form"${existing}>${f.body(row)}</div>
    <div class="btnrow">
      <button class="btn primary" id="saveBtn">Save</button>
      ${row.id ? '<button class="btn ghost" id="delBtn">Delete</button>' : ''}
      <button class="btn ghost" data-close="1">Cancel</button>
    </div>`);

  $('#saveBtn').onclick = async () => {
    const out = {...row};
    document.querySelectorAll('#form [name]').forEach(i => out[i.name] = i.value);
    if(!out.title && !out.name && !out.label) return toast('Give it a name at least.');
    await save(f.tab, out);
    closeSheet(); render();
    toast(navigator.onLine ? 'Saved' : 'Saved on the phone — will sync');
    sync({quiet:true});
  };
  if(row.id) $('#delBtn').onclick = async () => {
    await remove(f.tab, row.id);
    closeSheet(); render(); toast('Deleted');
  };
}

/* --- detail sheet with mark-paid --- */

function openObligation(id){
  const o = S.obligations.find(x => x.id === id);
  if(!o) return;
  const needsCheck = o.review === 'true' || o.review === 'yes';
  const hist = S.payments.filter(p => p.obligation_id === id)
    .sort((a,b) => a.paid_on < b.paid_on ? 1 : -1).slice(0,8);
  openSheet(`
    <h2>${esc(o.title)}</h2>
    <p class="sub">${[o.provider, nameOf(o.subject_id), o.account_ref].filter(Boolean).map(esc).join(' · ')}</p>
    ${needsCheck ? `<div class="card"><span class="chip review">check this</span>
      <div class="meta" style="margin-top:6px">${esc(o.note || 'This was guessed rather than confirmed.')}</div>
      <div class="btnrow"><button class="btn" id="ok">That's right</button>
      <button class="btn ghost" id="fix">Fix it</button></div></div>` : ''}
    <div class="card">
      <div class="tot"><b class="num">${o.amount ? money(+o.amount) : '—'}</b><span>${esc(o.cadence||'')}</span></div>
      <div class="meta" style="margin-top:6px">Next due ${pretty(o.next_due)}${
        o.notice_days ? ' · warns ' + o.notice_days + ' days before' : ''}</div>
      ${monthly(o) ? `<div class="meta">${money(monthly(o))} a month, spread out</div>` : ''}
    </div>
    <div class="btnrow">
      <button class="btn primary" id="paid">Mark paid</button>
      <button class="btn" id="edit">Edit</button>
      <button class="btn ghost" data-close="1">Close</button>
    </div>
    ${hist.length ? eyebrow('Paid before', hist.length) + hist.map(p =>
      rowHTML({b:String(parse(p.paid_on)?.getDate()??''), s:MON[parse(p.paid_on)?.getMonth()??0], cls:''},
        money(+p.amount||0), [p.method, p.who].filter(Boolean).join(' · '), '', '')).join('') : ''}`);

  if(needsCheck){
    $('#ok').onclick = async () => {
      await save('obligations', {...o, review:'', note:''});
      closeSheet(); render(); toast('Confirmed');
    };
    $('#fix').onclick = () => formSheet('obligation', o);
  }
  $('#edit').onclick = () => formSheet('obligation', o);
  $('#paid').onclick = () => markPaidSheet(o);
}

function markPaidSheet(o){
  openSheet(`
    <h2>Mark paid</h2>
    <p class="sub">${esc(o.title)} — records it, moves the due date on, and shifts the calendar.</p>
    <div id="form">
      ${field('Paid on', 'paid_on', today(), 'date')}
      ${field('Amount £', 'amount', o.amount, 'number', 'step="0.01" inputmode="decimal"')}
      ${select('How', 'method', 'Direct debit', vocabList('method'))}
      ${field('Note', 'note', '')}
    </div>
    <div class="btnrow">
      <button class="btn primary" id="confirm">Mark paid</button>
      <button class="btn ghost" data-close="1">Cancel</button>
    </div>`);
  $('#confirm').onclick = async () => {
    const v = {};
    document.querySelectorAll('#form [name]').forEach(i => v[i.name] = i.value);
    // optimistic: write the payment locally and advance the date on the phone too
    await save('payments', { obligation_id:o.id, subject_id:o.subject_id,
      paid_on:v.paid_on, amount:v.amount, category:o.category,
      method:v.method, note:v.note });
    await enqueue('markPaid', { obligation_id:o.id, ...v });
    closeSheet(); render();
    toast('Marked paid'); sync({quiet:true});
  };
}

/* --- documents --- */

function documentSheet(subjectId = ''){
  openSheet(`
    <h2>Photograph a letter</h2>
    <p class="sub">It goes to Drive, the text is read out of it automatically, and you can search it later.</p>
    <label for="file">Photo or PDF</label>
    <input id="file" type="file" accept="image/*,application/pdf" capture="environment">
    <div id="form">
      ${field('What is it', 'title', '')}
      ${select('What it is about', 'subject_id', subjectId, subjectOptions())}
      ${select('Category', 'category', '', vocabList('doc_category'))}
      <div class="grid2">
        <div>${field('Dated', 'doc_date', today(), 'date')}</div>
        <div>${field('Expires', 'expires_on', '', 'date')}</div>
      </div>
      ${field('Note', 'note', '')}
    </div>
    <div class="btnrow">
      <button class="btn primary" id="up">Upload</button>
      <button class="btn ghost" data-close="1">Cancel</button>
    </div>`);

  $('#up').onclick = async () => {
    const f = $('#file').files[0];
    if(!f) return toast('Choose a photo first.');
    if(!navigator.onLine) return toast('Uploads need signal. Try again when you have some.');
    const btn = $('#up'); btn.disabled = true; btn.textContent = 'Uploading…';
    try{
      const data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.onerror = () => rej(new Error('Could not read that file.'));
        r.readAsDataURL(f);
      });
      const v = {};
      document.querySelectorAll('#form [name]').forEach(i => v[i.name] = i.value);
      await call('upload', { ...v, name: f.name, mime: f.type, data });
      closeSheet(); toast('Uploaded and read'); sync();
    }catch(e){
      toast(e.message); btn.disabled = false; btn.textContent = 'Upload';
    }
  };
}

function settingsSheet(){
  openSheet(`
    <h2>Settings</h2>
    <p class="sub">Signed in as ${esc(cfg.who || 'unknown')} · ${queueLen} waiting to sync</p>
    <label for="s_ep">Web app address</label>
    <input id="s_ep" type="url" value="${esc(cfg.endpoint)}">
    <label for="s_tk">Token</label>
    <input id="s_tk" type="password" placeholder="leave blank to keep the current one">
    <div class="btnrow">
      <button class="btn primary" id="s_save">Save</button>
      <button class="btn" id="s_sync">Sync now</button>
      <button class="btn ghost" id="s_out">Forget this phone</button>
    </div>
    <div class="eyebrow">Version</div>
    <p class="meta">App ${VERSION}. If something looks stale, pull down to reload — the app always
      asks the network for its own code before falling back to the copy on the phone.</p>`);
  $('#s_save').onclick = () => {
    cfg.endpoint = $('#s_ep').value;
    if($('#s_tk').value.trim()) cfg.token = $('#s_tk').value;
    closeSheet(); sync();
  };
  $('#s_sync').onclick = () => { closeSheet(); sync(); };
  $('#s_out').onclick = async () => {
    localStorage.clear();
    for(const t of TABS) await putAll(t, []);
    closeSheet(); location.reload();
  };
}

/* ------------------------------------------------------------ events */

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-close],[data-open],[data-subject],[data-back],[data-new],[data-settings],[data-doc],[data-tel],[data-datesview],[data-month],[data-week],[data-day]');
  if(!t) return;

  if(t.dataset.datesview){ datesView = t.dataset.datesview; return render(); }
  if(t.dataset.month){ datesAnchor = shiftMonth(datesAnchor, +t.dataset.month);
    daySelected = null; return render(); }
  if(t.dataset.week){
    const d = parse(datesAnchor); d.setDate(d.getDate() + 7 * +t.dataset.week);
    datesAnchor = iso(d); return render(); }
  if(t.dataset.day){ daySelected = t.dataset.day; return render(); }

  if(t.dataset.close) return closeSheet();
  if(t.dataset.back){ subjectOpen = null; return render(); }
  if(t.dataset.settings) return settingsSheet();
  if(t.dataset.subject){ subjectOpen = t.dataset.subject; window.scrollTo(0,0); return render(); }
  if(t.dataset.tel && t.dataset.tel !== 'undefined'){ location.href = 'tel:' + t.dataset.tel; return; }

  if(t.dataset.doc){
    const d = S.documents.find(x => x.id === t.dataset.doc);
    if(d && d.drive_url) window.open(d.drive_url, '_blank');
    return;
  }

  if(t.dataset.new){
    const kind = t.dataset.new;
    const seed = t.dataset.subjectId ? {subject_id: t.dataset.subjectId} : {};
    if(kind === 'document') return documentSheet(t.dataset.subjectId || '');
    return formSheet(kind, seed);
  }

  if(t.dataset.open){
    const [kind, id] = t.dataset.open.split(':');
    if(kind === 'obligation' || kind === 'notice') return openObligation(id);
    if(kind === 'event')    return formSheet('event', S.events.find(x => x.id === id) || {});
    if(kind === 'activity') return formSheet('activity', S.activities.find(x => x.id === id) || {});
    if(kind === 'document'){
      const d = S.documents.find(x => x.id === id);
      if(d && d.drive_url) window.open(d.drive_url, '_blank');
    }
  }
});

document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  screen = b.dataset.screen; subjectOpen = null; window.scrollTo(0,0); render();
});
$('#fab').onclick = () => cfg.ready ? captureSheet() : toast('Connect to your Sheet first.');
$('#syncBtn').onclick = () => cfg.ready ? sync() : render();
$('#ver').textContent = 'v' + VERSION;

window.addEventListener('online', () => sync({quiet:true}));
window.addEventListener('offline', () => setStatus('off','Offline'));
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible') sync({quiet:true});
});

/* share target: anything shared into the app lands in capture */
(function shared(){
  const p = new URLSearchParams(location.search);
  const text = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join(' ');
  if(text){
    history.replaceState({}, '', location.pathname);
    setTimeout(() => { captureSheet(); const box = document.querySelector('#say');
      if(box) box.value = text; }, 400);
  }
})();

/* ------------------------------------------------------------ start */

(async function start(){
  db = await openDB();
  await loadLocal();
  render();
  if(cfg.ready){ setStatus('busy','Syncing'); sync({quiet:true}); }
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
