import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const catalogue = JSON.parse(await readFile(new URL('catalogue.json', import.meta.url), 'utf8'));
const taxonomy = JSON.parse(await readFile(new URL('taxonomy.json', import.meta.url), 'utf8'));
const sources = JSON.parse(await readFile(new URL('source-register.json', import.meta.url), 'utf8'));
const rows = catalogue.services;
assert.equal(rows.length, 200);
assert.equal(catalogue.categories.length, 10);
assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
assert.equal(new Set(rows.map(row => row.service.toLowerCase())).size, rows.length);
assert.equal(sources.sources.length, rows.length);

for (const category of catalogue.categories) {
  assert.equal(rows.filter(row => row.category === category.id).length, 20);
}
for (const row of rows) {
  const group = taxonomy.categories.find(category => category.id === row.category);
  assert.ok(group?.comparison_groups.includes(row.comparison_group), row.id);
  assert.ok(row.plan && row.purpose && row.constraints.length && row.capability_tags.length >= 2, row.id);
  assert.ok(row.capability_tags.every(tag => taxonomy.capability_tags.includes(tag)), row.id);
  assert.ok(Number.isFinite(row.price.amount) && row.price.amount > 0, row.id);
  assert.ok(['USD', 'GBP', 'EUR', 'SEK'].includes(row.price.currency), row.id);
  assert.ok(row.sources.length && row.sources.every(source => new URL(source.url).protocol === 'https:'), row.id);
  assert.ok(sources.sources.some(source => source.service_id === row.id && source.url === row.sources[0].url), row.id);
  if (['annual_month_rate', 'advertised_month', 'listed_offer', 'serving', 'bag', 'box'].includes(row.price.unit)) {
    assert.equal(row.price.billing_amount, null, row.id);
  }
  if (['28_days', '30_days', '90_days'].includes(row.price.unit)) {
    assert.equal(row.price.monthly_reference, null, row.id);
  }
  assert.equal(row.price.requires_fresh_quote, true, row.id);
  assert.equal(row.price.exact_total_confirmed, false, row.id);
  assert.equal(row.execution.integration_status, 'catalogue_only', row.id);
  assert.equal(row.execution.paypal_acceptance, 'unknown', row.id);
  for (const field of ['purchase_supported', 'cancellation_supported', 'migration_supported']) assert.equal(row.execution[field], false, row.id);
  for (const field of ['runtime_tested', 'market_eligibility_confirmed', 'history_preservation_confirmed', 'plan_entitlements_confirmed']) assert.equal(row.evidence[field], false, row.id);
}

const result = {
  status: 'pass',
  scope: 'Structural and scope checks only; not live price, plan entitlement or integration validation.',
  services: rows.length,
  categories: catalogue.categories.map(({ label, count }) => ({ label, count })),
  distinct_primary_price_urls: new Set(rows.map(row => row.sources[0].url)).size,
  comparison_groups: new Set(rows.map(row => row.comparison_group)).size,
  capability_tags: taxonomy.capability_tags.length,
  records_with_research_flags: rows.filter(row => row.research_flags.length).length,
  checks: ['200 unique services', '20 services per category', 'positive sourced prices', 'taxonomy membership', 'billing distinctions', 'source-register coverage', 'unknown entitlements', 'execution disabled']
};
await writeFile(new URL('validation.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
