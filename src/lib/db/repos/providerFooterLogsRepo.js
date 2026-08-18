import { getAdapter } from "../driver.js";

const MAX_LOGS = 200;

function redactSensitive(text) {
  if (!text || typeof text !== "string") return "";
  
  let redacted = text;
  
  // Redact potential API keys, tokens, or sensitive identifiers
  const patterns = [
    /[a-zA-Z0-9-_]{20,}/g, // Long alphanumeric strings
    /sk-[a-zA-Z0-9]{20,}/g, // OpenAI-style keys
    /Bearer\s+[a-zA-Z0-9-_]+/g, // Bearer tokens
    /'[a-zA-Z0-9]{20,}'/g, // Quoted long strings
    /["'][a-zA-Z0-9]{20,}["']/g, // Double-quoted long strings
  ];
  
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  
  // Redact potential URLs with tokens
  redacted = redacted.replace(/https?:\/\/[^\s]+?(\?|&)([a-zA-Z0-9-_]{10,}=)[^\s]*/g, 
    (match) => match.replace(/[a-zA-Z0-9-_]{10,}=[^\s]*/, "token=[REDACTED]"));
  
  return redacted;
}

export async function addProviderFooterLog(provider, model, referralText, timestamp = new Date().toISOString()) {
  if (!provider || !model || !referralText) {
    throw new Error("provider, model, and referralText are required");
  }
  
  const db = await getAdapter();
  
  // Redact referral text before storing
  const redactedText = redactSensitive(referralText);
  
  // Use transaction for atomicity
  const transaction = db.transaction(() => {
    // Insert new log
    db.run(
      `INSERT INTO provider_footer_logs (timestamp, provider, model, referral_text) VALUES (?, ?, ?, ?)`,
      [timestamp, provider, model, redactedText]
    );
    
    // Delete old logs to maintain max limit (keep only MAX_LOGS most recent)
    db.run(
      `DELETE FROM provider_footer_logs WHERE id NOT IN (
        SELECT id FROM provider_footer_logs 
        ORDER BY timestamp DESC 
        LIMIT ${MAX_LOGS}
      )`
    );
  });
  
  transaction();
}

export async function getProviderFooterLogs(limit = 50) {
  const db = await getAdapter();
  
  const stmt = db.prepare(
    `SELECT id, timestamp, provider, model, referral_text 
     FROM provider_footer_logs 
     ORDER BY timestamp DESC 
     LIMIT ?`
  );
  
  const rows = stmt.all(Math.min(limit, MAX_LOGS));
  
  return rows.map(row => ({
    id: row.id,
    timestamp: row.timestamp,
    provider: row.provider,
    model: row.model,
    referral_text: row.referral_text,
  }));
}

export async function clearProviderFooterLogs() {
  const db = await getAdapter();
  
  const result = db.prepare(`DELETE FROM provider_footer_logs`).run();
  
  return { 
    success: true, 
    message: "All provider footer logs cleared",
    deletedCount: result.changes || 0
  };
}

export async function countProviderFooterLogs() {
  const db = await getAdapter();
  
  const result = db.prepare(`SELECT COUNT(*) as count FROM provider_footer_logs`).get();
  return result.count || 0;
}