#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { loadConfig } from './config/load.js'
import { Logger } from './core/logger.js'
import { runDemo } from './demo/demo.js'
import { formatDoctorReport, runDoctor } from './doctor.js'
import { runMcpStdio } from './mcp/server.js'
import { createMesh } from './runtime.js'
import { buildMcpGateway } from './slack/mcp-gateway.js'
import { SlackTransport } from './slack/transport.js'

// Node 22 ships a native dotenv parser. Load a local .env for the clone-and-run
// workflow while preserving explicitly exported values as the source of truth.
// MCP clients and containers may omit the file and inject env normally.
if (existsSync('.env')) {
  const exported = { ...process.env }
  loadEnvFile('.env')
  Object.assign(process.env, exported)
}

const USAGE = `slack-agent-mesh — portable Slack transport and coordination for existing agents

Usage:
  slack-agent-mesh serve   [--config <path>]     Start the Socket Mode broker (needs Slack creds)
  slack-agent-mesh mcp     [--config <path>]     Run the MCP server over stdio
  slack-agent-mesh doctor  [--config <path>]     Validate config and environment
  slack-agent-mesh demo    --script <path>       Run the credential-free scripted demo

Options:
  --config <path>   Path to mesh config (default: mesh.config.yaml)
  --script <path>   Demo script JSON (default: examples/demo-conversation.json)
  -h, --help        Show this help
`

interface ParsedArgs {
  command: string | undefined
  config: string
  script: string
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: undefined,
    config: 'mesh.config.yaml',
    script: 'examples/demo-conversation.json',
    help: false,
  }
  const rest = [...argv]
  if (rest[0] === '-h' || rest[0] === '--help') {
    out.help = true
    return out
  }
  out.command = rest.shift()
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '--config') out.config = rest.shift() ?? out.config
    else if (arg === '--script') out.script = rest.shift() ?? out.script
    else if (arg === '-h' || arg === '--help') out.help = true
  }
  return out
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command) {
    process.stdout.write(`${USAGE}\n`)
    return args.help ? 0 : 1
  }

  switch (args.command) {
    case 'demo': {
      const result = await runDemo(args.script)
      process.stdout.write(`${result.transcript}\n`)
      return 0
    }

    case 'doctor': {
      const report = runDoctor(args.config)
      process.stdout.write(`${formatDoctorReport(report)}\n`)
      return report.ok ? 0 : 1
    }

    case 'mcp': {
      // MCP works with or without Slack credentials. When a bot token is
      // present, mesh_send/mesh_reply post to real Slack via a live gateway;
      // otherwise the in-memory gateway lets agents exercise the tool surface
      // locally (and drives the credential-free demo).
      const config = loadConfig(args.config)
      const logger = new Logger({ debug: config.mesh.debug, level: 'info' })
      const { gateway, live } = await buildMcpGateway({ config, logger })
      logger.info('mcp gateway resolved', { live })
      const mesh = createMesh({ config, gateway, logger })
      await runMcpStdio(mesh)
      return 0
    }

    case 'serve': {
      const config = loadConfig(args.config)
      const logger = new Logger({ debug: config.mesh.debug, level: 'info' })
      const transport = new SlackTransport({ config, logger })
      const { stop } = await transport.start((gateway) => createMesh({ config, gateway, logger }))
      const shutdown = async () => {
        logger.info('shutting down')
        await stop()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      // Keep the process alive; the Socket Mode connection drives everything.
      await new Promise<void>(() => {})
      return 0
    }

    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}\n`)
      return 1
  }
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code
  },
  (err) => {
    process.stderr.write(`error: ${(err as Error).message}\n`)
    process.exitCode = 1
  },
)
