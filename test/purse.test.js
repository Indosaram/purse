import test from 'node:test';
import assert from 'node:assert/strict';
import { compileHeuristic, evaluate } from '../core/policy.js';
import { Purse } from '../core/engine.js';
import { MockPayments } from '../payments/mock.js';
import { DEFAULT_RULES } from '../core/catalog.js';

const memStore = () => { let s = null; return { load: async () => s, save: async (x) => { s = structuredClone(x); } }; };
const noon = () => new Date('2026-11-04T12:00:00');
const make = async () => new Purse({ payments: new MockPayments(), ai: { provider: 'heuristic', model: 't' }, store: memStore(), now: noon }).init();

test('rule reader understands the default rules', () => {
  const { policy, unparsed } = compileHeuristic(DEFAULT_RULES);
  assert.equal(policy.weekly_limit, 60);
  assert.equal(policy.ask_over, 25);
  assert.equal(policy.hard_max, 150);
  assert.deepEqual(policy.blocked_categories.sort(), ['alcohol', 'gift_cards', 'tobacco']);
  assert.deepEqual(policy.ask_categories, ['electronics']);
  assert.deepEqual(policy.allowed_categories.sort(), ['groceries', 'household']);
  assert.deepEqual(unparsed, []);
});

test('quiet hours and merchants', () => {
  const { policy } = compileHeuristic('Only buy from Corner Market. Nothing between 11pm and 7am.');
  assert.deepEqual(policy.allowed_merchants, ['Corner Market']);
  assert.deepEqual(policy.quiet_hours, { start: 23, end: 7 });
  const v = evaluate(policy, { merchant: 'Corner Market', total: 5, category: 'groceries', flags: [] }, { spentThisWeek: 0, spentThisMonth: 0, now: new Date('2026-11-04T23:30:00') });
  assert.equal(v.verdict, 'ask');
});

test('no PayPal connected: even small purchases need a one-time checkout', async () => {
  const p = await make();
  const r = await p.requestPurchase({ sku: 'CM-PT-6' });
  assert.equal(r.status, 'needs_approval');
  const a = await p.approve(r.id);
  assert.equal(a.status, 'awaiting_paypal');
  const done = await p.completeCheckout(a.orderId);
  assert.equal(done.status, 'paid');
});

test('full policy walk with a saved PayPal wallet', async () => {
  const p = await make();
  const s = await p.connectStart({});
  await p.connectFinish(s.setupTokenId);

  const towels = await p.requestPurchase({ sku: 'CM-PT-6' });
  assert.equal(towels.status, 'paid');
  assert.match(towels.orderId, /^MOCK-/);

  const wine = await p.requestPurchase({ sku: 'VD-RW-1' });
  assert.equal(wine.status, 'blocked');

  const vac = await p.requestPurchase({ sku: 'BE-SV-1' });
  assert.equal(vac.status, 'needs_approval');

  const tv = await p.requestPurchase({ sku: 'BE-TV-65' });
  assert.equal(tv.status, 'blocked');

  const sneaky = await p.requestPurchase({ sku: 'DX-GC-50' });
  assert.equal(sneaky.status, 'needs_approval');
  assert.ok(sneaky.flags.includes('injection'));

  const trial = await p.requestPurchase({ sku: 'MP-SP-1' });
  assert.equal(trial.status, 'needs_approval');
  assert.ok(trial.flags.includes('recurring'));

  const approved = await p.approve(vac.id);
  assert.equal(approved.status, 'paid');

  // weekly budget: 11.49 spent; vacuum (electronics) is outside the category budget? it counts toward spend
  const snap = p.snapshot();
  assert.equal(snap.budget.week, 100.49);

  const refunded = await p.refund(snap.ledger.find((l) => l.requestId === vac.id).id);
  assert.equal(refunded.status, 'refunded');
  assert.equal(p.snapshot().budget.week, 11.49);
});

test('weekly limit holds under concurrent agents', async () => {
  const p = await make();
  const s = await p.connectStart({});
  await p.connectFinish(s.setupTokenId);
  const results = await Promise.all(Array.from({ length: 8 }, () => p.requestPurchase({ sku: 'CM-CF-12' }))); // 13.99 each
  const paid = results.filter((r) => r.status === 'paid').length;
  assert.equal(paid, 4); // 4 × 13.99 = 55.96 ≤ 60; the 5th would exceed
  assert.ok(p.snapshot().budget.week <= 60);
});

test('approving a threshold ask offers a new rule', async () => {
  const p = await make();
  const s = await p.connectStart({});
  await p.connectFinish(s.setupTokenId);
  const d = await p.requestPurchase({ sku: 'CM-PT-6', qty: 3 }); // 34.47 household
  assert.equal(d.status, 'needs_approval');
  await p.approve(d.id);
  const sg = p.snapshot().suggestions[0];
  assert.equal(sg.category, 'household');
  assert.equal(sg.limit, 35);
  await p.applySuggestion(sg.id, true);
  const again = await p.requestPurchase({ sku: 'CM-TB-40', qty: 1 });
  assert.equal(again.status, 'paid');
});

test('agent plans a cart from an errand', async () => {
  const p = await make();
  const s = await p.connectStart({});
  await p.connectFinish(s.setupTokenId);
  const r = await p.runAgent("We're out of paper towels and dish soap. Grab a bottle of wine for Friday and a vacuum.");
  const bySku = Object.fromEntries(r.results.map((x) => [x.sku, x.status]));
  assert.equal(bySku['CM-PT-6'], 'paid');
  assert.equal(bySku['CM-DS-2'], 'paid');
  assert.equal(bySku['VD-RW-1'], 'blocked');
  assert.equal(bySku['BE-SV-1'], 'needs_approval');
});
