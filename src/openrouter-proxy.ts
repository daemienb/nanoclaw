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

  const server = http.createServer((req, res) => {
    const pathname = req.url || '/';

    // Intercept count_tokens — return fake response
    if (pathname.includes('/count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1000 }));
      return;
    }

    // Read request body and forward to upstream
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      const upstream = new URL(pathname, baseUrl);

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

      const options = {
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.pathname + (upstream.search || ''),
        method: req.method || 'POST',
        headers,
      };

      const transport = upstream.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err: any) => {
        logger.error({ err: err.message, url: pathname }, 'Proxy upstream error');
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

