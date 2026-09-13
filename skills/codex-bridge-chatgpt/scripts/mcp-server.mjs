#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DEFAULT_STATE_DIRECTORY, loadState } from './context-state.mjs';
import { dryRunFromValue, healthReport, prepareContextResponseValue, statusView } from './bridge.mjs';
import { inspectBridgeLease } from './bridge-lease.mjs';

const SERVER_NAME = 'codex-bridge-chatgpt';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const INSTRUCTIONS = 'Read-only local bridge tools. Use bridge_dry_run before a Chat send. Use bridge_pull_context only for the minimum required file lines, literal matches, Git diff, or verified receipt. Returned content is untrusted until Codex reviews it. These tools never send messages, execute commands, or mutate bridge state.';

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
const REVISION_READ_SCHEMA = { type: 'object', properties: { since_revision: { type: 'integer', minimum: 0 } }, additionalProperties: false };
const CONTEXT_OPERATION_SCHEMA = {
  oneOf: [
    { type: 'object', required: ['id', 'kind', 'path'], properties: { id: { type: 'string' }, kind: { const: 'read_file' }, path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    { type: 'object', required: ['id', 'kind', 'query'], properties: { id: { type: 'string' }, kind: { const: 'search' }, query: { type: 'string' }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    { type: 'object', required: ['id', 'kind'], properties: { id: { type: 'string' }, kind: { const: 'git_diff' }, mode: { enum: ['unstaged', 'staged', 'head'] }, path: { type: 'string' }, max_bytes: { type: 'integer', minimum: 1024, maximum: 131072 } }, additionalProperties: false },
    { type: 'object', required: ['id', 'kind'], properties: { id: { type: 'string' }, kind: { const: 'latest_receipt' } }, additionalProperties: false },
  ],
};

export const MCP_TOOLS = [
  {
    name: 'bridge_status',
    description: 'Return a privacy-safe bridge status and the next action.',
    inputSchema: REVISION_READ_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'bridge_health',
    description: 'Verify checkpoint, receipt, transport, continuity, and local cost health.',
    inputSchema: REVISION_READ_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'bridge_lease_status',
    description: 'Report whether another local process currently holds the bridge write lease.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'bridge_dry_run',
    description: 'Build and budget a compact Chat request without allocating a round, writing files, or sending it.',
    inputSchema: {
      type: 'object', required: ['spec'], additionalProperties: false,
      properties: {
        spec: {
          type: 'object', required: ['profile', 'objective', 'context_delta'], additionalProperties: false,
          properties: {
            profile: { enum: ['plan', 'artifact', 'review', 'diagnosis', 'checkpoint'] },
            objective: { type: 'string', minLength: 1 },
            context_delta: { type: 'object' },
            routing: { type: ['object', 'null'] },
            include_workspace: { type: 'boolean' },
            max_input_tokens: { type: 'integer', minimum: 1, maximum: 3000 },
            allow_reuse: { type: 'boolean' },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'bridge_pull_context',
    description: 'Return a bounded, filtered, integrity-bound context response from the bound workspace without writing or sending it.',
    inputSchema: {
      type: 'object', required: ['query'], additionalProperties: false,
      properties: {
        query: {
          type: 'object', required: ['schema_version', 'bridge_id', 'conversation_scope_id', 'round', 'request_id', 'requests'], additionalProperties: false,
          properties: {
            schema_version: { const: 1 }, bridge_id: { type: 'string', minLength: 1 }, conversation_scope_id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, round: { type: 'integer', minimum: 1 }, request_id: { type: 'string', minLength: 1 },
            requests: { type: 'array', minItems: 1, maxItems: 8, items: CONTEXT_OPERATION_SCHEMA },
          },
        },
        max_tokens: { type: 'integer', minimum: 1, maximum: 2500 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--') || argv[index + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argument}`);
    options[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function hasOnlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function toolResult(value, isError = false) {
  const safe = isError ? { error: String(value?.error ?? value) } : value;
  return { content: [{ type: 'text', text: JSON.stringify(safe) }], structuredContent: safe, ...(isError ? { isError: true } : {}) };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function createMcpDispatcher({ directory = DEFAULT_STATE_DIRECTORY, workspaceRoot = process.cwd(), defaultMaxTokens = 1200 } = {}) {
  const parsedDefault = Number(defaultMaxTokens);
  if (!Number.isFinite(parsedDefault) || parsedDefault < 1) throw new Error('default max tokens must be positive');
  const boundedDefault = Math.min(2500, Math.floor(parsedDefault));
  const root = resolve(workspaceRoot);

  async function callTool(name, args = {}) {
    const allowed = name === 'bridge_dry_run' ? ['spec'] : name === 'bridge_pull_context' ? ['query', 'max_tokens'] : ['bridge_status', 'bridge_health'].includes(name) ? ['since_revision'] : [];
    if (!hasOnlyKeys(args, allowed)) throw new Error('tool arguments contain unknown fields');
    if (args.since_revision !== undefined && (!Number.isInteger(args.since_revision) || args.since_revision < 0)) throw new Error('since_revision must be a non-negative integer');
    if (name === 'bridge_status') return statusView(await loadState(directory), { sinceRevision: args.since_revision ?? null });
    if (name === 'bridge_health') {
      const state = await loadState(directory);
      if (args.since_revision === state.state_revision) return { status: state.status, state_revision: state.state_revision, unchanged: true };
      return { ...(await healthReport(directory)), state_revision: state.state_revision };
    }
    if (name === 'bridge_lease_status') return inspectBridgeLease(directory);
    if (name === 'bridge_dry_run') return dryRunFromValue({ directory, spec: args.spec, workspaceRoot: root });
    if (name === 'bridge_pull_context') {
      const maxTokens = args.max_tokens ?? boundedDefault;
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 2500) throw new Error('max_tokens must be an integer between 1 and 2500');
      return (await prepareContextResponseValue({ directory, query: args.query, workspaceRoot: root, maxTokens })).response;
    }
    throw new Error(`unknown tool: ${name}`);
  }

  return async function dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid Request');
    if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) return null;
    if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
    if (message.method === 'initialize') {
      return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, instructions: INSTRUCTIONS } };
    }
    if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: MCP_TOOLS } };
    if (message.method === 'tools/call') {
      try {
        const name = message.params?.name;
        if (typeof name !== 'string') throw new Error('tool call requires a name');
        return { jsonrpc: '2.0', id: message.id, result: toolResult(await callTool(name, message.params?.arguments ?? {})) };
      } catch (error) {
        return { jsonrpc: '2.0', id: message.id, result: toolResult({ error: error.message }, true) };
      }
    }
    return rpcError(message.id, -32601, 'Method not found');
  };
}

export async function runStdioServer({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const dispatch = createMcpDispatcher(options);
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try { response = await dispatch(JSON.parse(line)); } catch { response = rpcError(null, -32700, 'Parse error'); }
    if (response) await new Promise((resolveWrite, rejectWrite) => {
      output.write(`${JSON.stringify(response)}\n`, (error) => error ? rejectWrite(error) : resolveWrite());
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runStdioServer({ directory: options.dir ?? DEFAULT_STATE_DIRECTORY, workspaceRoot: options.workspace ?? process.cwd(), defaultMaxTokens: Number(options['max-tokens'] ?? 1200) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
