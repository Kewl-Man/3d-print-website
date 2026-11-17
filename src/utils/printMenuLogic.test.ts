import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNtfyPayload,
  calculateOrderTotal,
  filterProducts,
  formatCurrency,
  normalizeAssetUrl,
  resolveInitialProducts,
  validateOrderInput,
  validateProductInput,
  type PrintOrder,
  type PrintProduct,
} from './printMenuLogic';

const sampleProducts: PrintProduct[] = [
  {
    id: 'cube-1',
    title: 'Articulated Infinity Cube',
    price: 4,
    category: 'Fidgets',
    description: 'Smooth folding desk fidget.',
    imageUrl: './assets/images/print_infinity_cube_1794801362371.jpg',
    inStock: true,
    colors: ['Galaxy Purple', 'Matte Black'],
    sortOrder: 0,
  },
  {
    id: 'dragon-1',
    title: 'Crystal Flexi Dragon',
    price: 8.5,
    category: 'Flexi Toys',
    description: 'Coiled multi-segment dragon.',
    imageUrl: './assets/images/print_flexi_dragon_1794801362157.jpg',
    inStock: false,
    colors: ['Silk Cyan', 'Cobalt Blue'],
    sortOrder: 1,
  },
];

test('formatCurrency formats numbers cleanly with 2 decimals', () => {
  assert.equal(formatCurrency(4), '$4.00');
  assert.equal(formatCurrency(8.5), '$8.50');
  assert.equal(formatCurrency(-2), '$0.00');
});

test('calculateOrderTotal multiplies price and quantity accurately', () => {
  assert.equal(calculateOrderTotal(4.5, 3), 13.5);
  assert.equal(calculateOrderTotal(3.33, 2), 6.66);
  assert.equal(calculateOrderTotal(5, 0), 5);
});

test('resolveInitialProducts keeps empty catalog when initialized and normalizes asset URLs', () => {
  const emptyAfterDelete = resolveInitialProducts([], sampleProducts, true);
  assert.equal(emptyAfterDelete.length, 0);

  const brandNewNull = resolveInitialProducts(null, sampleProducts, false);
  assert.equal(brandNewNull.length, 2);

  const brandNewEmptySnapshot = resolveInitialProducts([], sampleProducts, false);
  assert.equal(brandNewEmptySnapshot.length, 2);

  assert.equal(
    normalizeAssetUrl('/src/assets/images/print_infinity_cube_1794801362371.jpg'),
    './assets/images/print_infinity_cube_1794801362371.jpg'
  );
  assert.equal(
    normalizeAssetUrl('/assets/images/print_flexi_dragon_1794801362157.jpg'),
    './assets/images/print_flexi_dragon_1794801362157.jpg'
  );
});

test('filterProducts filters by category, search query, and price sorting', () => {
  assert.equal(filterProducts(sampleProducts, 'All', '').length, 2);
  assert.equal(filterProducts(sampleProducts, 'Fidgets', '').length, 1);
  assert.equal(filterProducts(sampleProducts, 'All', 'dragon')[0].id, 'dragon-1');
  assert.equal(filterProducts(sampleProducts, 'Desk Gear', '').length, 0);

  const asc = filterProducts(sampleProducts, 'All', '', 'price-asc');
  assert.deepEqual(asc.map((p) => p.id), ['cube-1', 'dragon-1']);

  const desc = filterProducts(sampleProducts, 'All', '', 'price-desc');
  assert.deepEqual(desc.map((p) => p.id), ['dragon-1', 'cube-1']);
});

test('validateOrderInput enforces required fields, Phone/Discord/Email rules, and max qty 4', () => {
  const empty = validateOrderInput({
    buyerName: '   ',
    contactMethod: 'Discord',
    contact: '',
    quantity: 1,
    productInStock: true,
  });
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.buyerName);
  assert.ok(empty.errors.contact);

  const badEmail = validateOrderInput({
    buyerName: 'Marcus',
    contactMethod: 'Email',
    contact: 'not-an-email',
    quantity: 1,
    productInStock: true,
  });
  assert.equal(badEmail.valid, false);
  assert.ok(badEmail.errors.contact);

  const badMethod = validateOrderInput({
    buyerName: 'Marcus',
    contactMethod: 'Snap',
    contact: 'marcus',
    quantity: 1,
    productInStock: true,
  });
  assert.equal(badMethod.valid, false);
  assert.ok(badMethod.errors.contactMethod);

  const overMax = validateOrderInput({
    buyerName: 'Marcus',
    contactMethod: 'Discord',
    contact: '@marcus_09',
    quantity: 5,
    productInStock: true,
  });
  assert.equal(overMax.valid, false);
  assert.equal(overMax.errors.quantity, 'gng, how much do u need? 🥀');

  const ok = validateOrderInput({
    buyerName: 'Marcus',
    contactMethod: 'Discord',
    contact: '@marcus_09',
    quantity: 4,
    productInStock: true,
  });
  assert.equal(ok.valid, true);
});

test('validateProductInput validates new catalog item fields and max lengths', () => {
  const bad = validateProductInput({
    title: '',
    price: 0,
    category: 'Unknown',
    description: '',
  });
  assert.equal(bad.valid, false);

  const good = validateProductInput({
    title: 'Gyro Ring',
    price: 5.5,
    category: 'Fidgets',
    description: 'Smooth spinning concentric rings.',
  });
  assert.equal(good.valid, true);
});

test('buildNtfyPayload formats in-person cash order cleanly', () => {
  const order: PrintOrder = {
    id: 'ORD-1042',
    productId: 'cube-1',
    productTitle: 'Articulated Infinity Cube',
    unitPrice: 4,
    colorName: 'Galaxy Purple',
    quantity: 2,
    totalPrice: 8,
    buyerName: 'Liam',
    contactMethod: 'Phone',
    contact: '555-0192',
    notes: 'Purple if possible',
    createdAt: '2026-11-15T20:00:00Z',
    status: 'Pending',
    ntfySent: true,
  };
  const payload = buildNtfyPayload(order, 'https://ntfy.sh/ziauddin-3dprints-209/');
  assert.equal(payload.url, 'https://ntfy.sh/ziauddin-3dprints-209');
  assert.equal(payload.headers.Priority, 'high');
  assert.match(payload.body, /2x Articulated Infinity Cube/);
  assert.match(payload.body, /Phone: 555-0192/);
  assert.match(payload.body, /\$8\.00 \(in person\)/);
});
