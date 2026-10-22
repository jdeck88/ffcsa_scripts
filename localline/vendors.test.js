const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateSummaryPDF, vendorReportTitle } = require('./vendors');

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
