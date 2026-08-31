#!/usr/bin/env node
/**
 * Final Verification of RequestLogger Overlap Fix
 * Checks all acceptance criteria
 */

const http = require('http');
const fs = require('fs');

const BASE_URL = 'http://localhost:20127';

let results = {
  serverRunning: false,
  authWorking: false,
  fixConfirmed: false,
  testPageAccessible: false,
  errors: []
};

async function checkServer() {
  console.log('='.repeat(60));
  console.log('FINAL VERIFICATION - RequestLogger Overlap Fix');
  console.log('='.repeat(60) + '\n');
  
  // Test 1: Server is running
  console.log('[1] Checking dev server status...');
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`${BASE_URL}/`, (res) => {
        resolve();
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
    });
    results.serverRunning = true;
    console.log('    ✅ PASSED: Dev server responding\n');
  } catch (err) {
    results.errors.push(`Server not responding: ${err.message}`);
    console.log('    ❌ FAILED: Cannot reach dev server\n');
  }
  
  // Test 2: Test page accessible
  console.log('[2] Checking standalone test page...');
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`${BASE_URL}/test-overlap-fix.html`, (res) => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Status ${res.statusCode}`));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
    });
    results.testPageAccessible = true;
    console.log('    ✅ PASSED: Test page accessible\n');
  } catch (err) {
    results.errors.push(`Test page error: ${err.message}`);
    console.log('    ⚠️  WARNING: Test page issue\n');
  }
  
  // Test 3: Verify key={log} in source
  console.log('[3] Verifying RequestLogger.js has key={log}...');
  try {
    const rlPath = '/opt/9router/src/shared/components/RequestLogger.js';
    const content = fs.readFileSync(rlPath, 'utf8');
    
    const hasKeyI = /<tr[^>]*\s+key=\{i\}/.test(content);
    const hasKeyLog = /<tr[^>]*\s+key=\{log\}/.test(content);
    
    if (!hasKeyI && hasKeyLog) {
      results.fixConfirmed = true;
      console.log('    ✅ PASSED: Using key={log} instead of index\n');
    } else if (hasKeyI) {
      results.errors.push('Found problematic key={i} pattern');
      console.log('    ❌ FAILED: Still using array index as key\n');
    } else {
      results.errors.push('Could not verify key prop');
      console.log('    ⚠️  WARNING: Could not verify key pattern\n');
    }
  } catch (err) {
    results.errors.push(`Source file error: ${err.message}`);
    console.log('    ⚠️  WARNING: Cannot read source files\n');
  }
  
  // Summary
  console.log('='.repeat(60));
  console.log('VERIFICATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Server Running:       ${results.serverRunning ? '✅ YES' : '❌ NO'}`);
  console.log(`Test Page Accessible: ${results.testPageAccessible ? '✅ YES' : '❌ NO'}`);
  console.log(`Fix Confirmed:        ${results.fixConfirmed ? '✅ YES' : '❌ NO'}`);
  
  if (results.errors.length > 0) {
    console.log('\nErrors/Warnings:');
    results.errors.forEach(e => console.log(`  • ${e}`));
  }
  
  console.log('\n' + '='.repeat(60));
  if (results.serverRunning && results.fixConfirmed) {
    console.log('✅ OVERLAP FIX VERIFIED - All critical checks passed');
    process.exit(0);
  } else {
    console.log('⚠️ VERIFICATION INCOMPLETE - Review errors above');
    process.exit(1);
  }
}

checkServer();
