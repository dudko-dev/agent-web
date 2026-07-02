import { defineConfig } from 'tsup'

// The optional provider peers: never bundled, imported dynamically at runtime
// so consumers install / map only what they use.
const OPTIONAL_PEERS = [
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
]

export default defineConfig([
  // Two entry points:
  //   .      → the core agent (no MCP, no node:* — safe for any browser bundle)
  //   ./mcp  → the optional HTTP MCP connector, kept separate so
  //            @modelcontextprotocol/sdk never enters the core bundle.
  // All model providers, WebLLM, and the MCP SDK are external optional peers —
  // consumers install only what they use; we import them dynamically at runtime.
  {
    entry: {
      index: 'src/index.ts',
      mcp: 'src/mcp/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    external: ['ai', 'zod', 'idb', ...OPTIONAL_PEERS],
  },
  // Standalone browser bundle (dist/agent-web.js) — the core with `ai`, `zod`
  // and `idb` bundled in, ready for a <script type="module"> tag, a CDN
  // (jsDelivr / unpkg), or a GitHub-release download. Optional provider peers
  // stay external: in a bundler-less page they resolve through an import map.
  {
    entry: { 'agent-web': 'src/index.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: true,
    dts: false,
    clean: false, // runs after the main config; must not wipe its output
    splitting: false, // ONE self-contained file, no chunk siblings
    noExternal: ['ai', 'zod', 'idb'],
    external: OPTIONAL_PEERS,
  },
])
