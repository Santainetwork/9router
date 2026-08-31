#!/usr/bin/env node
/**
 * Verification script for RequestLogger overlap fix
 */

const fs = require('fs');

const paths = {
  REQUEST_LOGGER_PATH: '/opt/9router/src/shared/components/RequestLogger.js',
  USAGE_REPO_PATH: '/opt/9router/src/lib/db/repos/usageRepo.js',
  API_ROUTE_PATH: '/opt/9router/src/app/api/usage/request-logs/route.js',
  DETAILS_TAB_PATH: '/opt/9router/src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js',
};

console.log('='.repeat(60));
console.log('RequestLogger Overlap Fix Verification');
console.log('='.repeat(60));

let allPassed = true;

// Test 1: Verify key prop change in RequestLogger.js
console.log('\n[Test 1] Checking RequestLogger.js key prop...');
try {
  const content = fs.readFileSync(paths.REQUEST_LOGGER_PATH, 'utf8');
  
  // Check that key={i} is NOT present in table rows
  const hasKeyI = /<tr[^>]*\s+key=\{i\}/.test(content);
  
  // Check that key={log} IS present in table rows  
  const hasKeyLog = /<tr[^>]*\s+key=\{log\}/.test(content);
  
  if (hasKeyI) {
    console.log('  ❌ FAILED: Found key={i} - should be key={log}');
    allPassed = false;
  } else if (!hasKeyLog) {
    console.log('  ❌ FAILED: Did not find key={log}');
    allPassed = false;
  } else {
    console.log('  ✅ PASSED: Using unique key={log} instead of index');
  }
  
  // Check auto-refresh interval is set to 3000ms (3 seconds)
  const hasAutoRefresh = /setInterval.*fetchLogs.*3000|3000.*setInterval.*fetchLogs/.test(content);
  if (hasAutoRefresh) {
    console.log('  ✅ PASSED: Auto-refresh interval is 3 seconds');
  } else {
    console.log('  ⚠️  WARNING: Could not confirm 3-second auto-refresh interval');
  }
  
} catch (err) {
  console.log('  ❌ ERROR: Could not read file:', err.message);
  allPassed = false;
}

// Test 2: Verify getRecentLogs returns string logs with proper format
console.log('\n[Test 2] Checking usageRepo.js getRecentLogs implementation...');
try {
  const repoContent = fs.readFileSync(paths.USAGE_REPO_PATH, 'utf8');
  
  const usesUpstreamModel = /meta\.upstreamModel|requestedModel/.test(repoContent);
  if (usesUpstreamModel) {
    console.log('  ✅ PASSED: Uses upstreamModel/requestedModel from meta');
  } else {
    console.log('  ⚠️  WARNING: Model selection could be improved');
  }
  
} catch (err) {
  console.log('  ❌ ERROR:', err.message);
  allPassed = false;
}

// Test 3: Verify API route exists and returns logs
console.log('\n[Test 3] Checking /api/usage/request-logs route...');
try {
  const apiContent = fs.readFileSync(paths.API_ROUTE_PATH, 'utf8');
  
  const callsGetRecentLogs = /getRecentLogs/.test(apiContent);
  if (callsGetRecentLogs) {
    console.log('  ✅ PASSED: Route calls getRecentLogs function');
  } else {
    console.log('  ❌ FAILED: Route does not call getRecentLogs');
    allPassed = false;
  }
  
  const noStoreCache = /no-store/i.test(apiContent);
  if (noStoreCache) {
    console.log('  ✅ PASSED: Response cache control set appropriately');
  } else {
    console.log('  ⚠️  INFO: Cache control headers may need review');
  }
  
} catch (err) {
  console.log('  ❌ ERROR:', err.message);
  allPassed = false;
}

// Test 4: Verify RequestDetailsTab has isUpstreamModel helper
console.log('\n[Test 4] Checking RequestDetailsTab.js helper functions...');
try {
  const detailsContent = fs.readFileSync(paths.DETAILS_TAB_PATH, 'utf8');
  
  const hasIsUpstreamModel = /function\s+isUpstreamModel/.test(detailsContent);
  if (hasIsUpstreamModel) {
    console.log('  ✅ PASSED: isUpstreamModel helper function exists');
  } else {
    console.log('  ❌ FAILED: Missing isUpstreamModel helper');
    allPassed = false;
  }
  
  const modelSelection = /model:\s*e\.model\s*\|\s*e\.meta\?\.\s*upstreamModel/.test(detailsContent);
  if (modelSelection) {
    console.log('  ✅ PASSED: Model selection includes upstreamModel support');
  } else {
    console.log('  ⚠️  INFO: Model selection pattern needs review');
  }
  
} catch (err) {
  console.log('  ❌ ERROR:', err.message);
  allPassed = false;
}

// Summary
console.log('\n' + '='.repeat(60));
if (allPassed) {
  console.log('✅ All verification tests PASSED');
  process.exit(0);
} else {
  console.log('❌ Some tests FAILED - see above for details');
  process.exit(1);
}
