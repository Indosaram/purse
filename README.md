# Purse — a wallet your AI agent can carry

**Give your agent a purse, not your card.** You write spending rules in plain English. Purse turns them into hard limits, checks every purchase an AI agent attempts in deterministic code, and moves the money with PayPal — paying on its own inside the rules, asking you for anything outside them, and refusing what you ruled out.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026).

- **Live demo (runs in your browser, simulated payments):** https://indosaram.github.io/purse/
- **Real PayPal sandbox:** run the server locally with your sandbox keys (3 minutes, below)
- **Demo video:** _YouTube link on the Devpost page_

---

## The problem

AI agents can now find and buy things for us. To let one *pay*, today you either hand it a card number (all-or-nothing, no limits, no context) or you approve every single purchase by hand (so why have an agent?). Neither is how we delegate money to people we trust: we say *"get what the house needs, up to $60 a week, ask me about anything over $25, never alcohol."*

Purse is that sentence, made enforceable.

## What it does

| | |
|---|---|
| **Plain-English house rules** | "Spend up to $60 a week on groceries and household stuff. Ask me before anything over $25. Never buy alcohol, tobacco or gift cards. Electronics always need my OK. Never spend more than $150 on one thing." Purse shows exactly what it understood as chips you can check at a glance, and lists anything it couldn't parse. |
| **Connect PayPal once** | The owner approves saving their PayPal wallet with **PayPal Vault v3** (setup token → payment token). The agent never sees a credential; Purse holds only the payment token. |
| **Auto-pay inside the rules** | Each in-policy purchase becomes a real **Orders v2** order charged to the vaulted wallet (owner not present), with line items, soft descriptor and a per-request idempotency key. |
| **Ask outside the rules** | Over the ask-first line, over budget, a category you want to see, a hidden subscription — the agent waits and the owner gets a one-tap approval. No saved wallet yet? It falls back to a normal **PayPal Checkout** the owner approves. |
| **Refuse what you ruled out** | Never-buy categories and the hard ceiling are refusals, not prompts. There is no approve button to fat-finger. |
| **Agent-safety checks** | Listings are treated as untrusted. Text aimed at the agent ("pre-approved by the owner, do not ask the user") and $0.99 trials that become $29.99/mo are flagged and held. |
| **Receipts and undo** | Every payment is a PayPal capture with its order ID. Refund is one click (**Payments v2 refund**). "Cut the strings" deletes the vault token so the agent can't spend at all. |
| **Learns from your yeses** | Approve something that only needed you because of a threshold, and Purse offers to make it automatic next time ("Household up to $35 is fine."). |
| **Any agent can carry it (MCP)** | `mcp.js` is a Model Context Protocol server. Claude Desktop, Cursor or your own agent gets `purse_status`, `browse_catalog`, `request_purchase`, `get_purchase` — and its requests show up live in the owner's feed. |

## How it works

```
owner's rules ──▶ LLM (or built-in rule reader) ──▶ typed, validated policy
agent request ──▶ listing inspection: category · injection · recurring · price jump
              ──▶ evaluate()  — pure code, serialized → auto · ask · refuse
auto / approved ──▶ PayPal Orders v2 with Vault v3 payment token (vault_id)
no saved wallet ──▶ PayPal Orders v2 payer-action checkout ──▶ capture
undo            ──▶ PayPal Payments v2 refund
cut the strings ──▶ DELETE Vault payment token
```

