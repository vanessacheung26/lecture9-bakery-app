// policy.js: the right ending of each case under the class policy (Lecture 8, slide 3, with Exercise 1's rules), and the
// rating rule. Decided from the facts of the case (what really happened), never from the agent's reading. Lecture 9 copy.
//   Food never arrived: refund the order total; not if there is a drop-off photo or the request is more than 24 hours
//     after delivery (rejected); a refund over $50 goes to a person.
//   Missing items: refund the exact value of the missing items (reorder them if the customer asks to send them again
//     within 2 hours of delivery); rejected if there is a drop-off photo or the request is more than 24 hours after delivery.
//   The missing part of a meal deal has no price of its own on the order: a person decides the amount.
//   Allergy or illness: a person. Anything else (late or cold food, a rude driver): rejected.
//   A refund or reorder already on this order: rejected. 2 or more refunds in the past 30 days: a person.
(function (root) {
'use strict';
const minutes = t => Math.round(Date.parse(t + ':00Z') / 60000);
const r2 = n => Math.round(n * 100) / 100;
function refund(amount, card, why) { return {kind: 'refund', label: `Refund $${amount.toFixed(2)}${why ? ' (' + why + ')' : ''}`, refunds: [{amount: r2(amount), card}], reorders: [], human: false, refused: false}; }
function reorder(items) { return {kind: 'reorder', label: `Reorder ${items.join(', ')}`, refunds: [], reorders: [{items}], human: false, refused: false}; }
function human(why) { return {kind: 'human', label: 'A person' + (why ? ` (${why})` : ''), refunds: [], reorders: [], human: true, refused: false}; }
function refused(why) { return {kind: 'refused', label: 'Reject' + (why ? ` (${why})` : ''), refunds: [], reorders: [], human: false, refused: true}; }

function policyEnding(c) {
  const t = c.truth, now = minutes(c.time);
  const h = c.history || {refunds: [], reorders: []};
  if (h.refunds.some(r => r.order === c.order.number) || (h.reorders || []).some(r => r.order === c.order.number)) return refused('already a refund on this order');
  const refunds30 = h.refunds.filter(r => (now - minutes(r.date)) / 60 <= 30 * 24).length;
  if (refunds30 >= 2) return human('2 or more refunds in 30 days');
  if (t.kind === 'illness') return human('allergy or illness');
  if (t.kind === 'other') return refused('not about missing items');
  const hours = (now - minutes(c.delivery.delivered)) / 60;
  if (hours > 24) return refused('more than 24 hours after delivery');
  if (c.delivery.photo === 'at the address') return refused('drop-off photo');
  if (t.kind === 'never') return c.order.total > 50 ? human('refund over $50') : refund(c.order.total, c.order.card, 'the order total');
  if (t.kind === 'mealpart') return human('part of a meal deal: no price of its own');
  // missing items
  const items = c.order.items.filter(x => t.named.includes(x.name));
  const bill = r2(items.reduce((a, x) => a + x.price, 0));
  if (bill >= 50) return refused('missing items $50 or more');
  if (t.asksReorder && hours <= 2) return reorder(items.map(x => x.name));
  return refund(bill, c.order.card, 'the missing items');
}

// The rating rule, printed on the page: the chance that a customer rates the chat 1 star, from the ending they got.
const ONE_STAR = {refund: 0.01, reorder: 0.01, human: 0.10, rejectRight: 0.10, rejectWrong: 0.85};
const RULE_TEXT = [
  ['Refunded or reordered', '1 in 100'],
  ['Sent to a person', '10 in 100'],
  ['Rejected, and the policy rejects it too', '10 in 100'],
  ['Rejected, but the policy gives a refund, a reorder or a person', '85 in 100'],
];
// ending: 'refund' | 'reorder' | 'human' | 'refused' | 'none'
function oneStarChance(ending, right) {
  if (ending === 'refund' || ending === 'reorder') return ONE_STAR.refund;
  if (ending === 'human') return ONE_STAR.human;
  return right.refused ? ONE_STAR.rejectRight : ONE_STAR.rejectWrong; // rejected, or no ending at all
}
const P = {policyEnding, oneStarChance, ONE_STAR, RULE_TEXT, refund, reorder, human, refused};
if (typeof module !== 'undefined' && module.exports) module.exports = P;
else root.POLICY = P;
})(typeof window !== 'undefined' ? window : globalThis);
