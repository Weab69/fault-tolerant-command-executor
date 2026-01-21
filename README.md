# Fault-Tolerant Single-Agent Command Execution System

A robust, crash-resilient command execution system built with Node.js and TypeScript. The system consists of a Control Server that orchestrates commands and an Agent that executes them, with full fault tolerance across crashes and restarts.

## 🚀 Quick Start

### Using Docker (Recommended)

```bash
# Start both server and agent
docker-compose up --build

# In another terminal, test the API
curl -X POST http://localhost:3000/commands \
  -H "Content-Type: application/json" \
  -d '{"type": "DELAY", "payload": {"ms": 5000}}'

# Check command status
curl http://localhost:3000/commands/<commandId>
```

### Local Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Terminal 1: Start the server
npm run start:server

# Terminal 2: Start the agent
npm run start:agent
```

## 📐 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client                                   │
│              POST /commands    GET /commands/:id                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Control Server                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  REST API   │  │  Command    │  │      SQLite DB          │  │
│  │  Endpoints  │──│  Manager    │──│  - commands             │  │
│  │             │  │             │  │  - agent_heartbeats     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                          │                                       │
│            ┌─────────────┴─────────────┐                        │
│            │     Agent Endpoints       │                        │
│            │  /agent/fetch             │                        │
│            │  /agent/result            │                        │
│            │  /agent/sync              │                        │
│            │  /agent/heartbeat         │                        │
│            └─────────────┬─────────────┘                        │
└──────────────────────────┼──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Agent                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Poller    │  │  Command    │  │     Executors           │  │
│  │             │──│  Handler    │──│  - DELAY                │  │
│  │             │  │             │  │  - HTTP_GET_JSON        │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Persistent Agent ID (survives restarts)                    ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Control Server** | Accept commands, persist state, coordinate with agent, recover from crashes |
| **Agent** | Poll for work, execute commands, report results, handle its own crashes |
| **SQLite DB** | ACID-compliant persistence with WAL mode for crash safety |

## 🔄 Command Lifecycle

```
     ┌──────────┐
     │ PENDING  │ ← Command created via POST /commands
     └────┬─────┘
          │ Agent fetches (POST /agent/fetch)
          ▼
     ┌──────────┐
     │ RUNNING  │ ← Assigned to agent, execution in progress
     └────┬─────┘
          │
    ┌─────┴─────┐
    │           │
    ▼           ▼
┌──────────┐ ┌──────────┐
│COMPLETED │ │  FAILED  │ ← Agent reports result (POST /agent/result)
└──────────┘ └──────────┘
```

## 💾 Persistence Approach

### Why SQLite?

1. **ACID Compliance**: Guarantees atomic state transitions
2. **WAL Mode**: Write-Ahead Logging enables crash recovery
3. **Zero External Dependencies**: No need for separate database server
4. **Deterministic**: Predictable behavior across restarts

### Database Schema

```sql
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'DELAY' or 'HTTP_GET_JSON'
  payload TEXT NOT NULL,        -- JSON serialized
  status TEXT NOT NULL,         -- PENDING/RUNNING/COMPLETED/FAILED
  result TEXT,                  -- JSON serialized result
  agent_id TEXT,               -- Assigned agent
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE agent_heartbeats (
  agent_id TEXT PRIMARY KEY,
  last_heartbeat TEXT NOT NULL,
  current_command_id TEXT
);
```

## 🛡️ Crash Recovery Explanation

### Server Crash Recovery

**Strategy**: On startup, reset all `RUNNING` commands to `PENDING`

**Rationale**:
- Commands in `RUNNING` state during a crash have unknown execution state
- Resetting to `PENDING` allows the agent to retry
- This is safer than marking `FAILED` (which loses potentially valid work)
- Idempotency is maintained because each command is still processed exactly once

```typescript
// server/src/db/database.ts
private recoverFromCrash(): void {
  const runningCommands = this.db.prepare(`
    SELECT id FROM commands WHERE status = 'RUNNING'
  `).all();

  if (runningCommands.length > 0) {
    const resetStmt = this.db.prepare(`
      UPDATE commands 
      SET status = 'PENDING', agent_id = NULL, started_at = NULL
      WHERE status = 'RUNNING'
    `);
    resetStmt.run();
  }
}
```

### Agent Crash Recovery

**Strategy**: On startup, sync with server and report any unfinished command as `FAILED`

**Rationale**:
- Agent cannot know if it completed execution before crashing
- Reporting as `FAILED` triggers server to reset to `PENDING` for retry
- Prevents any possibility of double execution

```typescript
// agent/src/index.ts
private async handleUnfinishedCommand(): Promise<void> {
  const unfinishedCommand = await syncWithServer(this.config);
  
  if (unfinishedCommand) {
    // Report as failed - server will reset to PENDING for retry
    await reportResult(
      this.config,
      unfinishedCommand.id,
      'FAILED',
      null,
      'Agent crashed during execution'
    );
  }
}
```

### Stale Command Detection

The server periodically checks for agents that haven't sent heartbeats:

```typescript
checkStaleCommands(timeoutMs: number): number {
  // Find agents with stale heartbeats
  // Reset their commands to PENDING
}
```

## ⚖️ Trade-offs & Design Decisions

### 1. Single Agent Assignment

**Decision**: One command assigned to one agent at a time

**Trade-off**: 
- ✅ Simplifies idempotency guarantees
- ✅ No coordination needed between agents
- ❌ No parallelism (intentional per spec)

### 2. Heartbeat-Based Liveness

**Decision**: Agent sends heartbeats during execution

**Trade-off**:
- ✅ Detects dead agents quickly
- ✅ Allows server to reclaim stuck commands
- ❌ Additional network traffic
- ❌ Needs tuning (timeout too short = false positives)

### 3. RUNNING → PENDING on Crash

**Decision**: Reset unfinished commands to PENDING, not FAILED

**Trade-off**:
- ✅ Automatic retry without manual intervention
- ✅ No work is lost
- ❌ Potential for re-execution (mitigated by idempotent design)

### 4. Agent ID Persistence

**Decision**: Agent ID is stored in a file and survives restarts

**Trade-off**:
- ✅ Server can track which agent was executing what
- ✅ Enables proper crash recovery
- ❌ Requires persistent storage

### 5. Sequential Command Processing

**Decision**: Agent processes one command at a time

**Trade-off**:
- ✅ Simpler to reason about
- ✅ Matches spec requirement
- ❌ No parallelism within single agent

## 🔧 API Reference

### POST /commands
Create a new command.

**Request:**
```json
{
  "type": "DELAY" | "HTTP_GET_JSON",
  "payload": { ... }
}
```

**Response:**
```json
{ "commandId": "uuid" }
```

### GET /commands/:id
Get command status and result.

**Response:**
```json
{
  "status": "PENDING" | "RUNNING" | "COMPLETED" | "FAILED",
  "result": { ... },
  "agentId": "string | null"
}
```

### GET /commands
List all commands (for debugging).

### POST /agent/fetch
Agent requests next available command.

### POST /agent/result
Agent reports command completion.

### POST /agent/sync
Agent checks for unfinished commands on restart.

### POST /agent/heartbeat
Agent sends periodic heartbeat.

## 🧪 Testing

### Automated Tests

```bash
# Start server and agent first, then:
node scripts/test-crash-recovery.js