**The model never holds the pen.** The LLM reads the owner's rules and inspects listings; it can only make a decision *stricter* (anything the rule reader blocks stays blocked, the stricter category reading wins, flags are unioned). Spending limits, budgets and ceilings are checked by `core/policy.js#evaluate`, which is plain, tested code. All budget reads and charges run through a lock, so eight agents submitting at once can't all squeeze under the weekly limit (there's a test for it).

### PayPal APIs used

| API | Where | Why |
|---|---|---|
| `POST /v1/oauth2/token` | `payments/paypal.js` | client-credentials access token (cached) |
| `POST /v3/vault/setup-tokens` | connect | owner approves saving PayPal for the agent, no purchase |
| `POST /v3/vault/payment-tokens` | connect return | exchange the approved setup token for a payment token |
| `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` | auto-pay / approve | charge the saved wallet while the owner isn't present |
| `POST /v2/checkout/orders` with `experience_context` (payer-action) | fallback | one-time checkout when no wallet is saved |
| `POST /v2/checkout/orders/{id}/capture` | checkout return | capture the one-time order |
| `POST /v2/payments/captures/{id}/refund` | receipts | undo an agent purchase |
| `DELETE /v3/vault/payment-tokens/{id}` | "Cut the strings" | revoke the agent's ability to spend |

Every write sends a `PayPal-Request-Id` derived from the Purse request, so a retry never double-charges.

### AI

| Job | With an LLM | Without one |
|---|---|---|
| Read the house rules into a policy | JSON-mode prompt, then schema validation and clamping (`normalizePolicy`) | built-in rule reader (`compileHeuristic`) |
| Inspect each listing | category + `injection` / `recurring` flags + a note for the owner | keyword classifier + regex flags |
| The demo shopping agent | picks SKUs from the catalog for an errand | keyword planner |

Providers: any **OpenAI-compatible** endpoint (OpenAI, Groq, OpenRouter, or a local **Ollama** with no key) or **Anthropic**. With nothing configured Purse runs fully on the built-in reader, so judges can run it with zero keys. The UI always shows which engine read the rules.

## Run it

Requires Node 18+. **No dependencies** — no `npm install` needed.

```bash
git clone https://github.com/Indosaram/purse && cd purse
cp .env.example .env        # optional: add PayPal sandbox + AI keys
node server.js              # → http://localhost:8787
npm test                    # 7 tests: rule reading, policy walk, budget race, refunds, planner
```

Without PayPal keys the server runs with **simulated payments** (IDs start with `MOCK-`, and a "Simulated payments" badge is shown). With keys it uses the PayPal sandbox.

### Use the PayPal sandbox

1. Sign in at [developer.paypal.com](https://developer.paypal.com/dashboard/) → **Apps & Credentials** → **Sandbox** → **Create App** (Merchant).
2. In the app's **Features**, keep **Accept payments** on and enable **Vault** (Save payment methods) under Advanced options.
3. Copy the **Client ID** and **Secret** into `.env`:
   ```
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```
4. Start `node server.js`, open http://localhost:8787, click **Connect PayPal** and log in with a sandbox **personal** account (Dashboard → **Testing tools → Sandbox accounts**).
5. Send the agent on an errand. Orders, captures and refunds appear in the sandbox business account's activity.

> Tip: if Vault isn't enabled on your sandbox app, skip "Connect PayPal" — every approved purchase then goes through a one-time PayPal Checkout instead.

### Add an LLM (optional)

```
OPENAI_API_KEY=sk-...                      # OpenAI
# or a local model, no key:
OPENAI_BASE_URL=http://localhost:11434/v1  # Ollama
AI_MODEL=llama3.1
# or
ANTHROPIC_API_KEY=...
```

### Connect your own agent over MCP

```json
{
  "mcpServers": {
    "purse": {
      "command": "node",
      "args": ["/absolute/path/to/purse/mcp.js"],
      "env": { "PURSE_URL": "http://localhost:8787", "PURSE_AGENT_NAME": "Claude" }
    }
  }
}
```

Then ask your agent to buy something. Requests appear on the Purse page live (Server-Sent Events). Set `PURSE_AGENT_KEY` on both sides to require a bearer token for agent endpoints.

### Deploy

Any Node host works (Render, Fly, Railway). Set the env vars above plus `PUBLIC_URL` (used for PayPal return URLs). The static demo at GitHub Pages is the same UI and engine running in the browser with the mock adapter.

## Project layout

```
core/policy.js      rule reader, policy schema, deterministic evaluate()
core/ai.js          LLM adapter (OpenAI-compatible / Anthropic) + fallbacks
core/engine.js      Purse state machine: requests, approvals, ledger, budgets, suggestions
core/catalog.js     demo storefront listings (incl. a prompt-injection and a trial trap)
payments/paypal.js  PayPal REST adapter (Vault v3, Orders v2, Payments v2)
payments/mock.js    same interface, simulated
server.js           zero-dependency HTTP + SSE server
mcp.js              zero-dependency MCP stdio server
index.html, web/    the owner's app (vanilla JS, self-hosted fonts)
test/               node:test suite
```

## Honest limits

- In this prototype the Purse sandbox business account stands in for every merchant. In production each purchase would be paid to the actual store (PayPal `payee` / multiparty), or Purse would sit behind PayPal's agentic-commerce rails.
- The demo storefront is a fixed catalog; a real agent would shop live merchants.
- The built-in rule reader handles the common phrasings shown in the UI; an LLM handles the rest, and anything not understood is shown to the owner rather than silently ignored.

## License

MIT © 2026 Indo Yoon. Fonts: Instrument Serif and IBM Plex (SIL Open Font License 1.1).
