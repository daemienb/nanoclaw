/**
 * OpenRouter API Proxy
 *
 * Bridges between the Claude Agent SDK and OpenRouter.
 * The SDK calls /v1/messages/count_tokens as a pre-flight check,
 * but OpenRouter returns 404 for this endpoint, causing the SDK
 * to report "There's an issue with the selected model."
 *
 * This proxy intercepts count_tokens and returns a fake response,
 * while forwarding all other requests to the upstream URL.
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { logger } from './logger.js';

const PROXY_PORT = 3001;
const PROXY_HOST = '0.0.0.0';

let proxyRunning = false;

/**
 * Start the OpenRouter proxy if ANTHROPIC_BASE_URL points to a
 * non-Anthropic endpoint (e.g. OpenRouter).
 * Returns the proxy base URL for agent containers to use,
 * or null if no proxy is needed.
 */
export function startOpenRouterProxy(): string | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl || baseUrl.includes('anthropic.com')) {
    return null; // Direct Anthropic — no proxy needed
  }

  if (proxyRunning) {
    return `http://172.17.0.1:${PROXY_PORT}`;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const modelOverride = process.env.OPENROUTER_MODEL || '';

  const server = http.createServer((req, res) => {
    const pathname = req.url || '/';
    logger.info({ method: req.method, url: pathname }, 'Proxy request');

    // Intercept count_tokens — return fake response
    if (pathname.includes('/count_tokens')) {
      logger.info({ url: pathname }, 'Proxy: intercepted count_tokens');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1000 }));
      return;
    }

    // Read request body and forward to upstream
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', () => {
      let body = Buffer.concat(bodyChunks);

      // ── WHITELIST APPROACH ──────────────────────────────────────────
      // Instead of blacklisting Anthropic-only fields (which breaks every
      // time the SDK adds a new one), we whitelist only the fields that
      // OpenRouter's Anthropic-compatible Messages API accepts.
      // Any field not in this list is silently dropped.
      const ALLOWED_BODY_FIELDS = new Set([
        'model',
        'messages',
        'system',
        'tools',
        'tool_choice',
        'metadata',
        'max_tokens',
        'stream',
        'temperature',
        'top_p',
        'top_k',
        'stop_sequences',
      ]);

      // Content block types that OpenRouter understands
      const ALLOWED_CONTENT_TYPES = new Set([
        'text',
        'image',
        'tool_use',
        'tool_result',
      ]);

      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString());

          // Log original keys for debugging
          logger.info(
            { bodyKeys: Object.keys(parsed) },
            'Proxy: request body keys (before whitelist)',
          );

          // Rewrite model if OPENROUTER_MODEL is configured
          if (modelOverride && parsed.model) {
            logger.info(
              { from: parsed.model, to: modelOverride },
              'Proxy: rewriting model',
            );
            parsed.model = modelOverride;
          }

          // Force stream to true — some OpenRouter models (e.g. Gemini)
          // require streaming via the Anthropic messages API.
          if ('stream' in parsed && parsed.stream !== true) {
            logger.info(
              { streamValue: parsed.stream },
              'Proxy: forcing stream=true',
            );
            parsed.stream = true;
          }

          // Build a clean body with only whitelisted fields
          const cleaned: Record<string, unknown> = {};
          for (const key of ALLOWED_BODY_FIELDS) {
            if (key in parsed) {
              cleaned[key] = parsed[key];
            }
          }

          // Log what was stripped
          const strippedKeys = Object.keys(parsed).filter(
            (k) => !ALLOWED_BODY_FIELDS.has(k),
          );
          if (strippedKeys.length > 0) {
            logger.info(
              { strippedKeys },
              'Proxy: stripped non-whitelisted fields',
            );
          }

          // Clean message content blocks — strip thinking, redacted_thinking,
          // thought_signature blocks, and cache_control from content
          if (Array.isArray(cleaned.messages)) {
            for (const msg of cleaned.messages as Array<{
              content?: unknown;
              cache_control?: unknown;
            }>) {
              // Strip cache_control from message level
              delete msg.cache_control;

              if (Array.isArray(msg.content)) {
                msg.content = msg.content.filter(
                  (block: { type?: string }) =>
                    ALLOWED_CONTENT_TYPES.has(block.type || ''),
                );
                // Strip cache_control from each content block
                for (const block of msg.content) {
                  if (block && typeof block === 'object') {
                    delete (block as Record<string, unknown>).cache_control;
                  }
                }
              }
            }
          }

          // Clean system prompt — strip cache_control
          if (Array.isArray(cleaned.system)) {
            for (const block of cleaned.system as Array<
              Record<string, unknown>
            >) {
              delete block.cache_control;
            }
          }

          body = Buffer.from(JSON.stringify(cleaned));
        } catch {
          // Not JSON or parse error — forward as-is
        }
      }

      // The SDK sends paths like /v1/messages but baseUrl already includes
      // the full path (e.g. https://openrouter.ai/api/v1).
      // We need to combine them correctly to avoid double /v1.
      const baseUrlParsed = new URL(baseUrl);
      const basePath = baseUrlParsed.pathname.replace(/\/$/, ''); // e.g. /api/v1
      // Strip leading /v1 from pathname if baseUrl already ends with /v1
      let adjustedPath = pathname;
      if (basePath.endsWith('/v1') && pathname.startsWith('/v1/')) {
        adjustedPath = pathname.slice(3); // /v1/messages -> /messages
      }
      // Strip ?beta=true — this triggers Anthropic context-management features
      // that OpenRouter doesn't support, causing 400 errors.
      adjustedPath = adjustedPath
        .replace(/[?&]beta=true/g, '')
        .replace(/\?$/, '');
      const upstream = new URL(basePath + adjustedPath, baseUrl);

      logger.info(
        { pathname, adjustedPath, upstreamUrl: upstream.href },
        'Proxy: forwarding request',
      );

      // ── HEADER WHITELIST ────────────────────────────────────────────
      // Only forward headers that OpenRouter expects. This strips
      // anthropic-beta, anthropic-version, and any future Anthropic-only
      // headers automatically.
      const ALLOWED_HEADERS = new Set([
        'content-type',
        'accept',
        'user-agent',
        'x-request-id',
      ]);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!ALLOWED_HEADERS.has(key)) continue;
        if (value) headers[key] = Array.isArray(value) ? value[0] : value;
      }
      if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers['authorization'] = `Bearer ${apiKey}`;
      }
      headers['host'] = upstream.hostname;
      // Update content-length to match the (possibly rewritten) body
      if (body.length > 0) {
        headers['content-length'] = String(body.length);
      }

      const options = {
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.pathname + (upstream.search || ''),
        method: req.method || 'POST',
        headers,
      };

      const transport = upstream.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(options, (proxyRes) => {
        logger.info(
          {
            url: pathname,
            status: proxyRes.statusCode,
            contentType: proxyRes.headers['content-type'],
          },
          'Proxy upstream response',
        );

        // For SSE streaming responses, ensure we don't buffer
        const responseHeaders = { ...proxyRes.headers };
        // Remove transfer-encoding to avoid chunked encoding issues with SSE
        delete responseHeaders['transfer-encoding'];
        // Ensure no content-length for streaming (it's chunked from upstream)
        delete responseHeaders['content-length'];

        res.writeHead(proxyRes.statusCode || 502, responseHeaders);

        // Flush each chunk immediately for SSE streaming
        proxyRes.on('data', (chunk: Buffer) => {
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          res.end();
        });
      });

      proxyReq.on('error', (err: any) => {
        logger.error(
          { err: err.message, url: pathname },
          'Proxy upstream error',
        );
        res.writeHead(502);
        res.end(`Proxy error: ${err.message}`);
      });

      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  });

  server.listen(PROXY_PORT, PROXY_HOST, () => {
    logger.info(
      { port: PROXY_PORT, upstream: baseUrl },
      'OpenRouter proxy started',
    );
  });

  proxyRunning = true;
  // Return the URL that agent containers (inside DinD) can reach
  // via the Docker bridge gateway
  return `http://172.17.0.1:${PROXY_PORT}`;
}
