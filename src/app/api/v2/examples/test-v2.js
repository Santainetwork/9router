/**
 * V2 API Comprehensive Test Examples
 * Shows all token saver toggle configurations
 */

const BASE_URL_V2 = "http://localhost:20128/v2";

async function testV2Info() {
  console.log("\n=== Test 1: Get V2 API Info ===");
  
  const response = await fetch(`${BASE_URL_V2}`, { method: "GET" });
  const data = await response.json();
  console.log("API Version:", data.version);
  console.log("Description:", data.description);
}

async function testGlobalToggleOn() {
  console.log("\n=== Test 2: Enable ALL Token Savers (Default) ===");
  
  const body = JSON.stringify({
    model: "anthropic/claude-sonnet-4",
    messages: [{ role: "user", content: "Hello, how are you?" }],
    stream: false,
    token_saver_config: {
      enabled: true  // Enable everything
    }
  });
  
  const response = await fetch(`${BASE_URL_V2}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  
  console.log("Status:", response.status);
  if (response.ok) {
    const result = await response.text();
    console.log("✓ Success (first 100 chars):", result.substring(0, 100));
  } else {
    console.log("Response:", await response.text());
  }
}

async function testGlobalToggleOff() {
  console.log("\n=== Test 3: Disable ALL Token Savers ===");
  
  const body = JSON.stringify({
    model: "anthropic/claude-sonnet-4",
    messages: [{ role: "user", content: "What's the weather like today?" }],
    stream: false,
    token_saver_config: {
      enabled: false  // Disable EVERYTHING
    }
  });
  
  const response = await fetch(`${BASE_URL_V2}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  
  console.log("Status:", response.status);
  if (response.ok) {
    const result = await response.text();
    console.log("✓ All savers disabled - first 100 chars:", result.substring(0, 100));
  } else {
    console.log("Response:", await response.text());
  }
}

async function testSelectiveDisable() {
  console.log("\n=== Test 4: Selective Disable (Turn Off Specific Features) ===");
  
  const body = JSON.stringify({
    model: "anthropic/claude-sonnet-4",
    messages: [{ role: "user", content: "Explain quantum computing simply." }],
    stream: false,
    token_saver_config: {
      enabled: true,       // Keep global on
      caveman: false,      // NO terse system prompt
      ponytail: false,     // NO lazy-dev system prompt
      headroom: true,      // Use Headroom compression
      pxpipe: true         // Use image compression
      // rtk will use dashboard default
    }
  });
  
  const response = await fetch(`${BASE_URL_V2}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  
  console.log("Status:", response.status);
  console.log("Caveman & Ponytail DISABLED, RTK+Headroom+PXPIPE ENABLED");
  if (response.ok) {
    console.log("✓ Partial configuration applied");
  }
}

async function testMinimizeTokens() {
  console.log("\n=== Test 5: Maximum Token Savings (All Features ON) ===");
  
  const body = JSON.stringify({
    model: "anthropic/claude-sonnet-4",
    messages: [
      { role: "system", content: "You are a helpful assistant. Be concise." },
      { role: "user", content: "Write a poem about AI" }
    ],
    stream: false,
    token_saver_config: {
      enabled: true,
      rtk: true,            // ✅ RTK compression
      headroom: true,       // ✅ Headroom proxy
      caveman: "full",      // ✅ Aggressive brevity injection
      ponytail: "minimal",  // ✅ Light dev-style hints
      pxpipe: true          // ✅ Image optimization
    }
  });
  
  const response = await fetch(`${BASE_URL_V2}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  
  console.log("Status:", response.status);
  console.log("ALL SAVERS ACTIVE - Expected max compression");
  if (response.ok) {
    const result = await response.text();
    console.log("✓ Max savings mode");
  }
}

async function testBasicRtkOnly() {
  console.log("\n=== Test 6: Minimal Mode (RTK Only) ===");
  
  const body = JSON.stringify({
    model: "anthropic/claude-sonnet-4",
    messages: [{ role: "user", content: "Simple question: What is JavaScript?" }],
    stream: false,
    token_saver_config: {
      enabled: true,
      rtk: true,              // ✅ Basic compression only
      headroom: false,        // ❌ No external proxy
      caveman: false,         // ❌ No system prompts
      ponytail: false,        // ❌ No system prompts
      pxpipe: false           // ❌ No image processing
    }
  });
  
  const response = await fetch(`${BASE_URL_V2}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  
  console.log("Status:", response.status);
  console.log("ONLY RTK ENABLED - Cleanest baseline");
  if (response.ok) {
    console.log("✓ Minimal mode active");
  }
}

async function testCompareConfigurations() {
  console.log("\n=== Test 7: A/B Comparison of Different Configs ===");
  
  const configs = [
    { name: "No Savers", config: { enabled: false } },
    { name: "Basic RTK", config: { enabled: true, rtk: true, caveman: false, ponytail: false, headroom: false, pxpipe: false } },
    { name: "Full Stack", config: { enabled: true, rtk: true, caveman: true, ponytail: true, headroom: true, pxpipe: true } }
  ];
  
  const prompt = "What are three key features of React?";
  
  for (const test of configs) {
    console.log(`\n  Testing: ${test.name}`);
    
    const body = JSON.stringify({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: prompt }],
      stream: false,
      token_saver_config: test.config
    });
    
    const start = Date.now();
    const response = await fetch(`${BASE_URL_V2}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    const duration = Date.now() - start;
    
    if (response.ok) {
      console.log(`    ✓ Status: ${response.status}, Time: ${duration}ms`);
    } else {
      console.log(`    ✗ Failed: ${await response.text()}`);
    }
  }
}

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("V2 API Token Saver Toggle - Complete Test Suite");
  console.log("=".repeat(60));
  
  try {
    await testV2Info();
    await testGlobalToggleOn();
    await testGlobalToggleOff();
    await testSelectiveDisable();
    await testMinimizeTokens();
    await testBasicRtkOnly();
    await testCompareConfigurations();
    
    console.log("\n" + "=".repeat(60));
    console.log("✅ All tests completed!");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("\n❌ Test suite error:", error.message);
  }
}

// Run automatically or export for manual testing
if (typeof require !== "undefined") {
  require.main === module && runAllTests();
} else {
  // ES modules
  global.runAllTests = runAllTests;
}

console.log("\nRun with: node src/app/api/v2/examples/test-v2.js");
console.log("Or import and call runAllTests() in browser.");
