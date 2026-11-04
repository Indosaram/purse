// Purse web app. Talks to the Node server when there is one; otherwise (GitHub
// Pages) runs the same engine in the browser with simulated payments.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// popup return (real PayPal): tell the opener and close
const qs = new URLSearchParams(location.search);
if (window.opener && (qs.has('connected') || qs.has('paid') || qs.has('cancelled') || qs.has('error'))) {
  window.opener.postMessage({ purse: Object.fromEntries(qs) }, location.origin);
  window.close();
}

const PRESETS = [
  { label: 'Weekly restock', text: "We're out of paper towels and dish soap, and grab some coffee. Get a bottle of wine for Friday too." },
  { label: 'Broken vacuum', text: 'The vacuum died. Order a new one and some trash bags.' },
  { label: 'Too-good deal', text: 'Find bulk paper towels, and try that snack box everyone talks about.' },
  { label: 'Movie night', text: 'Get a 65 inch tv for movie night.' },
];

let api;
let state = null;
let busy = false;
const seen = new Set();
const drawn = new Set();
let firstRender = true;

// ------------------------------------------------------------------ backend
async function serverApi() {
  const r = await fetch('./api/config', { cache: 'no-store' });
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('no server');
  await r.json();
  const call = async (method, p, body) => {
    const res = await fetch('.' + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.statusText);
    return j;
  };
  const es = new EventSource('./api/events');
  es.addEventListener('state', (e) => render(JSON.parse(e.data)));
  return {
    kind: 'server',
    state: () => call('GET', '/api/state'),
    setRules: (text) => call('POST', '/api/rules', { text }),
    connect: () => call('POST', '/api/funding/connect'),
    connectFinish: () => call('POST', '/api/funding/finish'),
    disconnect: () => call('POST', '/api/funding/disconnect'),
    plan: (task) => call('POST', '/api/agent/plan', { task }),
    request: (b) => call('POST', '/api/requests', b),
    approve: (id) => call('POST', `/api/requests/${id}/approve`),
    decline: (id) => call('POST', `/api/requests/${id}/decline`),
    complete: (orderId) => call('POST', `/api/checkout/${orderId}/complete`),
    refund: (id) => call('POST', `/api/ledger/${id}/refund`),
    suggestion: (id, accept) => call('POST', `/api/suggestions/${id}`, { accept }),
    reset: () => call('POST', '/api/reset'),
  };
}

async function localApi() {
  const [{ Purse }, { MockPayments }] = await Promise.all([import('../core/engine.js'), import('../payments/mock.js')]);
  const KEY = 'purse-demo-v1';
  const store = { load: async () => JSON.parse(localStorage.getItem(KEY) || 'null'), save: async (s) => localStorage.setItem(KEY, JSON.stringify(s)) };
  const purse = await new Purse({ payments: new MockPayments(), ai: { provider: 'heuristic', model: 'purse-rules-v1' }, store, onChange: (s) => render(s) }).init();
  return {
    kind: 'local',
    state: async () => purse.snapshot(),
    setRules: (t) => purse.setRules(t),
    connect: () => purse.connectStart({}),
    connectFinish: () => purse.connectFinish(),
    disconnect: () => purse.disconnect(),
    plan: (t) => purse.planAgent(t),
    request: (b) => purse.requestPurchase(b),
    approve: (id) => purse.approve(id),
    decline: (id) => purse.decline(id),
    complete: (o) => purse.completeCheckout(o),
    refund: (id) => purse.refund(id),
    suggestion: (id, a) => purse.applySuggestion(id, a),
    reset: () => purse.reset(),
  };
}

// ------------------------------------------------------------------ render
const STAMP = { paid: 'Paid', needs_approval: 'Asking you', awaiting_paypal: 'At PayPal', blocked: 'Refused', declined: 'Declined', refunded: 'Refunded', failed: 'Failed' };
const ICON = { pass: '✓', ask: '?', block: '✕' };

