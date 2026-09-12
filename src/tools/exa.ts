export async function searchWeb(query: string, numResults = 5) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error('EXA_API_KEY no está configurada.');
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: Math.min(Math.max(numResults, 1), 10),
      contents: { text: { maxCharacters: 2500 } },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Exa respondió HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json() as { results?: unknown[] };
  return data.results || [];
}
