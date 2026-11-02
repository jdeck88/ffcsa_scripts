const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Production prices stay outside this public repository. Install the reviewed
// ledger with the deployment; never silently omit corrections when it is missing.
const ledgerPath = process.env.VENDOR_COST_CORRECTIONS_FILE || path.join(__dirname, 'data', 'vendor_cost_corrections.private.json');
if (!fs.existsSync(ledgerPath)) throw new Error('The reviewed vendor Cost correction ledger is missing. Restore it from the private deployment backup before generating reports.');
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
if (ledger.version !== 1 || !Array.isArray(ledger.rules) || !ledger.rules.length) throw new Error('The vendor Cost correction ledger is invalid or empty; reports are blocked.');

// This ledger records reviewed publication inputs and verified repair receipts.
// It is not a lookup of today's catalog costs or markups.
const PRICING_BASIS = 'order-vendor-cost-v2-' + crypto.createHash('sha256')
  .update(JSON.stringify(ledger)).digest('hex').slice(0, 12);
const id = value => String(value?.id ?? value ?? '');
const norm = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
  ? Date.parse(value) : NaN;
const byProduct = new Map();
for (const rule of ledger.rules) {
  if (!byProduct.has(id(rule.productId))) byProduct.set(id(rule.productId), []);
  byProduct.get(id(rule.productId)).push(rule);
}

function resolveVendorCost(entry, savedPrice, rules = byProduct.get(id(entry.product)) || []) {
  const fail = message => { throw new Error(`${entry.product_name || 'Product'} (entry ${entry.id ?? 'unknown'}): ${message}; vendor Cost needs review`); };
  const packageId = id(entry.product_package);
  const candidates = rules.filter(r => id(r.productId) === id(entry.product) &&
    (packageId ? id(r.packageId) === packageId : r.packageName === entry.package_name));
  const matchingPrice = candidates.filter(r => Math.abs(savedPrice - r.erroneousCents / 100) < 0.000001);
  if (!candidates.length && rules.some(r => id(r.productId) === id(entry.product) &&
    Math.abs(savedPrice - r.erroneousCents / 100) < 0.000001)) {
    fail('package does not match the reviewed incident mapping');
  }
  if (!matchingPrice.length) return { price: savedPrice, correction: null };
  const created = timestamp(entry.created_at);
  if (!Number.isFinite(created)) fail('missing timestamp for an incident price');
  const active = candidates.filter(r => created >= timestamp(r.startAt) &&
    (!r.endAt || created < timestamp(r.endAt)));
  if (!active.length) {
    // An edit may have repriced an older line. Its creation time cannot prove which cost applies.
    const updated = timestamp(entry.updated_at);
    if (matchingPrice.some(r => created < timestamp(r.startAt) && updated >= timestamp(r.startAt) &&
      (!r.endAt || updated < timestamp(r.endAt)))) fail('older order line may have been repriced during the incident');
    return { price: savedPrice, correction: null };
  }
  if (active.length !== 1) fail('ambiguous publication history');
  const rule = active[0];
  if (Math.abs(savedPrice - rule.erroneousCents / 100) >= 0.000001) fail('saved price differs from the applicable publication');
  if (rule.holdReason || !Number.isSafeInteger(rule.costCents) || rule.costCents < 0) fail(rule.holdReason || 'unverified historical Cost');
  if (entry.charge_type !== rule.chargeType) fail('saved charge type differs from the reviewed product');
  if (rule.chargeType !== 'package' && !rule.chargeUnits.map(norm).includes(norm(entry.charge_unit))) fail('saved weight unit differs from the reviewed product');
  if (entry.vendor_name && !(rule.verifiedVendors || [rule.vendor]).map(norm).includes(norm(entry.vendor_name))) fail('saved vendor differs from the reviewed publication');
  return { price: rule.costCents / 100, correction: {
    incident: ledger.incident, actionId: rule.actionId, revisionId: rule.revisionId,
    savedUnitPrice: savedPrice, correctedUnitPrice: rule.costCents / 100,
  } };
}

module.exports = { PRICING_BASIS, resolveVendorCost };
