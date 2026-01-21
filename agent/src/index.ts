/**
 * Skipr Agent
 * 
 * Command execution worker with fault tolerance. 
 * 
 * Features:
 * - Polls server for commands
 * - Executes DELAY and HTTP_GET_JSON commands
 * - Sends heartbeats during execution
 * - Handles crash recovery on restart
 * - Supports failure simulation flags
 * 
 * Usage:
 *   node agent.js [options]
 *   
 * Options:
 *   --kill-after=N      Crash after N polling cycles
 *   --random-failures   Random crashes during command execution
 *   --agent-id=ID       Use specific agent ID (otherwise persisted/generated)
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import {
  Command,
  FetchCommandResponse,
  ReportResultResponse,
  SyncResponse,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_SERVER_PORT,
} from '@fault-tolerant/shared';
import { executeCommand } from './executor/commands';

// ============================================================================ 
// Configuration
// ============================================================================ 

interface AgentConfig {
  serverUrl: string;
  pollInterval: number;
  agentId: string;
  killAfter: number | null;
  randomFailures: boolean;
  dataPath: string;
}

function parseArgs(): Partial<AgentConfig> {
  const config: Partial<AgentConfig> = {};
  
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--kill-after=')) {
      config.killAfter = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--random-failures') {
      config.randomFailures = true;
    } else if (arg.startsWith('--agent-id=')) {
      config.agentId = arg.split('=')[1];
    } else if (arg.startsWith('--server=')) {
      config.serverUrl = arg.split('=')[1];
    } else if (arg.startsWith('--poll-interval=')) {
      config.pollInterval = parseInt(arg.split('=')[1], 10);
    }
  }
  
  return config;
}

function loadConfig(): AgentConfig {
  const args = parseArgs();
  const dataPath = process.env.AGENT_DATA_PATH || path.join(__dirname, '../data');
  
  // Ensure data directory exists
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true });
  }
  
  return {
    serverUrl: args.serverUrl || process.env.SERVER_URL || `http://localhost:${DEFAULT_SERVER_PORT}`,
    pollInterval: args.pollInterval || parseInt(process.env.POLL_INTERVAL || String(DEFAULT_POLL_INTERVAL), 10),
    agentId: args.agentId || loadOrCreateAgentId(dataPath),
    killAfter: args.killAfter ?? (process.env.KILL_AFTER ? parseInt(process.env.KILL_AFTER, 10) : null),
    randomFailures: args.randomFailures || process.env.RANDOM_FAILURES === 'true',
    dataPath,
  };
}

/**
 * Load existing agent ID from file or create a new one
 * This ensures the agent maintains its identity across restarts
 */
function loadOrCreateAgentId(dataPath: string): string {
  const idFile = path.join(dataPath, 'agent-id.txt');
  
  if (fs.existsSync(idFile)) {
    const existingId = fs.readFileSync(idFile, 'utf-8').trim();
    console.log(`[AGENT] Loaded existing agent ID: ${existingId}`);
    return existingId;
  }
  
  const newId = `agent-${uuidv4().slice(0, 8)}`;
  fs.writeFileSync(idFile, newId);
  console.log(`[AGENT] Created new agent ID: ${newId}`);
  return newId;
}

// ============================================================================ 
// HTTP Client
// ============================================================================ 

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  delay = 1000
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`[AGENT] Request failed, retrying in ${delay}ms...`);
      await sleep(delay);
      delay *= 2; // Exponential backoff
    }
  }
  throw new Error('Unreachable');
}

// ============================================================================ 
// Server Communication
// ============================================================================ 

async function syncWithServer(config: AgentConfig): Promise<Command | null> {
  try {
    const response = await fetchWithRetry(
      `${config.serverUrl}/agent/sync`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: config.agentId }),
      }
    );
    
    if (!response.ok) {
      console.error(`[AGENT] Sync failed: ${response.status}`);
      return null;
    }
    
    const data = await response.json() as SyncResponse;
    return data.unfinishedCommand;
  } catch (error) {
    console.error('[AGENT] Sync error:', error);
    return null;
  }
}

async function fetchNextCommand(config: AgentConfig): Promise<Command | null> {
  try {
    const response = await fetchWithRetry(
      `${config.serverUrl}/agent/fetch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: config.agentId }),
      }
    );
    
    if (!response.ok) {
      console.error(`[AGENT] Fetch failed: ${response.status}`);
      return null;
    }
    
    const data = await response.json() as FetchCommandResponse;
    return data.command;
  } catch (error) {
    console.error('[AGENT] Fetch error:', error);
    return null;
  }
}

async function reportResult(
  config: AgentConfig,
  commandId: string,
  status: 'COMPLETED' | 'FAILED',
  result: unknown,
  error?: string
): Promise<boolean> {
  try {
    const response = await fetchWithRetry(
      `${config.serverUrl}/agent/result`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: config.agentId,
          commandId,
          status,
          result,
          error,
        }),
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AGENT] Report result failed: ${response.status} - ${errorText}`);
      return false;
    }
    
    const data = await response.json() as ReportResultResponse;
    return data.acknowledged;
  } catch (error) {
    console.error('[AGENT] Report result error:', error);
    return false;
  }
}

