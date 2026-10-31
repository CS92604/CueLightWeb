// Reads a server-sent-event response body as lines.

/** Yields each line of a streamed response body. Throws what the stream throws; the caller maps it to words. */
export async function* readLines(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffered = '';
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffered.search(/\r\n|\n|\r/)) >= 0) {
        const lineEnd = buffered[nl] === '\r' && buffered[nl + 1] === '\n' ? nl + 2 : nl + 1;
        yield buffered.slice(0, nl);
        buffered = buffered.slice(lineEnd);
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) yield buffered;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** The JSON payloads of the "data:" lines of an SSE body; "[DONE]" ends it; unparseable lines are skipped. */
export async function* readData(response, signal) {
  for await (const line of readLines(response, signal)) {
    if (!line.startsWith('data:')) continue; // blank lines, comments, event names
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    try { yield JSON.parse(data); } catch { /* skip */ }
  }
}
