import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { onRequestPost } from './generate.js';

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
});

function jsonRequest(body, origin = 'https://level1-website-agent.pages.dev', headers = {}) {
  return new Request('https://level1-website-agent.pages.dev/api/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function memoryCaches() {
  const store = new Map();

  return {
    default: {
      async match(request) {
        const response = store.get(request.url);
        return response ? response.clone() : undefined;
      },
      async put(request, response) {
        store.set(request.url, response.clone());
      }
    }
  };
}

test('rejects unapproved models before calling OpenRouter', async () => {
  let upstreamCalled = false;
  globalThis.fetch = async () => {
    upstreamCalled = true;
    throw new Error('unexpected upstream call');
  };

  const response = await onRequestPost({
    env: { OPENROUTER_API_KEY: 'test-key' },
    request: jsonRequest({
      model: 'untrusted/vendor-model',
      max_tokens: 8000,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' }
      ]
    })
  });

  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(upstreamCalled, false);
  assert.match(payload.error.message, /Unsupported model/);
});

test('forwards only sanitized generation fields to OpenRouter', async () => {
  let upstreamPayload;
  globalThis.fetch = async (_url, init) => {
    upstreamPayload = JSON.parse(init.body);
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  const response = await onRequestPost({
    env: { OPENROUTER_API_KEY: 'test-key' },
    request: jsonRequest({
      model: 'anthropic/claude-sonnet-latest',
      max_tokens: 999999,
      temperature: 2,
      tools: [{ type: 'function' }],
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamPayload, {
    model: 'anthropic/claude-sonnet-latest',
    max_tokens: 8000,
    stream: true,
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' }
    ]
  });
});

test('rejects browser requests from unapproved origins before calling OpenRouter', async () => {
  let upstreamCalled = false;
  globalThis.fetch = async () => {
    upstreamCalled = true;
    throw new Error('unexpected upstream call');
  };

  const response = await onRequestPost({
    env: { OPENROUTER_API_KEY: 'test-key' },
    request: jsonRequest({
      model: 'anthropic/claude-sonnet-latest',
      max_tokens: 8000,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' }
      ]
    }, 'https://attacker.example')
  });

  assert.equal(response.status, 403);
  assert.equal(upstreamCalled, false);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('rate limits repeated generation requests from the same client before calling OpenRouter', async () => {
  globalThis.caches = memoryCaches();

  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  const body = {
    model: 'anthropic/claude-sonnet-latest',
    max_tokens: 8000,
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' }
    ]
  };

  for (let i = 0; i < 5; i += 1) {
    const response = await onRequestPost({
      env: { OPENROUTER_API_KEY: 'test-key' },
      request: jsonRequest(body, undefined, { 'CF-Connecting-IP': '203.0.113.10' })
    });
    assert.equal(response.status, 200);
  }

  const limitedResponse = await onRequestPost({
    env: { OPENROUTER_API_KEY: 'test-key' },
    request: jsonRequest(body, undefined, { 'CF-Connecting-IP': '203.0.113.10' })
  });

  assert.equal(limitedResponse.status, 429);
  const payload = await limitedResponse.json();
  assert.equal(upstreamCalls, 5);
  assert.match(payload.error.message, /Rate limit exceeded/);
  assert.ok(limitedResponse.headers.get('Retry-After'));
});
