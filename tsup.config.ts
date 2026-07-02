import { defineConfig } from 'tsup'

// Two entry points:
//   .      → the core agent (no MCP, no node:* — safe for any browser bundle)
//   ./mcp  → the optional HTTP MCP connector, kept separate so
//            @modelcontextprotocol/sdk never enters the core bundle.
// All model providers, WebLLM, and the MCP SDK are external optional peers —
// consumers install only what they use; we import them dynamically at runtime.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    mcp: 'src/mcp/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: [
    'ai',
    'zod',
    'idb',
    '@ai-sdk/openai',
    '@ai-sdk/anthropic',
    '@ai-sdk/google',
    '@ai-sdk/openai-compatible',
    '@ai-sdk/xai',
    '@ai-sdk/deepseek',
    '@browser-ai/web-llm',
    '@browser-ai/core',
    '@mlc-ai/web-llm',
    '@modelcontextprotocol/sdk',
  ],
})
