// ============================================================================
// Command Types and Interfaces for Skipr Fault-Tolerant System
// ============================================================================

/**
 * Supported command types in the system
 */
export type CommandType = 'DELAY' | 'HTTP_GET_JSON';

/**
 * Command lifecycle states
 * - PENDING: Command created, waiting to be picked up by agent
 * - RUNNING: Command assigned to agent, execution in progress
 * - COMPLETED: Command executed successfully
 * - FAILED: Command execution failed or timed out
 */
export type CommandStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

// ============================================================================
// Command Payloads
// ============================================================================

/**
 * Payload for DELAY command
 */
export interface DelayPayload {
  ms: number;
}

/**
 * Payload for HTTP_GET_JSON command
 */
export interface HttpGetJsonPayload {
  url: string;
}

export type CommandPayload = DelayPayload | HttpGetJsonPayload;

// ============================================================================
// Command Results
// ============================================================================

/**
 * Result of DELAY command execution
 */
export interface DelayResult {
  ok: boolean;
  tookMs: number;
}

/**
 * Result of HTTP_GET_JSON command execution
 */
export interface HttpGetJsonResult {
  status: number;
  body: object | string | null;
  truncated: boolean;
  bytesReturned: number;
  error: string | null;
}

export type CommandResult = DelayResult | HttpGetJsonResult | null;

// ============================================================================
// Command Entity
// ============================================================================

/**
 * Full command entity stored in the database
 */
export interface Command {
  id: string;
  type: CommandType;
  payload: CommandPayload;
  status: CommandStatus;
  result: CommandResult;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Request body for POST /commands
 */
export interface CreateCommandRequest {
  type: CommandType;
  payload: CommandPayload;
}

/**
 * Response for POST /commands
 */
export interface CreateCommandResponse {
  commandId: string;
}

/**
 * Response for GET /commands/:id
 */
export interface GetCommandResponse {
  status: CommandStatus;
  result: CommandResult;
  agentId: string | null;
}

// ============================================================================
// Agent-Server Communication Types
// ============================================================================

/**
 * Request from agent to fetch next command
 */
export interface FetchCommandRequest {
  agentId: string;
}

/**
 * Response when command is available
 */
export interface FetchCommandResponse {
  command: Command | null;
}

/**
 * Request from agent to report command result
 */
export interface ReportResultRequest {
  agentId: string;
  commandId: string;
  status: 'COMPLETED' | 'FAILED';
  result: CommandResult;
  error?: string;
}

/**
 * Response for result report
 */
export interface ReportResultResponse {
  acknowledged: boolean;
  message?: string;
}

/**
 * Request from agent to check for unfinished commands after restart
 */
export interface SyncRequest {
  agentId: string;
}

/**
 * Response with unfinished command if any
 */
export interface SyncResponse {
  unfinishedCommand: Command | null;
}

// ============================================================================
// Agent Heartbeat (for detecting dead agents)
// ============================================================================

export interface HeartbeatRequest {
  agentId: string;
  commandId?: string;
}

export interface HeartbeatResponse {
  acknowledged: boolean;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface ServerConfig {
  port: number;
  dbPath: string;
  commandTimeout: number; // ms before RUNNING command is considered stale
}

export interface AgentConfig {
  serverUrl: string;
  pollInterval: number; // ms between polls
  agentId?: string; // Optional, generated if not provided
  killAfter?: number; // Crash after N cycles (for testing)
  randomFailures?: boolean; // Random crashes during execution
}

// ============================================================================
// Type Guards
// ============================================================================

export function isDelayPayload(payload: unknown): payload is DelayPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'ms' in payload &&
    typeof (payload as DelayPayload).ms === 'number'
  );
}

export function isHttpGetJsonPayload(payload: unknown): payload is HttpGetJsonPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'url' in payload &&
    typeof (payload as HttpGetJsonPayload).url === 'string'
  );
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_SERVER_PORT = 3000;
export const DEFAULT_POLL_INTERVAL = 1000; // 1 second
export const DEFAULT_COMMAND_TIMEOUT = 60000; // 60 seconds
export const MAX_BODY_SIZE = 10240; // 10KB max body size for HTTP_GET_JSON
