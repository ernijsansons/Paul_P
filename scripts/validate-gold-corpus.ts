/**
 * Paul P - Gold Corpus Validation Script
 *
 * Validates the LLM regression test gold corpus for:
 * - Unique test IDs
 * - Required fields
 * - Valid score ranges
 * - Category coverage
 *
 * Run with: npx tsx scripts/validate-gold-corpus.ts
 */

import { getPrimaryGoldCorpus, validateCorpus } from '../src/lib/llm/gold-corpus';

function main() {
  console.log('=' .repeat(60));
  console.log('PAUL P - GOLD CORPUS VALIDATION');
  console.log('=' .repeat(60));
  console.log();

  const corpus = getPrimaryGoldCorpus();
  console.log(`📊 Total test cases: ${corpus.length}`);
  console.log();

  // Count by category
  const byCategory: Record<string, number> = {};
  for (const tc of corpus) {
    byCategory[tc.category] = (byCategory[tc.category] || 0) + 1;
  }

  console.log('📁 By Category:');
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log();

  // Count by run type
  const byRunType: Record<string, number> = {};
  for (const tc of corpus) {
    byRunType[tc.input.runType] = (byRunType[tc.input.runType] || 0) + 1;
  }

  console.log('🔧 By Run Type:');
  for (const [rt, count] of Object.entries(byRunType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rt}: ${count}`);
  }
  console.log();

  // Validate corpus
  console.log('✅ Running validation...');
  const validation = validateCorpus();

  if (validation.valid) {
    console.log('  ✓ Corpus is valid!');
  } else {
    console.log('  ✗ Corpus has errors:');
    for (const error of validation.errors) {
      console.log(`    - ${error}`);
    }
  }
  console.log();

  // Show sample test case
  console.log('📝 Sample Test Case:');
  const sample = corpus[0];
  console.log(`  ID: ${sample.id}`);
  console.log(`  Name: ${sample.name}`);
  console.log(`  Category: ${sample.category}`);
  console.log(`  Title: ${sample.input.marketTitle}`);
  console.log(`  Expected Score Range: [${sample.expectedOutput.scoreRange.join(', ')}]`);
  console.log(`  Min Confidence: ${sample.expectedOutput.minConfidence}`);
  console.log();

  // Check coverage requirements
  console.log('📋 Coverage Requirements:');
  const requirements = [
    { name: 'Standard resolution', min: 8, actual: byCategory['standard_resolution'] || 0 },
    { name: 'Edge cases', min: 4, actual: byCategory['edge_case'] || 0 },
    { name: 'Ambiguous phrasing', min: 2, actual: byCategory['ambiguous_phrasing'] || 0 },
    { name: 'Adversarial', min: 2, actual: byCategory['adversarial'] || 0 },
  ];

  let allMet = true;
  for (const req of requirements) {
    const met = req.actual >= req.min;
    allMet = allMet && met;
    const status = met ? '✓' : '✗';
    console.log(`  ${status} ${req.name}: ${req.actual}/${req.min} (${met ? 'OK' : 'NEEDS MORE'})`);
  }
  console.log();

  // Final verdict
  console.log('=' .repeat(60));
  if (validation.valid && allMet) {
    console.log('✅ GOLD CORPUS READY FOR USE');
  } else {
    console.log('❌ GOLD CORPUS NEEDS FIXES');
    process.exit(1);
  }
  console.log('=' .repeat(60));
}

main();
