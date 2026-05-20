/**
 * Cloudflare Worker — 국세청 사업자 상태 조회 프록시
 * 환경 변수: NTS_API_KEY (wrangler secret put NTS_API_KEY)
 * KV 바인딩: RL_KV (IP별 rate limiting)
 */

const NTS_API_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';

// IP당 분당 최대 호출 횟수
const RATE_LIMIT = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/status' && request.method === 'POST') {
      return handleStatus(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${ip}`;

  const current = await env.RL_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= RATE_LIMIT) return false;

  // TTL 60초 — 1분 윈도우
  await env.RL_KV.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

async function handleStatus(request, env) {
  const allowed = await checkRateLimit(request, env);
  if (!allowed) {
    return jsonError('요청 한도를 초과했습니다. 잠시 후 다시 시도하세요. (분당 30회)', 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('요청 본문이 올바르지 않습니다.', 400);
  }

  const b_no = body?.b_no;
  if (!Array.isArray(b_no) || b_no.length === 0) {
    return jsonError('b_no 배열이 필요합니다.', 400);
  }
  if (b_no.length > 100) {
    return jsonError('한 번에 최대 100건까지만 조회할 수 있습니다.', 400);
  }

  const apiKey = env.NTS_API_KEY;
  if (!apiKey) {
    return jsonError('서버 설정 오류: API 키가 없습니다.', 500);
  }

  const upstream = await fetch(`${NTS_API_URL}?serviceKey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ b_no }),
  });

  const data = await upstream.json();

  return new Response(JSON.stringify(data), {
    status: upstream.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
