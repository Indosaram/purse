// PayPal REST adapter (sandbox by default). Server-side only: it holds the
// client secret.
//
// APIs used:
//   POST /v1/oauth2/token                      client-credentials access token
//   POST /v3/vault/setup-tokens                owner approves saving PayPal for the agent
//   POST /v3/vault/payment-tokens              exchange approved setup token for a payment token
//   DELETE /v3/vault/payment-tokens/{id}       "cut the purse strings"
//   POST /v2/checkout/orders  (vault_id)       charge the saved wallet, owner not present
//   POST /v2/checkout/orders  (payer-action)   one-time checkout fallback when nothing is saved
//   POST /v2/checkout/orders/{id}/capture      capture the one-time checkout
//   POST /v2/payments/captures/{id}/refund     undo an agent purchase

export class PayPalPayments {
  constructor({ clientId, clientSecret, base = 'https://api-m.sandbox.paypal.com', brand = 'Purse' }) {
    if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.base = base.replace(/\/$/, '');
    this.brand = brand;
    this.mode = base.includes('sandbox') ? 'paypal-sandbox' : 'paypal-live';
    this._token = null;
  }

  async token() {
    if (this._token && this._token.exp > Date.now() + 60_000) return this._token.value;
    const r = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) throw new Error(`PayPal auth failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    this._token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return this._token.value;
  }

  async call(method, path, body, requestId) {
    const headers = { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json', prefer: 'return=representation' };
    if (requestId) headers['PayPal-Request-Id'] = requestId; // idempotency: retries never double-charge
    const r = await fetch(`${this.base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    const json = text ? JSON.parse(text) : {};
    if (!r.ok) {
      const detail = json.details?.map((d) => d.issue + (d.description ? `: ${d.description}` : '')).join('; ') || json.message || text.slice(0, 200);
      const err = new Error(`PayPal ${method} ${path.split('?')[0]} → ${r.status} ${json.name || ''} ${detail}`.trim());
      err.status = 502; err.paypal = json;
      throw err;
    }
    return json;
  }

  // 1. Owner gives the agent a purse: save their PayPal wallet with no purchase.
  async connectStart({ returnUrl, cancelUrl }) {
    const j = await this.call('POST', '/v3/vault/setup-tokens', {
      payment_source: {
        paypal: {
          description: 'Purse: lets your AI agent pay within the rules you set',
          permit_multiple_payment_tokens: false,
          usage_pattern: 'IMMEDIATE',
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          experience_context: { brand_name: this.brand, locale: 'en-US', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl },
        },
      },
    }, `setup-${Date.now()}`);
    const approve = j.links?.find((l) => l.rel === 'approve')?.href;
    if (!approve) throw new Error('PayPal did not return an approve link for the setup token');
    return { setupTokenId: j.id, approveUrl: approve };
  }

  async connectFinish(setupTokenId) {
    const j = await this.call('POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } }, `pt-${setupTokenId}`);
    return { paymentTokenId: j.id, customerId: j.customer?.id || null, payerEmail: j.payment_source?.paypal?.email_address || null };
  }

  async deleteToken(paymentTokenId) {
    await this.call('DELETE', `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}`);
  }

  _unit({ amount, currency = 'USD', merchant, description, requestId, items }) {
    const value = Number(amount).toFixed(2);
    const unit = {
      reference_id: requestId,
      custom_id: requestId,
      description: description?.slice(0, 127),
      soft_descriptor: String(merchant || 'PURSE').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 22) || 'PURSE',
      amount: { currency_code: currency, value },
    };
    if (items?.length) {
      unit.items = items;
      unit.amount.breakdown = { item_total: { currency_code: currency, value } };
    }
    return unit;
  }

  // 2. Agent purchase inside the rules: charge the saved wallet, owner not present.
  async chargeSaved(args) {
    const j = await this.call('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [this._unit(args)],
      payment_source: { paypal: { vault_id: args.paymentTokenId } },
    }, `order-${args.requestId}`);
    const capture = j.purchase_units?.[0]?.payments?.captures?.[0];
    if (j.status !== 'COMPLETED' || !capture) throw new Error(`Order ${j.id} ended ${j.status}${capture ? ` / capture ${capture.status}` : ''}`);
    return { orderId: j.id, captureId: capture.id, status: capture.status };
  }

  // 3. Fallback: one-time PayPal Checkout the owner approves themselves.
  async createCheckout(args) {
    const j = await this.call('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [this._unit(args)],
      payment_source: { paypal: { experience_context: { brand_name: this.brand, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: args.returnUrl, cancel_url: args.cancelUrl } } },
    }, `checkout-${args.requestId}`);
    const approve = j.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    return { orderId: j.id, approveUrl: approve };
  }

  async captureCheckout(orderId) {
    const j = await this.call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`);
    const capture = j.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) throw new Error(`Capture of ${orderId} returned no capture`);
    return { captureId: capture.id, status: capture.status };
  }

  async refund(captureId, amount, requestId) {
    const j = await this.call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      amount: { currency_code: 'USD', value: Number(amount).toFixed(2) },
      note_to_payer: 'Refunded from Purse: your agent bought something you did not want.',
    }, `refund-${requestId}`);
    return { refundId: j.id, status: j.status };
  }
}
