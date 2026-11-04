// Policy: the structured form of the owner's plain-English rules, and the
// deterministic evaluator that decides every purchase.
//
// Design rule: an LLM may *read* the rules and *describe* a decision, but it
// never makes the decision. evaluate() is pure code, so a prompt injection in a
// product title can't talk its way past a spending limit.

import { CATEGORY_KEYS, phraseToCategories, labelOf } from './categories.js';

export const EMPTY_POLICY = {
  currency: 'USD',
  weekly_limit: null,          // total auto+approved spend per ISO week
  monthly_limit: null,
  ask_over: null,              // single purchase above this needs the owner
  hard_max: null,              // single purchase above this is refused outright
  blocked_categories: [],
  ask_categories: [],
  allowed_categories: [],      // if non-empty, anything else needs the owner
  allowed_merchants: [],       // if non-empty, other merchants need the owner
  quiet_hours: null,           // { start: 22, end: 7 } in local hours -> ask
  category_limits: {},         // { household: 40 } per-purchase auto limit by category
};

const num = (s) => (s == null ? null : Number(String(s).replace(/[,$]/g, '')));
const money = /\$\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s?(?:dollars|usd|bucks)/i;

function amountIn(str) {
  const m = String(str).match(money);
  return m ? num(m[1] ?? m[2]) : null;
}

function hour(h, ampm) {
  let x = Number(h) % 12;
  if (!ampm) return Number(h) % 24;
  if (/p/i.test(ampm)) x += 12;
  return x;
}

