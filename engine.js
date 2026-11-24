// engine.js: the harness of the Agentic Workflow Builder (MGOC50, Lecture 9 copy). Students don't need to read it.
// Lecture 9 changes: each case can run at its own time (options.now) and with its own customers (options.customers);
// a result says which Action ended it (stop); answersFor asks the agent's jobs for one case (used to record two weeks of logs).
//
// A design is a decision tree made of four kinds of blocks:
//   Look up           a fixed rule reads one file: the order, the delivery record, the driver chat or past cases
//   Ask the agent     the agent (qwen3:1.7b) does one job: read the message, match items to the order, or give an amount
//   Check             a fixed rule asks one yes/no question about a value from above; it splits the tree in two
//   Action            the final action: refund, reorder or reject (a fixed rule), or human escalation (a supervisor
//                     reviews the case); the path ends there
// The tree runs top to bottom, in the order it is drawn. A block uses only values from blocks above it on its path.
// Every ending gets an audit record, and a reply: the agent writes it after an Action; after a human escalation the reply
// is always "A supervisor is reviewing your problem." Any failure (a record missing, no clear answer from the agent,
// a declined refund) goes to a human automatically.
(function (root) {
'use strict';

const DATA = (typeof module !== 'undefined' && module.exports) ? require('./data.js') : root.DATA;

// ===== Small helpers =====
const clone = x => JSON.parse(JSON.stringify(x));
const money = n => '$' + Number(n).toFixed(2);
const minutes = t => Math.round(Date.parse(t + ':00Z') / 60000);
const NOW_MIN = minutes(DATA.NOW);
const hoursSince = t => (NOW_MIN - minutes(t)) / 60;
function niceTime(t) {
  if (!t) return 'none';
  const d = new Date(t + ':00Z');
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”"`*_]/g, '').replace(/\s+/g, ' ').trim();
const digits = s => String(s || '').replace(/\D/g, '');
let idCounter = 0;
const newId = () => 'b' + Date.now().toString(36).slice(-4) + (++idCounter).toString(36) + Math.random().toString(36).slice(2, 5);

// ===== The catalog: what students choose from =====
const WHO = {rule: 'a fixed rule', agent: 'the agent', human: 'a human'};
const BLOCKS = {
  lookup: {name: 'Look up', who: 'rule', help: 'A fixed rule reads one file.'},
  agent:  {name: 'Ask the agent', who: 'agent', help: 'The agent reads the message and answers from a fixed list.'},
  check:  {name: 'Check', who: 'rule', help: 'A fixed rule asks a yes/no question. The tree splits into yes and no.'},
  act:    {name: 'Action', who: 'rule', help: 'The final action: refund, reorder, reject, or human escalation. The path ends here.'},
};
const ORDER_OF_BLOCKS = ['lookup', 'agent', 'check', 'act'];
// who decides at a block: the human escalation Action is a human; every other Action is a fixed rule
const whoKey = b => b.type === 'act' && b.action === 'human' ? 'human' : BLOCKS[b.type].who;
const whoOf = b => WHO[whoKey(b)];

// What each block can provide to the blocks below it. A provider is a file looked up or a job the agent did.
const FILES = {
  order:    {name: 'Order record', what: 'items ordered', brings: 'the items and prices, the total, the card, the time ordered'},
  delivery: {name: 'Delivery record', what: 'was it delivered', brings: 'the drop-off photo, the location match, the driver\'s name and phone'},
  chat:     {name: 'Driver chat', what: 'messages with the driver', brings: 'the messages between the customer and the driver'},
  past:     {name: 'Past cases', what: 'earlier refunds and reorders', brings: 'this customer\'s refunds and reorders in other chats (only when Memory is on)'},
};
const JOBS = {
  read:   {name: 'Identify the category: What is the message about? Refund or reorder?', gives: 'the category and what the customer asks for'},
  match:  {name: 'Which items in message match order?', gives: 'the missing items that are on the order; a fixed rule adds their prices', needs: 'order'},
  amount: {name: 'Give the refund amount', gives: 'a dollar amount, from the message and the order', needs: 'order', hidden: true}, // the cheat design only
};
const PROVIDER_NAMES = {order: 'Look up: Order record', delivery: 'Look up: Delivery record', chat: 'Look up: Driver chat', past: 'Look up: Past cases',
                        read: 'Ask the agent: Identify the category', match: 'Ask the agent: Which items match the order?', amount: 'Ask the agent: Give the refund amount'};
const providerOf = b => b.type === 'lookup' ? b.file : b.type === 'agent' ? b.job : null;

const CATEGORIES = ['never arrived', 'missing items', 'allergy or illness', 'something else'];
const ASKS = ['refund', 'reorder'];

// The questions a Check can ask. {n} is the number the student can change.
const CHECKS = {
  allergy:    {q: 'Is the message about an allergy or illness?', needs: 'read', test: v => v.read.category === 'allergy or illness', shows: v => `category: ${v.read.category}`},
  never:      {q: 'Does the message say the whole order never arrived?', needs: 'read', test: v => v.read.category === 'never arrived', shows: v => `category: ${v.read.category}`},
  missing:    {q: 'Is the message about missing items in delivery?', needs: 'read', test: v => v.read.category === 'missing items', shows: v => `category: ${v.read.category}`},
  reorder:    {q: 'Does the customer ask for a reorder?', needs: 'read', test: v => v.read.asks === 'reorder', shows: v => `asks for: ${v.read.asks}`},
  within:     {q: 'Within {n} hours of delivery?', num: 24, needs: 'delivery', test: (v, n) => v.delivery.hours <= n, shows: v => `delivered ${niceTime(v.delivery.delivered)}, ${Math.round(v.delivery.hours * 10) / 10} hours ago`},
  total:      {q: 'Is the order total over ${n}?', num: 50, needs: 'order', test: (v, n) => v.order.total > n, shows: v => `order total ${money(v.order.total)}`},
  photo:      {q: 'No photo proof of delivery?', needs: 'delivery', test: v => v.delivery.photo !== 'at the address', shows: v => `drop-off photo: ${v.delivery.photo}`},
  chat:       {q: 'Did the customer write to the driver after drop-off?', needs: 'chat', test: v => v.chat.after === 'yes', shows: v => `wrote after drop-off: ${v.chat.after}`},
  refunds:    {q: '{n} or more refunds in the past 30 days?', num: 2, needs: 'past', test: (v, n) => v.past.refunds30 >= n, shows: v => `refunds in 30 days: ${v.past.refunds30}`},
  fixed:      {q: 'Already a refund or reorder on this order?', needs: 'past', test: v => v.past.fixed === 'yes', shows: v => `already fixed: ${v.past.fixed}`},
  onOrder:    {q: 'Is any missing item on the order?', needs: 'match', test: v => v.match.items.length > 0, shows: v => `matched: ${v.match.items.map(x => x.name).join(', ') || 'none'}`},
  itemsUnder: {q: 'Are the missing items under ${n}?', num: 50, needs: 'match', test: (v, n) => v.match.total < n, shows: v => `missing items' bill: ${money(v.match.total)}`},
  amountOver: {q: 'Is the agent\'s amount over ${n}?', num: 50, needs: 'amount', test: (v, n) => v.amount.value > n, shows: v => `the agent's amount: ${money(v.amount.value)}`},
};
// in the order of the class's refund tree first, then the rest (the page also uses this order for each new Check's first choice)
const CHECK_ORDER = ['missing', 'within', 'photo', 'itemsUnder', 'reorder', 'allergy', 'never', 'total', 'chat', 'refunds', 'fixed', 'onOrder', 'amountOver'];

const ACTIONS = {
  refund:  {name: 'Refund', choiceLabel: 'Amount', choices: {
    total: {label: 'the order total', needs: 'order'},
    items: {label: 'the missing items\' bill', needs: 'match'},
    agent: {label: 'the amount the agent gave', needs: 'amount'}}},
  reorder: {name: 'Reorder', choiceLabel: 'What', choices: {
    order: {label: 'the whole order', needs: 'order'},
    items: {label: 'the missing items', needs: 'match'}}},
  refuse:  {name: 'Reject', choices: null},
  human:   {name: 'Human escalation', choices: null},
};
const HUMAN_REPLY = 'A supervisor is reviewing your problem.';

const MODELS = {qwen: {name: 'qwen3:1.7b (Ollama, on this laptop)', id: 'qwen3:1.7b'}};
const BENCH_TEMPERATURE = 0.7; // the test area only; every Run uses 0. Never shown to students.
const LIMITS = {blocks: 80, message: 500};

// ===== The design: a tree of blocks =====
// design = {name, note, memory: {conversation, caseRecord, pastCases}, key: id of the answer key or null, tree: [blocks]}
// A Check holds two lists, yes and no, and is always the last block of its list. Act ends a list.
function newDesign(name) {
  return {format: 'awb-design-1', name: name || 'My tree', note: '', key: null,
          memory: {conversation: false, caseRecord: false, pastCases: false}, tree: []};
}
function newBlock(type, opts = {}) {
  const b = {id: newId(), type};
  if (type === 'lookup') b.file = opts.file || 'order';
  if (type === 'agent') { b.job = opts.job || 'read'; b.vote = !!opts.vote; }
  if (type === 'check') { b.check = opts.check || 'allergy'; b.num = opts.num != null ? opts.num : (CHECKS[b.check].num != null ? CHECKS[b.check].num : null); b.yes = []; b.no = []; }
  if (type === 'act') { b.action = opts.action || 'refund'; b.choice = opts.choice || (ACTIONS[b.action].choices ? Object.keys(ACTIONS[b.action].choices)[0] : null); }
  return b;
}
const isEnding = b => !!b && b.type === 'act';
const closes = b => b && (b.type === 'check' || isEnding(b)); // nothing may follow it in its list

// Lists are named by {parent: id of a Check or null for the top, branch: 'yes' | 'no' | null}.
function listAt(design, ref) {
  if (!ref || !ref.parent) return design.tree;
  const f = findBlock(design, ref.parent);
  return f && f.block.type === 'check' ? f.block[ref.branch] : null;
}
function findBlock(design, id, list = design.tree, ref = {parent: null, branch: null}) {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.id === id) return {block: b, list, index: i, ref};
    if (b.type === 'check') {
      for (const br of ['yes', 'no']) { const f = findBlock(design, id, b[br], {parent: b.id, branch: br}); if (f) return f; }
    }
  }
  return null;
}
function allBlocks(list, out = []) {
  for (const b of list) { out.push(b); if (b.type === 'check') { allBlocks(b.yes, out); allBlocks(b.no, out); } }
  return out;
}
function allLists(design) {
  const out = [{ref: {parent: null, branch: null}, list: design.tree}];
  for (const b of allBlocks(design.tree)) if (b.type === 'check') for (const br of ['yes', 'no']) out.push({ref: {parent: b.id, branch: br}, list: b[br]});
  return out;
}
function inSubtree(block, id) {
  if (block.id === id) return true;
  return block.type === 'check' && allBlocks(block.yes.concat(block.no)).some(b => b.id === id);
}
// Insert a block at a place. A Check inserted above other blocks takes them into one of its branches (continueOn).
// Nothing may be inserted after a Check or an ending: the tree has nowhere to go from there.
function insertBlock(design, ref, index, block, continueOn) {
  const list = listAt(design, ref);
  if (!list) return {ok: false, msg: 'That place is gone.'};
  if (allBlocks(design.tree).length >= LIMITS.blocks) return {ok: false, msg: `A tree can have at most ${LIMITS.blocks} blocks.`};
  index = Math.max(0, Math.min(index == null ? list.length : index, list.length));
  if (index > 0 && closes(list[index - 1])) return {ok: false, msg: 'Nothing can go below a Check or an ending. Add it inside a branch instead.'};
  const below = list.slice(index);
  if (block.type === 'check' && below.length) {
    const br = continueOn === 'yes' ? 'yes' : 'no';
    // a Check being moved may already have blocks under that answer: the blocks below cannot follow its ending
    if (block[br].length) return {ok: false, msg: `This Check already has blocks under "${br}", so the blocks below cannot go there. Choose the other answer, or move it to the bottom of a branch.`};
    list.splice(index, below.length, block);
    block[br].push(...below);
  } else if (isEnding(block) && below.length) {
    return {ok: false, msg: 'An ending must be the last block of its branch. Delete the blocks below it first, or add the ending at the bottom.'};
  } else list.splice(index, 0, block);
  return {ok: true};
}
function removeBlock(design, id) {
  const f = findBlock(design, id);
  if (!f) return {ok: false};
  f.list.splice(f.index, 1);
  return {ok: true, removed: f.block};
}
function moveBlock(design, id, ref, index, continueOn) {
  const f = findBlock(design, id);
  if (!f) return {ok: false, msg: 'That block is gone.'};
  if (ref && ref.parent && inSubtree(f.block, ref.parent)) return {ok: false, msg: 'A Check cannot go inside its own branches.'};
  const snapshot = clone(design.tree);
  let at = index;
  if (sameRef(f.ref, ref) && index > f.index) at -= 1;
  f.list.splice(f.index, 1);
  const r = insertBlock(design, ref, at, f.block, continueOn);
  if (!r.ok) design.tree = snapshot;
  return r;
}
const sameRef = (a, b) => (a.parent || null) === (b.parent || null) && (a.branch || null) === (b.branch || null);

// ===== What a block may use: the providers above it on its own path =====
function providersAbove(design, id) {
  const path = pathTo(design, id);
  const out = new Set();
  if (!path) return out;
  for (const b of path) { const p = providerOf(b); if (p) out.add(p); }
  return out;
}
// The blocks above a block (or above a place in a list) on its path, top first.
function pathTo(design, id) {
  const walk = (list, above) => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.id === id) return above.concat(list.slice(0, i));
      if (b.type === 'check') {
        const here = above.concat(list.slice(0, i + 1));
        for (const br of ['yes', 'no']) { const r = walk(b[br], here); if (r) return r; }
      }
    }
    return null;
  };
  return walk(design.tree, []);
}
function providersAtPlace(design, ref, index) {
  const list = listAt(design, ref) || [];
  let above = [];
  if (ref && ref.parent) { above = pathTo(design, ref.parent) || []; above = above.concat([findBlock(design, ref.parent).block]); }
  above = above.concat(list.slice(0, index == null ? list.length : index));
  const out = new Set();
  for (const b of above) { const p = providerOf(b); if (p) out.add(p); }
  return out;
}
// What a block still needs from above, if anything (the page shows it in red).
function needsOf(b) {
  if (b.type === 'agent') return JOBS[b.job].needs ? [JOBS[b.job].needs] : [];
  if (b.type === 'check') return [CHECKS[b.check].needs];
  if (b.type === 'act') {
    const A = ACTIONS[b.action];
    const need = [];
    if (b.action === 'refund') need.push('order');
    if (A.choices && A.choices[b.choice]) need.push(A.choices[b.choice].needs);
    return [...new Set(need)];
  }
  return [];
}
function checkText(b) {
  const C = CHECKS[b.check];
  return C.q.replace('{n}', b.num != null ? b.num : C.num);
}
function blockText(b) {
  if (b.type === 'lookup') return 'Look up: ' + FILES[b.file].name;
  if (b.type === 'agent') return 'Ask the agent: ' + JOBS[b.job].name + (b.vote ? ' (vote of 5)' : '');
  if (b.type === 'check') return 'Check: ' + checkText(b);
  if (b.type === 'act') {
    const A = ACTIONS[b.action];
    return A.choices ? `${A.name} ${A.choices[b.choice].label}` : A.name;
  }
  return '';
}

