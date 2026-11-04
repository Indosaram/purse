// Mock adapter with the same interface and PayPal-shaped IDs. Used for the
// static GitHub Pages demo, for tests, and when no sandbox keys are set.
// Nothing here pretends to be PayPal: IDs are prefixed MOCK- and the UI shows
// a "Simulated" badge whenever this adapter is active.

const ALPHA = 'ABCDEFGHJKLMNPRSTUVWXY0123456789';
const pid = (n = 17) => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');

export class MockPayments {
  constructor({ approveBase = '#mock-paypal' } = {}) {
    this.mode = 'mock';
    this.approveBase = approveBase;
    this.orders = new Map();
    this.tokens = new Set();
  }

  async connectStart() {
    const id = `MOCK-${pid(12)}`;
    return { setupTokenId: id, approveUrl: `${this.approveBase}?setup=${id}` };
  }

  async connectFinish(setupTokenId) {
    const token = `mock_${pid(7).toLowerCase()}`;
    this.tokens.add(token);
    return { paymentTokenId: token, customerId: `customer_${pid(10)}`, payerEmail: 'sb-buyer@personal.example.com', setupTokenId };
  }

  async deleteToken(id) { this.tokens.delete(id); }

  async chargeSaved({ amount }) {
    await new Promise((r) => setTimeout(r, 250));
    const orderId = `MOCK-${pid()}`;
    const captureId = `MOCK-${pid()}`;
    this.orders.set(orderId, { amount, captureId, status: 'COMPLETED' });
    return { orderId, captureId, status: 'COMPLETED' };
  }

  async createCheckout({ amount }) {
    const orderId = `MOCK-${pid()}`;
    this.orders.set(orderId, { amount, status: 'PAYER_ACTION_REQUIRED' });
    return { orderId, approveUrl: `${this.approveBase}?order=${orderId}` };
  }

  async captureCheckout(orderId) {
    const captureId = `MOCK-${pid()}`;
    return { captureId, status: 'COMPLETED' };
  }

  async refund() {
    await new Promise((r) => setTimeout(r, 200));
    return { refundId: `MOCK-${pid()}`, status: 'COMPLETED' };
  }
}
