const ALLOWED_MODELS = new Set([
  'anthropic/claude-opus-4.7',
  'anthropic/claude-sonnet-latest',
  'openai/gpt-5.4',
  'google/gemini-3.5-flash',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash:free'
]);

const MAX_SYSTEM_PROMPT_CHARS = 3000;
const MAX_USER_PROMPT_CHARS = 7000;
const MAX_OUTPUT_TOKENS = 8000;
const RATE_LIMIT_WINDOW_SECONDS = 600;
const RATE_LIMIT_MAX_REQUESTS = 5;

const PRODUCTION_HOSTNAME = 'level1-website-agent.pages.dev';
const PREVIEW_HOSTNAME_SUFFIX = '.level1-website-agent.pages.dev';
const LOCAL_ORIGINS = new Set(['http://localhost:8788', 'http://127.0.0.1:8788']);

function isAllowedOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (LOCAL_ORIGINS.has(origin)) return true;

  try {
    const url = new URL(origin);
    return (
      url.protocol === 'https:' &&
      (url.hostname === PRODUCTION_HOSTNAME || url.hostname.endsWith(PREVIEW_HOSTNAME_SUFFIX))
    );
  } catch {
    return false;
  }
}

function corsHeaders(request, contentType) {
  const headers = {
    'Vary': 'Origin'
  };
  const origin = request.headers.get('Origin');

  if (origin && isAllowedOrigin(request)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  return headers;
}

function jsonError(request, status, message, extraHeaders = {}) {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { ...corsHeaders(request, 'application/json'), ...extraHeaders } }
  );
}

function clientAddress(request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;

  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();

  return 'unknown';
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function rateLimitResponse(request) {
  if (!globalThis.caches?.default) {
    return null;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(nowSeconds / RATE_LIMIT_WINDOW_SECONDS);
  const retryAfter = RATE_LIMIT_WINDOW_SECONDS - (nowSeconds % RATE_LIMIT_WINDOW_SECONDS);
  const clientHash = await sha256Hex(clientAddress(request));
  const cacheKey = new Request('https://level1-website-agent.local/ratelimit/' + windowId + '/' + clientHash);
  const current = await caches.default.match(cacheKey);
  let count = 0;

  if (current) {
    const payload = await current.json().catch(() => ({}));
    count = Number.isInteger(payload.count) ? payload.count : 0;
  }

  if (count >= RATE_LIMIT_MAX_REQUESTS) {
    return jsonError(request, 429, 'Rate limit exceeded. Please wait before generating another website.', {
      'Retry-After': String(retryAfter)
    });
  }

  await caches.default.put(
    cacheKey,
    new Response(JSON.stringify({ count: count + 1 }), {
      headers: { 'Cache-Control': 'max-age=' + retryAfter }
    })
  );

  return null;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const apiKey = env.OPENROUTER_API_KEY;

  if (!isAllowedOrigin(request)) {
    return jsonError(request, 403, 'Origin not allowed.');
  }

  const limitedResponse = await rateLimitResponse(request);
  if (limitedResponse) {
    return limitedResponse;
  }

  if (!apiKey) {
    return jsonError(request, 500, 'OPENROUTER_API_KEY secret not configured on this deployment.');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(request, 400, 'Invalid JSON body.');
  }

  if (!ALLOWED_MODELS.has(body?.model)) {
    return jsonError(request, 400, 'Unsupported model.');
  }

  const messages = body?.messages;
  const systemMessage = messages?.[0];
  const userMessage = messages?.[1];

  if (
    !Array.isArray(messages) ||
    messages.length !== 2 ||
    systemMessage?.role !== 'system' ||
    userMessage?.role !== 'user' ||
    typeof systemMessage.content !== 'string' ||
    typeof userMessage.content !== 'string' ||
    systemMessage.content.length > MAX_SYSTEM_PROMPT_CHARS ||
    userMessage.content.length > MAX_USER_PROMPT_CHARS
  ) {
    return jsonError(request, 400, 'Invalid generation request.');
  }

  const upstreamBody = {
    model: body.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    messages: [
      { role: 'system', content: systemMessage.content },
      { role: 'user', content: userMessage.content }
    ]
  };

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'HTTP-Referer': 'https://level1-website-agent.pages.dev',
      'X-Title': 'Level 1 Website Agent'
    },
    body: JSON.stringify(upstreamBody)
  });

  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    return new Response(
      JSON.stringify({ error: err.error || { message: 'Upstream API error ' + upstream.status } }),
      { status: upstream.status, headers: corsHeaders(request, 'application/json') }
    );
  }

  // Pipe the SSE stream straight through
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders(request, 'text/event-stream'),
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    }
  });
}

export async function onRequestOptions(context) {
  const { request } = context;
  if (!isAllowedOrigin(request)) {
    return new Response(null, { status: 403, headers: { 'Vary': 'Origin' } });
  }

  return new Response(null, {
    headers: {
      ...corsHeaders(request),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
