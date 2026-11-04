// The Purse engine. Runs unchanged on the Node server (real PayPal sandbox)
// and in the browser (static demo with the mock adapter).

import { evaluate, explain, describePolicy, normalizePolicy, EMPTY_POLICY } from './policy.js';
import { compilePolicy, inspectListing, planCart, aiLabel } from './ai.js';
import { CATALOG, findSku, DEFAULT_RULES } from './catalog.js';
import { labelOf } from './categories.js';

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function startOfWeek(d) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}

function freshState() {
  return {
    version: 1,
    owner: 'Mina',
    rules: DEFAULT_RULES,
    policy: structuredClone(EMPTY_POLICY),
    policyEngine: null,
    unparsed: [],
    funding: null,           // { paymentTokenId, customerId, payerEmail, connectedAt }
    pendingSetup: null,      // { setupTokenId, approveUrl }
    requests: [],
    ledger: [],
    suggestions: [],
    log: [],
  };
}

export class Purse {
  constructor({ payments, ai, store, now = () => new Date(), catalog = CATALOG, onChange = () => {} }) {
    this.payments = payments;
    this.ai = ai;
    this.store = store;
    this.now = now;
    this.catalog = catalog;
    this.onChange = onChange;
    this._lock = Promise.resolve();
  }

  // Serialize everything that reads budgets and moves money, so two agents
  // submitting at once can't both squeeze under the weekly limit.
  _serial(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  async init() {
    this.state = (await this.store.load()) || null;
    if (!this.state) {
      this.state = freshState();
      await this._compile(this.state.rules);
      await this._save();
    }
    return this;
  }

  async _save() {
    await this.store.save(this.state);
    this.onChange(this.snapshot());
  }

  _log(kind, text, extra = {}) {
    this.state.log.unshift({ id: uid('ev'), at: this.now().toISOString(), kind, text, ...extra });
    this.state.log = this.state.log.slice(0, 200);
  }

  spent(since) {
    return r2(this.state.ledger.filter((l) => l.status === 'captured' && new Date(l.at) >= since).reduce((s, l) => s + l.amount, 0));
  }

  snapshot() {
    const now = this.now();
    const week = this.spent(startOfWeek(now));
    const month = this.spent(new Date(now.getFullYear(), now.getMonth(), 1));
    const p = this.state.policy;
    return {
      owner: this.state.owner,
      rules: this.state.rules,
      policy: p,
      policyLines: describePolicy(p),
      policyEngine: this.state.policyEngine,
      unparsed: this.state.unparsed,
      funding: this.state.funding,
      pendingSetup: this.state.pendingSetup,
      budget: { week, weekLimit: p.weekly_limit, weekLeft: p.weekly_limit == null ? null : r2(Math.max(0, p.weekly_limit - week)), month, monthLimit: p.monthly_limit },
      requests: this.state.requests.slice(0, 60),
      ledger: this.state.ledger.slice(0, 60),
      suggestions: this.state.suggestions.filter((s) => !s.done),
      log: this.state.log.slice(0, 40),
      mode: this.payments.mode,
      ai: aiLabel(this.ai),
    };
  }

  async _compile(text) {
    const { policy, unparsed, engine } = await compilePolicy(this.ai, text);
    this.state.rules = text;
    this.state.policy = normalizePolicy(policy);
    this.state.unparsed = unparsed;
    this.state.policyEngine = engine;
  }

  setRules(text) {
    return this._serial(async () => {
      await this._compile(String(text).slice(0, 4000));
      this._log('rules', 'Rules updated');
      await this._save();
      return this.snapshot();
    });
  }

  // ------------------------------------------------------------ funding
  connectStart(urls) {
    return this._serial(async () => {
      const r = await this.payments.connectStart(urls);
      this.state.pendingSetup = { setupTokenId: r.setupTokenId, approveUrl: r.approveUrl };
      await this._save();
      return r;
    });
  }

  connectFinish(setupTokenId) {
    return this._serial(async () => {
      const id = setupTokenId || this.state.pendingSetup?.setupTokenId;
      if (!id) throw new Error('No PayPal approval in progress');
      const r = await this.payments.connectFinish(id);
      this.state.funding = { ...r, connectedAt: this.now().toISOString() };
      this.state.pendingSetup = null;
      this._log('funding', `PayPal connected${r.payerEmail ? ` (${r.payerEmail})` : ''}`);
      await this._save();
      return this.state.funding;
    });
  }

  disconnect() {
    return this._serial(async () => {
      if (this.state.funding && this.payments.deleteToken) {
        try { await this.payments.deleteToken(this.state.funding.paymentTokenId); } catch { /* token may already be gone */ }
      }
      this.state.funding = null;
      this._log('funding', 'PayPal disconnected; agent can no longer spend');
      await this._save();
    });
  }

  // ------------------------------------------------------------ purchases
  // listing: { agent, merchant, title, price, qty, sku?, description?, category?, reason? }
  requestPurchase(listing) {
    return this._serial(async () => {
      const item = listing.sku ? findSku(listing.sku) : null;
      const merchant = String(listing.merchant || item?.merchant || 'Unknown merchant').slice(0, 80);
      const title = String(listing.title || item?.title || 'Untitled item').slice(0, 200);
      const unit = r2(listing.price ?? item?.price);
      const qty = Math.max(1, Math.min(99, parseInt(listing.qty, 10) || 1));
      const total = r2(unit * qty);
      const insp = await inspectListing(this.ai, { title, description: listing.description, merchant, price: unit, category: listing.category || item?.category }, item);

      const now = this.now();
      const ctx = { spentThisWeek: this.spent(startOfWeek(now)), spentThisMonth: this.spent(new Date(now.getFullYear(), now.getMonth(), 1)), now };
      const { verdict, checks } = evaluate(this.state.policy, { merchant, total, category: insp.category, flags: insp.flags }, ctx);

      if (!this.state.funding && verdict === 'auto') {
        checks.push({ rule: 'funding', outcome: 'ask', detail: 'No PayPal account is connected yet, so it needs a one-time checkout.' });
      }
      const finalVerdict = checks.some((c) => c.outcome === 'block') ? 'block' : checks.some((c) => c.outcome === 'ask') ? 'ask' : 'auto';

      const req = {
        id: uid('req'), at: now.toISOString(), agent: String(listing.agent || 'Agent').slice(0, 40),
        merchant, title, sku: item?.sku || listing.sku || null, qty, unitPrice: unit, total,
        category: insp.category, categoryLabel: labelOf(insp.category), flags: insp.flags, note: insp.note,
        reason: listing.reason ? String(listing.reason).slice(0, 240) : null,
        verdict: finalVerdict, checks, explanation: explain(finalVerdict, checks), status: 'evaluating',
      };
      this.state.requests.unshift(req);

      if (finalVerdict === 'block') {
        req.status = 'blocked';
        this._log('blocked', `Refused ${title} (${merchant})`, { requestId: req.id });
      } else if (finalVerdict === 'ask') {
        req.status = 'needs_approval';
        this._log('ask', `${req.agent} wants ${title} for $${total.toFixed(2)}`, { requestId: req.id });
      } else {
        await this._chargeSaved(req, 'auto');
      }
      await this._save();
      return req;
    });
  }

  async _chargeSaved(req, via) {
    try {
      const r = await this.payments.chargeSaved({
        paymentTokenId: this.state.funding.paymentTokenId, amount: req.total, currency: this.state.policy.currency,
        merchant: req.merchant, description: `${req.title} ×${req.qty}`.slice(0, 127), requestId: req.id,
        items: [{ name: req.title.slice(0, 127), quantity: String(req.qty), unit_amount: { currency_code: 'USD', value: req.unitPrice.toFixed(2) } }],
      });
      req.orderId = r.orderId; req.captureId = r.captureId; req.status = 'paid'; req.paidVia = via;
      this.state.ledger.unshift({ id: uid('pay'), requestId: req.id, at: this.now().toISOString(), merchant: req.merchant, title: req.title, qty: req.qty, amount: req.total, orderId: r.orderId, captureId: r.captureId, via, status: 'captured', category: req.category });
      this._log('paid', `Paid $${req.total.toFixed(2)} to ${req.merchant}${via === 'auto' ? ' automatically' : ' after your OK'}`, { requestId: req.id });
    } catch (e) {
      req.status = 'failed'; req.error = e.message;
      this._log('failed', `Payment failed for ${req.title}: ${e.message}`, { requestId: req.id });
    }
  }

  _find(id) {
    const r = this.state.requests.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error('Request not found'), { status: 404 });
    return r;
  }