// ---------------------------------------------------------------- heuristic
// A small, honest rule reader. It exists so Purse runs with no API key and so
// tests are deterministic; the LLM compiler (core/ai.js) handles phrasing this
// does not.
export function compileHeuristic(text) {
  const p = structuredClone(EMPTY_POLICY);
  const notes = [];
  const sentences = String(text).replace(/\n+/g, '. ').split(/(?<=[.!?;])\s+|\.\s*$/).map((s) => s.trim()).filter(Boolean);

  for (const raw of sentences) {
    const s = raw.toLowerCase();
    let used = false;

    // weekly / monthly budgets
    const per = s.match(/(?:\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:dollars|usd|bucks))[^.]*?\b(?:a|per|each|every|\/)\s?(week|wk|month|mo)\b/);
    if (per) {
      const v = num(per[1] ?? per[2]);
      if (/^w/.test(per[3])) p.weekly_limit = v; else p.monthly_limit = v;
      const cats = phraseToCategories(s.slice(s.indexOf(per[0]) + per[0].length));
      if (cats.length && !/never|don't|do not/.test(s)) p.allowed_categories = [...new Set([...p.allowed_categories, ...cats])];
      used = true;
    }

    // hard maximum: "never spend more than $150", "hard stop at $150", "nothing over $200, ever"
    const hard = s.match(/(?:hard (?:stop|limit|cap|max)|never (?:spend|pay)|absolute(?:ly)? (?:max|limit)|refuse|nothing)[^.]*?(?:over|above|more than|at|beyond|past)\s*\$?\s?(\d+(?:\.\d+)?)/);
    if (hard) { p.hard_max = num(hard[1]); used = true; }

    // approval threshold: "ask me before anything over $25"
    const ask = s.match(/(?:ask|check with|ping|confirm|approval|approve|ok|okay)[^.]*?(?:over|above|more than|exceeding|beyond)\s*\$?\s?(\d+(?:\.\d+)?)/);
    if (ask && !(hard && hard.index === ask.index)) { p.ask_over = num(ask[1]); used = true; }

    // per-category auto limits: "household items up to $40 are fine"
    const catLim = s.match(/^(.*?)\b(?:up to|under|below|less than)\s*\$\s?(\d+(?:\.\d+)?)\s*(?:are|is)?\s*(?:fine|ok|okay|allowed|automatic)/);
    if (catLim) {
      for (const c of phraseToCategories(catLim[1])) p.category_limits[c] = num(catLim[2]);
      used = true;
    }

    // never buy X
    const never = s.match(/(?:never|don't|do not|no)\s+(?:ever\s+)?(?:buy|purchase|order|get)\s+(?:any\s+)?(.+)/);
    if (never && !hard) {
      const cats = phraseToCategories(never[1]);
      p.blocked_categories = [...new Set([...p.blocked_categories, ...cats])];
      if (cats.length) used = true;
    }

    // X always needs my OK / ask me about X
    const needs = s.match(/^(.+?)\s+(?:always\s+)?(?:need|needs|require|requires)\s+(?:my\s+)?(?:ok|okay|approval|sign-?off|yes)/)
      || s.match(/(?:always\s+)?ask (?:me )?(?:first )?(?:about|before buying|for)\s+(.+)/);
    if (needs && !ask) {
      const cats = phraseToCategories(needs[1]);
      p.ask_categories = [...new Set([...p.ask_categories, ...cats])];
      if (cats.length) used = true;
    }

    // only from these merchants
    const only = s.match(/only (?:from|at|buy from|shop at|use)\s+(.+)/);
    if (only) {
      p.allowed_merchants = only[1].split(/,|\bor\b|\band\b/).map((m) => m.trim().replace(/[.]$/, '')).filter(Boolean)
        .map((m) => raw.slice(raw.toLowerCase().indexOf(m), raw.toLowerCase().indexOf(m) + m.length));
      used = true;
    }

    // quiet hours: "nothing between 11pm and 7am"
    const qh = s.match(/between\s+(\d{1,2})(?::\d\d)?\s*(am|pm)?\s+(?:and|to|-)\s+(\d{1,2})(?::\d\d)?\s*(am|pm)?/);
    if (qh) {
      const startAmpm = qh[2] || (qh[4] === 'am' ? 'pm' : qh[4]);
      p.quiet_hours = { start: hour(qh[1], startAmpm), end: hour(qh[3], qh[4]) };
      used = true;
    }

    if (!used) notes.push(raw);
  }
  // an ask threshold above the hard max is meaningless
  if (p.hard_max != null && p.ask_over != null && p.ask_over > p.hard_max) p.ask_over = p.hard_max;
  return { policy: p, unparsed: notes };
}

// ------------------------------------------------------------ normalization
// Anything that claims to be a policy (LLM output, a saved file) goes through
// here. Unknown keys are dropped, numbers are clamped, categories validated.
export function normalizePolicy(input) {
  const p = structuredClone(EMPTY_POLICY);
  if (!input || typeof input !== 'object') return p;
  const pos = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e6 ? Math.round(n * 100) / 100 : null; };
  const cats = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter((c) => CATEGORY_KEYS.includes(c)))] : []);
  p.weekly_limit = pos(input.weekly_limit);
  p.monthly_limit = pos(input.monthly_limit);
  p.ask_over = pos(input.ask_over);
  p.hard_max = pos(input.hard_max);
  p.blocked_categories = cats(input.blocked_categories);
  p.ask_categories = cats(input.ask_categories).filter((c) => !p.blocked_categories.includes(c));
  p.allowed_categories = cats(input.allowed_categories).filter((c) => !p.blocked_categories.includes(c));
  p.allowed_merchants = Array.isArray(input.allowed_merchants) ? input.allowed_merchants.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : [];
  if (input.quiet_hours && Number.isInteger(+input.quiet_hours.start) && Number.isInteger(+input.quiet_hours.end)) {
    p.quiet_hours = { start: +input.quiet_hours.start % 24, end: +input.quiet_hours.end % 24 };
  }
  if (input.category_limits && typeof input.category_limits === 'object') {
    for (const [k, v] of Object.entries(input.category_limits)) if (CATEGORY_KEYS.includes(k) && pos(v) != null) p.category_limits[k] = pos(v);
  }
  if (p.hard_max != null && p.ask_over != null && p.ask_over > p.hard_max) p.ask_over = p.hard_max;
  return p;
}

// Human-readable lines for the "here's what I understood" panel.
export function describePolicy(p) {
  const $ = (v) => `$${Number(v).toFixed(v % 1 ? 2 : 0)}`;
  const out = [];
  if (p.weekly_limit != null) out.push({ kind: 'budget', text: `${$(p.weekly_limit)} per week` + (p.allowed_categories.length ? ` on ${p.allowed_categories.map(labelOf).join(', ').toLowerCase()}` : '') });
  if (p.monthly_limit != null) out.push({ kind: 'budget', text: `${$(p.monthly_limit)} per month` });
  if (p.ask_over != null) out.push({ kind: 'ask', text: `Ask above ${$(p.ask_over)}` });
  for (const [c, v] of Object.entries(p.category_limits)) out.push({ kind: 'auto', text: `${labelOf(c)} auto up to ${$(v)}` });
  for (const c of p.ask_categories) out.push({ kind: 'ask', text: `Ask for ${labelOf(c).toLowerCase()}` });
  for (const c of p.blocked_categories) out.push({ kind: 'block', text: `Never ${labelOf(c).toLowerCase()}` });
  if (p.hard_max != null) out.push({ kind: 'block', text: `Refuse above ${$(p.hard_max)}` });
  if (p.allowed_merchants.length) out.push({ kind: 'ask', text: `Only ${p.allowed_merchants.join(', ')}` });
  if (p.quiet_hours) out.push({ kind: 'ask', text: `Quiet ${fmtHour(p.quiet_hours.start)}–${fmtHour(p.quiet_hours.end)}` });
  return out;
}

