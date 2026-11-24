// analyze.js: the "Analyze logs" tab of the Lecture 9 copy (MGOC50). Students don't need to read it.
// It reads two weeks of chat logs from logs.js and shows: the two weeks' numbers, then three approaches, each one way to
// analyze the same logs (Stopping point distribution, Differential analysis, Categorical Breakdown), the chats behind any result,
// the categories the agent chose, and each chat as a story. Differential analysis runs one week's chats through the other
// week's workflow (week 2's through week 1's by default; a swap button reverses it). The two workflows differ at one step,
// "About missing items? No": week 1 sends the chat to a person, week 2 rejects it. Week 2's chats that end differently carry
// their week-1 ending in logs.js (c.s1). The agent is never called: its answers were recorded from real runs.
// The page only presents results. It never judges a chat or a rule as right or wrong, and never names a cause.
(function () {
'use strict';
const L = window.LOGS, POL = window.POLICY;
const INSTR = !!window.L9_INSTRUCTOR; // the instructor copy sets this: the partial revert replayed, and the rating rule
const TREES = {last: W.cleanDesign(L.trees.last), this: W.cleanDesign(L.trees.this)};
const WEEK = {last: 'Week 1', this: 'Week 2'};
const week = w => WEEK[w].toLowerCase();
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY3 = DAYS.map(d => d.slice(0, 3));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ENDING = {refund: 'Refund', reorder: 'Reorder', refused: 'Rejected', human: 'Sent to a person', none: 'No ending'};
const ACT = {refund: 'Refund', reorder: 'Reorder', refuse: 'Rejected', human: 'Sent to a person'};
const CATS = ['missing items', 'never arrived', 'allergy or illness', 'something else', 'no clear answer'];
const money = n => '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const money0 = n => '$' + Math.round(n).toLocaleString('en-US');
const num = n => Math.round(n).toLocaleString('en-US');
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '0%';
const signed = (n, f = num) => (n > 0 ? '+' : n < 0 ? '−' : '±') + f(Math.abs(n));
const A = id => document.getElementById(id);
const sum = (list, f) => list.reduce((a, c) => a + f(c), 0);

// ----- the chats -----
const D = t => new Date(t + ':00Z');
const hoursBetween = (a, b) => (D(b) - D(a)) / 3600000;
function when(t, withDay = true) { const d = D(t), h = d.getUTCHours(), m = d.getUTCMinutes(); return `${withDay ? DAY3[(d.getUTCDay() + 6) % 7] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ', ' : ''}${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`; }
function gap(h) { if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`; if (h < 48) return `${Math.round(h * 10) / 10} hours`; return `${Math.round(h / 24 * 10) / 10} days`; }
for (const c of L.cases) {
  c.day = (D(c.t).getUTCDay() + 6) % 7;
  c.cat = c.read && c.read.category ? c.read.category : 'no clear answer';
  c.rest = c.o.restaurant;
  c.photo = c.d.photo !== 'none';
  c.hrs = hoursBetween(c.d.delivered, c.t);
  c.place = c.stop === L.w1Stop ? L.ex1Stop : c.stop; // week 1's "a person" and week 2's "Reject" sit at the same step
}
const byId = Object.fromEntries(L.cases.map(c => [c.id, c]));
const restaurants = [...new Set(L.cases.map(c => c.rest))].sort();
const inWeek = w => L.cases.filter(c => c.w === w);

// ----- the workflow's endings ("places"), in the order the tree draws them -----
const GLOSS = {photo: ' (the driver took a drop-off photo)', within24: ' (written more than 24 hours after delivery)', itemsUnder: ' (the missing items cost $50 or more)'};
function checkGloss(b, br) { if (br !== 'no') return ''; if (b.check === 'photo') return GLOSS.photo; if (b.check === 'within' && b.num === 24) return GLOSS.within24; if (b.check === 'itemsUnder') return GLOSS.itemsUnder; return ''; }
const PLACES = [];
// a short plain phrase for each answer of a check, used to name the stopping points
function phrase(b, br) {
  const y = br === 'yes';
  if (b.check === 'missing') return y ? 'about missing items' : 'not about missing items';
  if (b.check === 'photo') return y ? 'no drop-off photo' : "the driver's drop-off photo shows the delivery";
  if (b.check === 'reorder') return y ? 'the customer asked for a reorder' : 'no reorder asked';
  if (b.check === 'within') return y ? `within ${b.num} hours of delivery` : `more than ${b.num} hours after delivery`;
  if (b.check === 'itemsUnder') return y ? `missing items under $${b.num}` : `missing items cost $${b.num} or more`;
  return `${W.checkText(b)} ${br}`;
}
const endsUnder = list => { const out = []; (function w(l) { for (const b of l) { if (b.type === 'check') { w(b.yes); w(b.no); } else if (b.type === 'act') out.push(b.id); } })(list); return out; };
const CARD = {reorder: 'Number of reorders', refund: 'Number of refunds', refuse: 'Number of rejections', human: 'Number sent to a person'};
(function walk(list, path) {
  for (const b of list) {
    if (b.type === 'agent') path = path.concat([{text: b.job === 'read' ? 'The agent reads the message and picks a category.' : 'The agent matches the message to the items on the order.', match: b.job !== 'read'}]);
    else if (b.type === 'lookup') path = path.concat([{text: b.file === 'delivery' ? 'A fixed rule looks up the delivery record.' : 'A fixed rule looks up the order record.'}]);
    else if (b.type === 'check') { const pre = !path.some(st => st.match); for (const br of ['yes', 'no']) walk(b[br], path.concat([{b, br, ids: endsUnder(b[br]), pre}])); return; }
    else if (b.type === 'act') {
      const checks = path.filter(s => s.b), last = checks[checks.length - 1], prev = checks[checks.length - 2];
      const why = (b.action === 'refund' || b.action === 'reorder') && prev && prev.br === 'yes' ? `${phrase(prev.b, prev.br)}, ${phrase(last.b, last.br)}` : phrase(last.b, last.br);
      const changed = b.id === L.ex1Stop;
      const end = changed ? `week 1: ${ACT.human}; week 2: ${ACT.refuse}` : ACT[b.action];
      const endName = changed ? 'Week 1: sent to a person, week 2: rejected' : ACT[b.action];
      PLACES.push({id: b.id, q: `${W.checkText(last.b)} ${last.br}${checkGloss(last.b, last.br)}`, end, why, path, action: b.action,
        group: changed ? 'human' : b.action, card: changed ? 'Week 1: sent to a person · Week 2: rejected' : CARD[b.action], label: `${endName} (${why})`});
      return;
    }
  }
})(TREES.this.tree, []);
{ // the chats where the agent matched no item on the order: they passed every check up to the match, then had nothing to refund
  const viaMatch = PLACES.find(p => p.action === 'refund' && p.path.some(st => st.match)).path;
  const upTo = viaMatch.slice(0, viaMatch.findIndex(st => st.match) + 1);
  PLACES.push({id: 'auto', q: 'No item on the order matched the message', end: ACT.human, why: 'no item on the order matched the message, so there was nothing to refund',
    path: upTo.concat([{text: 'No item on the order matched the message, so there was nothing to refund. The workflow sent the chat to a person.'}]), action: 'human', group: 'human', card: CARD.human,
    label: `${ACT.human} (no item on the order matched the message)`});
}
const placeOf = id => PLACES.find(p => p.id === id) || {label: id, q: id, end: ''};

// ----- running one chat again for its log (the agent's recorded answers; nothing is called) -----
function storeFor(c) {
  return {orders: {[c.o.number]: W.clone(c.o)}, deliveries: {[c.o.number]: Object.assign({}, c.d)}, chats: {}, cancelled: new Set(), history: {[c.cu]: W.clone(c.h)}};
}
const caseDef = c => ({id: c.id, num: 1, customer: c.cu, from: c.o.number, messages: [c.m], right: c.right});
function runOne(c) {
  const fake = {agent: job => job === 'read' ? c.read : job === 'match' ? c.match : null, model: async () => c.reply == null ? '' : c.reply};
  return W.runCase(TREES[c.w], caseDef(c), {store: storeFor(c), now: c.t, fakeAnswers: fake, customers: L.customers});
}
const endingText = c => c.end === 'refund' ? `Refund ${money(c.refund)}` : ENDING[c.end];
const starText = n => '★'.repeat(n) + '☆'.repeat(5 - n);

// ----- filters shared by the first three approaches -----
const TIMES = [['2h', 'Within 2 hours of delivery', h => h <= 2], ['24h', '2 to 24 hours after delivery', h => h > 2 && h <= 24], ['late', 'More than 24 hours after delivery', h => h > 24]];
const timeKey = c => TIMES.find(x => x[2](c.hrs))[0];
const F0 = {end: 'all', cat: 'all', rest: 'all', day: 'all', photo: 'all', time: 'all'};
const RATE0 = {min: 1, max: 5};
const rateAll = r => r.min === 1 && r.max === 5;
const rateText = r => r.min === r.max ? `rated ${r.min} star${r.min > 1 ? 's' : ''}` : `rated ${r.min} to ${r.max} stars`;
const S = {method: 'stop', rate: Object.assign({}, RATE0), f: Object.assign({}, F0), dxDir: 'w2', field: 'refund'};
let shown = null; // the choices when Show results was last pressed
function passes(c, f, rate) {
  if (c.stars < rate.min || c.stars > rate.max) return false;
  if (f.end !== 'all' && c.end !== f.end) return false;
  if (f.cat !== 'all' && c.cat !== f.cat) return false;
  if (f.rest !== 'all' && c.rest !== f.rest) return false;
  if (f.day !== 'all' && String(c.day) !== f.day) return false;
  if (f.photo !== 'all' && (f.photo === 'yes') !== c.photo) return false;
  if (f.time !== 'all' && timeKey(c) !== f.time) return false;
  return true;
}
function describeFilters(sh) {
  const f = sh.f, parts = [];
  if (!rateAll(sh.rate)) parts.push(rateText(sh.rate));
  if (f.end !== 'all') parts.push(`ending: ${ENDING[f.end]}`);
  if (f.cat !== 'all') parts.push(`category: ${f.cat}`);
  if (f.rest !== 'all') parts.push(f.rest);
  if (f.day !== 'all') parts.push(DAYS[f.day]);
  if (f.photo !== 'all') parts.push(f.photo === 'yes' ? 'with a drop-off photo' : 'no drop-off photo');
  if (f.time !== 'all') parts.push(TIMES.find(x => x[0] === f.time)[1].toLowerCase());
  return parts.length ? parts.join(' · ') : 'none (every chat)';
}

// ----- the two weeks' numbers -----
function stats(list) {
  const refunds = list.filter(c => c.end === 'refund'), dollars = sum(list, c => c.refund);
  return {chats: list.length, refunds: refunds.length, dollars, avg: refunds.length ? dollars / refunds.length : 0,
          reorders: list.filter(c => c.end === 'reorder').length, rejected: list.filter(c => c.end === 'refused').length,
          person: list.filter(c => c.end === 'human').length, oneStar: list.filter(c => c.stars === 1).length};
}
const TILES = [['chats', 'Chats', num], ['refunds', 'Refunds', num], ['dollars', 'Total refunded', money0], ['avg', 'Average refund', money],
               ['reorders', 'Reorders', num], ['rejected', 'Rejected', num], ['person', 'Sent to a person', num], ['oneStar', 'Chats rated 1 star', num]];
// each card has two halves with the same weight: the first set of numbers on the left, the second on the right
function tiles(a, b, names = TILES, labels = [WEEK.last, WEEK.this]) {
  return el('div', {class: 'tiles'}, names.map(([k, name, f]) => el('div', {class: 'tile'}, el('div', {class: 'tile-name', text: name}),
    el('div', {class: 'tile-halves'},
      el('div', {class: 'th last'}, el('span', {class: 'th-w', text: labels[0]}), el('span', {class: 'th-n', text: f(a[k])})),
      el('div', {class: 'th this'}, el('span', {class: 'th-w', text: labels[1]}), el('span', {class: 'th-n', text: f(b[k])}))))));
}

// ----- the chat as a story -----
async function story(c, opts = {}) {
  const r = await runOne(c);
  const wrap = el('div', {class: 'story'});
  wrap.append(el('div', {class: 'st-head'}, el('b', {text: `Order ${c.o.number} · ${c.rest}`}), ` · ${when(c.t)} · ${WEEK[c.w]}`));
  wrap.append(el('div', {class: 'bubble cust'}, el('div', {class: 'b-who', text: `${L.customers[c.cu] || 'The customer'} wrote:`}), el('div', {class: 'b-text', text: c.m})));
  const items = el('table', {class: 'rc-items'}, c.o.items.map(x => el('tr', {}, el('td', {text: x.name}), el('td', {class: 'num', text: money(x.price)}))));
  const past = c.h.refunds.length ? c.h.refunds.map(x => `${money(x.amount)} for ${x.items} on order ${x.order} (${when(x.date)})`).join('; ') : 'none';
  wrap.append(el('div', {class: 'receipt'}, el('div', {class: 'rc-title', text: 'The order and its delivery'}), items,
    el('div', {class: 'rc-line'}, el('b', {text: `Total paid ${money(c.o.total)}`}), ' (the items plus the delivery fee and tax), card ending ', c.o.card),
    el('div', {class: 'rc-line'}, el('b', {text: 'Ordered: '}), when(c.o.placed)),
    el('div', {class: 'rc-line'}, el('b', {text: 'Delivered: '}), `${when(c.d.delivered)}, by ${c.d.driverName}`),
    el('div', {class: 'rc-line'}, el('b', {text: 'Drop-off photo: '}), c.photo ? 'yes, the driver took one at the address' : 'none'),
    el('div', {class: 'rc-line'}, el('b', {text: 'Message sent: '}), `${gap(c.hrs)} after delivery`),
    el('div', {class: 'rc-line'}, el('b', {text: 'Earlier refunds for this customer: '}), past)));
  wrap.append(el('div', {class: 'st-sub', text: 'What the workflow did, step by step'}),
    el('p', {class: 'small', style: 'margin:0 0 4px'}, el('span', {class: 'dot-k agent'}), ' the agent  ', el('span', {class: 'dot-k rule'}), ' a fixed rule  ', el('span', {class: 'dot-k human'}), ' a person'));
  const ol = el('ol', {class: 'steps'});
  let reply = null;
  for (const row of r.log) {
    if (row.step === 'Reply') { reply = row.output.replace(/^reply sent: "?|"$/g, ''); continue; }
    if (row.step === 'Audit record') continue; // bookkeeping only; the ending is shown below
    const who = row.who === 'the agent' ? 'agent' : row.who === 'a human' ? 'human' : 'rule';
    ol.append(el('li', {class: 'step ' + who}, el('span', {class: 'dot', 'aria-hidden': 'true'}),
      el('div', {}, el('div', {}, el('span', {class: 'step-name', text: row.step}), el('span', {class: 'step-out', text: '  → ' + row.output})),
        el('div', {class: 'step-io'}, el('span', {class: 'step-who', text: row.who === 'the agent' ? 'The agent' : row.who === 'a human' ? 'A person' : 'A fixed rule'}), ` · based on: ${row.inputs}`))));
  }
  wrap.append(ol, el('div', {class: 'st-end'}, el('b', {text: 'How it ended: '}), r.outcome.text));
  if (reply) wrap.append(el('div', {class: 'bubble agent'}, el('div', {class: 'b-who', text: 'The reply the customer got:'}), el('div', {class: 'b-text', text: reply})));
  wrap.append(el('div', {class: 'st-rate'}, 'The customer rated the chat ', el('span', {class: 'stars', text: starText(c.stars)}), ` (${c.stars} of 5)`));
  if (opts.both) {
    const dx = DX[c.w === 'this' ? 'w2' : 'w1'], out = (e, r) => e === 'refund' ? `Refund ${money(r)}` : ENDING[e];
    wrap.append(el('div', {class: 'st-compare'}, el('div', {class: 'st-sub', style: 'margin-top:0', text: 'How each week\'s workflow ends this chat'}),
      el('div', {}, el('b', {text: "Week 1's workflow: "}), out(dx.endA(c), dx.refA(c)), el('span', {class: 'st-last', text: ` · last decision: ${lastQ(dx.placeA(c))}`})),
      el('div', {}, el('b', {text: "Week 2's workflow: "}), out(dx.endB(c), dx.refB(c)), el('span', {class: 'st-last', text: ` · last decision: ${lastQ(dx.placeB(c))}`}))));
  }
  return wrap;
}

// ----- the drawer that shows one chat -----
let drawerList = [], drawerOpts = {}, drawerReturn = null;
async function openChat(id, list, opts = {}) {
  drawerList = list || [id]; drawerOpts = opts;
  if (A('drawer').hidden) drawerReturn = document.activeElement;
  const i = drawerList.indexOf(id), c = byId[id];
  A('drawer-back').hidden = false; A('drawer').hidden = false;
  document.body.classList.add('drawer-open');
  const body = A('dr-body');
  body.replaceChildren(el('p', {text: 'Opening the chat…'}));
  const st = await story(c, opts);
  const nav = el('div', {class: 'dr-nav'},
    el('button', {class: 'btn', text: '← Previous chat', disabled: i > 0 ? null : true, onclick: () => openChat(drawerList[i - 1], drawerList, drawerOpts)}),
    el('span', {class: 'small', text: drawerList.length > 1 ? `Chat ${i + 1} of ${num(drawerList.length)} in this list` : ''}),
    el('button', {class: 'btn', text: 'Next chat →', disabled: i >= 0 && i < drawerList.length - 1 ? null : true, onclick: () => openChat(drawerList[i + 1], drawerList, drawerOpts)}),
    el('button', {class: 'btn', id: 'dr-close', text: 'Close ✕', onclick: closeChat}));
  A('drawer').setAttribute('aria-label', `The chat about order ${c.o.number}`);
  body.replaceChildren(nav, st);
  A('drawer').scrollTop = 0;
  A('dr-close').focus();
  for (const tr of document.querySelectorAll('tr.on')) tr.classList.remove('on');
  for (const tr of document.querySelectorAll(`tr[data-id="${id}"]`)) tr.classList.add('on');
}
function closeChat() {
  A('drawer').hidden = true; A('drawer-back').hidden = true; document.body.classList.remove('drawer-open');
  if (drawerReturn && document.contains(drawerReturn)) drawerReturn.focus();
  drawerReturn = null;
}

// ----- a list of chats -----
function chatTable(list, opts) {
  const box = el('div');
  let n = 20;
  const draw = () => {
    const t = el('table', {class: 'an-table an-list'}, el('tr', {}, opts.cols.map(h => el('th', {scope: 'col', text: h[0]}))));
    const ids = list.map(c => c.id);
    for (const c of list.slice(0, n)) {
      t.append(el('tr', {tabindex: '0', 'data-id': c.id, title: 'Click to read the whole chat', onclick: () => openChat(c.id, ids, opts.open),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(c.id, ids, opts.open); } }},
        opts.cols.map(h => el('td', {class: h[2] || '', text: h[1](c)}))));
    }
    box.replaceChildren(t);
    if (list.length > n) box.append(el('button', {class: 'btn', text: `Show 20 more (${num(list.length - n)} left)`, onclick: () => { n += 20; draw(); }}));
    if (!list.length) box.replaceChildren(el('p', {class: 'small', text: 'No chat matches.'}));
  };
  draw();
  return box;
}
const COLS = [['When', c => when(c.t)], ['Week', c => WEEK[c.w]], ['Restaurant', c => c.rest], ["Customer's message", c => c.m, 'an-msg'], ['How it ended', endingText], ['Rating', c => starText(c.stars), 'stars']];
const COLS1 = COLS.filter(h => h[0] !== 'Week');

// ----- the three approaches -----
const METHODS = [
  ['stop', 'Stopping point distribution', 'How many chats stopped at each node in the decision tree?'],
  ['diff', 'Differential analysis: week 1 vs week 2', ''], // its question and button follow the direction (DX_DIRS)
  ['breakdown', 'Categorical Breakdown', 'How many chats fall in each range of a number?'],
];
const DX_DIRS = {
  w2: {label: "Run week 2's chats through week 1's workflow", q: "How would week 2's chats have ended under week 1's workflow?"},
  w1: {label: "Run week 1's chats through week 2's workflow", q: "How would week 1's chats have ended under week 2's workflow?"},
};
// the stopping points in the decision tree's own words (slide 2's short names), top to bottom; its two refund stops are one end there
const TREE_STOPS = [
  [L.ex1Stop, 'About missing items? No → Reject (week 1: send to a person)'],
  ['bsvn0svib', 'Within 24 hours? No → Reject'],
  ['bsvn0qnlu', 'No photo proof? No → Reject'],
  ['auto', 'Match missing items: no item matched → Send to a person'],
  ['bsvn0opzr', 'Missing items under $50? No → Reject'],
  ['bsvn0ea7r', 'Asks for a reorder, within 2 hours? Yes → Reorder'],
  ['bsvn0hfmr', 'Asks for a reorder, within 2 hours? No → Refund the items'],
];
const stopName = id => (TREE_STOPS.find(x => x[0] === (id === 'bsvn0f329' ? 'bsvn0hfmr' : id)) || [id, id])[1];
function pickMethod(m, focus = false) {
  S.method = m;
  for (const b of document.querySelectorAll('#an-tabs [role="tab"]')) {
    const on = b.dataset.m === m;
    b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
    if (on) { A('an-panel').setAttribute('aria-labelledby', b.id); if (focus) b.focus(); }
  }
  A('an-desc').textContent = m === 'diff' ? DX_DIRS[S.dxDir].q : METHODS.find(x => x[0] === m)[2];
  A('an-show').textContent = m === 'diff' ? DX_DIRS[S.dxDir].label : 'Show results';
  const swapTo = 'Swap the weeks: ' + DX_DIRS[S.dxDir === 'w2' ? 'w1' : 'w2'].label;
  A('an-swap').hidden = m !== 'diff'; A('an-swap').title = swapTo; A('an-swap').setAttribute('aria-label', swapTo);
  A('an-step3').hidden = true; A('an-step4').hidden = true; A('an-stale').textContent = ''; shown = null;
  renderControls();
}
function selectBox(label, value, options, onchange) {
  const s = el('select', {onchange: e => onchange(e.target.value)});
  for (const [v, t] of options) { const o = el('option', {value: String(v), text: t}); if (String(value) === String(v)) o.selected = true; s.append(o); }
  return el('label', {class: 'an-f'}, el('span', {class: 'an-flab', text: label}), s);
}
function starsBox(id, rate, onchange) {
  const box = (which, label) => el('input', {type: 'number', id: `${id}-${which}`, min: '1', max: '5', step: '1', value: String(rate[which]), 'aria-label': `Star rating, ${label}`, class: 'stars-in',
    onchange: e => {
      const v = Math.min(5, Math.max(1, Math.round(Number(e.target.value)) || RATE0[which]));
      rate[which] = v; e.target.value = String(v);
      if (rate.min > rate.max) { const other = which === 'min' ? 'max' : 'min'; rate[other] = v; A(`${id}-${other}`).value = String(v); }
      onchange();
    }});
  return el('div', {class: 'an-f', role: 'group', 'aria-label': 'Star rating'}, el('span', {class: 'an-flab', text: 'Star rating'}), el('span', {class: 'stars-f'}, box('min', 'from'), ' to ', box('max', 'to')));
}
function markStale() { if (shown) A('an-stale').textContent = S.method === 'diff' ? 'Filters changed: press the button again to update.' : 'Filters changed: press Show results to update.'; }
function renderControls() {
  const kids = [];
  const f = S.f, set = k => v => { f[k] = v; markStale(); };
  kids.push(el('div', {class: 'an-row'},
    starsBox('an-stars', S.rate, markStale),
    selectBox('How the chat ended', f.end, [['all', 'Every ending'], ['refund', 'Refund'], ['reorder', 'Reorder'], ['refused', 'Rejected'], ['human', 'Sent to a person']], set('end')),
    selectBox('Category the agent chose', f.cat, [['all', 'Any category'], ...CATS.map(x => [x, x])], set('cat')),
    selectBox('Restaurant', f.rest, [['all', 'Every restaurant'], ...restaurants.map(x => [x, x])], set('rest')),
    selectBox('Day of the week', f.day, [['all', 'Every day'], ...DAYS.map((d, i) => [i, d])], set('day')),
    selectBox('Drop-off photo', f.photo, [['all', 'Either'], ['yes', 'The driver took a photo'], ['no', 'No photo']], set('photo')),
    selectBox('When the customer wrote', f.time, [['all', 'Any time'], ...TIMES.map(x => [x[0], x[1]])], set('time'))));
  if (S.method === 'breakdown') kids.unshift(el('div', {class: 'an-row'},
    selectBox('Break down by', S.field, FIELDS.map(x => [x.k, x.label]), v => { S.field = v; markStale(); })));
  A('an-filters').replaceChildren(...kids);
}
function showResults() {
  shown = JSON.parse(JSON.stringify({method: S.method, rate: S.rate, f: S.f, dxDir: S.dxDir, field: S.field}));
  A('an-stale').textContent = '';
  A('an-step3').hidden = false;
  A('an-step4').hidden = S.method !== 'stop';
  if (S.method === 'stop') renderStops();
  else if (S.method === 'diff') renderDiff();
  else { breakSel = null; renderBreakdown(); }
  A('an-step3').scrollIntoView({behavior: 'smooth', block: 'start'});
}
const shownBase = w => inWeek(w).filter(c => passes(c, shown.f, shown.rate));

// ----- the chats behind a result -----
let listState = null; // {title, pick: c => bool, week}
function showList(title, pick, weekChoice = 'this', scroll = true) {
  listState = {title, pick, week: weekChoice};
  renderList();
  A('an-step4').hidden = false;
  if (scroll) A('an-step4').scrollIntoView({behavior: 'smooth', block: 'start'});
}
function renderList() {
  const ls = listState, box = A('an-list');
  const base = c => passes(c, shown.f, shown.rate) && ls.pick(c);
  const counts = {last: inWeek('last').filter(base).length, this: inWeek('this').filter(base).length};
  const list = L.cases.filter(c => (ls.week === 'both' || c.w === ls.week) && base(c));
  const tabs = el('div', {class: 'seg', role: 'group', 'aria-label': 'Which week to list'},
    [['this', `Week 2 (${num(counts.this)})`], ['last', `Week 1 (${num(counts.last)})`], ['both', `Both weeks (${num(counts.this + counts.last)})`]].map(([k, t]) =>
      el('button', {class: 'btn' + (ls.week === k ? ' on' : ''), 'aria-pressed': String(ls.week === k), text: t, onclick: () => { ls.week = k; renderList(); }})));
  box.replaceChildren(el('p', {class: 'an-listtitle'}, el('b', {text: ls.title})), tabs,
    chatTable(list, {cols: ls.week === 'both' ? COLS : COLS1, open: {}}));
}

function noMatch(base) {
  if (base.last.length || base.this.length) return false;
  A('an-res-how').textContent = '';
  A('an-results').replaceChildren(el('div', {class: 'note bad'}, el('b', {text: 'No chat in either week matches these filters. '}), `Filters: ${describeFilters(shown)}. Remove a filter or press Clear filters.`));
  A('an-step4').hidden = true;
  return true;
}
// ----- Stopping point distribution: one box per stopping point; click a box for the path that leads to it -----
const cap = t => t[0].toUpperCase() + t.slice(1);
const STOP_ENDS = [['reorder', 'Number of reorders'], ['refund', 'Number of refunds'], ['refuse', 'Number of rejections'], ['human', 'Number sent to a person']];
const endOf = (p, w) => p.id === L.ex1Stop && w === 'last' ? 'human' : p.action; // the one stop whose ending changed between the weeks
// The decision tree as drawn on slide 2 (its short names; the two reorder checks shown as one). Each row: a step on the main
// line, and for checks (and the item match) the exit to the side. Ends name the stops (tree block ids) they hold.
const TREE_ROWS = [
  {kind: 'agent', text: 'Read the message'},
  {kind: 'check', text: 'About missing items?', exit: {label: 'No', name: 'Reject', ids: [L.ex1Stop]}},
  {kind: 'lookup', text: 'Delivery record'},
  {kind: 'check', text: 'Within 24 hours?', exit: {label: 'No', name: 'Reject', ids: ['bsvn0svib']}},
  {kind: 'check', text: 'No photo proof?', exit: {label: 'No', name: 'Reject', ids: ['bsvn0qnlu']}},
  {kind: 'lookup', text: 'Order record'},
  {kind: 'agent', text: 'Match missing items', exit: {label: 'No item matched', name: 'Send to a person', ids: ['auto']}},
  {kind: 'check', text: 'Missing items under $50?', exit: {label: 'No', name: 'Reject', ids: ['bsvn0opzr']}},
  {kind: 'check', text: 'Asks for a reorder, within 2 hours?', exit: {label: 'Yes', name: 'Reorder', ids: ['bsvn0ea7r']}, down: {label: 'No', name: 'Refund the items', ids: ['bsvn0f329', 'bsvn0hfmr']}},
];
let stopSel = null, stopEnd = null; // the box clicked (an ending), and the lit end node clicked in its tree
function renderStops() {
  const base = {last: shownBase('last'), this: shownBase('this')};
  if (noMatch(base)) return;
  const cntE = (w, ids, e) => base[w].filter(c => ids.includes(c.place) && endOf(placeOf(c.place), w) === e).length;
  const allIds = PLACES.map(p => p.id);
  A('an-res-how').textContent = 'Each box counts the chats that ended one way. Click a box to see where in the decision tree they ended.';
  const grid = el('div', {class: 'sp-grid'});
  for (const [e, title] of STOP_ENDS) {
    const half = (w, n) => el('span', {class: 'sp-half ' + w}, el('span', {class: 'sp-wk', text: WEEK[w]}), el('span', {class: 'sp-n', text: num(n)}));
    grid.append(el('button', {class: 'sp-box', 'aria-pressed': String(stopSel === e), 'data-end': e,
      onclick: () => { stopSel = stopSel === e ? null : e; stopEnd = null; renderStops(); if (stopSel) A('tr-box').scrollIntoView({behavior: 'smooth', block: 'nearest'}); }},
      el('span', {class: 'sp-lab', text: title}), el('span', {class: 'sp-halves'}, half('last', cntE('last', allIds, e)), half('this', cntE('this', allIds, e)))));
  }
  const parts = [el('div', {class: 'an-legend'}, el('span', {class: 'an-key last'}), 'Week 1 ', el('span', {class: 'an-key this'}), 'Week 2'), grid];
  if (stopSel) {
    const e = stopSel;
    const endNode = (x, key) => {
      const a = cntE('last', x.ids, e), b = cntE('this', x.ids, e);
      const lit = x.ids.some(id => endOf(placeOf(id), 'last') === e || endOf(placeOf(id), 'this') === e);
      if (!lit) return el('span', {class: 'tr-end'}, x.name);
      const note = x.ids.includes(L.ex1Stop) && e === 'human' ? el('span', {class: 'tr-note', text: 'Week 1: send to a person'}) : null;
      return el('button', {class: 'tr-end lit', 'aria-pressed': String(stopEnd === key), title: 'Click to read these chats', 'aria-label': `${x.name}: ${num(a)} in week 1, ${num(b)} in week 2`,
        onclick: () => { stopEnd = stopEnd === key ? null : key; renderStops(); A('an-step4').scrollIntoView({behavior: 'smooth', block: 'start'}); }},
        el('span', {class: 'tr-endname', text: x.name}), note,
        el('span', {class: 'tr-nums'}, el('span', {class: 'tr-n last'}, el('small', {text: WEEK.last}), num(a)), el('span', {class: 'tr-n this'}, el('small', {text: WEEK.this}), num(b))));
    };
    const rows = el('div', {class: 'tr-rows'});
    TREE_ROWS.forEach((r, i) => {
      if (i) rows.append(el('div', {class: 'tr-link'}, TREE_ROWS[i - 1].kind === 'check' ? el('span', {class: 'tr-yes', text: 'Yes'}) : null));
      rows.append(el('div', {class: 'tr-row'}, el('span', {class: 'tr-node ' + r.kind}, r.text),
        r.exit ? el('span', {class: 'tr-exit'}, el('span', {class: 'tr-line'}, el('span', {class: 'tr-lab', text: r.exit.label})), endNode(r.exit, 'x' + i)) : null));
      if (r.down) { rows.append(el('div', {class: 'tr-link'}, el('span', {class: 'tr-yes', text: r.down.label}))); rows.append(el('div', {class: 'tr-row'}, endNode(r.down, 'd' + i))); }
    });
    parts.push(el('div', {class: 'tr-box', id: 'tr-box'}, el('div', {class: 'tr-head'}, el('h3', {text: 'Decision tree'})), rows));
  }
  A('an-results').replaceChildren(...parts);
  const ending = {reorder: 'Reordered', refund: 'Refunded', refuse: 'Rejected', human: 'Sent to a person'};
  if (stopSel && stopEnd) {
    const i = Number(stopEnd.slice(1)), r = TREE_ROWS[i], x = stopEnd[0] === 'x' ? r.exit : r.down, e = stopSel;
    const pick = c => x.ids.includes(c.place) && endOf(placeOf(c.place), c.w) === e;
    const wk = base.this.some(pick) || !base.last.some(pick) ? 'this' : 'last';
    showList(`${ending[e]} at: ${r.text} ${x.label}`, pick, wk, false);
  } else if (stopSel) {
    const e = stopSel, pick = c => endOf(placeOf(c.place), c.w) === e;
    showList(ending[e], pick, base.this.some(pick) || !base.last.some(pick) ? 'this' : 'last', false);
  } else showList('All the chats that match your filters', () => true, 'this', false);
}

// ----- Categorical Breakdown: how many chats fall in each range of a number, week 1 | week 2 (a histogram) -----
const matchedItems = c => (c.match && c.match.items) || [];
const inRange = (a, b) => v => v >= a && v < b; // from a, up to but not including b
const upTo = (a, b) => v => v > a && v <= b; // more than a, up to and including b (the "When the customer wrote" filter's edges)
const DOLLARS5 = [['Under $5', inRange(0, 5)], ['$5 to $9.99', inRange(5, 10)], ['$10 to $14.99', inRange(10, 15)], ['$15 to $19.99', inRange(15, 20)], ['$20 to $24.99', inRange(20, 25)], ['$25 or more', inRange(25, Infinity)]];
const FIELDS = [
  {k: 'refund', label: 'Refund amount', of: 'chats with a refund', has: c => c.end === 'refund', val: c => c.refund, bins: DOLLARS5},
  {k: 'total', label: 'Order total', of: 'chats', has: () => true, val: c => c.o.total,
   bins: [['Under $10', inRange(0, 10)], ['$10 to $19.99', inRange(10, 20)], ['$20 to $29.99', inRange(20, 30)], ['$30 to $39.99', inRange(30, 40)], ['$40 to $49.99', inRange(40, 50)], ['$50 or more', inRange(50, Infinity)]]},
  {k: 'matched', label: 'Value of the items the agent matched', of: 'chats with a matched item', has: c => matchedItems(c).length > 0,
   val: c => matchedItems(c).reduce((p, x) => p + x.price, 0), bins: DOLLARS5},
  {k: 'nmatched', label: 'Items the agent matched', of: 'chats', has: () => true, val: c => matchedItems(c).length,
   bins: [['None', v => v === 0], ['1', v => v === 1], ['2', v => v === 2], ['3 or more', v => v >= 3]]},
  {k: 'hrs', label: 'Hours from delivery to message', of: 'chats', has: () => true, val: c => c.hrs,
   bins: [['Up to 1 hour', v => v <= 1], ['1 to 2 hours', upTo(1, 2)], ['2 to 6 hours', upTo(2, 6)], ['6 to 24 hours', upTo(6, 24)], ['24 to 48 hours', upTo(24, 48)], ['More than 48 hours', v => v > 48]]},
  {k: 'stars', label: 'Star rating', of: 'chats', has: () => true, val: c => c.stars, bins: [1, 2, 3, 4, 5].map(n => [`${n} star${n > 1 ? 's' : ''}`, v => v === n])},
  {k: 'hour', label: 'Time of day the customer wrote', of: 'chats', has: () => true, val: c => D(c.t).getUTCHours(),
   bins: [['Midnight to 6 a.m.', inRange(0, 6)], ['6 to 9 a.m.', inRange(6, 9)], ['9 a.m. to noon', inRange(9, 12)], ['Noon to 3 p.m.', inRange(12, 15)], ['3 to 6 p.m.', inRange(15, 18)], ['6 to 9 p.m.', inRange(18, 21)], ['9 p.m. to midnight', inRange(21, 24)]]},
];
let breakSel = null; // the bar clicked: "week|range number"
function renderBreakdown() {
  const v = FIELDS.find(x => x.k === shown.field);
  const base = {last: shownBase('last').filter(v.has), this: shownBase('this').filter(v.has)};
  if (!base.last.length && !base.this.length) {
    A('an-res-how').textContent = '';
    A('an-results').replaceChildren(el('div', {class: 'note bad'}, el('b', {text: `No ${v.of} in either week match these filters. `}), `Filters: ${describeFilters(shown)}. Remove a filter or press Clear filters.`));
    A('an-step4').hidden = true;
    return;
  }
  const inBin = (c, b) => b[1](v.val(c));
  const counts = {last: v.bins.map(b => base.last.filter(c => inBin(c, b)).length), this: v.bins.map(b => base.this.filter(c => inBin(c, b)).length)};
  const max = Math.max(1, ...counts.last, ...counts.this); // one scale for both weeks
  A('an-res-how').textContent = `${v.label}: the number of ${v.of} in each range. Click a bar to read those chats.`;
  const bar = (w, i) => {
    const n = counts[w][i], k = `${w}|${i}`, b = v.bins[i], say = `${WEEK[w]}, ${b[0]}: ${num(n)} ${v.of}`;
    const kids = [el('span', {class: 'hg-n', text: num(n)}), el('span', {class: 'hg-fill', style: `height:${(190 * n / max).toFixed(1)}px`})];
    return n ? el('button', {class: 'hg-bar ' + w, 'aria-pressed': String(breakSel === k), title: say, 'aria-label': say,
      onclick: () => { breakSel = breakSel === k ? null : k; renderBreakdown(); }}, ...kids) : el('span', {class: 'hg-bar ' + w, title: say}, ...kids);
  };
  A('an-results').replaceChildren(el('div', {class: 'small', style: 'margin:0 0 4px', text: `Filters: ${describeFilters(shown)}`}),
    el('div', {class: 'hg-card'},
      el('div', {class: 'hg-legend'}, ['last', 'this'].map(w => el('span', {class: 'hg-key ' + w}, el('i'), el('b', {text: WEEK[w]}), `: ${num(base[w].length)} ${v.of}`))),
      el('div', {class: 'hg-chart', role: 'group', 'aria-label': `${v.label} in ranges, week 1 and week 2`},
        v.bins.map((b, i) => el('div', {class: 'hg-bin'}, el('div', {class: 'hg-bars'}, bar('last', i), bar('this', i)), el('div', {class: 'hg-lab', text: b[0]}))))));
  if (breakSel) {
    const [w, i] = breakSel.split('|'), b = v.bins[+i];
    showList(`${v.label}: ${b[0]}`, c => v.has(c) && inBin(c, b), w);
  } else A('an-step4').hidden = true;
}

// ===== Differential analysis: one week's chats run through the other week's workflow =====
// For each week-2 chat whose ending differs, logs.js holds its ending under week 1's workflow (c.s1): the agent's recorded
// reading of the message is kept and week 1's fixed rules are applied to it. Every other week-2 chat ends the same way in both.
// Week 1's chats under week 2's workflow: week 1 sent a chat to a person at "About missing items? No" (stop L.w1Stop), and
// week 2's workflow rejects it there; every other step is the same, so every other week-1 chat ends the same way in both.
const DX_ENDS = [['reorder', 'Reorder'], ['refund', 'Refund'], ['refused', 'Rejected'], ['human', 'Sent to a person']];
const end1 = c => c.s1 ? c.s1.end : c.end; // the ending under week 1's workflow
const place1 = c => !c.s1 ? c.place : c.s1.stop === L.w1Stop ? L.ex1Stop : c.s1.stop; // where week 1's workflow ended it
// the last decision before each ending, in the decision tree's own words (slide 2; its two reorder checks are one there)
const LAST = {[L.ex1Stop]: 'About missing items? No', bsvn0svib: 'Within 24 hours? No', bsvn0qnlu: 'No photo proof? No', auto: 'Match missing items: no item matched',
  bsvn0opzr: 'Missing items under $50? No', bsvn0ea7r: 'Asks for a reorder, within 2 hours? Yes', bsvn0hfmr: 'Asks for a reorder, within 2 hours? No', bsvn0f329: 'Asks for a reorder, within 2 hours? No'};
const TREE_ACT = {reorder: 'Reorder', refund: 'Refund the items', refused: 'Reject', human: 'Send to a person'};
const lastQ = place => LAST[place] || placeOf(place).q;
const lastDecision = (place, end) => `${lastQ(place)} → ${TREE_ACT[end]}`;
const DXCOLS = [['When', c => when(c.t)], ['Restaurant', c => c.rest], ["Customer's message", c => c.m, 'an-msg'], ['Rating', c => starText(c.stars), 'stars']];
// A: week 1's workflow, B: week 2's workflow, for the chats of the week each direction runs
const DX = {
  w2: {w: 'this', endA: c => end1(c), endB: c => c.end, placeA: c => place1(c), placeB: c => c.place,
       refA: c => c.s1 ? (c.s1.end === 'refund' ? c.refund || 0 : 0) : c.refund || 0, refB: c => c.refund || 0},
  w1: {w: 'last', endA: c => c.end, endB: c => c.stop === L.w1Stop ? 'refused' : c.end, placeA: c => c.place, placeB: c => c.place,
       refA: c => c.refund || 0, refB: c => c.stop === L.w1Stop ? 0 : c.refund || 0},
};
let dxSel = null, dxRow = null, dxCats = false; // the number clicked in the table ("week 1 ending|week 2 ending"), the row clicked under it, the categories chart
function catChart(list) { // one bar per category the agent chose, for the chats behind the clicked number
  return el('div', {class: 'dx-cats'}, el('div', {class: 'dx-cats-t', text: `Category the agent chose (${num(list.length)} chats)`}),
    CATS.map(k => { const n = list.filter(c => c.cat === k).length;
      return el('div', {class: 'dx-cat'}, el('span', {text: k}), el('span', {class: 'dx-cat-b'}, el('span', {style: `width:${(n / list.length * 100).toFixed(1)}%`})), el('span', {class: 'dx-cat-n', text: num(n)})); }));
}
function renderDiff() {
  const dx = DX[shown.dxDir], wk = dx.w === 'this' ? 'week-2' : 'week-1';
  const base = shownBase(dx.w);
  if (!base.length) {
    A('an-res-how').textContent = '';
    A('an-results').replaceChildren(el('div', {class: 'note bad'}, el('b', {text: `No ${wk} chat matches these filters. `}), `Filters: ${describeFilters(shown)}. Remove a filter or press Clear filters.`));
    A('an-step4').hidden = true;
    return;
  }
  const inCell = (e1, e2) => base.filter(c => dx.endA(c) === e1 && dx.endB(c) === e2);
  if (dxSel && !inCell(...dxSel.split('|')).length) { dxSel = null; dxRow = null; }
  A('an-res-how').textContent = `Each number counts ${wk} chats. Row: how week 1's workflow ends them. Column: how week 2's workflow ends them. Click a number to see where each workflow ended them.`;
  const t = el('table', {class: 'an-table dx'},
    el('tr', {}, el('td', {class: 'dx-blank', colspan: '2', rowspan: '2'}), el('th', {scope: 'colgroup', colspan: String(DX_ENDS.length), class: 'dx-w2', text: "Week 2's workflow"}),
      el('th', {scope: 'col', rowspan: '2', class: 'dx-all', text: 'All'})),
    el('tr', {}, DX_ENDS.map(([, n]) => el('th', {scope: 'col', text: n}))));
  DX_ENDS.forEach(([e1, n1], i) => {
    t.append(el('tr', {}, i ? null : el('th', {scope: 'rowgroup', rowspan: String(DX_ENDS.length), class: 'dx-w1', text: "Week 1's workflow"}),
      el('th', {scope: 'row', text: n1}), DX_ENDS.map(([e2, n2]) => {
      const n = inCell(e1, e2).length, k = `${e1}|${e2}`;
      if (!n) return el('td', {class: 'num zero', text: '0'});
      return el('td', {class: 'num'}, el('button', {class: 'dx-cell', 'aria-pressed': String(dxSel === k), title: 'Click to see where each workflow ended these chats',
        'aria-label': `${num(n)} chats: ${n1} under week 1's workflow, ${n2} under week 2's workflow`,
        onclick: () => { dxSel = dxSel === k ? null : k; dxRow = null; dxCats = false; renderDiff(); if (dxSel) A('dx-why').scrollIntoView({behavior: 'smooth', block: 'nearest'}); }}, num(n)));
    }), el('td', {class: 'num dx-tot', text: num(base.filter(c => dx.endA(c) === e1).length)})));
  });
  t.append(el('tr', {class: 'dx-tot'}, el('th', {scope: 'row', colspan: '2', text: 'All'}), DX_ENDS.map(([e2]) => el('td', {class: 'num', text: num(base.filter(c => dx.endB(c) === e2).length)})), el('td', {class: 'num', text: num(base.length)})));
  const parts = [el('div', {class: 'small', style: 'margin:0 0 4px', text: `${num(base.length)} ${wk} chats · Filters: ${describeFilters(shown)}`}), el('div', {class: 'dx-wrap'}, t)];
  if (!dxSel) { A('an-results').replaceChildren(...parts); A('an-step4').hidden = true; return; }
  const [e1, e2] = dxSel.split('|'), name = x => DX_ENDS.find(y => y[0] === x)[1];
  const groups = [];
  for (const c of inCell(e1, e2)) {
    const a = lastDecision(dx.placeA(c), e1), b = lastDecision(dx.placeB(c), e2);
    let g = groups.find(x => x.a === a && x.b === b);
    if (!g) groups.push(g = {a, b, list: []});
    g.list.push(c);
  }
  groups.sort((x, y) => y.list.length - x.list.length);
  if (dxRow != null && !groups[dxRow]) dxRow = null;
  const pickRow = i => { dxRow = dxRow === i ? null : i; renderDiff(); A('an-step4').scrollIntoView({behavior: 'smooth', block: 'start'}); };
  const why = el('table', {class: 'an-table dx-why'}, el('tr', {}, el('th', {scope: 'col', text: "Week 1's workflow"}), el('th', {scope: 'col', text: "Week 2's workflow"}), el('th', {scope: 'col', text: 'Chats'})));
  groups.forEach((g, i) => why.append(el('tr', {tabindex: '0', class: dxRow === i ? 'on' : '', title: 'Click to read only these chats', onclick: () => pickRow(i),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickRow(i); } }},
    el('td', {text: g.a}), el('td', {text: g.b}), el('td', {class: 'num', text: num(g.list.length)}))));
  const title = `${name(e1)} → ${name(e2)}`, all = inCell(e1, e2);
  parts.push(el('div', {class: 'dx-whybox', id: 'dx-why'}, el('h3', {text: `${title}: ${num(all.length)} chats`}),
    el('p', {class: 'dx-dollars'}, el('b', {text: 'Refund dollars: '}), `${money0(sum(all, dx.refA))} under week 1's workflow · ${money0(sum(all, dx.refB))} under week 2's workflow`),
    el('p', {class: 'small', style: 'margin:0', text: 'The last decision before the ending, in each workflow.' + (groups.length > 1 ? ' Click a row to read only its chats.' : '')}), why,
    el('button', {class: 'btn', style: 'margin-top:12px', 'aria-expanded': String(dxCats), onclick: () => { dxCats = !dxCats; renderDiff(); }}, dxCats ? 'Hide categories' : 'Show categories'),
    dxCats ? catChart(all) : null));
  A('an-results').replaceChildren(...parts);
  const list = dxRow == null ? all : groups[dxRow].list;
  const listTitle = dxRow == null ? title : `${title} · ${groups[dxRow].b}`;
  A('an-list').replaceChildren(el('p', {class: 'an-listtitle'}, el('b', {text: `${listTitle}: ${num(list.length)} chats`})), chatTable(list, {cols: DXCOLS, open: {both: true}}));
  A('an-step4').hidden = false;
}

// ----- instructor copy: both fixes together, and the rating rule -----
function renderInstructor() {
  if (!INSTR) return;
  A('sw-instructor').hidden = false;
  const fix1 = c => ['never arrived', 'allergy or illness'].includes(c.cat) && !c.photo && c.hrs <= 24; // the partial revert
  const fixed = inWeek('this').map(c => {
    if (c.place === L.ex1Stop && fix1(c)) return {c, end: 'human', refund: 0, ok: 1};
    return {c, end: c.end, refund: c.refund, ok: c.ok};
  });
  const st = rs => { const refunds = rs.filter(x => x.end === 'refund'), dollars = sum(rs, x => x.refund);
    return {refunds: refunds.length, dollars, avg: refunds.length ? dollars / refunds.length : 0, reorders: rs.filter(x => x.end === 'reorder').length, rejected: rs.filter(x => x.end === 'refused').length,
            person: rs.filter(x => x.end === 'human').length, exp: sum(rs, x => POL.oneStarChance(x.end, x.c.right)), bad: rs.filter(x => !x.ok && x.end !== 'human').length}; };
  const a = st(inWeek('this').map(c => ({c, end: c.end, refund: c.refund, ok: c.ok}))), b = st(fixed);
  const names = [['refunds', 'Refunds', num], ['dollars', 'Refund dollars', money0], ['avg', 'Average refund', money], ['reorders', 'Reorders', num], ['rejected', 'Rejected', num],
                 ['person', 'Sent to a person', num], ['exp', 'Expected chats rated 1 star (rating rule)', num], ['bad', 'Refunded, reordered or rejected against the policy', num]];
  A('sw-instructor').replaceChildren(el('h3', {text: 'Instructor copy only: the partial revert'}),
    el('p', {class: 'small', text: 'The partial revert from the differential analysis: at "Is the message about missing items in delivery? no", never arrived or allergy or illness, no drop-off photo, within 24 hours → a person, as in week 1; the rest stay rejected. Week 2 is replayed with it. A chat sent to a person counts as following the policy.'}),
    tiles(a, b, names, ['Week 2 as it ran', 'With the partial revert']),
    el('h4', {text: 'How the star ratings in these logs were drawn'}),
    el('table', {class: 'an-table'}, el('tr', {}, el('th', {text: 'What the customer got'}), el('th', {text: 'Chance of a 1-star rating'})), ...POL.RULE_TEXT.map(([x, y]) => el('tr', {}, el('td', {text: x}), el('td', {text: y})))));
}

// ----- download -----
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function download() {
  const head = ['week', 'day', 'time', 'order', 'customer', 'restaurant', 'items', 'order total', 'card', 'delivered', 'hours from delivery to message', 'drop-off photo', 'message',
                "agent's category", 'asks for', "agent's matched items", 'where it stopped', 'ending', 'ending detail', 'refund amount', 'rating', 'reply'];
  const lines = [head.join(',')];
  for (const c of L.cases) {
    lines.push([WEEK[c.w], DAYS[c.day], c.t.replace('T', ' '), c.o.number, L.customers[c.cu] || c.cu, c.rest, c.o.items.map(x => `${x.name} ${x.price.toFixed(2)}`).join('; '), c.o.total.toFixed(2), c.o.card,
      c.d.delivered.replace('T', ' '), c.hrs.toFixed(1), c.photo ? 'yes' : 'no', c.m, c.cat, c.read && c.read.asks || '', c.match ? (c.match.items || []).map(x => x.name).join('; ') : 'no clear answer',
      stopName(c.place), ENDING[c.end], c.out, c.refund ? c.refund.toFixed(2) : '', c.stars, c.reply].map(csvCell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], {type: 'text/csv'});
  const a = el('a', {href: URL.createObjectURL(blob), download: 'Lecture 9 chat logs (two weeks).csv'});
  document.body.append(a); a.click(); a.remove();
}

// The class policy (Lecture 8, slide 3) and Lecture 8 Exercise 1's two rules, worded as the slides give them.
const POLICY_TEXT = [
  ['Case 1: Food never arrived:', 'refund the total or reorder. Check no drop-off photo.'],
  ['Case 2: Wrong or missing items:', 'Refund the exact value. Check that it was on the order.'],
  ['Case 3: Allergy or illness:', 'Escalate to a supervisor immediately. Do not offer a refund or reorder first.'],
  ['Case 4: Refund limits:', 'Send to a human if the refund exceeds $50 or the customer has had two or more refunds in the past 30 days.'],
  ['For every case:', 'Either refund or reorder but not both. Refund to the original card. Only refund if the request is within 24 hours of the order.'],
  ['Reorders:', 'If the customer asks to send the items again, reorder the missing items instead of refunding them. (Conditions: 2 hours, no photo proof, under $50)'],
  ['Everything else:', 'Reject requests that do not satisfy our policy (e.g., the request is irrelevant or photo evidence is available).'],
];

function start() {
  const n = w => num(inWeek(w).length);
  A('an-intro').textContent = `This tab gives statistics for ${n('last')} chat logs from week 1 (${L.weeks.last.dates}) and ${n('this')} from week 2 (${L.weeks.this.dates}).`;
  for (const ul of document.querySelectorAll('.an-policy')) ul.append(...POLICY_TEXT.map(([t, x]) => el('li', {}, el('b', {text: t + ' '}), x)));
  A('an-tiles').replaceChildren(tiles(stats(inWeek('last')), stats(inWeek('this'))));
  const tabs = A('an-tabs');
  tabs.replaceChildren(...METHODS.map(([k, name]) => el('button', {role: 'tab', id: 'an-tab-' + k, 'data-m': k, 'aria-controls': 'an-panel', 'aria-selected': 'false', tabindex: '-1', text: name, onclick: () => pickMethod(k)})));
  tabs.onkeydown = e => {
    const keys = METHODS.map(x => x[0]), i = keys.indexOf(S.method);
    if (e.key === 'ArrowRight') pickMethod(keys[(i + 1) % keys.length], true);
    else if (e.key === 'ArrowLeft') pickMethod(keys[(i + keys.length - 1) % keys.length], true);
  };
  A('an-show').onclick = showResults;
  A('an-swap').onclick = () => { S.dxDir = S.dxDir === 'w2' ? 'w1' : 'w2'; dxSel = null; dxRow = null; dxCats = false; pickMethod('diff'); A('an-swap').focus(); };
  A('an-clear').onclick = () => { S.f = Object.assign({}, F0); S.rate = Object.assign({}, RATE0); renderControls(); markStale(); };
  A('an-download').onclick = download;
  renderInstructor();
  A('drawer-back').onclick = closeChat;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !A('drawer').hidden) closeChat(); });
  pickMethod('stop');
}
start();
})();