// ===== Problems that stop Run =====
function validate(design) {
  const problems = [];
  const visit = (list, ref, above) => {
    const have = new Set(above.map(providerOf).filter(Boolean));
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      for (const need of needsOf(b)) if (!have.has(need)) problems.push({id: b.id, msg: `Needs ${PROVIDER_NAMES[need]} above it.`});
      if (b.type === 'check' && CHECKS[b.check].num != null) {
        const n = b.num == null || b.num === '' ? NaN : Number(b.num);
        if (!Number.isFinite(n) || n < 0 || n > 10000) problems.push({id: b.id, msg: 'Fill in the blank: type a number in the box.'});
      }
      if (i < list.length - 1 && closes(b)) problems.push({id: list[i + 1].id, msg: 'Nothing can run below a Check or an ending.'});
      const p = providerOf(b); if (p) have.add(p);
      if (b.type === 'check') for (const br of ['yes', 'no']) visit(b[br], {parent: b.id, branch: br}, above.concat(list.slice(0, i + 1)));
    }
    const last = list[list.length - 1];
    if (!closes(last)) problems.push({ref, end: true, msg: 'What happens here? End this path with an Action: refund, reorder, reject or human escalation.'});
  };
  visit(design.tree, {parent: null, branch: null}, []);
  return {ok: problems.length === 0, problems};
}

// ===== A block's three things, in plain words (the page shows them when a block is clicked) =====
function describe(design, id) {
  const f = findBlock(design, id);
  if (!f) return null;
  const b = f.block;
  const have = providersAbove(design, id);
  const missing = needsOf(b).filter(n => !have.has(n)).map(n => PROVIDER_NAMES[n]);
  const d = {title: blockText(b), who: whoOf(b), permissions: '', dependencies: '', stopping: ''};
  if (b.type === 'lookup') {
    d.permissions = `Reads the ${FILES[b.file].name.toLowerCase()} for this order only (${FILES[b.file].brings}). It changes nothing.`;
    d.dependencies = b.file === 'past' ? 'The customer. With Memory off, there are no past cases to read.' : 'The order number from the help page the customer wrote from.';
    d.stopping = 'Done when the file is read. A missing file goes to a human.';
  } else if (b.type === 'agent') {
    const J = JOBS[b.job];
    d.permissions = b.job === 'read' ? 'Answers two questions, each from a fixed list: the category, and refund or reorder. It can do nothing else.'
      : b.job === 'match' ? 'Lists the items on the order that the customer says are missing. It can do nothing else. The harness keeps an item only if the customer named it.'
      : 'Gives one dollar amount. It can do nothing else (and nothing checks the amount).';
    d.dependencies = 'The customer\'s message' + (b.job !== 'read' ? ', and the items on the order (from Look up: Order)' : '') + '.';
    d.stopping = 'Done when every answer is on its list. Anything else is asked once more; still no clear answer goes to a human.';
    d.gives = J.gives;
  } else if (b.type === 'check') {
    const C = CHECKS[b.check];
    d.permissions = 'Answers yes or no from the records. It changes nothing.';
    d.dependencies = PROVIDER_NAMES[C.needs] + ' above it.';
    d.stopping = 'Done when it has answered. The case goes down the yes or the no branch.';
  } else if (b.type === 'act') {
    if (b.action === 'refund') {
      d.permissions = `One refund, of ${ACTIONS.refund.choices[b.choice].label}, to the card on the order. Nothing else.`;
      d.dependencies = `The card from Look up: Order; the amount from ${PROVIDER_NAMES[ACTIONS.refund.choices[b.choice].needs]}; the path of checks above it.`;
      d.stopping = 'Done when the refund record and the audit record exist, and the agent has written the reply. A declined refund goes to a human.';
    } else if (b.action === 'reorder') {
      d.permissions = `One reorder of ${ACTIONS.reorder.choices[b.choice].label}, at no charge. Nothing else.`;
      d.dependencies = `The items from ${PROVIDER_NAMES[ACTIONS.reorder.choices[b.choice].needs]}; the path of checks above it.`;
      d.stopping = 'Done when the reorder record and the audit record exist, and the agent has written the reply.';
    } else if (b.action === 'refuse') {
      d.permissions = 'Rejects the request. No refund, no reorder.';
      d.dependencies = 'The check above it, which gives the reason.';
      d.stopping = 'Done when the audit record exists and the agent has written the reply.';
    } else {
      d.permissions = 'Hands the case to a supervisor, with a hand-off record. No refund or reorder.';
      d.dependencies = 'The check above it, which gives the reason.';
      d.stopping = `Done when the hand-off record exists and the reply "${HUMAN_REPLY}" is sent.`;
    }
  }
  if (missing.length) d.problem = `Needs ${missing.join(' and ')} above it.`;
  return d;
}