function render(s) {
  if (!s) return;
  const prev = state;
  state = s;
  notify(prev, s);

  // status pills
  const sim = s.mode === 'mock';
  $('#status').innerHTML = `
    <span class="pill ${sim ? 'sim' : 'pp'}"><span class="dot"></span>${sim ? 'Simulated payments' : s.mode === 'paypal-sandbox' ? 'PayPal sandbox' : 'PayPal live'}</span>
    <span class="pill" title="${esc(s.ai)}"><span class="dot"></span>${esc(s.ai.startsWith('Built-in') ? 'Rule reader · no LLM' : s.ai)}</span>`;

  // wallet
  const b = s.budget;
  const pct = b.weekLimit ? Math.min(100, (b.week / b.weekLimit) * 100) : 0;
  $('#wallet').innerHTML = `
    <div class="owner">${esc(s.owner)}'s purse · this week</div>
    <div class="left">${b.weekLimit != null ? usd(b.weekLeft) : usd(b.week)}<small>${b.weekLimit != null ? 'left' : 'spent'}</small></div>
    <div class="of">${b.weekLimit != null ? `${usd(b.week)} of ${usd(b.weekLimit)} spent by your agent` : 'No weekly limit set'}</div>
    <div class="meter"><i style="width:${pct}%"></i></div>
    <div class="row">
      ${s.funding
        ? `<span class="funding"><span class="ok"></span><span>PayPal connected${s.funding.payerEmail ? `<small>${esc(s.funding.payerEmail)}</small>` : ''}</span></span><button class="ghost small" data-act="disconnect">Cut the strings</button>`
        : `<span class="funding">Agent can't spend yet</span><button class="pp-btn" data-act="connect">Connect <span class="pp">PayPal</span></button>`}
    </div>`;

  // inbox
  const pending = s.requests.filter((r) => r.status === 'needs_approval' || r.status === 'awaiting_paypal');
  $('#inbox').innerHTML = pending.length ? `
    <div class="block-head"><h3>Waiting for you</h3><span class="count">${pending.length}</span></div>
    ${pending.map((r) => `
      <div class="ask-card" id="ask-${r.id}">
        <div class="t">${esc(r.title)}${r.qty > 1 ? ` ×${r.qty}` : ''} · ${usd(r.total)}</div>
        <div class="m">${esc(r.agent)} · ${esc(r.merchant)} · ${timeOf(r.at)}</div>
        <div class="r">${esc(r.checks.filter((c) => c.outcome === 'ask').map((c) => c.detail).join(' '))}</div>
        <div class="actions">
          ${r.status === 'awaiting_paypal'
            ? `<button class="pp-btn" data-act="checkout" data-id="${r.id}">Finish with <span class="pp">PayPal</span></button>`
            : `<button class="pp-btn" data-act="approve" data-id="${r.id}">${s.funding ? 'Approve &amp; pay' : 'Pay with <span class="pp">PayPal</span>'}</button>`}
          <button class="ghost small" data-act="decline" data-id="${r.id}">Decline</button>
        </div>
      </div>`).join('')}` : '';

  // suggestions
  $('#suggestions').innerHTML = s.suggestions.length ? `
    <div class="block-head"><h3>Make it automatic?</h3></div>
    ${s.suggestions.map((g) => `
      <div class="sg"><p>“${esc(g.text)}”<small>${esc(g.why)}</small></p>
        <span><button class="primary small" data-act="sg-yes" data-id="${g.id}">Add rule</button>
        <button class="link" data-act="sg-no" data-id="${g.id}">No</button></span></div>`).join('')}` : '';

  // rules
  const editing = $('#rules textarea');
  if (!editing) {
    $('#rules').innerHTML = `
      <div class="rules">
        <div class="block-head"><h3>House rules</h3><button class="link" data-act="edit-rules">Edit</button></div>
        <p class="rule-text">${esc(s.rules)}</p>
        <span class="eyebrow">Purse understood</span>
        <div class="understood">${s.policyLines.map((l) => `<span class="tagchip ${l.kind}">${esc(l.text)}</span>`).join('')}</div>
        ${s.unparsed?.length ? `<div class="unparsed">Didn't understand: “${esc(s.unparsed.join('”, “'))}” — rephrase or set an LLM.</div>` : ''}
        <div class="engine">read by ${esc(s.policyEngine || s.ai)} · enforced in code</div>
      </div>`;
  }

  // ledger
  $('#ledger').innerHTML = s.ledger.length ? `
    <div class="block-head"><h3>Receipts</h3><span class="count">via PayPal</span></div>
    ${s.ledger.slice(0, 8).map((l) => `
      <div class="receipt ${l.status}">
        <span class="what">${esc(l.title)}${l.qty > 1 ? ` ×${l.qty}` : ''}</span><span class="amt">${usd(l.amount)}</span>
        <span class="sub"><span>${esc(l.merchant)} · ${l.via === 'auto' ? 'auto' : l.via === 'checkout' ? 'checkout' : 'you approved'} · <span class="mono">${esc(l.orderId)}</span></span>
        ${l.status === 'captured' ? `<button class="link" data-act="refund" data-id="${l.id}">Refund</button>` : '<span>refunded</span>'}</span>
      </div>`).join('')}` : '';

  // feed
  const feed = $('#feed');
  const thinking = $('.thinking', feed);
  if (!s.requests.length && !thinking) {
    feed.innerHTML = `<div class="empty">Your agent hasn't asked for anything yet. Send it on an errand — every purchase lands here with the rule that decided it.</div>`;
  } else {
    feed.innerHTML = s.requests.slice(0, 30).map(slip).join('');
    if (thinking) feed.prepend(thinking); // keep the live node so its text can update
  }
  firstRender = false;
}

