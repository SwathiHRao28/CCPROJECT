# Distributed Real-Time Drawing Board with Mini-RAFT Consensus

## Overview
This project implements a distributed, real-time collaborative drawing board using WebSockets, Docker, and a simplified RAFT consensus protocol. The system consists of three replicas that maintain a shared stroke log through leader election, log replication, and fault tolerance.

## Architecture
- **Gateway Service**: WebSocket server that manages client connections, forwards strokes to the leader, and broadcasts committed strokes.
- **Replica Nodes (3)**: Implement RAFT-lite protocol with follower, candidate, and leader states. Handle log replication, elections, and commits.
- **Frontend**: Browser-based canvas for drawing with real-time synchronization.

## Setup and Running
1. Ensure Docker and Docker Compose are installed.
2. Run `docker-compose up -d` to start all services.
3. Open `http://localhost:3000` in multiple browser tabs for testing.

## Testing Results

### Demo Under Chaotic Conditions
The system was tested under various failure scenarios:
- **Rapid Failures**: Killed leader replicas multiple times, system elected new leaders within seconds.
- **Simultaneous Connections**: Multiple browser tabs connected and drawing simultaneously without lag.
- **Stress Testing**: Containers restarted while drawing; no data loss or disconnection.

Events observed:
- Initial election: Replica1 became leader (Term 2)
- Killed Replica1: Replica2 elected leader (Term 3)
- Restarted Replica1: Synced log from leader
- Killed Replica2: Replica1 re-elected leader (Term 4)
- Restarted Replica2: Synced and became follower

### Logs Demonstrating Failover Events
From container logs:
```
replica1: [4:02:56 AM] LEADER Elected for term 2
replica2: [4:03:49 AM] LEADER Elected for term 3
replica1: [4:05:26 AM] LEADER Elected for term 4
```
All replicas maintained identical log states after sync, confirming consistency.

### Consistent Canvas State After Restarts
- Drew strokes in browser before failures.
- After killing and restarting replicas, all nodes had matching log lengths (2779 bytes).
- Browser synced state immediately upon leader change, no blank screens.
- Restarted nodes caught up via `/sync-log` RPC.

## Key Features
- Zero-downtime hot-reload via bind mounts and nodemon.
- Automatic leader failover.
- Log replication with majority commits.
- Real-time WebSocket broadcasting.
- Fault tolerance: System remains available with 2+ healthy replicas.

## API Endpoints
- `/request-vote`: RAFT vote requests
- `/append-entries`: Log replication
- `/heartbeat`: Leader heartbeats
- `/sync-log`: Catch-up for restarted nodes
- `/stroke`: Submit new drawing strokes (leader only)
- `/state`: Get replica state and log
- `/health`: Health check

## Technologies
- Node.js, Express, WebSockets
- Docker, Docker Compose
- RAFT consensus protocol
