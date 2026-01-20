/**
 * SQLite Database Layer for Command Persistence
 * 
 * Design Decisions:
 * - Uses SQLite for ACID compliance and crash safety
 * - All state changes are transactional
 * - Handles crash recovery by resetting RUNNING commands to PENDING on startup
 */

import Database from 'better-sqlite3';
import { Command, CommandStatus, CommandType, CommandPayload, CommandResult } from '@fault-tolerant/shared';
import path from 'path';
import fs from 'fs';

export class CommandDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better crash recovery
    this.db.pragma('synchronous = NORMAL'); // Good balance of safety and performance
    
    this.initialize();
  }

  /**
   * Initialize database schema
   */
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        result TEXT,
        agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);
      CREATE INDEX IF NOT EXISTS idx_commands_agent_id ON commands(agent_id);

      -- Agent heartbeat tracking for detecting dead agents
      CREATE TABLE IF NOT EXISTS agent_heartbeats (
        agent_id TEXT PRIMARY KEY,
        last_heartbeat TEXT NOT NULL,
        current_command_id TEXT
      );
    `);

    // Handle crash recovery - reset any RUNNING commands to PENDING
    this.recoverFromCrash();
  }

  /**
   * Crash Recovery Strategy:
   * On server startup, find all RUNNING commands and reset them to PENDING.
   * 
   * Rationale:
   * - RUNNING commands during a crash have unknown state
   * - Marking them PENDING allows retry, maintaining idempotency
   * - The agent will re-fetch and re-execute if needed
   * - This is safer than marking FAILED (which loses work)
   * 
   * Alternative considered: Mark as FAILED
   * - Pro: No duplicate execution risk
   * - Con: Loses potentially valid work
   * - Con: Requires manual intervention to retry
   */
  private recoverFromCrash(): void {
    const runningCommands = this.db.prepare(`
      SELECT id FROM commands WHERE status = 'RUNNING'
    `).all() as { id: string }[];

    if (runningCommands.length > 0) {
      console.log(`[RECOVERY] Found ${runningCommands.length} commands in RUNNING state`);
      
      const resetStmt = this.db.prepare(`
        UPDATE commands 
        SET status = 'PENDING', agent_id = NULL, started_at = NULL, updated_at = ?
        WHERE status = 'RUNNING'
      `);
      
      const result = resetStmt.run(new Date().toISOString());
      console.log(`[RECOVERY] Reset ${result.changes} commands to PENDING state`);
    }
  }

  /**
   * Create a new command
   */
  createCommand(id: string, type: CommandType, payload: CommandPayload): Command {
    const now = new Date().toISOString();
    
    const stmt = this.db.prepare(`
      INSERT INTO commands (id, type, payload, status, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', ?, ?)
    `);
    
    stmt.run(id, type, JSON.stringify(payload), now, now);
    
    return {
      id,
      type,
      payload,
      status: 'PENDING',
      result: null,
      agentId: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
  }

  /**
   * Get a command by ID
   */
  getCommand(id: string): Command | null {
    const row = this.db.prepare(`
      SELECT * FROM commands WHERE id = ?
    `).get(id) as CommandRow | undefined;

    return row ? this.rowToCommand(row) : null;
  }

  /**
   * Fetch and assign the next pending command to an agent
   * Uses a transaction to ensure atomic assignment (no race conditions)
   */
  fetchNextCommand(agentId: string): Command | null {
    const transaction = this.db.transaction(() => {
      // First check if agent already has a command assigned
      const existingCommand = this.db.prepare(`
        SELECT * FROM commands 
        WHERE agent_id = ? AND status = 'RUNNING'
      `).get(agentId) as CommandRow | undefined;

      if (existingCommand) {
        // Agent already has a running command - return it
        return this.rowToCommand(existingCommand);
      }

      // Find next pending command
      const pendingCommand = this.db.prepare(`
        SELECT * FROM commands 
        WHERE status = 'PENDING'
        ORDER BY created_at ASC
        LIMIT 1
      `).get() as CommandRow | undefined;

      if (!pendingCommand) {
        return null;
      }

      // Assign to agent
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE commands 
        SET status = 'RUNNING', agent_id = ?, started_at = ?, updated_at = ?
        WHERE id = ?
      `).run(agentId, now, now, pendingCommand.id);

      // Update heartbeat
      this.updateHeartbeat(agentId, pendingCommand.id);

      return {
        ...this.rowToCommand(pendingCommand),
        status: 'RUNNING' as CommandStatus,
        agentId,
        startedAt: now,
        updatedAt: now,
      };
    });

    return transaction();
  }

  /**
   * Get unfinished command for an agent (used during agent restart sync)
   */
  getUnfinishedCommand(agentId: string): Command | null {
    const row = this.db.prepare(`
      SELECT * FROM commands 
      WHERE agent_id = ? AND status = 'RUNNING'
    `).get(agentId) as CommandRow | undefined;

    return row ? this.rowToCommand(row) : null;
  }

  /**
   * Complete a command with result
   */
  completeCommand(
    commandId: string, 
    agentId: string, 
    status: 'COMPLETED' | 'FAILED',
    result: CommandResult,
    error?: string
  ): boolean {
    const now = new Date().toISOString();
    
    // Verify the command is assigned to this agent and is running
    const command = this.db.prepare(`
      SELECT * FROM commands WHERE id = ? AND agent_id = ? AND status = 'RUNNING'
    `).get(commandId, agentId) as CommandRow | undefined;

    if (!command) {
      console.log(`[DB] Command ${commandId} not found or not assigned to agent ${agentId}`);
      return false;
    }

    const finalResult = error ? { ...result, error } : result;

    const stmt = this.db.prepare(`
      UPDATE commands 
      SET status = ?, result = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND agent_id = ?
    `);

    const changes = stmt.run(status, JSON.stringify(finalResult), now, now, commandId, agentId);
    
    // Clear heartbeat command
    this.updateHeartbeat(agentId, undefined);

    return changes.changes > 0;
  }

  /**
   * Update agent heartbeat
   */
  updateHeartbeat(agentId: string, commandId?: string): void {
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_heartbeats (agent_id, last_heartbeat, current_command_id)
      VALUES (?, ?, ?)
    `).run(agentId, now, commandId || null);
  }

  /**
   * Check for stale commands (agents that died without reporting)
   * Commands are considered stale if the agent hasn't sent a heartbeat in the timeout period
   */
  checkStaleCommands(timeoutMs: number): number {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    
    const transaction = this.db.transaction(() => {
      // Find agents with stale heartbeats
      const staleAgents = this.db.prepare(`
        SELECT agent_id FROM agent_heartbeats 
        WHERE last_heartbeat < ? AND current_command_id IS NOT NULL
      `).all(cutoff) as { agent_id: string }[];

      if (staleAgents.length === 0) {
        return 0;
      }

      const agentIds = staleAgents.map(a => a.agent_id);
      
      // Reset commands from stale agents to PENDING
      const now = new Date().toISOString();
      let resetCount = 0;
      
      for (const agentId of agentIds) {
        const result = this.db.prepare(`
          UPDATE commands 
          SET status = 'PENDING', agent_id = NULL, started_at = NULL, updated_at = ?
          WHERE agent_id = ? AND status = 'RUNNING'
        `).run(now, agentId);
        
        resetCount += result.changes;

        // Clear the heartbeat
        this.db.prepare(`
          UPDATE agent_heartbeats SET current_command_id = NULL WHERE agent_id = ?
        `).run(agentId);
      }

      return resetCount;
    });

    return transaction();
  }

  /**
   * Get all commands (for debugging)
   */
  getAllCommands(): Command[] {
    const rows = this.db.prepare(`
      SELECT * FROM commands ORDER BY created_at ASC
    `).all() as CommandRow[];

    return rows.map(row => this.rowToCommand(row));
  }

  /**
   * Convert database row to Command object
   */
  private rowToCommand(row: CommandRow): Command {
    return {
      id: row.id,
      type: row.type as CommandType,
      payload: JSON.parse(row.payload),
      status: row.status as CommandStatus,
      result: row.result ? JSON.parse(row.result) : null,
      agentId: row.agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Database row type
 */
interface CommandRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  result: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}