  approve(id, urls = {}) {
    return this._serial(async () => {
      const req = this._find(id);
      if (req.status !== 'needs_approval') throw Object.assign(new Error(`Request is ${req.status}`), { status: 409 });
      if (req.verdict === 'block') throw Object.assign(new Error('Blocked requests cannot be approved; change the rules first'), { status: 409 });
      req.approvedAt = this.now().toISOString();
      if (this.state.funding) {
        await this._chargeSaved(req, 'approved');
      } else {
        // No saved PayPal yet: fall back to a normal one-time PayPal Checkout.
        const r = await this.payments.createCheckout({ amount: req.total, currency: 'USD', merchant: req.merchant, description: req.title, requestId: req.id, ...urls });
        req.orderId = r.orderId; req.approveUrl = r.approveUrl; req.status = 'awaiting_paypal';
      }
      this._suggestFrom(req);
      await this._save();
      return req;
    });
  }

  completeCheckout(orderId) {
    return this._serial(async () => {
      const req = this.state.requests.find((r) => r.orderId === orderId);
      if (!req) throw Object.assign(new Error('Unknown order'), { status: 404 });
      if (req.status === 'paid') return req;
      const r = await this.payments.captureCheckout(orderId);
      req.captureId = r.captureId; req.status = 'paid'; req.paidVia = 'checkout';
      this.state.ledger.unshift({ id: uid('pay'), requestId: req.id, at: this.now().toISOString(), merchant: req.merchant, title: req.title, qty: req.qty, amount: req.total, orderId, captureId: r.captureId, via: 'checkout', status: 'captured', category: req.category });
      this._log('paid', `Paid $${req.total.toFixed(2)} to ${req.merchant} via PayPal Checkout`, { requestId: req.id });
      await this._save();
      return req;
    });
  }