// What a block does and what it can give, in plain words, for the panel on the right of the page.
const CHECK_YES = {
  allergy: 'Yes if the agent read the message as "allergy or illness".',
  never: 'Yes if the agent read the message as "never arrived" (the whole order).',
  missing: 'Yes if the agent read the message as "missing items".',
  reorder: 'Yes if the agent says the customer asks for a reorder; no if they ask for a refund.',
  within: 'Yes if the order was delivered at most ___ hours ago (from the delivery record).',
  total: 'Yes if the order total is more than $___ (from the order record).',
  photo: 'Yes if the drop-off photo does not show the food at the customer\'s address (no photo, or a photo somewhere else).',
  chat: 'Yes if the customer wrote to the driver after the drop-off.',
  refunds: 'Yes if the customer got ___ or more refunds in the past 30 days.',
  fixed: 'Yes if this order already got a refund or a reorder.',
  onOrder: 'Yes if the agent found at least one missing item on the order.',
  itemsUnder: 'Yes if the missing items add up to less than $___.',
  amountOver: 'Yes if the agent\'s amount is more than $___.',
};
function explain(design, id) {
  const f = findBlock(design, id);
  if (!f) return null;
  const b = f.block;
  const have = providersAbove(design, id);
  const missing = needsOf(b).filter(n => !have.has(n)).map(n => PROVIDER_NAMES[n]);
  const e = {title: blockText(b), does: '', outputsTitle: 'Possible outputs', outputs: []};
  if (b.type === 'lookup') {
    e.does = {order: 'Opens the order record of the order the customer wrote from.',
              delivery: 'Opens the delivery record of that order: was it delivered, when, and where.',
              chat: 'Opens the messages between the customer and the driver.',
              past: 'Opens this customer\'s earlier cases. Memory must be on; otherwise it finds nothing.'}[b.file];
    e.outputs = {order: ['The items ordered and their prices', 'The order total', 'The card it was paid with'],
                 delivery: ['When it was delivered', 'The drop-off photo: at the address, somewhere else, or none', 'The driver\'s name and phone'],
                 chat: ['The messages, with their times', 'Did the customer write after the drop-off: yes or no'],
                 past: ['Refunds in the past 30 days', 'Already a refund or reorder on this order: yes or no']}[b.file];
  } else if (b.type === 'agent') {
    if (b.job === 'read') {
      e.does = 'The agent reads the customer\'s message and answers two questions. Each answer must come from a fixed list. If the first answer is never arrived or missing items, the agent is also asked which food or drink did not arrive: a fixed rule keeps missing items only if the customer\'s message names that food, and otherwise makes it never arrived.';
      e.outputs = ['Category: never arrived, missing items, allergy or illness, or something else (for example, food that came late or cold, or a rude driver)',
                   'What does the customer ask for? refund or reorder'];
    } else if (b.job === 'match') {
      e.does = 'The agent reads the message and the list of items on the order, and names the items the customer says are missing. The harness keeps an item only if the customer named it, and a fixed rule adds up their prices.';
      e.outputs = ['One or more items from the order, with their prices added up', 'All of them (the whole order)', 'None'];
    } else {
      e.does = 'The agent reads the message and the order and gives a dollar amount to refund. Nothing checks the amount.';
      e.outputs = ['One dollar amount, like 18.00'];
    }
  } else if (b.type === 'check') {
    e.does = 'Asks one yes/no question and sends the case down the yes branch or the no branch. ' + CHECK_YES[b.check];
    e.outputs = ['yes: the blocks under yes run next', 'no: the blocks under no run next'];
  } else if (b.type === 'act') {
    e.outputsTitle = 'Then';
    if (b.action === 'refund') e.does = {items: 'Refunds the prices of the missing items to the card on the order.', total: 'Refunds the whole order total to the card on the order.',
                                         agent: 'Refunds whatever amount the agent gave, to the card on the order.'}[b.choice];
    else if (b.action === 'reorder') e.does = b.choice === 'order' ? 'Sends the whole order again, at no charge.' : 'Sends the missing items again, at no charge.';
    else if (b.action === 'refuse') e.does = 'Rejects the request: no refund and no reorder.';
    else e.does = 'Hands the case to a human supervisor. No refund and no reorder.';
    e.outputs = [b.action === 'human' ? `The customer gets the fixed reply "${HUMAN_REPLY}"` : 'The agent writes the customer a short reply that tells them the decision', 'The path ends here'];
  }
  if (missing.length) e.problem = `Needs ${missing.join(' and ')} above it.`;
  return e;
}

// ===== The agent =====
class ModelError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
let fakeModel = null; // tests only
function setFakeModel(fn) { fakeModel = fn; }
const estimateTokens = s => Math.ceil(String(s || '').length / 4);
// Every answer stops after this many tokens, so a runaway answer cannot hold up a run (Ollama would otherwise keep writing).
const MAX_ANSWER_TOKENS = 300;
async function askModel(prompt, opts = {}) {
  const started = Date.now();
  if (fakeModel) {
    const text = await fakeModel(prompt, opts);
    return {text: String(text), tokensIn: estimateTokens(prompt), tokensOut: estimateTokens(text), seconds: 0};
  }
  const model = MODELS.qwen;
  let response;
  try {
    response = await fetch('http://127.0.0.1:11434/api/chat', {method: 'POST', signal: opts.signal, headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model: model.id, messages: [{role: 'user', content: prompt}], stream: false, think: false,
                            options: {temperature: Number(opts.temperature) || 0, num_predict: MAX_ANSWER_TOKENS}})});
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ModelError('failed', 'Ollama is not answering: open the Ollama app, then run again.');
  }
  const raw = await response.text();
  let data = null; try { data = JSON.parse(raw); } catch { data = null; }
  if (!response.ok) throw new ModelError('failed', response.status === 404 ? `${model.id} is not in Ollama: ask Claude Code or Codex to run "ollama pull ${model.id}".` : `Ollama answered ${response.status}.`);
  const text = data && data.message ? String(data.message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
  return {text, tokensIn: data.prompt_eval_count || estimateTokens(prompt), tokensOut: data.eval_count || estimateTokens(text), seconds: (Date.now() - started) / 1000};
}

// ===== The records for one case (fresh copies, so runs repeat) =====
function freshStore() {
  const orders = {};
  for (const o of DATA.orders) orders[o.number] = clone(o);
  const deliveries = {};
  for (const [n, d] of Object.entries(DATA.deliveries)) deliveries[n] = {delivered: d[0], photo: d[1], locationMatch: d[2], driverName: d[3], driverPhone: d[4]};
  return {orders, deliveries, chats: clone(DATA.chats), cancelled: new Set(DATA.cancelledCards), history: clone(DATA.history)};
}

