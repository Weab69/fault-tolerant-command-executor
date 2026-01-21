/**
 * Command Executors
 * 
 * Implementations of DELAY and HTTP_GET_JSON command types.
 */

import {
  Command,
  CommandResult,
  DelayPayload,
  DelayResult,
  HttpGetJsonPayload,
  HttpGetJsonResult,
  isDelayPayload,
  isHttpGetJsonPayload,
  MAX_BODY_SIZE,
} from '@fault-tolerant/shared';

/**
 * Execute a command based on its type
 */
export async function executeCommand(
  command: Command,
  onProgress?: () => void
): Promise<CommandResult> {
  switch (command.type) {
    case 'DELAY':
      if (!isDelayPayload(command.payload)) {
        throw new Error('Invalid DELAY payload');
      }
      return executeDelay(command.payload, onProgress);

    case 'HTTP_GET_JSON':
      if (!isHttpGetJsonPayload(command.payload)) {
        throw new Error('Invalid HTTP_GET_JSON payload');
      }
      return executeHttpGetJson(command.payload);

    default:
      throw new Error(`Unknown command type: ${command.type}`);
  }
}

/**
 * Execute DELAY command
 * 
 * Waits for the specified number of milliseconds and returns the actual time taken.
 * Calls onProgress periodically if provided (useful for heartbeats).
 */
async function executeDelay(
  payload: DelayPayload,
  onProgress?: () => void
): Promise<DelayResult> {
  const startTime = Date.now();
  const targetMs = payload.ms;

  console.log(`[EXECUTOR] Starting DELAY for ${targetMs}ms`);

  // For long delays, break into smaller chunks and call progress callback
  const chunkSize = 1000; // 1 second chunks
  let elapsed = 0;

  while (elapsed < targetMs) {
    const remaining = targetMs - elapsed;
    const sleepTime = Math.min(chunkSize, remaining);
    
    await sleep(sleepTime);
    elapsed = Date.now() - startTime;

    if (onProgress) {
      onProgress();
    }
  }

  const tookMs = Date.now() - startTime;
  console.log(`[EXECUTOR] DELAY completed in ${tookMs}ms (target: ${targetMs}ms)`);

  return {
    ok: true,
    tookMs,
  };
}

/**
 * Execute HTTP_GET_JSON command
 * 
 * Fetches JSON from the specified URL and returns status code and body.
 * Truncates body if it exceeds MAX_BODY_SIZE.
 */
async function executeHttpGetJson(
  payload: HttpGetJsonPayload
): Promise<HttpGetJsonResult> {
  const { url } = payload;

  console.log(`[EXECUTOR] Starting HTTP_GET_JSON for ${url}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Skipr-Agent/1.0',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    let body: object | string | null = null;
    let truncated = false;
    let bytesReturned = 0;

    // Read the body
    const text = await response.text();
    bytesReturned = Buffer.byteLength(text, 'utf8');

    // Truncate if too large
    if (bytesReturned > MAX_BODY_SIZE) {
      truncated = true;
      const truncatedText = text.slice(0, MAX_BODY_SIZE);
      
      // Try to parse as JSON
      if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(truncatedText);
        } catch {
          body = truncatedText + '... [truncated]';
        }
      } else {
        body = truncatedText + '... [truncated]';
      }
    } else {
      // Try to parse as JSON
      if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      } else {
        body = text;
      }
    }

    console.log(`[EXECUTOR] HTTP_GET_JSON completed: status=${response.status}, bytes=${bytesReturned}`);

    return {
      status: response.status,
      body,
      truncated,
      bytesReturned,
      error: null,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`[EXECUTOR] HTTP_GET_JSON failed: ${errorMessage}`);

    return {
      status: 0,
      body: null,
      truncated: false,
      bytesReturned: 0,
      error: errorMessage,
    };
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}