  decline(id) {
    return this._serial(async () => {
      const req = this._find(id);
      if (!['needs_approval', 'awaiting_paypal'].includes(req.status)) throw Object.assign(new Error(`Request is ${req.status}`), { status: 409 });
      req.status = 'declined';
      this._log('declined', `You declined ${req.title}`, { requestId: req.id });
      await this._save();
      return req;
    });
  }

  refund(ledgerId) {
    return this._serial(async () => {
      const l = this.state.ledger.find((x) => x.id === ledgerId);
      if (!l) throw Object.assign(new Error('Payment not found'), { status: 404 });
      if (l.status !== 'captured') throw Object.assign(new Error('Already refunded'), { status: 409 });
      const r = await this.payments.refund(l.captureId, l.amount, l.requestId);
      l.status = 'refunded'; l.refundId = r.refundId; l.refundedAt = this.now().toISOString();
      const req = this.state.requests.find((x) => x.id === l.requestId);
      if (req) req.status = 'refunded';
      this._log('refund', `Refunded $${l.amount.toFixed(2)} from ${l.merchant}`, { requestId: l.requestId });
      await this._save();
      return l;
    });
  }

  // When the owner approves something that only needed approval because of a
  // threshold, offer to make that kind of purchase automatic next time.
  _suggestFrom(req) {
    const t = req.checks.find((c) => c.rule === 'threshold' && c.outcome === 'ask');
    const others = req.checks.filter((c) => c.outcome === 'ask' && c.rule !== 'threshold' && c.rule !== 'funding');
    if (!t || others.length) return;
    const limit = Math.ceil(req.total / 5) * 5;
    const cat = req.category;
    if (this.state.suggestions.some((s) => !s.done && s.category === cat)) return;
    this.state.suggestions.push({ id: uid('sg'), category: cat, limit, text: `${labelOf(cat)} up to $${limit} is fine.`, why: `You approved ${req.title} ($${req.total.toFixed(2)}).`, done: false });
  }

  applySuggestion(id, accept = true) {
    return this._serial(async () => {
      const s = this.state.suggestions.find((x) => x.id === id);
      if (!s) throw Object.assign(new Error('Suggestion not found'), { status: 404 });
      s.done = true;
      if (accept) {
        this.state.rules = `${this.state.rules.trim()}\n${s.text}`;
        this.state.policy.category_limits[s.category] = s.limit;
        this._log('rules', `New rule: ${s.text}`);
      }
      await this._save();
      return this.snapshot();
    });
  }

  // ------------------------------------------------------------ demo agent
  async planAgent(task) {
    const { picks, engine } = await planCart(this.ai, task, this.catalog);
    return { engine, picks: picks.map((p) => ({ ...p, item: findSku(p.sku) })) };
  }

  async runAgent(task, agent = 'Pantry agent') {
    const { picks, engine } = await planCart(this.ai, task, this.catalog);
    const results = [];
    for (const p of picks) {
      const item = findSku(p.sku);
      results.push(await this.requestPurchase({ agent, sku: item.sku, merchant: item.merchant, title: item.title, price: item.price, qty: p.qty, category: item.category, reason: p.why }));
    }
    return { engine, picks, results };
  }

  async reset() {
    return this._serial(async () => {
      const keepFunding = this.state.funding;
      this.state = freshState();
      this.state.funding = keepFunding;
      await this._compile(this.state.rules);
      await this._save();
      return this.snapshot();
    });
  }
}