// ===== Prompts: exactly what the agent is asked =====
function messageText(ctx) {
  if (ctx.memory.conversation && ctx.conversation.length > 1) {
    return 'The conversation so far:\n' + ctx.conversation.map(m => (m.from === 'customer' ? 'Customer: ' : 'Support: ') + m.text).join('\n');
  }
  return "The customer's message:\n\"" + ctx.message + '"';
}
function earlierText(ctx) {
  const rec = ctx.memory.caseRecord && ctx.state.caseRecord;
  if (!rec || !rec.answers.length) return [];
  return ['', 'Earlier in this case: ' + rec.answers.join('; ') + '.'];
}
const READ_QUESTIONS = [
  'What is the category of this message? Answer with exactly one of: never arrived | missing items | allergy or illness | something else. Answer missing items if the customer says one or more items were missing or did not come; never arrived only if the whole order did not arrive; allergy or illness if the customer reports an allergic reaction or an illness after eating the food; otherwise something else (for example, food that came late or cold, or a rude driver).',
  'What does the customer ask for? Answer with exactly one of: refund | reorder. Answer reorder only if the message asks us to send food: send it, send it again, resend it, bring it, deliver it or reorder it. If the message asks for money back or a refund, or does not ask for anything, answer refund.',
];
function agentPrompt(job, ctx, retry) {
  const lines = ["You read a customer's message for DoorDash support and answer questions about it."];
  lines.push('', messageText(ctx), ...earlierText(ctx));
  const items = ctx.values.order ? ctx.values.order.items : [];
  if (job === 'read') {
    lines.push('', 'Questions:', ...READ_QUESTIONS.map((q, i) => `${i + 1}. ${q}`), '', 'Reply with one line per question, and nothing else:', '1: <answer>', '2: <answer>');
  } else if (job === 'match') {
    lines.push('', 'The items on the order:', ...items.map(x => '- ' + x.name), '',
      'Which of these items does the customer say are missing? Copy their names exactly from the list above, separated by ;. If the customer says the whole order is missing, reply: all of them. If none of the items in the list is missing, reply: none.',
      '', 'Reply with the item names only, and nothing else.');
  } else {
    lines.push('', `The items on the order: ${items.map(x => `${x.name} ${money(x.price)}`).join('; ')}.`,
      'How much should we refund? Answer with a number only, like 12.50.');
  }
  if (retry) lines.push('', 'Your last reply could not be read. Reply exactly in the format asked.');
  return lines.join('\n');
}
// Block "What is the message about?": when the first answer is "never arrived" or "missing items", the agent is also asked
// which food did not arrive. A fixed rule keeps "missing items" only if a food word of that answer is in the customer's words.
function foodPrompt(ctx) {
  return ["You read a customer's message for DoorDash support and answer questions about it.", '', messageText(ctx), '',
          'Which food or drink does the customer say did not arrive? Answer with its name only. If the customer means the whole order or all of the food, answer: whole order'].join('\n');
}
const NOT_FOOD = new Set(['whole', 'entire', 'full', 'order', 'orders', 'food', 'foods', 'meal', 'dinner', 'lunch', 'breakfast', 'delivery', 'everything', 'all', 'nothing',
  'anything', 'stuff', 'the', 'my', 'of', 'it', 'them', 'and', 'none', 'customer', 'says', 'did', 'not', 'arrive', 'or', 'name', 'never', 'arrived', 'came', 'come',
  'delivered', 'deliver', 'showed', 'show', 'missing', 'didnt', 'didn', 'received', 'receive', 'got', 'get', 'yet', 'still', 'here', 'there', 'was', 'were', 'has',
  'have', 'hasnt', 'havent', 'been', 'from', 'with', 'for', 'this', 'that', 'your', 'our', 'any', 'driver', 'app', 'bag']);
// "missing items" if a food word of the agent's answer is in the customer's words; "never arrived" otherwise; null if the agent said nothing
function namedFood(text, ctx) {
  const t = norm(text).replace(/^answer\s*:\s*/, '');
  if (!t) return null;
  const words = s => norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean), cut = w => w.replace(/(es|s)$/, '').replace(/e$/, '');
  const said = new Set(words(customerWords(ctx)).map(cut));
  const food = words(t.split(':').pop()).filter(w => w.length > 2 && !NOT_FOOD.has(w));
  return food.length && food.some(w => said.has(cut(w))) ? 'missing items' : 'never arrived';
}
// One line per kind of decision, so the reply does not promise what the decision does not include.
const REPLY_LIMITS = {refund: 'We refunded money only. Do not say that we will send any food.',
                      reorder: 'We are sending the food again only. Do not say that we refunded any money.',
                      refused: 'We rejected the request: no refund and no new delivery. Say so clearly and kindly. Do not promise a refund, a new delivery or a follow-up.'};
// After a Reject, the reply writer gets a plain reason instead of the check's question and its yes/no answer
// (a question like "No photo proof of delivery? no" is a double negative the agent misreads). [answer yes, answer no]
const REJECT_REASONS = {
  allergy: ['your message is about an allergy or illness', 'your message is not about an allergy or illness'],
  never: ['your message says the whole order never arrived', 'your message does not say the whole order never arrived'],
  missing: ['your message is about missing items', 'this kind of problem is not covered by our refund policy'],
  reorder: ['you asked us to send the food again', 'you did not ask us to send the food again'],
  within: ['you wrote within {n} hours of the delivery', 'you asked too late: requests must be made within {n} hours of delivery'],
  total: ['the order total is more than ${n}', 'the order total is ${n} or less'],
  photo: ['there is no drop-off photo of the food at your address', 'the drop-off photo shows the food at your address'],
  chat: ['you wrote to the driver after the drop-off', 'you did not write to the driver after the drop-off'],
  refunds: ['you have had {n} or more refunds in the past 30 days', 'you have had fewer than {n} refunds in the past 30 days'],
  fixed: ['this order already got a refund or a reorder', 'this order has not had a refund or a reorder'],
  onOrder: ['an item you named is on the order', 'none of the items you named is on the order'],
  itemsUnder: ['the missing items add up to less than ${n}', 'the missing items add up to ${n} or more'],
  amountOver: ['the refund amount would be more than ${n}', 'the refund amount would be ${n} or less'],
};
function rejectReason(last) {
  const r = last && REJECT_REASONS[last.check];
  return r ? r[last.answer === 'yes' ? 0 : 1].split('{n}').join(last.num) : null;
}
function replyPrompt(ctx, decision, kind) {
  return ['You write the reply to a DoorDash customer for the support team.', '', 'The decision: ' + decision, ...(REPLY_LIMITS[kind] ? [REPLY_LIMITS[kind]] : []), '', messageText(ctx), '',
          'Write a short, friendly reply (2 to 4 sentences) that tells the customer the decision. Do not promise or offer anything else.'].join('\n');
}

// ===== Reading the agent's answers =====
function pickAnswer(text, answers) {
  const t = norm(text).replace(/^answer\s*:\s*/, '').replace(/^<|>$/g, '').replace(/[.!]+$/, '').trim();
  const exact = answers.find(a => norm(a) === t);
  if (exact) return exact;
  const starts = answers.filter(a => t.startsWith(norm(a)) && /^[\s,.;:(\-]/.test(t.slice(norm(a).length) || ' '));
  return starts.sort((a, b) => b.length - a.length)[0] || null;
}
function parseRead(text) {
  const byNum = {};
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(?:\*\*)?\s*(?:Q(?:uestion)?\s*)?(\d+)\s*(?:\*\*)?\s*[:.)\-]\s*(.*)$/i);
    if (m && !byNum[m[1]]) byNum[m[1]] = m[2];
  }
  // an answer like "resend it", "send it again" or "deliver it" to question 2 means reorder
  const sendAgain = s => /^(?:(?:re)?send|re-?deliver|deliver|bring)(?: (?:it|them|the food|the items?))?(?: again)?$/.test(norm(s).replace(/^answer\s*:\s*/, '').replace(/[.!]+$/, '').trim()) ? 'reorder' : null;
  return {category: byNum['1'] == null ? null : pickAnswer(byNum['1'], CATEGORIES), asks: byNum['2'] == null ? null : (pickAnswer(byNum['2'], ASKS) || sendAgain(byNum['2'])),
          raw: [byNum['1'] || '', byNum['2'] || '']};
}
function parseMatch(text, items) {
  const t = norm(text).replace(/^answer\s*:\s*/, '').replace(/[.!]+$/, '').trim();
  if (/^(none|nothing|no items?|n\/a)$/.test(t)) return {items: []};
  if (/^(all of them|all|all items|the whole order|everything)$/.test(t)) return {items: items.slice(), all: true};
  const got = [];
  for (const piece of String(text || '').split(/[;\n]/).map(x => norm(x).replace(/^answer\s*:\s*/, '').replace(/^(?:[-*\u2022]|\d+[.)])\s*/, '').replace(/[.!]+$/, '').trim()).filter(Boolean)) {
    const exact = items.filter(x => norm(x.name) === piece);
    const near = exact.length ? exact : items.filter(x => norm(x.name).includes(piece) || (piece.length > 3 && piece.includes(norm(x.name))));
    if (near.length === 1 && !got.includes(near[0])) got.push(near[0]);
  }
  // a name the agent shortened or made plural ("Cokes") matches the one item that shares a word with it
  for (const piece of String(text || '').split(/[;\n,]/).map(x => norm(x).replace(/^answer\s*:\s*/, '').replace(/^(?:[-*\u2022]|\d+[.)])\s*/, '').replace(/[.!]+$/, '').trim()).filter(Boolean)) {
    const pw = wordsOf(piece).filter(w => w.length > 2 && !SIZE_WORDS.has(w)).map(stem);
    if (!pw.length) continue;
    const hits = items.filter(x => wordsOf(x.name).filter(w => w.length > 2 && !SIZE_WORDS.has(w)).map(stem).some(w => pw.includes(w) || pw.some(p => p.length >= 4 && w.endsWith(p))));
    if (hits.length === 1 && !got.includes(hits[0])) got.push(hits[0]);
  }
  return {items: got};
}
// The harness check on the agent's list: an item stays only if a word of its name is in the customer's words
// ("drink" or "beverage" counts for a drink). The agent sometimes adds items the customer never named.
const SIZE_WORDS = new Set(['large', 'small', 'medium', 'regular', 'can', 'cans', 'of', 'the', 'and', 'for', 'two', 'with', 'a']);
const DRINKS = ['coke', 'lemonade', 'iced tea', 'soda', 'green tea', 'milkshake'];
const stem = w => w.replace(/s$/, '').replace(/e$/, '');
const wordsOf = s => norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
function namedIn(item, said) {
  const words = wordsOf(said).map(stem);
  if (DRINKS.some(d => norm(item.name).includes(d)) && words.some(w => w === stem('drink') || w === stem('beverage'))) return true;
  // the end of a compound name counts too: "shake" for Milkshake
  return wordsOf(item.name).filter(w => w.length > 2 && !SIZE_WORDS.has(w)).some(w => words.includes(stem(w)) || words.some(m => m.length >= 4 && stem(w).endsWith(m)));
}
function customerWords(ctx) {
  return ctx.memory.conversation && ctx.conversation.length > 1 ? ctx.conversation.filter(m => m.from === 'customer').map(m => m.text).join(' ') : ctx.message;
}
function checkNamed(value, ctx) {
  if (!value || value.all) return value;
  const said = customerWords(ctx);
  return {items: value.items.filter(x => namedIn(x, said)), leftOut: value.items.filter(x => !namedIn(x, said))};
}
// The agent's final number: the one after "answer", else the last number it wrote (it may show its working first).
function parseAmount(text) {
  const t = norm(text).replace(/,/g, '');
  const after = t.match(/answer\s*(?:is)?\s*[:=]?\s*\$?\s*(-?\d+(?:\.\d+)?)/);
  const all = t.match(/-?\d+(?:\.\d+)?/g);
  const m = after ? after[1] : all ? all[all.length - 1] : null;
  if (m == null) return null;
  const v = Math.round(Number(m) * 100) / 100;
  return v >= 0 && v <= 10000 ? v : null;
}