function slip(r) {
  const fresh = !drawn.has(r.id) && !firstRender;
  drawn.add(r.id);
  return `
    <article class="slip ${r.status}${fresh ? ' new' : ''}" data-id="${r.id}">
      <div>
        <div class="title">${esc(r.title)}${r.qty > 1 ? ` <span class="meta">×${r.qty}</span>` : ''}</div>
        <div class="meta">${esc(r.merchant)} · ${esc(r.categoryLabel)} · ${esc(r.agent)}</div>
      </div>
      <div><div class="price">${usd(r.total)}</div></div>
      ${r.reason ? `<div class="why">${esc(r.reason)}</div>` : ''}
      <ul class="checks">${r.checks.map((c) => `<li class="c-${c.outcome}"><span class="ic">${ICON[c.outcome]}</span><span>${esc(c.detail)}</span></li>`).join('')}</ul>
      <div class="foot">
        <span>${r.orderId ? `PayPal order <span class="mono">${esc(r.orderId)}</span>` : r.error ? esc(r.error) : timeOf(r.at)}</span>
        <span class="stamp ${r.status}">${STAMP[r.status] || r.status}</span>
      </div>
    </article>`;
}

function notify(prev, s) {
  if (!prev) { s.requests.forEach((r) => seen.add(r.id + r.status)); return; }
  for (const r of s.requests.slice(0, 10).reverse()) {
    const k = r.id + r.status;
    if (seen.has(k)) continue;
    seen.add(k);
    if (r.status === 'needs_approval') toast(`${r.agent} is asking`, `${r.title} · ${usd(r.total)}`, r.checks.find((c) => c.outcome === 'ask')?.detail);
    if (r.status === 'blocked') toast('Purse refused a purchase', `${r.title} · ${usd(r.total)}`, r.checks.find((c) => c.outcome === 'block')?.detail);
  }
}

