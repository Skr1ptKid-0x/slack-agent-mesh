/**
 * Public library surface. Import these to embed the mesh, build a custom
 * transport, or test the router in isolation. Nothing here pulls in a
 * model-provider SDK.
 */

export { CommandAdapter } from './adapters/command.js'
export { MockAdapter } from './adapters/mock.js'
export { buildAdapter, buildAdapterMap } from './adapters/registry.js'
export type { Adapter, AdapterRequest, AdapterResult } from './adapters/types.js'
export { WebhookAdapter } from './adapters/webhook.js'
export type {
  InjectAgentTurnInput,
  InjectAgentTurnResult,
} from './broker/broker.js'
export { Broker } from './broker/broker.js'
export { findAgent, loadConfig, parseConfig, validateConfig } from './config/load.js'
export {
  type AdapterConfig,
  type AgentConfig,
  assertNoInlineSecrets,
  ConfigSecretError,
  ConfigValidationError,
  type MeshConfig,
} from './config/schema.js'
export { Logger } from './core/logger.js'
export {
  extractMentions,
  extractMentionTokens,
  mentionsAgent,
  stripUntrusted,
} from './core/mentions.js'
export { redactString, redactValue, registerSecret } from './core/redact.js'
export {
  type DelegationEdge,
  Router,
  type RouterOptions,
} from './core/router.js'
export {
  agentPrefix,
  type BoundedAgentText,
  boundText,
  EMPTY_BODY_PLACEHOLDER,
  formatBoundedAgentText,
  SLACK_MAX_TEXT,
  TRUNCATION_MARKER,
} from './core/text.js'
export type {
  AdmissionDecision,
  AdmissionReason,
  IngressMessage,
  TraceRecord,
  TurnRequest,
} from './core/types.js'
export { runDemo } from './demo/demo.js'
export { runDoctor } from './doctor.js'
export { createMcpServer, runMcpStdio } from './mcp/server.js'
export { createMesh, type Mesh, type RuntimeOptions } from './runtime.js'
export {
  MockGateway,
  type PostedMessage,
  type PostMessageInput,
  type SlackGateway,
  type ThreadMessage,
} from './slack/gateway.js'
export { normalizeSlackEvent, type RawSlackEvent } from './slack/ingress.js'
export {
  buildMcpGateway,
  type McpGatewayOptions,
  type ResolvedMcpGateway,
} from './slack/mcp-gateway.js'
export { resolveSlackCredentials, SlackTransport } from './slack/transport.js'
export { WebApiGateway } from './slack/web-gateway.js'
export { SqliteStore } from './store/sqlite.js'
export type { Store, ThreadRecord } from './store/store.js'
