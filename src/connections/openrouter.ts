import type { ConnectionsConfig } from '../config.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * The OpenRouter connection: chat completions (the injector's routing LLM) and embeddings
 * (`ontology_search` query/node vectors) over the OpenRouter HTTP API.
 *
 * Unconfigured (no `OPENROUTER_API_KEY`) the connection stays inert and `maybe()` returns
 * undefined — ontology search falls back to keyword scoring and sync reports itself
 * disabled, so credential-free dev/test runs keep working.
 */

export interface OpenRouterClient {
  /** One JSON-mode chat turn; returns the parsed JSON object the model produced. */
  chatJson(opts: { system: string; user: string; maxTokens?: number }): Promise<unknown>;
  /** Embeds each text; returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenRouterConnection extends Connection<OpenRouterClient> {
  maybe(): OpenRouterClient | undefined;
}

/** Strips markdown code fences some models wrap around JSON despite json_object mode. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export interface OpenRouterDeps {
  /** Overrides fetch (tests inject a fake). */
  fetchFn?: typeof fetch;
}

export function createOpenRouterConnection(
  config: ConnectionsConfig['openRouter'],
  deps: OpenRouterDeps = {},
): OpenRouterConnection {
  const name = 'openrouter';
  const kind = 'openrouter' as const;
  const configured = Boolean(config.apiKey);
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  async function post(pathname: string, body: unknown): Promise<unknown> {
    const res = await fetchFn(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'personal-context-mcp',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`OpenRouter ${pathname} failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  const client: OpenRouterClient = {
    async chatJson({ system, user, maxTokens }): Promise<unknown> {
      const data = (await post('/chat/completions', {
        model: config.chatModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        max_tokens: maxTokens ?? 2048,
        temperature: 0,
      })) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('OpenRouter chat returned no content');
      }
      return extractJson(content);
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      const data = (await post('/embeddings', {
        model: config.embedModel,
        input: texts,
      })) as { data?: { index?: number; embedding?: number[] }[] };
      const rows = data.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error(
          `OpenRouter embeddings returned ${rows.length} vectors for ${texts.length} inputs`,
        );
      }
      const out: number[][] = new Array(texts.length);
      rows.forEach((row, i) => {
        out[row.index ?? i] = row.embedding ?? [];
      });
      return out;
    },
  };

  return {
    name,
    kind,
    get(): OpenRouterClient {
      if (!configured) {
        throw new Error('OpenRouter is not configured (OPENROUTER_API_KEY unset)');
      }
      return client;
    },
    maybe(): OpenRouterClient | undefined {
      return configured ? client : undefined;
    },
    async healthCheck(): Promise<ConnectionHealth> {
      return {
        name,
        kind,
        ok: true,
        detail: configured
          ? `${baseUrl} (chat ${config.chatModel}, embed ${config.embedModel})`
          : 'not configured — ontology search uses keyword fallback, sync disabled',
      };
    },
    async close(): Promise<void> {
      /* stateless HTTP; nothing to release */
    },
  };
}