function toast(head, title, detail) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="app">Purse</div><b>${esc(head)}</b>${esc(title)}${detail ? `<div style="opacity:.7;margin-top:2px">${esc(detail)}</div>` : ''}`;
  $('#toasts').prepend(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 4200);
}

// ------------------------------------------------------------------ actions
function sheet(html) {
  const d = $('#sheet');
  d.innerHTML = `<div class="sheet">${html}</div>`;
  d.showModal();
  return new Promise((resolve) => {
    d.onclick = (e) => {
      const b = e.target.closest('[data-sheet]');
      if (b) { d.close(); resolve(b.dataset.sheet); }
      else if (e.target === d) { d.close(); resolve('cancel'); }
    };
  });
}

function simApproval(kind, amount) {
  return sheet(`
    <div class="sim">Sandbox simulation</div>
    <h2>${kind === 'vault' ? 'Save PayPal for Purse' : `Pay ${usd(amount)}`}</h2>
    <p>${kind === 'vault'
      ? 'In the live build this step is PayPal’s own approval page (Vault v3 setup token). You approve once; Purse stores only a payment token, never your login or card.'
      : 'In the live build this opens PayPal Checkout for a one-time order the agent can’t complete without you.'}</p>
    <div class="acct"><span>sb-buyer@personal.example.com</span><span>PayPal balance</span></div>
    <div class="acts"><button class="ghost" data-sheet="cancel">Cancel</button><button class="pp-btn" data-sheet="ok">${kind === 'vault' ? 'Agree &amp; connect' : 'Pay now'}</button></div>`);
}

function popup(url) {
  const w = window.open(url, 'paypal', 'width=480,height=720');
  return new Promise((resolve) => {
    const onMsg = (e) => { if (e.data?.purse) { window.removeEventListener('message', onMsg); resolve(e.data.purse); } };
    window.addEventListener('message', onMsg);
    const t = setInterval(() => { if (!w || w.closed) { clearInterval(t); window.removeEventListener('message', onMsg); resolve({ closed: true }); } }, 800);
  });
}

async function act(name, id, btn) {
  try {
    if (btn) btn.disabled = true;
    if (name === 'connect') {
      const r = await api.connect();
      if (state.mode === 'mock') { if ((await simApproval('vault')) === 'ok') await api.connectFinish(); }
      else await popup(r.approveUrl);
    } else if (name === 'disconnect') {
      await api.disconnect();
      toast('Purse strings cut', 'Your agent can no longer spend.', 'The PayPal payment token was deleted.');
    } else if (name === 'approve') {
      const r = await api.approve(id);
      if (r.status === 'awaiting_paypal') await checkout(r);
    } else if (name === 'checkout') {
      await checkout(state.requests.find((x) => x.id === id));
    } else if (name === 'decline') {
      await api.decline(id);
    } else if (name === 'refund') {
      await api.refund(id);
      toast('Refund sent', 'Money is on its way back to your PayPal.', null);
    } else if (name === 'sg-yes' || name === 'sg-no') {
      await api.suggestion(id, name === 'sg-yes');
    } else if (name === 'edit-rules') {
      $('#rules').innerHTML = `<div class="rules">
        <div class="block-head"><h3>House rules</h3><span class="count">plain English</span></div>
        <textarea id="rulesText">${esc(state.rules)}</textarea>
        <div class="errand-foot"><span class="engine">Purse reads these, then enforces them in code.</span>
        <span><button class="link" data-act="cancel-rules">Cancel</button> <button class="primary small" data-act="save-rules">Save rules</button></span></div></div>`;
      $('#rulesText').focus();
    } else if (name === 'save-rules') {
      const text = $('#rulesText').value;
      btn.textContent = 'Reading…';
      $('#rules').innerHTML = '';
      render(await api.setRules(text));
    } else if (name === 'cancel-rules') {
      $('#rules').innerHTML = '';
      render(state);
    }
    if (api.kind === 'server') render(await api.state());
  } catch (e) {
    toast('Something went wrong', e.message, null);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function checkout(r) {
  if (state.mode === 'mock') {
    if ((await simApproval('order', r.total)) === 'ok') await api.complete(r.orderId);
  } else {
    await popup(r.approveUrl);
  }
}

async function runErrand(task) {
  if (busy || !task.trim()) return;
  busy = true;
  $('#go').disabled = true;
  const feed = $('#feed');
  if ($('.empty', feed)) feed.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'thinking';
  t.innerHTML = '<span class="dots"><span></span><span></span><span></span></span><span>Reading the errand…</span>';
  feed.prepend(t);
  try {
    const { picks } = await api.plan(task);
    t.lastChild.textContent = picks.length ? `Found ${picks.length} thing${picks.length > 1 ? 's' : ''} to buy. Asking Purse for each…` : 'Nothing in the stores matches that errand.';
    await sleep(700);
    for (const p of picks) {
      await api.request({ agent: 'Pantry agent', sku: p.item.sku, merchant: p.item.merchant, title: p.item.title, price: p.item.price, qty: p.qty, category: p.item.category, reason: p.why });
      if (api.kind === 'server') render(await api.state());
      await sleep(900);
    }
    t.remove();
    if (!picks.length) toast('Nothing to buy', 'Try one of the example errands.', null);
  } catch (e) {
    t.remove();
    toast('Agent error', e.message, null);
  } finally {
    busy = false;
    $('#go').disabled = false;
    render(state);
  }
}

// ------------------------------------------------------------------ boot
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) act(b.dataset.act, b.dataset.id, b);
});

$('#presets').innerHTML = PRESETS.map((p, i) => `<button type="button" class="chip" data-preset="${i}">${esc(p.label)}</button>`).join('');
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (b) { $('#task').value = PRESETS[b.dataset.preset].text; $('#task').focus(); }
});
$('#errand').addEventListener('submit', (e) => { e.preventDefault(); runErrand($('#task').value); });
$('#task').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runErrand($('#task').value); } });
$('#reset').addEventListener('click', async () => { seen.clear(); drawn.clear(); state = null; render(await api.reset()); });
$('#mcpBtn').addEventListener('click', () => sheet(`
  <h2>Bring your own agent</h2>
  <p>Purse ships an MCP server. Any MCP client — Claude Desktop, Cursor, an Agent Toolkit app — gets four tools: <span class="mono">purse_status</span>, <span class="mono">browse_catalog</span>, <span class="mono">request_purchase</span>, <span class="mono">get_purchase</span>. It never receives PayPal credentials.</p>
  <pre>{
  "mcpServers": {
    "purse": {
      "command": "node",
      "args": ["/path/to/purse/mcp.js"],
      "env": { "PURSE_URL": "http://localhost:8787",
               "PURSE_AGENT_NAME": "Claude" }
    }
  }
}</pre>
  <p style="font-size:13px">Requests from that agent appear on this page live, with the same rules and the same approvals.</p>
  <div class="acts"><button class="primary" data-sheet="ok">Done</button></div>`));

(async () => {
  try { api = await serverApi(); } catch { api = await localApi(); }
  render(await api.state());
  window.addEventListener('message', async (e) => { if (e.data?.purse && api.kind === 'server') render(await api.state()); });
})();
