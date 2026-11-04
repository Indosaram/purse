// Shared category vocabulary. Used by the heuristic compiler, the item
// classifier, and to validate whatever an LLM returns.

export const CATEGORIES = {
  groceries:     { label: 'Groceries',      words: ['grocery', 'groceries', 'food', 'produce', 'milk', 'eggs', 'bread', 'coffee', 'rice', 'pasta', 'fruit', 'banana', 'apple', 'vegetable', 'snack', 'cereal', 'oat', 'cheese', 'yogurt', 'butter', 'tea', 'olive oil', 'tomato'] },
  household:     { label: 'Household',      words: ['household', 'home', 'cleaning', 'paper towel', 'toilet paper', 'tissue', 'detergent', 'dish soap', 'soap', 'sponge', 'trash bag', 'bin bag', 'laundry', 'light bulb', 'battery', 'batteries', 'foil', 'wrap'] },
  pharmacy:      { label: 'Pharmacy',       words: ['pharmacy', 'medicine', 'medication', 'vitamin', 'ibuprofen', 'bandage', 'toothpaste', 'shampoo', 'sunscreen', 'health'] },
  baby:          { label: 'Baby',           words: ['baby', 'diaper', 'nappy', 'wipes', 'formula'] },
  pet:           { label: 'Pet',            words: ['pet', 'dog', 'cat', 'kibble', 'litter'] },
  alcohol:       { label: 'Alcohol',        words: ['alcohol', 'wine', 'beer', 'vodka', 'whisky', 'whiskey', 'sake', 'liquor', 'spirits', 'champagne', 'prosecco', 'cider', 'gin', 'rum'] },
  tobacco:       { label: 'Tobacco',        words: ['tobacco', 'cigarette', 'cigar', 'vape', 'nicotine'] },
  gift_cards:    { label: 'Gift cards',     words: ['gift card', 'gift cards', 'giftcard', 'voucher', 'prepaid card'] },
  electronics:   { label: 'Electronics',    words: ['electronics', 'electronic', 'gadget', 'vacuum', 'headphone', 'earbuds', 'charger', 'cable', 'phone', 'laptop', 'tablet', 'speaker', 'camera', 'appliance', 'kettle', 'blender'] },
  clothing:      { label: 'Clothing',       words: ['clothing', 'clothes', 'shirt', 'jacket', 'shoes', 'socks', 'dress', 'apparel'] },
  travel:        { label: 'Travel',         words: ['travel', 'flight', 'hotel', 'train', 'ticket', 'rideshare', 'taxi'] },
  subscriptions: { label: 'Subscriptions',  words: ['subscription', 'subscriptions', 'membership', 'recurring', 'trial', 'plan'] },
  digital:       { label: 'Digital goods',  words: ['digital', 'in-app', 'game credit', 'coins', 'gems', 'download', 'ebook', 'app'] },
  toys:          { label: 'Toys & games',   words: ['toy', 'toys', 'lego', 'board game', 'puzzle'] },
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);

export function labelOf(cat) {
  return CATEGORIES[cat]?.label || cat;
}

// Map a free-text phrase ("gift cards", "booze", "anything electronic") to
// zero or more category keys.
export function phraseToCategories(phrase) {
  const p = ` ${String(phrase).toLowerCase()} `;
  const extra = { booze: 'alcohol', liquor: 'alcohol', smokes: 'tobacco', gadgets: 'electronics', 'stuff for the house': 'household', cleaning: 'household' };
  const hits = new Set();
  for (const [k, v] of Object.entries(extra)) if (p.includes(k)) hits.add(v);
  for (const key of CATEGORY_KEYS) {
    if (p.includes(key.replace('_', ' '))) hits.add(key);
    for (const w of CATEGORIES[key].words) {
      // whole-word-ish match so "app" does not match "apple"
      const re = new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?([^a-z]|$)`);
      if (re.test(p)) { hits.add(key); break; }
    }
  }
  return [...hits];
}

// Best single category for a product title.
export function classifyTitle(title) {
  const cats = phraseToCategories(title);
  // Restricted categories win: a "wine gift set" is alcohol, not groceries.
  for (const strict of ['alcohol', 'tobacco', 'gift_cards', 'subscriptions', 'electronics']) {
    if (cats.includes(strict)) return strict;
  }
  return cats[0] || 'other';
}
