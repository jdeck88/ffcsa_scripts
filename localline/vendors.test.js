process.env.VENDOR_COST_CORRECTIONS_FILE = require('path').join(__dirname, 'vendor_cost_corrections.fixture.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateSummaryPDF, vendorReportTitle, groupByCategoryWithSubtotals } = require('./vendors');

test('matching Red Ranger chickens combine across saved category labels', () => {
  const product = 'ea, Red Ranger Roasting Chicken, Medium - Medium, 4.01 - 5.00 lbs';
  const line = { productId: '123', product, packageName: 'Medium, 4.01 - 5.00 lbs',
    quantity: 1, price: 24.37, totalPrice: 24.37 };
  const items = [
    { ...line, category: 'Pasture - raised Poultry, Specials and Bundles' },
    { ...line, category: 'Pasture - raised Poultry' }
  ];
  const expected = [
    [product, 2, 24.37, '48.74'],
    ['', '', ' Pasture - raised Poultry', '48.74']
  ];
  assert.deepEqual(groupByCategoryWithSubtotals(items), expected);
  assert.deepEqual(groupByCategoryWithSubtotals([...items].reverse()), expected);
});

test('category merging preserves distinct products, packages, prices and bundle sections', () => {
  const line = { productId: '123', product: 'Red Ranger Chicken - Medium', packageName: 'Medium',
    quantity: 1, price: 24.37, totalPrice: 24.37, category: 'Poultry' };
  const items = [
    line,
    { ...line, category: 'Poultry, Specials and Bundles', price: 20, totalPrice: 20 },
    { ...line, product: 'Red Ranger Chicken - Large', packageName: 'Large' },
    { ...line, productId: '456' },
    { ...line, product: 'Box content: Red Ranger Chicken - Medium', category: 'Box Contents - Bundle A' },
    { ...line, product: 'Box content: Red Ranger Chicken - Medium', category: 'Box Contents - Bundle B' }
  ];
  const rows = groupByCategoryWithSubtotals(items);
  const products = rows.filter(row => row[0]);
  assert.equal(products.length, 6);
  assert.ok(products.every(row => row[1] === 1));
  assert.equal(products.reduce((sum, row) => sum + Number(row[3]), 0).toFixed(2), '141.85');
});

test('report titles use the fulfillment date in the fixed format', () => {
  assert.equal(vendorReportTitle('2026-10-24'), 'FFCSA Reports: All Vendor Data for 2026-10-24');
});

// Poppler lets this regression check the actual printed contents and page references.
const hasPdfText = spawnSync('pdftotext', ['-v']).status === 0;
test('PDF contents reflect actual deliveries, withheld reports and multipage order sheets', { skip: !hasPdfText }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffcsa-vendor-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orders = {};
  for (let i = 0; i < 30; i++) {
    const vendor = `Farm ${String(i).padStart(2, '0')}`;
    orders[vendor] = Array.from({ length: i === 0 ? 100 : 1 }, (_, j) => ({
      productId: j, product: `Vegetable ${j}`, category: 'Produce', quantity: 2,
      price: 3, totalPrice: 6, fulfillmentDate: '2026-10-24'
    }));
  }
  const output = path.join(dir, 'vendors.pdf');
  const options = {
    title: vendorReportTitle('2026-10-24'),
    delivery: { sent: ['Farm 00'], failed: [{ vendor: 'Farm 01', reason: 'No vendor email address on file' }] },
    blockedVendors: ['Withheld Farm']
  };
  await generateSummaryPDF(orders, output, null, 'Withheld Farm needs a corrected price.', options);
  const extract = () => {
    const result = spawnSync('pdftotext', ['-layout', output, '-'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\f').filter(page => page.trim());
  };
  const pages = extract();
  assert.match(pages[0], /FFCSA Reports: All Vendor Data for\s+2026-10-24/);
  assert.match(pages[1], /Contents \(continued\)/);
  const contents = pages.slice(0, 2).join('\n');
  assert.match(contents, /Farm 00\s+Emailed\s+\d+/);
  assert.match(contents, /Farm 01\s+\d+/);
  assert.match(contents, /Withheld Farm\s+—/);
  assert.match(contents, /have been emailed directly to the vendors/);
  assert.doesNotMatch(pages.join('\n'), /Reports not emailed|No vendor email address on file/);
  assert.match(pages[2], /Reports needing review/);
  assert.match(pages[2], /Withheld Farm needs a corrected price/);
  for (const vendor of Object.keys(orders)) {
    const match = contents.match(new RegExp(`${vendor}\\s+(?:Emailed\\s+)?(\\d+)`));
    assert.ok(match, `Contents entry for ${vendor}`);
    assert.match(pages[Number(match[1]) - 1], new RegExp(`${vendor}\\s+Product`));
  }
  for (let i = 0; i < pages.length; i++) assert.ok(pages[i].includes(`${i + 1} / ${pages.length}`));

  await generateSummaryPDF(orders, output, null, '', { ...options, testing: true });
  const previewPages = extract();
  assert.doesNotMatch(previewPages.slice(0, 2).join('\n'), /Farm 00\s+Emailed/);
  assert.match(previewPages[2], /Farm 00\s+Product/);
  assert.doesNotMatch(previewPages.join('\n'), /Reports not emailed/);
});
