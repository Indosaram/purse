#!/usr/bin/env node
// Purse server: zero dependencies, Node 18+.
//   node server.js            → http://localhost:8787
// Uses the PayPal sandbox when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are set,
// otherwise the mock adapter (clearly labelled in the UI).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Purse } from './core/engine.js';
import { aiFromEnv } from './core/ai.js';
import { CATALOG, searchCatalog } from './core/catalog.js';
import { PayPalPayments } from './payments/paypal.js';
import { MockPayments } from './payments/mock.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8787);
const DATA = process.env.PURSE_DATA || path.join(ROOT, 'data', 'state.json');
const API_KEY = process.env.PURSE_AGENT_KEY || ''; // optional shared secret for agent endpoints

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const payments = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
  ? new PayPalPayments({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET, base: process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com' })
  : new MockPayments();

const store = {
  async load() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return null; } },
  async save(s) { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(DATA + '.tmp', DATA); },
};

const clients = new Set();
const purse = await new Purse({ payments, ai: aiFromEnv(process.env), store, onChange: (snap) => broadcast(snap) }).init();

function broadcast(snap) {
  const data = `event: state\ndata: ${JSON.stringify(snap)}\n\n`;
  for (const res of clients) res.write(data);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
const PUBLIC = [/^\/index\.html$/, /^\/web\//, /^\/core\//, /^\/payments\/mock\.js$/];

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function redirect(res, to) { res.writeHead(302, { location: to }); res.end(); }

async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e5) throw Object.assign(new Error('Body too large'), { status: 413 }); }
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function origin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function agentAuth(req) {
  if (!API_KEY) return true;
  return req.headers.authorization === `Bearer ${API_KEY}`;
}

const routes = [
  ['GET', /^\/api\/config$/, async () => ({ mode: payments.mode, ai: purse.snapshot().ai, server: true })],
  ['GET', /^\/api\/state$/, async () => purse.snapshot()],
  ['GET', /^\/api\/catalog$/, async (req, url) => searchCatalog(url.searchParams.get('q'))],
  ['POST', /^\/api\/rules$/, async (req) => purse.setRules((await body(req)).text || '')],
  ['POST', /^\/api\/funding\/connect$/, async (req) => {
    const o = origin(req);
    return purse.connectStart({ returnUrl: `${o}/paypal/vault-return`, cancelUrl: `${o}/paypal/vault-cancel` });
  }],
  ['POST', /^\/api\/funding\/finish$/, async () => purse.connectFinish()],
  ['POST', /^\/api\/funding\/disconnect$/, async () => { await purse.disconnect(); return purse.snapshot(); }],
  ['POST', /^\/api\/requests$/, async (req) => {
    if (!agentAuth(req)) throw Object.assign(new Error('Agent key required'), { status: 401 });
    return purse.requestPurchase(await body(req));
  }],
  ['GET', /^\/api\/requests\/([\w-]+)$/, async (req, url, m) => {
    const r = purse.snapshot().requests.find((x) => x.id === m[1]) || purse.state.requests.find((x) => x.id === m[1]);
    if (!r) throw Object.assign(new Error('Not found'), { status: 404 });
    return r;
  }],
  ['POST', /^\/api\/requests\/([\w-]+)\/approve$/, async (req, url, m) => {
    const o = origin(req);
    return purse.approve(m[1], { returnUrl: `${o}/paypal/order-return`, cancelUrl: `${o}/paypal/order-cancel` });
  }],
  ['POST', /^\/api\/requests\/([\w-]+)\/decline$/, async (req, url, m) => purse.decline(m[1])],
  ['POST', /^\/api\/checkout\/([\w-]+)\/complete$/, async (req, url, m) => purse.completeCheckout(m[1])],
  ['POST', /^\/api\/ledger\/([\w-]+)\/refund$/, async (req, url, m) => purse.refund(m[1])],
  ['POST', /^\/api\/suggestions\/([\w-]+)$/, async (req, url, m) => purse.applySuggestion(m[1], (await body(req)).accept !== false)],
  ['POST', /^\/api\/agent\/plan$/, async (req) => purse.planAgent(String((await body(req)).task || ''))],
  ['POST', /^\/api\/agent\/plan$/, async (req) => purse.planAgent(String((await body(req)).task || ''))],
  ['POST', /^\/api\/agent\/run$/, async (req) => { const b = await body(req); return purse.runAgent(String(b.task || ''), b.agent); }],
  ['POST', /^\/api\/reset$/, async () => purse.reset()],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(purse.snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }

    // PayPal redirects
    if (url.pathname === '/paypal/vault-return') {
      try { await purse.connectFinish(); return redirect(res, '/?connected=1'); } catch (e) { return redirect(res, `/?error=${encodeURIComponent(e.message)}`); }
    }
    if (url.pathname === '/paypal/vault-cancel') { purse.state.pendingSetup = null; await store.save(purse.state); return redirect(res, '/?cancelled=1'); }
    if (url.pathname === '/paypal/order-return') {
      try { await purse.completeCheckout(url.searchParams.get('token')); return redirect(res, '/?paid=1'); } catch (e) { return redirect(res, `/?error=${encodeURIComponent(e.message)}`); }
    }
    if (url.pathname === '/paypal/order-cancel') return redirect(res, '/?cancelled=1');

    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return send(res, 200, await fn(req, url, m));
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    // static
    const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (!PUBLIC.some((re) => re.test(p))) return send(res, 404, 'Not found');
    const file = path.join(ROOT, path.normalize(p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Purse on http://localhost:${PORT}`);
  console.log(`  payments: ${payments.mode}${payments.mode === 'mock' ? '  (set PAYPAL_CLIENT_ID/SECRET for the PayPal sandbox)' : ''}`);
  console.log(`  ai:       ${purse.snapshot().ai}`);
  console.log(`  catalog:  ${CATALOG.length} demo listings`);
});