// ===== Running a case =====
// caseDef = {id, customer, from: order number, messages: [...], right}
async function runCase(design, caseDef, options = {}) {
  const store = options.store || freshStore();
  const state = {design, caseDef, store, options, memory: Object.assign({conversation: false, caseRecord: false, pastCases: false}, options.memory || design.memory),
                 conversation: [], records: {refunds: [], reorders: [], audits: [], handoffs: [], replies: []},
                 caseRecord: null, log: [], tokens: {in: 0, out: 0}, calls: 0, messages: [], fake: options.fakeAnswers || null,
                 nowMin: options.now ? minutes(options.now) : NOW_MIN, stop: null};
  for (let i = 0; i < caseDef.messages.length; i++) {
    if (options.signal && options.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    await runMessage(state, caseDef.messages[i], i);
  }
  const last = state.messages[state.messages.length - 1];
  const result = {caseId: caseDef.id, num: caseDef.num, messages: caseDef.messages, from: caseDef.from, customer: caseDef.customer,
                  outcome: last.outcome, perMessage: state.messages.map(m => m.outcome), records: state.records, log: state.log,
                  tokens: state.tokens.in + state.tokens.out, calls: state.calls, conversation: state.conversation, right: caseDef.right || null, stop: state.stop};
  result.grade = gradeCase(result, caseDef.right);
  return result;
}

async function runMessage(state, text, index) {
  state.conversation.push({from: 'customer', text});
  const ctx = {design: state.design, state, memory: state.memory, msgIndex: index, message: text, conversation: state.conversation,
               values: {}, rows: [], records: {refunds: [], reorders: [], audits: [], handoffs: [], replies: []},
               actions: [], lastCheck: null, ended: null, answers: []};
  await runList(ctx, state.design.tree);
  if (!ctx.ended) ctx.ended = {kind: 'none', text: 'No outcome: the path ended without an Action.'};
  // the case record keeps the agent's answers and the actions for the next message (memory switch 2)
  if (state.memory.caseRecord) {
    const prev = state.caseRecord || {answers: [], actions: []};
    const answers = prev.answers.slice();
    for (const a of ctx.answers) { const i = answers.findIndex(x => x.split(':')[0] === a.split(':')[0]); if (i >= 0) answers[i] = a; else answers.push(a); }
    state.caseRecord = {answers, actions: prev.actions.concat(ctx.actions)};
  }
  ctx.rows.forEach(r => state.log.push(Object.assign({msg: index + 1}, r)));
  for (const k of Object.keys(ctx.records)) state.records[k].push(...ctx.records[k]);
  state.messages.push({outcome: ctx.ended});
}

function row(ctx, b, fields) {
  const r = Object.assign({block: b ? b.id : null, step: b ? blockText(b) : '', who: b ? whoOf(b) : 'a fixed rule', inputs: '', output: '', tokens: 0}, fields);
  ctx.rows.push(r);
  return r;
}

async function runList(ctx, list) {
  for (const b of list) {
    if (ctx.state.options.signal && ctx.state.options.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    const r = await runBlock(ctx, b);
    if (ctx.ended) return;
    if (r && r.fail) return escalate(ctx, r.fail, true);
    if (b.type === 'check') return runList(ctx, b[r.answer]);
  }
}

async function runBlock(ctx, b) {
  const st = ctx.state, store = st.store, v = ctx.values;
  const hoursSince = t => (st.nowMin - minutes(t)) / 60; // this case's own clock
  switch (b.type) {
    case 'lookup': {
      const on = st.caseDef.from;
      const order = on && store.orders[on];
      if (!order || order.customer !== st.caseDef.customer) { row(ctx, b, {inputs: `order number: ${on || 'none'}`, output: 'failed: no such order for this customer'}); return {fail: 'the order was not found'}; }
      if (b.file === 'order') {
        v.order = {items: order.items, total: order.total, card: order.card, placed: order.placed, hours: hoursSince(order.placed), number: on};
        row(ctx, b, {inputs: `order number ${on}`, output: `${order.items.map(x => `${x.name} ${money(x.price)}`).join('; ')}; total ${money(order.total)}; card ending ${order.card}; ordered ${niceTime(order.placed)}`});
      } else if (b.file === 'delivery') {
        const d = store.deliveries[on];
        if (!d) { row(ctx, b, {inputs: `order number ${on}`, output: 'failed: no delivery record'}); return {fail: 'there is no delivery record'}; }
        v.delivery = {photo: d.photo, locationMatch: d.locationMatch ? 'yes' : 'no', hours: hoursSince(d.delivered),
                      driverName: d.driverName, driverPhone: d.driverPhone, delivered: d.delivered};
        row(ctx, b, {inputs: `order number ${on}`, output: `delivered ${niceTime(d.delivered)}; photo: ${d.photo}; location match: ${d.locationMatch ? 'yes' : 'no'}; driver ${d.driverName}, ${d.driverPhone}`});
      } else if (b.file === 'chat') {
        const msgs = store.chats[on] || [];
        const d = store.deliveries[on];
        const after = d ? msgs.some(m => m.from === 'customer' && minutes(m.time) > minutes(d.delivered)) : false;
        v.chat = {after: after ? 'yes' : 'no', messages: msgs};
        row(ctx, b, {inputs: `order number ${on}`, output: `${msgs.length} message(s)${msgs.length ? ': ' + msgs.map(m => `${m.from} at ${niceTime(m.time)}: "${m.text}"`).join('; ') : ''}; customer wrote after drop-off: ${after ? 'yes' : 'no'}`});
      } else if (b.file === 'past') {
        const keep = ctx.memory.pastCases;
        const h = keep ? (store.history[st.caseDef.customer] || {refunds: [], reorders: []}) : {refunds: [], reorders: []};
        const refunds30 = h.refunds.filter(r => hoursSince(r.date) <= 30 * 24).length;
        let fixed = h.refunds.some(r => r.order === on) || (h.reorders || []).some(r => r.order === on);
        let fromRecord = false;
        const rec = ctx.memory.caseRecord && st.caseRecord;
        if (!fixed && rec && rec.actions.some(a => a.order === on)) { fixed = true; fromRecord = true; }
        v.past = {refunds30, fixed: fixed ? 'yes' : 'no'};
        const list = h.refunds.map(r => `refund ${money(r.amount)} on order ${r.order} (${r.items}), ${niceTime(r.date)}`).concat((h.reorders || []).map(r => `reorder on order ${r.order}, ${niceTime(r.date)}`));
        row(ctx, b, {inputs: `customer ${(st.options.customers || DATA.customers)[st.caseDef.customer] || st.caseDef.customer}`,
          output: `${keep ? (list.join('; ') || 'no past refunds or reorders') : 'Memory is off: no past cases kept'}; refunds in 30 days: ${refunds30}; refund or reorder already on this order: ${fixed ? 'yes' + (fromRecord ? ' (from the case record)' : '') : 'no'}`});
      }
      return {};
    }
    case 'agent': return runAgent(ctx, b);
    case 'check': {
      const C = CHECKS[b.check];
      if (!v[C.needs]) { row(ctx, b, {output: `failed: needs ${PROVIDER_NAMES[C.needs]} above it`}); return {fail: `${checkText(b)} had nothing to check`}; }
      const n = b.num != null ? Number(b.num) : C.num;
      const yes = !!C.test(v, n);
      ctx.lastCheck = {q: checkText(b), answer: yes ? 'yes' : 'no', check: b.check, num: b.num != null ? b.num : CHECKS[b.check].num};
      row(ctx, b, {inputs: C.shows(v), output: `answer: ${yes ? 'yes' : 'no'}`});
      return {answer: yes ? 'yes' : 'no'};
    }
    case 'act': return runAct(ctx, b);
  }
  return {};
}

async function callModel(ctx, prompt, temperature, info) {
  const st = ctx.state;
  let res;
  if (st.fake && st.fake.model && info && info.reply) res = {text: await st.fake.model(prompt, info), tokensIn: estimateTokens(prompt), tokensOut: 5};
  else res = await askModel(prompt, {temperature, signal: st.options.signal});
  st.calls += 1; st.tokens.in += res.tokensIn; st.tokens.out += res.tokensOut;
  return res;
}

// One job, asked once (or 5 times with a vote). Unreadable answers are asked once more.
async function askJob(ctx, job, temperature) {
  let prompt = agentPrompt(job, ctx, false);
  let res = await callModel(ctx, prompt, temperature, {job});
  let parsed = parseJob(job, res.text, ctx);
  let tokens = res.tokensIn + res.tokensOut, text = res.text;
  if (!parsed.ok) {
    prompt = agentPrompt(job, ctx, true);
    res = await callModel(ctx, prompt, temperature, {job, retry: true});
    const again = parseJob(job, res.text, ctx);
    tokens += res.tokensIn + res.tokensOut; text += '\n(asked again) ' + res.text;
    if (job === 'read') { parsed.value.category = parsed.value.category || again.value.category; parsed.value.asks = parsed.value.asks || again.value.asks; parsed.ok = !!(parsed.value.category && parsed.value.asks); }
    else parsed = again;
  }
  if (job === 'read' && parsed.ok && (parsed.value.category === 'never arrived' || parsed.value.category === 'missing items')) {
    const p2 = foodPrompt(ctx);
    const r2 = await callModel(ctx, p2, temperature, {job, second: true});
    tokens += r2.tokensIn + r2.tokensOut; text += '\n(which food did not arrive?) ' + r2.text;
    parsed.value.category = namedFood(r2.text, ctx) || parsed.value.category;
    prompt += '\n\n(then a second question)\n' + p2;
  }
  return {parsed, tokens, prompt, text};
}
function parseJob(job, text, ctx) {
  if (job === 'read') { const r = parseRead(text); return {ok: !!(r.category && r.asks), value: r}; }
  if (job === 'match') { const r = checkNamed(parseMatch(text, ctx.values.order ? ctx.values.order.items : []), ctx); return {ok: !!r, value: r}; }
  const a = parseAmount(text); return {ok: a != null, value: a};
}
const keyOf = (job, value) => value == null ? null : job === 'read' ? `${value.category} / ${value.asks}` : job === 'match' ? (value.all ? 'all of them' : (value.items.map(x => x.name).sort().join(' + ') || 'none')) : money(value);

async function runAgent(ctx, b) {
  const v = ctx.values;
  if (b.job !== 'read' && !v.order) { row(ctx, b, {output: 'failed: needs Look up: Order above it'}); return {fail: 'the agent had no order to read'}; }
  const votes = b.vote ? 5 : 1;
  let calls;
  if (ctx.state.fake && ctx.state.fake.agent) {
    const value = ctx.state.fake.agent(b.job, ctx);
    calls = Array.from({length: votes}, () => ({parsed: {ok: value != null, value}, tokens: 0, prompt: '', text: ''}));
  } else {
    calls = [];
    for (let i = 0; i < votes; i++) calls.push(await askJob(ctx, b.job, 0));
  }
  const tokens = calls.reduce((a, c) => a + c.tokens, 0);
  const inputs = `the ${ctx.memory.conversation && ctx.conversation.length > 1 ? 'whole conversation' : 'message'}${b.job !== 'read' ? '; the items on the order' : ''}${ctx.memory.caseRecord && ctx.state.caseRecord && ctx.state.caseRecord.answers.length ? '; earlier answers in this case' : ''}`;
  // count the answers: one call stands alone; a vote needs 4 or 5 matching answers
  const tally = {}, first = {};
  if (b.job === 'read') {
    // a vote counts each question on its own
    const per = q => { const t = {}; for (const c of calls) { const x = c.parsed.value && c.parsed.value[q]; if (x) t[x] = (t[x] || 0) + 1; } return t; };
    const need = votes === 5 ? 4 : 1;
    const out = {};
    const shown = [];
    for (const q of ['category', 'asks']) {
      const t = per(q);
      const best = Object.entries(t).sort((a, c) => c[1] - a[1])[0];
      if (!best || best[1] < need) {
        const said = votes === 5 ? `the 5 answers split (${Object.entries(t).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none readable'})` : `the agent answered "${String(calls[0].text || '').slice(0, 120)}"`;
        row(ctx, b, {inputs, output: `failed: no clear answer to "${q === 'category' ? 'the category' : 'refund or reorder'}": ${said}`, tokens, prompt: calls[0].prompt, raw: calls.map(c => c.text)});
        return {fail: 'the agent gave no clear answer'};
      }
      out[q] = best[0];
      shown.push(`${q === 'category' ? 'category' : 'asks for'}: ${best[0]}${votes === 5 ? ` (${best[1]} of 5 votes)` : ''}`);
    }
    v.read = out;
    ctx.answers.push(`category: ${out.category}`, `asks for: ${out.asks}`);
    row(ctx, b, {inputs, output: shown.join('; '), tokens, prompt: calls[0].prompt, raw: calls.map(c => c.text)});
    return {};
  }
  for (const c of calls) { const k = keyOf(b.job, c.parsed.ok ? c.parsed.value : null); if (k == null) continue; tally[k] = (tally[k] || 0) + 1; if (!(k in first)) first[k] = c.parsed.value; }
  const best = Object.entries(tally).sort((a, c) => c[1] - a[1])[0];
  if (!best || best[1] < (votes === 5 ? 4 : 1)) {
    row(ctx, b, {inputs, output: `failed: no clear answer: the agent answered "${String(calls[0].text || '').slice(0, 120)}"`, tokens, prompt: calls[0].prompt, raw: calls.map(c => c.text)});
    return {fail: 'the agent gave no clear answer'};
  }
  const value = first[best[0]];
  if (b.job === 'match') {
    // the itemized bill: each matched item with its price on the order; the whole order is refunded at its total
    const sum = Math.round(value.items.reduce((a, x) => a + x.price, 0) * 100) / 100;
    const total = value.all ? v.order.total : sum;
    v.match = {items: value.items, total, all: !!value.all};
    ctx.answers.push(`missing items: ${value.all ? 'all of them' : (value.items.map(x => x.name).join(', ') || 'none')}`);
    row(ctx, b, {inputs, output: `missing: ${value.all ? 'all of them' : (value.items.map(x => x.name).join(', ') || 'none')}${value.leftOut && value.leftOut.length ? `; left out by the harness check (the customer did not name ${value.leftOut.length > 1 ? 'them' : 'it'}): ${value.leftOut.map(x => x.name).join(', ')}` : ''}`, tokens, prompt: calls[0].prompt, raw: calls.map(c => c.text)});
    row(ctx, null, {step: 'Itemized bill', who: 'a fixed rule', inputs: 'the matched items and their prices on the order',
                    output: !value.items.length ? 'no item on the order: $0.00'
                      : value.all ? `the whole order: ${value.items.map(x => `${x.name} ${money(x.price)}`).join(' + ')}; with the delivery fee and tax, the order total ${money(total)}`
                      : `${value.items.map(x => `${x.name} ${money(x.price)}`).join(' + ')} = ${money(total)}`});
  } else {
    v.amount = {value};
    row(ctx, b, {inputs, output: `amount: ${money(value)}`, tokens, prompt: calls[0].prompt, raw: calls.map(c => c.text)});
  }
  return {};
}

async function runAct(ctx, b) {
  const v = ctx.values, st = ctx.state, on = st.caseDef.from;
  st.stop = b.id; // the Action that ends this path (a failure below changes it to 'auto')
  if (b.action === 'human') return escalate(ctx, ctx.lastCheck ? `${ctx.lastCheck.q} ${ctx.lastCheck.answer}` : 'a supervisor reviews the case', false, b);
  if (b.action === 'refund') {
    if (!v.order) { row(ctx, b, {output: 'failed: no card (needs Look up: Order above it)'}); return {fail: 'there was no card to refund to'}; }
    const src = b.choice === 'total' ? (v.order ? v.order.total : null) : b.choice === 'items' ? (v.match ? v.match.total : null) : (v.amount ? v.amount.value : null);
    if (src == null) { row(ctx, b, {output: `failed: no amount (needs ${PROVIDER_NAMES[ACTIONS.refund.choices[b.choice].needs]} above it)`}); return {fail: 'there was no amount to refund'}; }
    const card = v.order.card;
    const inputs = `amount: ${ACTIONS.refund.choices[b.choice].label} = ${money(src)}; card ending ${card}`;
    if (!(src > 0)) { row(ctx, b, {inputs, output: 'failed: nothing to refund (no missing item is on the order)'}); return {fail: 'there was nothing to refund'}; }
    if (st.store.cancelled.has(String(card))) { row(ctx, b, {inputs, output: `failed: declined by the payment service (the card ending ${card} is cancelled)`}); return {fail: 'the refund was declined'}; }
    const items = b.choice === 'items' && v.match ? v.match.items.map(x => x.name) : [];
    const rec = {amount: Math.round(src * 100) / 100, card: String(card), order: on, items, msg: ctx.msgIndex + 1};
    ctx.records.refunds.push(rec); ctx.actions.push({type: 'refund', order: on});
    row(ctx, b, {inputs, output: `refund record: ${money(rec.amount)} to the card ending ${card}`});
    return finish(ctx, 'refund', `Refunded ${money(rec.amount)}${items.length ? ' for ' + items.join(', ') : ''} to the card ending ${card}.`,
                  {kind: 'refund', text: `Refunded ${money(rec.amount)} to the card ending ${card}`});
  }
  if (b.action === 'reorder') {
    const items = b.choice === 'order' ? (v.order ? v.order.items.map(x => x.name) : null) : (v.match ? v.match.items.map(x => x.name) : null);
    if (!items) { row(ctx, b, {output: `failed: nothing to reorder (needs ${PROVIDER_NAMES[ACTIONS.reorder.choices[b.choice].needs]} above it)`}); return {fail: 'there was nothing to reorder'}; }
    if (!items.length) { row(ctx, b, {output: 'failed: nothing to reorder (no missing item is on the order)'}); return {fail: 'there was nothing to reorder'}; }
    ctx.records.reorders.push({items, order: on, msg: ctx.msgIndex + 1}); ctx.actions.push({type: 'reorder', order: on});
    row(ctx, b, {inputs: `items: ${items.join(', ') || 'none'}`, output: `reorder record: ${items.join(', ') || 'nothing'}, at no charge`});
    return finish(ctx, 'reorder', `Reordered at no charge: ${items.join(', ')}.`, {kind: 'reorder', text: `Reordered ${items.join(', ')} at no charge`});
  }
  const why = ctx.lastCheck ? `${ctx.lastCheck.q} ${ctx.lastCheck.answer}` : 'no reason given';
  row(ctx, b, {inputs: `the check above: ${why}`, output: 'rejected'});
  const plain = rejectReason(ctx.lastCheck);
  return finish(ctx, 'refused', plain ? `Rejected, because ${plain}.` : 'Rejected.', {kind: 'refused', text: `Rejected (${why})`});
}

// After an Action: the audit record, then the agent writes the reply.
async function finish(ctx, kind, decision, outcome) {
  const why = ctx.lastCheck ? `${ctx.lastCheck.q} ${ctx.lastCheck.answer}` : '';
  ctx.records.audits.push({kind, why, msg: ctx.msgIndex + 1});
  row(ctx, null, {step: 'Audit record', who: 'a fixed rule', inputs: 'the decision', output: `audit record: ${kind}${why ? ' (' + why + ')' : ''}`});
  const prompt = replyPrompt(ctx, decision, kind);
  const res = await callModel(ctx, prompt, 0, {reply: true});
  ctx.records.replies.push({text: res.text, msg: ctx.msgIndex + 1});
  ctx.state.conversation.push({from: 'support', text: res.text});
  row(ctx, null, {step: 'Reply', who: 'the agent', inputs: `the decision; the ${ctx.memory.conversation && ctx.conversation.length > 1 ? 'conversation' : 'message'}`, output: `reply sent: "${res.text}"`, tokens: res.tokensIn + res.tokensOut, prompt});
  ctx.ended = outcome;
  return {};
}
// Human escalation: a hand-off record and the fixed reply. Failures come here automatically.
function escalate(ctx, reason, automatic, b) {
  ctx.state.stop = automatic ? 'auto' : (b ? b.id : ctx.state.stop);
  if (automatic) row(ctx, null, {step: 'Human escalation (automatic)', who: 'a human', inputs: 'a step failed', output: `hand-off record: ${reason}`});
  else row(ctx, b, {inputs: 'the check above', output: `hand-off record: ${reason}`});
  ctx.records.handoffs.push({reason, msg: ctx.msgIndex + 1});
  ctx.records.replies.push({text: HUMAN_REPLY, msg: ctx.msgIndex + 1});
  ctx.state.conversation.push({from: 'support', text: HUMAN_REPLY});
  row(ctx, null, {step: 'Reply', who: 'a fixed rule', inputs: 'always the same sentence', output: `reply sent: "${HUMAN_REPLY}"`});
  ctx.ended = {kind: 'human', text: `Human escalation (${reason})`};
  return {};
}

// ===== Grades: read from the records, never from the reply =====
function gradeCase(result, right) {
  if (!right) return null;
  const rec = result.records, problems = [];
  const last = result.perMessage[result.perMessage.length - 1];
  if (last.kind === 'none') problems.push(last.text.replace(/^No outcome: /, 'no outcome: ').replace(/\.$/, ''));
  const wantR = right.refunds || [], gotR = rec.refunds.slice();
  for (const w of wantR) {
    const i = gotR.findIndex(g => Math.abs(g.amount - w.amount) < 0.005 && g.card === w.card);
    if (i >= 0) { gotR.splice(i, 1); continue; }
    const near = gotR.shift();
    problems.push(near ? `refunded ${money(near.amount)} (right: ${money(w.amount)})` : `no refund (right: ${money(w.amount)} to the card ending ${w.card})`);
  }
  for (const g of gotR) problems.push(`refunded ${money(g.amount)} (right: ${wantR.length ? 'only the refund above' : 'no refund'})`);
  const wantO = right.reorders || [], gotO = rec.reorders.slice();
  for (const w of wantO) {
    const key = w.items.slice().sort().join('|');
    const i = gotO.findIndex(g => g.items.slice().sort().join('|') === key);
    if (i >= 0) { gotO.splice(i, 1); continue; }
    const near = gotO.shift();
    problems.push(near ? `reordered ${near.items.join(', ')} (right: ${w.items.join(', ')})` : `no reorder (right: reorder ${w.items.join(', ')})`);
  }
  for (const g of gotO) problems.push(`reordered ${g.items.join(', ') || 'nothing'} (right: no reorder)`);
  if (right.human && !rec.handoffs.length) problems.push('no human escalation (right: a human reviews it)');
  if (!right.human && rec.handoffs.length) problems.push('escalated to a human (right: no escalation)');
  const refused = rec.audits.some(a => a.kind === 'refused');
  if (right.refused && !refused) problems.push('not rejected (right: rejected)');
  if (!right.refused && refused) problems.push('rejected (right: not rejected)');
  if (right.noPhone) {
    const d = right.noPhone, short = d.slice(-7);
    if (rec.replies.some(r => digits(r.text).includes(d) || digits(r.text).includes(short))) problems.push("the reply gives out the driver's phone number");
  }
  return {right: problems.length === 0, problems};
}

// ===== Lecture 9: the agent's answers for one case =====
// Asks the agent's two jobs for one case, exactly as a tree would (the same prompts): what the message is about, and
// which items match the order. Used to record the two weeks of logs; a replay gives these answers back as fakeAnswers.
async function answersFor(caseDef, options = {}) {
  const store = options.store || freshStore();
  const order = store.orders[caseDef.from];
  const state = {design: null, caseDef, store, options, memory: {conversation: false, caseRecord: false, pastCases: false},
                 conversation: [{from: 'customer', text: caseDef.messages[0]}], records: {refunds: [], reorders: [], audits: [], handoffs: [], replies: []},
                 caseRecord: null, log: [], tokens: {in: 0, out: 0}, calls: 0, messages: [], fake: null, nowMin: options.now ? minutes(options.now) : NOW_MIN, stop: null};
  const ctx = {state, memory: state.memory, msgIndex: 0, message: caseDef.messages[0], conversation: state.conversation,
               values: {order: {items: order.items, total: order.total, card: order.card, placed: order.placed, number: caseDef.from}}, rows: [], answers: []};
  const read = await askJob(ctx, 'read', 0);
  const match = await askJob(ctx, 'match', 0);
  return {read: {ok: read.parsed.ok, value: read.parsed.value, text: read.text},
          match: {ok: match.parsed.ok, value: match.parsed.ok ? match.parsed.value : null, text: match.text},
          tokens: read.tokens + match.tokens};
}

// ===== Running many customers =====
const caseById = id => DATA.cases.find(c => c.id === id);
async function runCases(design, caseList, options = {}) {
  const v = validate(design);
  if (!v.ok) throw new Error('Fix the steps in red first: ' + v.problems[0].msg);
  const list = caseList.map(c => (typeof c === 'string' ? caseById(c) : c)).filter(Boolean);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    if (options.signal && options.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    let r;
    try { r = await runCase(design, list[i], options); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      r = {caseId: list[i].id, num: list[i].num, messages: list[i].messages, from: list[i].from, customer: list[i].customer,
           error: error.message || String(error), grade: null, log: [], tokens: 0, right: list[i].right || null};
    }
    results.push(r);
    if (options.onCase) options.onCase(r, i);
    if (r.error) { // Ollama is down: don't try the rest
      for (let j = i + 1; j < list.length; j++) results.push({caseId: list[j].id, num: list[j].num, messages: list[j].messages, error: 'Not run: ' + r.error, grade: null, log: [], tokens: 0});
      break;
    }
  }
  const graded = results.filter(r => r.grade);
  return {results, right: graded.filter(r => r.grade.right).length, graded: graded.length,
          tokens: results.reduce((a, r) => a + (r.tokens || 0), 0), errors: results.filter(r => r.error).length};
}

// ===== Exercise 4's test area: one "Read the message" block, run 10 times at a fixed hidden temperature =====
async function runBench(message, options = {}) {
  const runs = options.runs || 10, vote = !!options.vote;
  const out = [];
  for (let i = 0; i < runs; i++) {
    if (options.signal && options.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    const st = {options: {signal: options.signal}, caseRecord: null, tokens: {in: 0, out: 0}, calls: 0, fake: null};
    const ctx = {state: st, memory: {conversation: false, caseRecord: false}, message, conversation: [{from: 'customer', text: message}], values: {}};
    const n = vote ? 5 : 1;
    const answers = [];
    for (let k = 0; k < n; k++) {
      const r = await askJob(ctx, 'read', BENCH_TEMPERATURE);
      answers.push(r.parsed.value && r.parsed.value.category ? r.parsed.value.category : 'no clear answer');
    }
    const t = {}; answers.forEach(a => { t[a] = (t[a] || 0) + 1; });
    const best = Object.entries(t).sort((a, c) => c[1] - a[1])[0];
    const result = !vote ? answers[0] : (best[1] >= 4 && best[0] !== 'no clear answer' ? best[0] : 'split: a human');
    out.push({answers, result});
    if (options.onRun) options.onRun(out[out.length - 1], i);
  }
  return out;
}

// ===== Check my tree: compare a tree with the key, by what it does =====
// Every combination of the answers the key depends on is run through both trees, with the agent's answers filled in
// (no agent calls), and the outcomes are compared.
const PROBE = {
  category: [['missing items', 'items are missing'], ['something else', 'the message is not about missing items']],
  asks:     [['refund', 'asks for a refund'], ['reorder', 'asks to send them again']],
  within:   [[1, 'it was delivered 1 hour ago'], [5, 'it was delivered 5 hours ago'], [30, 'it was delivered 30 hours ago']],
  photo:    [[false, 'no drop-off photo'], [true, 'a drop-off photo at the address']],
  bill:     [[[20, 32.40], 'missing items $20.00 of a $32.40 order'], [[20, 64.00], 'missing items $20.00 of a $64.00 order'], [[55, 64.00], 'missing items $55.00 of a $64.00 order']],
};
function probes() {
  const keys = Object.keys(PROBE), out = [];
  const rec = (i, p) => { if (i === keys.length) { out.push(Object.assign({}, p)); return; } for (let k = 0; k < PROBE[keys[i]].length; k++) { p[keys[i]] = k; rec(i + 1, p); } };
  rec(0, {});
  return out;
}
function probeCase(p) {
  const store = freshStore();
  const deliveredMin = NOW_MIN - PROBE.within[p.within][0] * 60;
  const delivered = new Date(deliveredMin * 60000).toISOString().slice(0, 16);
  const placed = new Date((deliveredMin - 40) * 60000).toISOString().slice(0, 16);
  const [missing, total] = PROBE.bill[p.bill][0];
  store.orders['9001'] = {number: '9001', customer: 'P1', items: [{name: 'Combo meal', price: missing}, {name: 'Side dish', price: Math.round((total - missing - 3) * 100) / 100}], total, card: '4242', placed, eta: placed, status: 'delivered'};
  store.deliveries['9001'] = {delivered, photo: PROBE.photo[p.photo][0] ? 'at the address' : 'none', locationMatch: false, driverName: 'Test driver', driverPhone: '000'};
  store.chats['9001'] = [];
  return {store, caseDef: {id: 'probe', customer: 'P1', from: '9001', messages: ['(a test customer)'], right: null}};
}
const probeWords = p => Object.keys(PROBE).map(k => PROBE[k][p[k]][1]).join(', ');
function probeAgent(p) {
  return job => job === 'read' ? {category: PROBE.category[p.category][0], asks: PROBE.asks[p.asks][0]}
    : job === 'match' ? {items: [{name: 'Combo meal', price: PROBE.bill[p.bill][0][0]}]} : 20;
}
function outcomeKey(result) {
  const r = result.records;
  if (result.outcome.kind === 'none') return {key: 'none', text: 'ends with no outcome'};
  if (r.handoffs.length) return {key: 'human', text: 'escalates to a human'};
  if (r.refunds.length) return {key: 'refund ' + r.refunds.map(x => x.amount).join(','), text: `refunds ${r.refunds.map(x => money(x.amount)).join(' and ')}`};
  if (r.reorders.length) return {key: 'reorder ' + r.reorders.map(x => x.items.join('+')).join(','), text: `reorders ${r.reorders.map(x => x.items.join(', ')).join('; ')}`};
  if (r.audits.some(a => a.kind === 'refused')) return {key: 'refused', text: 'rejects the request'};
  return {key: 'none', text: 'ends with no outcome'};
}
async function checkTree(design, keyDesign) {
  const v = validate(design);
  if (!v.ok) return {ok: false, message: 'Fix the steps in red first: ' + v.problems[0].msg};
  if (!design.tree.length) return {ok: false, message: 'Your tree is empty.'};
  for (const p of probes()) {
    const a = probeCase(p), b = probeCase(p);
    const fake = {agent: probeAgent(p), model: async () => 'OK.'};
    const opts = {memory: {conversation: false, caseRecord: false, pastCases: false}};
    const mine = await runCase(design, a.caseDef, Object.assign({store: a.store, fakeAnswers: fake}, opts));
    const key = await runCase(keyDesign, b.caseDef, Object.assign({store: b.store, fakeAnswers: fake}, opts));
    const m = outcomeKey(mine), k = outcomeKey(key);
    if (m.key !== k.key) return {ok: false, probe: p, message: `A customer writes that ${probeWords(p)}. The key ${k.text}; your tree ${m.text}.`};
  }
  return {ok: true, message: `Your tree matches the key: on all ${probes().length} kinds of customer it ends the same way.`};
}

// ===== Saved runs and designs as files =====
function savedRun(design, setKey, summary) {
  return {format: 'awb-run-1', made: new Date().toISOString(), model: MODELS.qwen.name, set: setKey, design: clone(design),
          summary: {right: summary.right, graded: summary.graded, tokens: summary.tokens}, results: clone(summary.results)};
}
function readDesign(text) {
  let d;
  try { d = JSON.parse(text); } catch { return {ok: false, msg: 'That file is not a saved tree.'}; }
  if (d && d.format === 'awb-run-1') d = d.design;
  const c = cleanDesign(d);
  return c ? {ok: true, design: c} : {ok: false, msg: 'That file was not made by the Agentic Workflow Builder.'};
}
// A design from storage or a file, made safe to draw and run: unknown choices go back to the defaults, an old
// "Human escalation" block becomes Act: Human escalation, and every block gets its own id. Returns null if it is not a design.
function cleanDesign(d) {
  if (!d || typeof d !== 'object' || d.format !== 'awb-design-1' || !Array.isArray(d.tree)) return null;
  const ids = new Set();
  const own = (x, list) => Object.prototype.hasOwnProperty.call(list, x);
  const cleanList = (list, depth) => {
    const out = [];
    if (!Array.isArray(list) || depth > 40) return out;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      let b;
      if (raw.type === 'human') b = {type: 'act', action: 'human', choice: null};
      else if (raw.type === 'lookup') b = {type: 'lookup', file: own(raw.file, FILES) ? raw.file : 'order'};
      else if (raw.type === 'agent') b = {type: 'agent', job: own(raw.job, JOBS) ? raw.job : 'read', vote: !!raw.vote};
      else if (raw.type === 'check') {
        const check = own(raw.check, CHECKS) ? raw.check : 'allergy';
        const n = raw.num == null || raw.num === '' ? null : Number(raw.num);
        b = {type: 'check', check, num: CHECKS[check].num == null || n == null || Number.isNaN(n) ? null : n,
             yes: cleanList(raw.yes, depth + 1), no: cleanList(raw.no, depth + 1)};
      } else if (raw.type === 'act') {
        const action = own(raw.action, ACTIONS) ? raw.action : 'refund';
        const ch = ACTIONS[action].choices;
        b = {type: 'act', action, choice: ch ? (own(raw.choice, ch) ? raw.choice : Object.keys(ch)[0]) : null};
      } else continue;
      let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : newId();
      if (ids.has(id)) id = newId();
      ids.add(id);
      out.push(Object.assign({id}, b));
    }
    return out;
  };
  const m = d.memory || {};
  return {format: 'awb-design-1', name: typeof d.name === 'string' && d.name.trim() ? d.name.slice(0, 120) : 'My tree', note: typeof d.note === 'string' ? d.note : '',
          key: typeof d.key === 'string' ? d.key : null, memory: {conversation: !!m.conversation, caseRecord: !!m.caseRecord, pastCases: !!m.pastCases},
          tree: cleanList(d.tree, 0)};
}
// A plain-text outline of a tree (for "Copy all answers").
function outline(design) {
  const lines = [];
  const walk = (list, depth) => {
    for (const b of list) {
      lines.push('  '.repeat(depth) + blockText(b));
      if (b.type === 'check') { lines.push('  '.repeat(depth + 1) + 'yes:'); walk(b.yes, depth + 2); lines.push('  '.repeat(depth + 1) + 'no:'); walk(b.no, depth + 2); }
    }
    if (!list.length || !closes(list[list.length - 1])) lines.push('  '.repeat(depth) + '(no ending)');
  };
  walk(design.tree, 0);
  return lines.join('\n');
}

const WB = {
  DATA, WHO, BLOCKS, ORDER_OF_BLOCKS, FILES, JOBS, PROVIDER_NAMES, CHECKS, CHECK_ORDER, ACTIONS, CATEGORIES, ASKS, MODELS, HUMAN_REPLY, LIMITS, READ_QUESTIONS,
  clone, money, niceTime, newId, newDesign, newBlock, isEnding, closes, listAt, findBlock, allBlocks, allLists, insertBlock, removeBlock, moveBlock, sameRef,
  providerOf, whoKey, whoOf, cleanDesign, providersAbove, providersAtPlace, pathTo, needsOf, checkText, blockText, validate, describe, explain,
  askModel, setFakeModel, ModelError, agentPrompt, replyPrompt, rejectReason, REJECT_REASONS, parseRead, parseMatch, checkNamed, parseAmount,
  freshStore, runCase, runCases, caseById, gradeCase, runBench, checkTree, probes, probeCase, probeAgent, outcomeKey, savedRun, readDesign, outline,
  answersFor, minutes,
};
if (typeof module !== 'undefined' && module.exports) module.exports = WB;
else root.WB = WB;
})(typeof window !== 'undefined' ? window : globalThis);
