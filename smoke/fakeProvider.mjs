// A stand-in for an OpenAI-style AI service, for the smoke tests: streams a canned reply over server-sent events and
// records every request it receives (so the tests can check what was sent, and that the key only went here).
import http from 'node:http';

export const REPLY = ['SAY\n• Sure, ', 'it was a booking system.\n• Happy to walk you through it.\nANSWER\n• ', 'I built a scheduling service.\nTYPE\n• It was a booking system, happy to share more.'];

export function startFakeProvider({ cors = true, status = 200, reply = REPLY } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const origin = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '60' };
    const send = (code, headers, body) => { res.writeHead(code, { ...(cors ? origin : {}), ...headers }); res.end(body); };
    if (req.method === 'OPTIONS') { send(204, {}); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* not json */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: json });
      if (status !== 200) { send(status, { 'content-type': 'application/json' }, JSON.stringify({ error: { message: 'fake failure' } })); return; }
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) { send(200, { 'content-type': 'application/json' }, JSON.stringify({ data: [{ id: 'fake-model' }] })); return; }
      if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { ...(cors ? origin : {}), 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let i = 0;
        const timer = setInterval(() => {
          if (i < reply.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply[i++] } }] })}\n\n`); return; }
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 800 } } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }, 25);
        res.on('close', () => clearInterval(timer));
        return;
      }
      send(404, { 'content-type': 'text/plain' }, 'not found');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ port, url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() });
  }));
}