# Or skip manual tests:
SKIP_MANUAL=true node scripts/test-crash-recovery.js
```

### Manual Test Scenarios

#### 1. Server Restart During Execution

```bash
# Create a long command
curl -X POST http://localhost:3000/commands \
  -H "Content-Type: application/json" \
  -d '{"type": "DELAY", "payload": {"ms": 30000}}'

# While running, restart server
docker-compose restart server

# Check status - should be PENDING (reset for retry)
curl http://localhost:3000/commands/<id>
```

#### 2. Agent Crash During Execution

```bash
# Start agent with crash simulation
docker-compose up agent -e RANDOM_FAILURES=true

# Create command and watch for crash
curl -X POST http://localhost:3000/commands \
  -H "Content-Type: application/json" \
  -d '{"type": "DELAY", "payload": {"ms": 10000}}'
```

#### 3. Agent Crash After N Cycles

```bash
# Agent will crash after 5 polling cycles
KILL_AFTER=5 npm run start:agent
```

#### 4. Agent Crash with Random Failures

```bash
# Start agent with random crash simulation
RANDOM_FAILURES=true npm run start:agent
```

## 📁 Project Structure

```
.
├── shared/                 # Shared types and constants
│   ├── src/
│   │   └── index.ts       # Type definitions
│   ├── package.json
│   └── tsconfig.json
├── server/                 # Control Server
│   ├── src/
│   │   ├── index.ts       # Entry point
│   │   ├── db/
│   │   │   └── database.ts # SQLite persistence
│   │   └── routes/
│   │       ├── commands.ts # Command API
│   │       └── agent.ts    # Agent API
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── agent/                  # Agent Worker
│   ├── src/
│   │   ├── index.ts       # Entry point
│   │   └── executor/
│   │       └── commands.ts # Command executors
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── scripts/
│   └── test-crash-recovery.js
├── docker-compose.yml
├── package.json            # Workspace root
└── README.md
```

## 🌍 Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `DB_PATH` | `./data/commands.db` | SQLite database path |
| `COMMAND_TIMEOUT` | `60000` | Time before stale command reset (ms) |
| `STALE_CHECK_INTERVAL` | `10000` | How often to check for stale commands (ms) |

### Agent

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_URL` | `http://localhost:3000` | Control server URL |
| `POLL_INTERVAL` | `1000` | Time between polls (ms) |
| `AGENT_DATA_PATH` | `./data` | Path for agent ID persistence |
| `KILL_AFTER` | - | Crash after N cycles (testing) |
| `RANDOM_FAILURES` | `false` | Enable random crashes (testing) |

## 🤔 Additional Questions Addressed

### What happens when multiple agents exist?

Currently, the system is designed for a single agent. If multiple agents were to connect:
- Each would get a unique agent ID
- Commands are assigned to the first agent that requests
- No load balancing is implemented
- Could be extended with agent registration and round-robin assignment

### What if agent restarts quickly?

- Agent ID is persisted, so it reconnects with same identity
- On startup, agent syncs with server to find unfinished commands
- Reports them as FAILED, triggering retry
- Then resumes normal polling

### What if agent requests next command while one is running?

- Server checks if agent already has a RUNNING command
- If yes, returns that command (idempotent)
- If no, assigns the next PENDING command
- Prevents duplicate assignments

## 📝 Reflection: AI Usage

### How AI Was Used

- **Architecture design**: AI helped outline the fault-tolerance strategy and state machine
- **Boilerplate code**: Generated initial TypeScript interfaces and Express routes
- **Documentation**: AI assisted with README structure and explanations
- **Plan, review, then implement approach**: This iterative approach was used to ensure correctness and buildability at each step.

### Where AI Was Wrong

- Initial crash recovery suggested marking RUNNING as FAILED, but PENDING is better for automatic retry
- Had to manually adjust heartbeat timeout logic to avoid false positives
- SQLite WAL mode configuration needed manual research

### What Required Manual Debugging

- Transaction handling in SQLite for atomic state changes
- Race condition in agent sync logic
- Docker networking between containers
- Proper signal handling for graceful shutdown

---