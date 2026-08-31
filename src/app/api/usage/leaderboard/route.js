import { NextResponse } from 'next/server';
import { getAdapter } from '@/lib/db/driver.js';

export const dynamic = 'force-dynamic';
const CACHE_DURATION_MS = 30 * 1000; // 30 seconds fresh cache
let cache = null;
let cacheTimestamp = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period') || '7d';
  const topN = parseInt(searchParams.get('top') || '100', 10);

  const cacheKey = `${period}_${topN}`;
  if (cache && cache.key === cacheKey && Date.now() - cacheTimestamp < CACHE_DURATION_MS) {
    return NextResponse.json(cache.data, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    let whereTimeClause = '';
    if (period === 'today') {
      whereTimeClause = "timestamp >= datetime('now', 'start of day')";
    } else if (period === '24h') {
      whereTimeClause = "timestamp >= datetime('now', '-1 day')";
    } else if (period === '7d') {
      whereTimeClause = "timestamp >= datetime('now', '-7 days')";
    } else if (period === '30d') {
      whereTimeClause = "timestamp >= datetime('now', '-30 days')";
    } else if (period === 'all') {
      whereTimeClause = "1=1";
    } else {
      whereTimeClause = "timestamp >= datetime('now', '-7 days')";
    }

    const [providersByUsage, providersByCost, keysByRequests, keysByCost] = await Promise.all([
      getProvidersByUsage(whereTimeClause, topN),
      getProvidersByCost(whereTimeClause, topN),
      getKeysByRequests(whereTimeClause, topN),
      getKeysByCost(whereTimeClause, topN),
    ]);

    const result = {
      success: true,
      metadata: { period, timestamp: new Date().toISOString() },
      data: {
        providersByUsage,
        providersByCost,
        keysByRequests,
        keysByCost
      }
    };

    cache = { key: cacheKey, timestamp: Date.now(), data: result };
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });

  } catch (error) {
    console.error('[Usage Leaderboard Error]', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

function maskKey(key) {
  if (!key || typeof key !== 'string') return '****';
  if (key.length <= 8) return key.charAt(0) + '***';
  return key.slice(0, 8) + '***';
}

async function getProvidersByUsage(whereTimeClause, limit) {
  const db = await getAdapter();
  const sql = `
    SELECT 
      provider,
      COUNT(*) as total_requests,
      SUM(COALESCE(JSON_EXTRACT(data, '$.tokens.prompt_tokens'), 0)) as input_tokens,
      SUM(COALESCE(JSON_EXTRACT(data, '$.tokens.completion_tokens'), 0)) as output_tokens,
      SUM(COALESCE(JSON_EXTRACT(data, '$.tokens.total_tokens'), 0)) as total_tokens
    FROM requestDetails
    WHERE ${whereTimeClause}
      AND provider IS NOT NULL
      AND status = 'success'
    GROUP BY provider
    ORDER BY total_requests DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(limit);
}

async function getProvidersByCost(whereTimeClause, limit) {
  const db = await getAdapter();
  const sql = `
    SELECT 
      provider,
      SUM(COALESCE(JSON_EXTRACT(data, '$.cost'), 0)) as total_cost,
      COUNT(*) as total_requests
    FROM requestDetails
    WHERE ${whereTimeClause}
      AND provider IS NOT NULL
      AND JSON_EXTRACT(data, '$.cost') IS NOT NULL
      AND status = 'success'
    GROUP BY provider
    HAVING total_cost > 0
    ORDER BY total_cost DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(limit);
}

async function getKeysByRequests(whereTimeClause, limit) {
  const db = await getAdapter();
  const sql = `
    SELECT 
      COALESCE(pc.name, rd.connectionId, 'unknown') as key_name,
      rd.connectionId,
      rd.provider,
      COUNT(*) as total_requests,
      SUM(COALESCE(JSON_EXTRACT(rd.data, '$.tokens.prompt_tokens'), 0)) as input_tokens,
      SUM(COALESCE(JSON_EXTRACT(rd.data, '$.tokens.completion_tokens'), 0)) as output_tokens,
      SUM(COALESCE(JSON_EXTRACT(rd.data, '$.tokens.total_tokens'), 0)) as total_tokens,
      ROUND(AVG(COALESCE(JSON_EXTRACT(rd.data, '$.latency.total'), 0))) as avg_latency_ms,
      SUM(COALESCE(JSON_EXTRACT(rd.data, '$.cost'), 0)) as total_cost
    FROM requestDetails rd
    LEFT JOIN providerConnections pc ON pc.id = rd.connectionId
    WHERE ${whereTimeClause.replace(/timestamp/g, 'rd.timestamp')}
      AND rd.status = 'success'
    GROUP BY rd.connectionId
    HAVING total_requests > 0
    ORDER BY total_requests DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(limit);
  return rows.map(r => ({
    id: r.connectionId,
    key_name: r.key_name || 'Unnamed',
    key_masked: maskKey(r.connectionId || ''),
    provider: r.provider || '',
    total_requests: r.total_requests,
    input_tokens: r.input_tokens || 0,
    output_tokens: r.output_tokens || 0,
    total_tokens: r.total_tokens || 0,
    avg_latency_ms: Math.round(r.avg_latency_ms) || 0,
    total_cost: r.total_cost || 0,
    cost_per_request: r.total_requests > 0 ? (r.total_cost / r.total_requests) : 0
  }));
}

async function getKeysByCost(whereTimeClause, limit) {
  const db = await getAdapter();
  const sql = `
    SELECT 
      COALESCE(pc.name, rd.connectionId, 'unknown') as key_name,
      rd.connectionId,
      rd.provider,
      SUM(COALESCE(JSON_EXTRACT(rd.data, '$.cost'), 0)) as total_cost,
      COUNT(*) as total_requests,
      ROUND(AVG(COALESCE(JSON_EXTRACT(rd.data, '$.latency.total'), 0))) as avg_latency_ms
    FROM requestDetails rd
    LEFT JOIN providerConnections pc ON pc.id = rd.connectionId
    WHERE ${whereTimeClause.replace(/timestamp/g, 'rd.timestamp')}
      AND rd.status = 'success'
      AND JSON_EXTRACT(rd.data, '$.cost') IS NOT NULL
    GROUP BY rd.connectionId
    HAVING total_cost > 0
    ORDER BY total_cost DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(limit);
  return rows.map(r => ({
    id: r.connectionId,
    key_name: r.key_name || 'Unnamed',
    key_masked: maskKey(r.connectionId || ''),
    provider: r.provider || '',
    total_cost: r.total_cost || 0,
    total_requests: r.total_requests,
    avg_latency_ms: Math.round(r.avg_latency_ms) || 0,
    cost_per_request: r.total_requests > 0 ? (r.total_cost / r.total_requests) : 0,
    requests_per_dollar: r.total_cost > 0 ? r.total_requests / r.total_cost : 0
  }));
}
