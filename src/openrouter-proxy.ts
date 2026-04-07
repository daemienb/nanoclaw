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

      // Rewrite model name and sanitize fields for OpenRouter compatibility
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString());
          let modified = false;

          // Rewrite model if OPENROUTER_MODEL is configured
          if (modelOverride && parsed.model) {
            logger.info(
              { from: parsed.model, to: modelOverride },
              'Proxy: rewriting model',
            );
            parsed.model = modelOverride;
            modified = true;
          }

          // Force stream to true for messages endpoint — some OpenRouter models
          // (e.g. Gemini) require streaming via the Anthropic messages API.
          // The SDK sometimes sends stream:false or stream:null.
          if ('stream' in parsed) {
            if (parsed.stream !== true) {
              logger.info(
                {
                  streamValue: parsed.stream,
                  streamType: typeof parsed.stream,
                },
                'Proxy: forcing stream=true',
              );
              parsed.stream = true;
              modified = true;
            }
          }
          // If stream is missing entirely, don't add it

          // Strip Anthropic-specific fields that cause 400 errors on
          // non-Anthropic models via OpenRouter (e.g. Gemini 3.x):
          //
          // 1. thinking blocks — Gemini uses its own thinking API, not
          //    Anthropic's {"type":"thinking","budget_tokens":N} format.
          //    Sending this causes a 400 "unknown field" error.
          //
          // 2. betas header / anthropic-beta — extended thinking beta
          //    is Anthropic-specific and rejected by OpenRouter for Gemini.
          //
          // 3. thought_signature — when the SDK sends a follow-up with
          //    a prior thinking block, it includes thought_signature in
          //    the content array. Strip these before forwarding.
          if (parsed.thinking !== undefined) {
            logger.info('Proxy: stripping thinking field for OpenRouter');
            delete parsed.thinking;
            modified = true;
          }
          if (Array.isArray(parsed.betas)) {
            const filtered = parsed.betas.filter(
              (b: string) =>
                !b.includes('thinking') && !b.includes('interleaved'),
            );
            if (filtered.length !== parsed.betas.length) {
              logger.info('Proxy: stripping thinking betas for OpenRouter');
              parsed.betas = filtered.length > 0 ? filtered : undefined;
              modified = true;
            }
          }
          // Strip thought_signature from message content blocks
          if (Array.isArray(parsed.messages)) {
            for (const msg of parsed.messages) {
              if (Array.isArray(msg.content)) {
                const before = msg.content.length;
                msg.content = msg.content.filter(
                  (block: { type?: string }) =>
                    block.type !== 'thinking' &&
                    block.type !== 'redacted_thinking',
                );
                if (msg.content.length !== before) {
                  logger.info(
                    'Proxy: stripped thinking blocks from message content',
                  );
                  modified = true;
                }
              }
            }
          }

          if (modified) {
            body = Buffer.from(JSON.stringify(parsed));
          }
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
      const upstream = new URL(basePath + adjustedPath, baseUrl);

      logger.info(
        { pathname, adjustedPath, upstreamUrl: upstream.href },
        'Proxy: forwarding request',
      );

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === 'host' || key === 'connection') continue;
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
