import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConnections } from '../../connections/registry.js';
import { discoverCollectionNames } from './discovery.js';

/** Best-effort live collection names; empty on any error so the prompt still renders. */
function liveNames(): string[] {
  try {
    return discoverCollectionNames(getConnections().localCorpus.get());
  } catch {
    return [];
  }
}

/**
 * Registers the `search-knowledge-base` prompt — a reusable template that walks the model through
 * the intended workflow (choose a collection, then `search_context`) for a natural-language question.
 * The candidate collections are read live from the local corpus, not a static list.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'search-knowledge-base',
    {
      title: 'Search a Taxfix knowledge base',
      description:
        'Guides the model to pick the right collection and run a semantic search to answer a question.',
      argsSchema: {
        question: z
          .string()
          .describe('The question to answer from the knowledge bases'),
        collection: z
          .string()
          .optional()
          .describe(
            'Optional target collection name; omit to let the model choose',
          ),
      },
    },
    async ({ question, collection }) => {
      let step: string;
      if (collection) {
        step = `Use the "${collection}" collection.`;
      } else {
        const names = liveNames();
        const from =
          names.length > 0 ? ` from: ${names.join(', ')}` : '';
        step = `First call the list_collections tool (or read the context-layer://collections resource) and choose the most relevant collection${from}.`;
      }
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `You are answering a question using Taxfix knowledge bases exposed by the context-layer MCP.\n\n` +
                `${step}\n` +
                `Then call search_context with that collection and query="${question}". ` +
                `Ground your answer in the returned payloads (cite title/path when present) and state clearly if nothing relevant was found.\n\n` +
                `Question: ${question}`,
            },
          },
        ],
      };
    },
  );
}
