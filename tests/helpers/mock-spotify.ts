export type MockResponses = Record<string, unknown>;

export function mockFetch(responses: MockResponses): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = typeof input === "string" ? input : input.toString();
    const key = `${method} ${url}`;
    if (key in responses) {
      const body = responses[key];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${key}`);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
