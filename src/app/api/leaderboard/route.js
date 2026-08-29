import { NextResponse } from 'next/server';
import db from '@/lib/db/config/database';

export const dynamic = 'force-dynamic';

const CACHE_DURATION_MS = 5 * 60 * 1000;
let cache = null;
let cacheTimestamp = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period') || '7d';
  const metric = searchParams.get('metric') || 'requests';
  const topN = parseInt(searchParams.get('top') || '20', 10);
  const showProviders = searchParams.get('providers') === 'true';

  if (cache && Date.now() - cacheTimestamp < CACHE_DURATION_MS) {
    return NextResponse.json(cache.data);
  }

  try {
    console.log(`[Leaderboard] Fetching: period=${period}, metric=${metric}`);

    const queries = {};
    queries.keysByRequests = await getApiKeysByRequests(period, topN);
    queries.keysByCost = await getApiKeysByCost(period, topN);
    
    if (showProviders) {
      queries.providersByUsage = await getProvidersByUsage(period, topN);
      queries.providersByCost = await getProvidersByCost(period, topN);
    }

    const response = {
      success: true,
      metadata: { period, metric, timestamp: new Date().toISOString() },
      data: queries
    };

    cache = { timestamp: Date.now(), data: response };
    return NextResponse.json(response);

  } catch (error) {
    console.error('[Leaderboard Error]', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

async function getApiKeysByRequests(period, limit) {
  const sql = `
    SELECT 
      ak.id, ak.name AS key_name, COALESCE(ak.key, '****') AS key_masked,
      COUNT(rd.id) AS total_requests,
      SUM(COALESCE(JSON_EXTRACT(rd.tokens, '$.prompt_tokens'), 0)) AS input_tokens,
      SUM(COALESCE(JSON_EXTRACT(rd.tokens, '$.completion_tokens'), 0)) AS output_tokens,
      SUM(COALESCE(JSON_EXTRACT(rd.tokens, '$.total_tokens'), 0)) AS total_tokens,
      SUM(COALESCE(rd.cost, 0)) AS total_cost,
      MAX(rd.timestamp) AS last_used,
      ROUND(AVG(rd.latency->>'$.total'), 0) AS avg_latency_ms
    FROM apiKeys ak
    LEFT JOIN requestDetails rd ON ak.id = rd.apiKey
    WHERE rd.timestamp >= datetime('now', '-${period.replace(/[a-z]/g, '')} days')
    GROUP BY ak.id
    ORDER BY total_requests DESC LIMIT ?
  `;
  
  const rows = db.prepare(sql).all(limit);
  return rows.map(row => ({ ...row, cost_per_request: row.total_requests > 0 ? (row.total_cost / row.total_requests).toFixed(4) : 0 }));
}

async function getApiKeysByCost(period, limit) {
  const sql = `
    SELECT 
      ak.id, ak.name AS key_name, SUM(COALESCE(rd.cost, 0)) AS total_cost,
      COUNT(rd.id) AS total_requests, SUM(COALESCE(rd.latency->>'$.total', 0)) AS total_latency
    FROM apiKeys ak
    LEFT JOIN requestDetails rd ON ak.id = rd.apiKey
    WHERE rd.timestamp >= datetime('now', '-${period.replace(/[a-z]/g, '')} days')
    GROUP BY ak.id HAVING total_cost > 0 ORDER BY total_cost DESC LIMIT ?
  `;
  
  const rows = db.prepare(sql).all(limit);
  return rows.map(row => ({ ...row, requests_per_dollar: row.total_cost > 0 ? row.total_requests / row.total_cost : 0 }));
}

async function getProvidersByUsage(period, limit) {
  const sql = `
    SELECT 
      rd.provider, COUNT(rd.id) AS total_requests,
      SUM(COALESCE(JSON_EXTRACT(rd.tokens, '$.prompt_tokens'), 0)) AS input_tokens,
      SUM(COALESCE(JSON_EXTRACT(rd.tokens, '$.completion_tokens'), 0)) AS output_tokens
    FROM requestDetails rd
    WHERE rd.timestamp >= datetime('now', '-${period.replace(/[a-z]/g, '')} days')
    GROUP BY rd.provider ORDER BY total_requests DESC LIMIT ?
  `;
  
  return db.prepare(sql).all(limit);
}

async function getProvidersByCost(period, limit) {
  const sql = `
    SELECT 
      rd.provider, SUM(COALESCE(rd.cost, 0)) AS total_cost,
      COUNT(rd.id) AS total_requests
    FROM requestDetails rd
    WHERE rd.timestamp >= datetime('now', '-${period.replace(/[a-z]/g, '')} days')
    GROUP BY rd.provider HAVING total_cost > 0 ORDER BY total_cost DESC LIMIT ?
  `;
  
  return db.prepare(sql).all(limit);
}