async function sendHeartbeat(config: AgentConfig, commandId?: string): Promise<void> {
  try {
    await fetch(`${config.serverUrl}/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: config.agentId,
        commandId,
      }),
    });
  } catch {
    // Heartbeat failures are not critical
  }
}

// ============================================================================ 
// Failure Simulation
// ============================================================================ 

function maybeSimulateCrash(config: AgentConfig, context: string): void {
  if (config.randomFailures && Math.random() < 0.2) { // 20% chance
    console.log(`[AGENT] 💥 SIMULATED CRASH during ${context}`);
    process.exit(1);
  }
}

// ============================================================================ 
// Main Agent Loop
// ============================================================================ 

class Agent {
  private config: AgentConfig;
  private pollCount = 0;
  private running = true;
  private currentCommand: Command | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Skipr Agent Starting...');
    console.log('='.repeat(60));
    console.log(`Agent ID: ${this.config.agentId}`);
    console.log(`Server URL: ${this.config.serverUrl}`);
    console.log(`Poll Interval: ${this.config.pollInterval}ms`);
    console.log(`Kill After: ${this.config.killAfter ?? 'disabled'}`);
    console.log(`Random Failures: ${this.config.randomFailures}`);
    console.log('='.repeat(60));

    // Setup graceful shutdown
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));

    // Check for unfinished commands from previous run
    await this.handleUnfinishedCommand();

    // Start main polling loop
    await this.pollLoop();
  }

  /**
   * Handle unfinished commands from previous agent run
   * 
   * Strategy:
   * - On startup, sync with server to check for assigned commands
   * - If found, the command state is unknown (we may have completed it but crashed before reporting)
   * - We report it as FAILED to ensure idempotency (better to retry than double-execute)
   * - Alternative: Could try to detect partial state, but that's more complex
   */
  private async handleUnfinishedCommand(): Promise<void> {
    console.log('[AGENT] Syncing with server for unfinished commands...');
    
    const unfinishedCommand = await syncWithServer(this.config);
    
    if (unfinishedCommand) {
      console.log(`[AGENT] Found unfinished command: ${unfinishedCommand.id} (${unfinishedCommand.type})`);
      console.log('[AGENT] Marking as FAILED (crash recovery - state unknown)');
      
      // Report as failed - the server will reset to PENDING for retry
      await reportResult(
        this.config,
        unfinishedCommand.id,
        'FAILED',
        null,
        'Agent crashed during execution - state unknown'
      );
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      this.pollCount++;

      // Check kill-after limit
      if (this.config.killAfter !== null && this.pollCount > this.config.killAfter) {
        console.log(`[AGENT] 💥 KILL-AFTER triggered (${this.config.killAfter} cycles)`);
        process.exit(1);
      }

      // Send heartbeat
      await sendHeartbeat(this.config, this.currentCommand?.id);

      // Random failure during polling
      maybeSimulateCrash(this.config, 'polling');

      // Fetch next command
      const command = await fetchNextCommand(this.config);

      if (command) {
        this.currentCommand = command;
        await this.executeAndReport(command);
        this.currentCommand = null;
      } else {
        // No command available, wait before next poll
        await sleep(this.config.pollInterval);
      }
    }
  }

  private async executeAndReport(command: Command): Promise<void> {
    console.log(`[AGENT] Executing command ${command.id} (${command.type})`);

    // Random failure before execution
    maybeSimulateCrash(this.config, 'before execution');

    try {
      // Execute with periodic heartbeats
      const heartbeatInterval = setInterval(() => {
        sendHeartbeat(this.config, command.id);
      }, 5000); // Send heartbeat every 5 seconds

      const result = await executeCommand(command, () => {
        // Random failure during execution
        maybeSimulateCrash(this.config, 'during execution');
      });

      clearInterval(heartbeatInterval);

      // Random failure after execution but before reporting
      maybeSimulateCrash(this.config, 'after execution before report');

      // Report result
      const reported = await reportResult(this.config, command.id, 'COMPLETED', result);
      
      if (reported) {
        console.log(`[AGENT] Command ${command.id} completed and reported successfully`);
      } else {
        console.error(`[AGENT] Failed to report result for command ${command.id}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[AGENT] Command ${command.id} execution failed:`, errorMessage);

      // Report failure
      await reportResult(this.config, command.id, 'FAILED', null, errorMessage);
    }
  }

  private shutdown(signal: string): void {
    console.log(`\n[AGENT] Received ${signal}, shutting down...`);
    this.running = false;
    
    // If we have a current command, it will be left in RUNNING state
    // Server will detect stale heartbeat and reset it to PENDING
    
    process.exit(0);
  }
}

// ============================================================================ 
// Utilities
// ============================================================================ 

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================ 
// Entry Point
// ============================================================================ 

const config = loadConfig();
const agent = new Agent(config);

agent.start().catch(error => {
  console.error('[AGENT] Fatal error:', error);
  process.exit(1);
});