export function fmtHour(h) {
  const ampm = h >= 12 ? 'pm' : 'am';
  const x = h % 12 === 0 ? 12 : h % 12;
  return `${x}${ampm}`;
}

// ---------------------------------------------------------------- evaluate
// ctx: { spentThisWeek, spentThisMonth, now: Date }
// request: { merchant, total, category, flags: [] }
// returns { verdict: 'auto'|'ask'|'block', checks: [...] }
export function evaluate(policy, request, ctx) {
  const p = policy;
  const checks = [];
  const add = (rule, outcome, detail) => checks.push({ rule, outcome, detail });
  const $ = (v) => `$${Number(v).toFixed(2)}`;
  const total = Number(request.total);

  if (!(total > 0)) add('amount', 'block', 'Purchase amount must be positive.');

  if (p.blocked_categories.includes(request.category)) add('category', 'block', `${labelOf(request.category)} is on your never-buy list.`);
  else if (p.ask_categories.includes(request.category)) add('category', 'ask', `You asked to approve ${labelOf(request.category).toLowerCase()} yourself.`);
  else if (p.allowed_categories.length && !p.allowed_categories.includes(request.category)) add('category', 'ask', `${labelOf(request.category)} is outside the categories this purse covers.`);
  else add('category', 'pass', `${labelOf(request.category)} is allowed.`);

  for (const f of request.flags || []) {
    if (f === 'recurring') add('recurring', 'ask', 'This would start a recurring charge.');
    if (f === 'injection') add('integrity', 'ask', 'The listing contains instructions aimed at the agent; holding for you.');
    if (f === 'price_jump') add('price', 'ask', 'Price is well above what this item usually costs.');
  }

  if (p.hard_max != null && total > p.hard_max) add('hard_max', 'block', `${$(total)} is above your ${$(p.hard_max)} ceiling.`);

  // A category allowance overrides the general ask-first line for that category.
  const catLimit = p.category_limits[request.category];
  const catName = labelOf(request.category).toLowerCase();
  if (catLimit != null) {
    if (total > catLimit) add('threshold', 'ask', `${$(total)} is above your ${$(catLimit)} ${catName} allowance.`);
    else add('threshold', 'pass', `Within your ${$(catLimit)} ${catName} allowance.`);
  } else if (p.ask_over != null) {
    if (total > p.ask_over) add('threshold', 'ask', `${$(total)} is above your ${$(p.ask_over)} ask-first line.`);
    else add('threshold', 'pass', `Under your ${$(p.ask_over)} ask-first line.`);
  }

  if (p.weekly_limit != null) {
    const after = ctx.spentThisWeek + total;
    if (after > p.weekly_limit) add('weekly', 'ask', `Would bring this week to ${$(after)} of ${$(p.weekly_limit)}.`);
    else add('weekly', 'pass', `${$(p.weekly_limit - after)} left this week after this.`);
  }
  if (p.monthly_limit != null) {
    const after = ctx.spentThisMonth + total;
    if (after > p.monthly_limit) add('monthly', 'ask', `Would bring this month to ${$(after)} of ${$(p.monthly_limit)}.`);
  }

  if (p.allowed_merchants.length) {
    const ok = p.allowed_merchants.some((m) => m.toLowerCase() === String(request.merchant).toLowerCase());
    add('merchant', ok ? 'pass' : 'ask', ok ? `${request.merchant} is on your list.` : `${request.merchant} isn't one of your stores.`);
  }

  if (p.quiet_hours) {
    const h = (ctx.now || new Date()).getHours();
    const { start, end } = p.quiet_hours;
    const quiet = start > end ? h >= start || h < end : h >= start && h < end;
    if (quiet) add('quiet_hours', 'ask', `It's within your quiet hours (${fmtHour(start)}–${fmtHour(end)}).`);
  }

  const verdict = checks.some((c) => c.outcome === 'block') ? 'block' : checks.some((c) => c.outcome === 'ask') ? 'ask' : 'auto';
  return { verdict, checks };
}

export function explain(verdict, checks) {
  const reasons = checks.filter((c) => c.outcome === (verdict === 'auto' ? 'pass' : verdict)).map((c) => c.detail);
  if (verdict === 'auto') return `Paid automatically. ${reasons.slice(0, 2).join(' ')}`.trim();
  if (verdict === 'ask') return `Needs your OK. ${reasons.join(' ')}`.trim();
  return `Refused. ${reasons.join(' ')}`.trim();
}
