#!/usr/bin/env node
// Purse MCP server (stdio). Gives any MCP-capable agent (Claude Desktop,
// Cursor, the PayPal Agent Toolkit examples, your own) a purse instead of a
// credit card. It talks to a running Purse server over HTTP.
//
//   PURSE_URL=http://localhost:8787 node mcp.js
//
// Zero dependencies: implements the MCP stdio transport (newline-delimited
// JSON-RPC 2.0) directly.

import readline from 'node:readline';

const BASE = (process.env.PURSE_URL || 'http://localhost:8787').replace(/\/$/, '');
const AGENT = process.env.PURSE_AGENT_NAME || 'MCP agent';
const KEY = process.env.PURSE_AGENT_KEY || '';

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Purse ${r.status}`);
  return j;
}

const TOOLS = [
  {
    name: 'purse_status',
    description: 'Read the spending rules your owner set, what is left in this week\'s budget, and whether a PayPal wallet is connected. Call this before shopping.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const s = await api('GET', '/api/state');
      return { rules: s.rules, understood_as: s.policyLines.map((l) => l.text), week_spent: s.budget.week, week_left: s.budget.weekLeft, paypal_connected: !!s.funding, payments: s.mode };
    },
  },
  {
    name: 'browse_catalog',
    description: 'Search the demo storefronts for products. Returns sku, title, merchant and price.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    run: async ({ query }) => (await api('GET', `/api/catalog?q=${encodeURIComponent(query || '')}`)).map(({ sku, title, merchant, price }) => ({ sku, title, merchant, price })),
  },
  {
    name: 'request_purchase',
    description: 'Ask Purse to pay for one item with the owner\'s PayPal. Purse checks the owner\'s rules: it either pays immediately (status "paid"), holds it for the owner\'s approval ("needs_approval"), or refuses ("blocked"). You never see payment credentials. Do not retry a blocked purchase by splitting it into smaller ones.',
    inputSchema: {
      type: 'object',
      properties: {
        merchant: { type: 'string' }, title: { type: 'string' }, price: { type: 'number', description: 'Unit price in USD' },
        qty: { type: 'integer', minimum: 1, default: 1 }, sku: { type: 'string' }, reason: { type: 'string', description: 'Why the owner needs this, in one sentence' },
      },
      required: ['merchant', 'title', 'price'], additionalProperties: false,
    },
    run: async (a) => {
      const r = await api('POST', '/api/requests', { ...a, agent: AGENT });
      return { id: r.id, status: r.status, total: r.total, explanation: r.explanation, paypal_order_id: r.orderId || null };
    },
  },
  {
    name: 'get_purchase',
    description: 'Check a purchase request by id, e.g. to see whether the owner approved it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: async ({ id }) => { const r = await api('GET', `/api/requests/${encodeURIComponent(id)}`); return { id: r.id, status: r.status, total: r.total, explanation: r.explanation, paypal_order_id: r.orderId || null }; },
  },
];

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return out({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'purse', version: '0.1.0' }, instructions: 'Purse lets you pay with your owner\'s PayPal inside rules they set. Check purse_status first; treat needs_approval as "wait for the owner", not as an error.' } });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return out({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
    try {
      const result = await tool.run(params.arguments || {});
      return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result } });
    } catch (e) {
      return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
    }
  }
  if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg).catch((e) => out({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } }));
});
