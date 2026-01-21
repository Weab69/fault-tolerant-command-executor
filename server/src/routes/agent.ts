/**
 * Agent Routes - Endpoints for agent-server communication
 */

import { Router, Request, Response } from 'express';
import { CommandDatabase } from '../db/database';
import {
  FetchCommandRequest,
  FetchCommandResponse,
  ReportResultRequest,
  ReportResultResponse,
  SyncRequest,
  SyncResponse,
  HeartbeatRequest,
  HeartbeatResponse,
} from '@fault-tolerant/shared';

export function createAgentRoutes(db: CommandDatabase): Router {
  const router = Router();

  /**
   * POST /agent/fetch
   * Agent requests the next available command
   * 
   * Behavior:
   * - If agent already has a RUNNING command, return that command
   * - Otherwise, assign the oldest PENDING command to the agent
   * - Returns null if no commands are available
   */
  router.post('/fetch', (req: Request, res: Response) => {
    try {
      const body = req.body as FetchCommandRequest;

      if (!body.agentId) {
        return res.status(400).json({ error: 'Missing agentId' });
      }

      const command = db.fetchNextCommand(body.agentId);

      console.log(
        command
          ? `[AGENT] Agent ${body.agentId} fetched command ${command.id} (${command.type})`
          : `[AGENT] Agent ${body.agentId} - no commands available`
      );

      const response: FetchCommandResponse = { command };
      return res.json(response);
    } catch (error) {
      console.error('[AGENT] Error fetching command:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /agent/result
   * Agent reports the result of command execution
   * 
   * Idempotency:
   * - Only accepts results from the agent that owns the command
   * - Only accepts results for commands in RUNNING state
   * - Duplicate reports are rejected gracefully
   */
  router.post('/result', (req: Request, res: Response) => {
    try {
      const body = req.body as ReportResultRequest;

      if (!body.agentId || !body.commandId || !body.status) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      if (body.status !== 'COMPLETED' && body.status !== 'FAILED') {
        return res.status(400).json({ error: 'Status must be COMPLETED or FAILED' });
      }

      const success = db.completeCommand(
        body.commandId,
        body.agentId,
        body.status,
        body.result,
        body.error
      );

      if (!success) {
        console.log(
          `[AGENT] Agent ${body.agentId} tried to report result for command ${body.commandId} but was rejected (not owner or not running)`
        );
        
        // Check if command exists and is already completed (idempotent response)
        const command = db.getCommand(body.commandId);
        if (command && (command.status === 'COMPLETED' || command.status === 'FAILED')) {
          // Already completed - acknowledge anyway for idempotency
          const response: ReportResultResponse = {
            acknowledged: true,
            message: 'Command already completed (idempotent)',
          };
          return res.json(response);
        }

        return res.status(409).json({
          error: 'Cannot complete command - not assigned to this agent or not in RUNNING state',
        });
      }

      console.log(`[AGENT] Agent ${body.agentId} completed command ${body.commandId} with status ${body.status}`);

      const response: ReportResultResponse = { acknowledged: true };
      return res.json(response);
    } catch (error) {
      console.error('[AGENT] Error reporting result:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /agent/sync
   * Agent checks for unfinished commands after restart
   * 
   * Purpose:
   * - After agent restart, check if there's a command still assigned
   * - Allows agent to resume or report the command appropriately
   */
  router.post('/sync', (req: Request, res: Response) => {
    try {
      const body = req.body as SyncRequest;

      if (!body.agentId) {
        return res.status(400).json({ error: 'Missing agentId' });
      }

      const unfinishedCommand = db.getUnfinishedCommand(body.agentId);

      console.log(
        unfinishedCommand
          ? `[AGENT] Agent ${body.agentId} sync - found unfinished command ${unfinishedCommand.id}`
          : `[AGENT] Agent ${body.agentId} sync - no unfinished commands`
      );

      const response: SyncResponse = { unfinishedCommand };
      return res.json(response);
    } catch (error) {
      console.error('[AGENT] Error syncing:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /agent/heartbeat
   * Agent sends periodic heartbeat to indicate it's alive
   * 
   * Purpose:
   * - Allows server to detect dead agents
   * - Commands from dead agents can be reclaimed after timeout
   */
  router.post('/heartbeat', (req: Request, res: Response) => {
    try {
      const body = req.body as HeartbeatRequest;

      if (!body.agentId) {
        return res.status(400).json({ error: 'Missing agentId' });
      }

      db.updateHeartbeat(body.agentId, body.commandId);

      const response: HeartbeatResponse = { acknowledged: true };
      return res.json(response);
    } catch (error) {
      console.error('[AGENT] Error processing heartbeat:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}