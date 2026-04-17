#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';

async function main(): Promise<void> {
  const server = new Server(
    { name: 'fastowl', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as {
        type: 'object';
        properties?: Record<string, unknown>;
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const text = await tool.handler(
        (req.params.arguments ?? {}) as Record<string, unknown>
      );
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: (err as Error).message }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('fastowl-mcp error:', err);
  process.exit(1);
});
