process.env.VENDOR_COST_CORRECTIONS_FILE = require('path').join(__dirname, 'vendor_cost_corrections.fixture.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveVendorCost } = require('./vendor_cost_corrections');

const rule = {
  productId: 123, packageId: 456, packageName: '1 lb', vendor: 'Example Farm',
  erroneousCents: 413, costCents: 275, startAt: '2026-10-30T00:00:00Z',
  endAt: '2026-11-02T20:00:00Z', chargeType: 'package', chargeUnits: [],
  actionId: 12, revisionId: 34,
};
const entry = {
  id: 1, product: 123, package_name: '1 lb', vendor_name: 'Example Farm',
  charge_type: 'package', created_at: '2026-10-30T20:00:00-04:00',
};
const price = (overrides = {}, saved = 4.13, rules = [rule]) => resolveVendorCost({ ...entry, ...overrides }, saved, rules);

test('reviewed incident replaces vendor Cost only, with publication provenance', () => {
  const result = price();
  assert.equal(result.price, 2.75);
  assert.equal(result.correction.savedUnitPrice, 4.13);
  assert.equal(result.correction.actionId, 12);
  assert.equal(entry.package_unit_price, undefined);
});

test('legitimate earlier/later prices, zero, unaffected products and corrected costs survive', () => {
  for (const overrides of [{ created_at: '2026-10-29T00:00:00Z' }, { created_at: rule.endAt }, { product: 789 }]) {
    assert.deepEqual(price(overrides), { price: 4.13, correction: null });
  }
  assert.equal(price({}, 0).price, 0);
  assert.equal(price({}, 2.75).price, 2.75);
  assert.equal(price({ product_package: 456, package_name: 'renamed' }).price, 2.75);
  assert.throws(() => price({ product_package: 999 }), /mapping/);
});

test('ambiguous timestamps, mappings, vendors and unsupported units fail closed', () => {
  for (const overrides of [{ created_at: null }, { created_at: '2026-10-31T12:00:00' },
    { vendor_name: 'Different Farm' }, { charge_type: 'weight' },
    { created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-31T00:00:00Z' }]) {
    assert.throws(() => price(overrides), /needs review/);
  }
  assert.throws(() => price({}, 4.13, [rule, { ...rule, packageId: 457 }]), /ambiguous/);
  assert.throws(() => price({}, 4.13, [{ ...rule, holdReason: 'Unverified repair' }]), /Unverified repair/);
});

test('successive frozen costs use their own time intervals, not the latest cost', () => {
  const boundary = '2026-11-01T00:00:00Z';
  const rules = [{ ...rule, endAt: boundary }, { ...rule, startAt: boundary, costCents: 300 }];
  assert.equal(price({}, 4.13, rules).price, 2.75);
  assert.equal(price({ created_at: boundary }, 4.13, rules).price, 3);
});

test('weight restoration requires the unchanged, verified charge unit', () => {
  const rules = [{ ...rule, chargeType: 'weight', chargeUnits: ['lb', 'pound'] }];
  assert.equal(price({ charge_type: 'weight', charge_unit: 'lb' }, 4.13, rules).price, 2.75);
  assert.throws(() => price({ charge_type: 'weight', charge_unit: 'kg' }, 4.13, rules), /weight unit/);
});

test('verified vendor transitions preserve the saved supplier without accepting unrelated vendors', () => {
  const rules = [{ ...rule, verifiedVendors: ['Example Farm', 'New Farm'] }];
  assert.equal(price({ vendor_name: 'New Farm' }, 4.13, rules).price, 2.75);
  assert.throws(() => price({ vendor_name: 'Unrelated Farm' }, 4.13, rules), /vendor/);
});

test('incident ledger has unambiguous package publication windows and cents-based costs', () => {
  const { rules } = require('./vendor_cost_corrections.fixture.json');
  const groups = new Map();
  for (const r of rules) {
    assert.ok(Number.isSafeInteger(r.productId) && Number.isSafeInteger(r.packageId));
    assert.ok(Number.isSafeInteger(r.costCents) && r.costCents >= 0);
    assert.ok(Number.isSafeInteger(r.erroneousCents) && r.erroneousCents > r.costCents);
    assert.ok(Number.isFinite(Date.parse(r.startAt)));
    if (r.endAt) assert.ok(Date.parse(r.endAt) >= Date.parse(r.startAt));
    const key = `${r.productId}:${r.packageId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.actionId - b.actionId);
    for (let i = 1; i < group.length; i++) {
      assert.ok(group[i - 1].endAt && Date.parse(group[i - 1].endAt) <= Date.parse(group[i].startAt));
    }
  }
});
