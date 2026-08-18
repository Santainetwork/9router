import { getAdapter } from "../driver.js";
import { redactProviderFooterText } from "@/shared/utils/providerFooter.js";

export { redactProviderFooterText };

const MAX_LOGS = 200;

export async function addProviderFooterLog(provider, model, referralText, timestamp = new Date().toISOString()) {
  if (!provider || !model || !referralText) {
    throw new Error("provider, model, and referralText are required");
  }

  const db = await getAdapter();
  const redactedText = redactProviderFooterText(referralText);

  db.transaction(() => {
    db.run(
      `INSERT INTO provider_footer_logs (timestamp, provider, model, referral_text) VALUES (?, ?, ?, ?)`,
      [timestamp, provider, model, redactedText],
    );
    db.run(
      `DELETE FROM provider_footer_logs WHERE id NOT IN (
        SELECT id FROM provider_footer_logs ORDER BY timestamp DESC LIMIT ${MAX_LOGS}
      )`,
    );
  });
}

export async function getProviderFooterLogs(limit = 50) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT id, timestamp, provider, model, referral_text
     FROM provider_footer_logs
     ORDER BY timestamp DESC
     LIMIT ?`,
    [Math.min(Math.max(Number(limit) || 50, 1), MAX_LOGS)],
  );

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    provider: row.provider,
    model: row.model,
    referral_text: row.referral_text,
  }));
}

export async function clearProviderFooterLogs() {
  const db = await getAdapter();
  const result = db.run("DELETE FROM provider_footer_logs");
  return {
    success: true,
    message: "All provider footer logs cleared",
    deletedCount: result.changes || 0,
  };
}

export async function countProviderFooterLogs() {
  const db = await getAdapter();
  const result = db.get("SELECT COUNT(*) AS count FROM provider_footer_logs");
  return result?.count || 0;
}
