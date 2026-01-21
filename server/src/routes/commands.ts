/**
 * Command Routes - REST API endpoints for command management
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CommandDatabase } from '../db/database';
import {
  CreateCommandRequest,
  CreateCommandResponse,
  GetCommandResponse,
  CommandType,
  isDelayPayload,
  isHttpGetJsonPayload,
} from '@fault-tolerant/shared';

export function createCommandRoutes(db: CommandDatabase): Router {
  const router = Router();

  /**
   * POST /commands
   * Create a new command
   */
  router.post('/', (req: Request, res: Response) => {
    try {
      const body = req.body as CreateCommandRequest;

      // Validate request
      if (!body.type || !body.payload) {
        return res.status(400).json({ error: 'Missing type or payload' });
      }

      if (!isValidCommandType(body.type)) {
        return res.status(400).json({ error: 'Invalid command type. Must be DELAY or HTTP_GET_JSON' });
      }

      // Validate payload based on type
      const payloadError = validatePayload(body.type, body.payload);
      if (payloadError) {
        return res.status(400).json({ error: payloadError });
      }

      // Create command
      const commandId = uuidv4();
      db.createCommand(commandId, body.type, body.payload);

      console.log(`[API] Created command ${commandId} of type ${body.type}`);

      const response: CreateCommandResponse = { commandId };
      return res.status(201).json(response);
    } catch (error) {
      console.error('[API] Error creating command:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /commands/:id
   * Get command status and result
   */
  router.get('/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const command = db.getCommand(id);

      if (!command) {
        return res.status(404).json({ error: 'Command not found' });
      }

      const response: GetCommandResponse = {
        status: command.status,
        result: command.result,
        agentId: command.agentId,
      };

      return res.json(response);
    } catch (error) {
      console.error('[API] Error fetching command:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /commands
   * List all commands (for debugging/testing)
   */
  router.get('/', (_req: Request, res: Response) => {
    try {
      const commands = db.getAllCommands();
      return res.json({ commands });
    } catch (error) {
      console.error('[API] Error listing commands:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

/**
 * Type guard for valid command types
 */
function isValidCommandType(type: string): type is CommandType {
  return type === 'DELAY' || type === 'HTTP_GET_JSON';
}

/**
 * Validate payload based on command type
 */
function validatePayload(type: CommandType, payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload must be an object';
  }

  switch (type) {
    case 'DELAY':
      if (!isDelayPayload(payload)) {
        return 'DELAY payload must have "ms" as a positive number';
      }
      if (payload.ms <= 0) {
        return 'DELAY "ms" must be a positive number';
      }
      break;

    case 'HTTP_GET_JSON':
      if (!isHttpGetJsonPayload(payload)) {
        return 'HTTP_GET_JSON payload must have "url" as a string';
      }
      try {
        new URL(payload.url);
      } catch {
        return 'HTTP_GET_JSON "url" must be a valid URL';
      }
      break;
  }

  return null;
}