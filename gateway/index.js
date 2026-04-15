const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' })); // Allow larger batches
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

let currentLeaderUrl = null;
let currentLeaderId = null;
let studentIdCounter = 0;
const clients = new Map(); // Store ws -> studentNumber
const committedLog = [];
const replicaPorts = [4001, 4002, 4003];

async function discoverLeaderFromReplicas() {
    for (const port of replicaPorts) {
        try {
            const res = await axios.get(`http://localhost:${port}/state`, { timeout: 500 });
            if (res.data && res.data.state === 'Leader' && res.data.id) {
                return { leaderId: res.data.id, port, log: Array.isArray(res.data.log) ? res.data.log : [] };
            }
        } catch (e) {
            // ignore unreachable replica
        }
    }
    return null;
}

function broadcastLeaderUpdate(leaderId) {
    const leaderMsg = JSON.stringify({ type: 'leader_update', leaderId });
    clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(leaderMsg));
}

function broadcastSync(logData) {
    const syncMsg = JSON.stringify({ type: 'sync', data: logData });
    clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(syncMsg));
}

async function refreshLeaderState(leaderId, port, sourceLog = []) {
    currentLeaderId = leaderId;
    currentLeaderUrl = leaderId ? `http://${leaderId}:${port}` : null;
    console.log(`[GATEWAY] refreshed leader state: ${leaderId} @ ${port}`);
    broadcastLeaderUpdate(leaderId);
    committedLog.length = 0;
    if (Array.isArray(sourceLog)) {
        committedLog.push(...sourceLog);
    }
    broadcastSync(committedLog);
}

wss.on('connection', ws => {
    studentIdCounter++;
    const myStudentId = studentIdCounter;
    clients.set(ws, myStudentId);

    // Tell this client who they are
    ws.send(JSON.stringify({ type: 'identity_update', studentId: myStudentId }));

    // Tell everyone about the new class size
    const classMsg = JSON.stringify({ type: 'class_update', count: clients.size });
    clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(classMsg));

    ws.send(JSON.stringify({ type: 'leader_update', leaderId: currentLeaderId }));

    if (committedLog.length > 0) {
        ws.send(JSON.stringify({ type: 'sync', data: committedLog }));
    } else if (currentLeaderUrl) {
        axios.get(`${currentLeaderUrl}/state`, { timeout: 1000 })
            .then(res => {
                if (Array.isArray(res.data.log)) {
                    committedLog.push(...res.data.log);
                }
                ws.send(JSON.stringify({ type: 'sync', data: res.data.log }));
            })
            .catch(() => {});
    }

    ws.on('message', async msg => {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'stroke') {
            const sendStroke = async (url) => {
                await axios.post(`${url}/stroke`, parsed.data, { timeout: 2000 });
            };

            if (currentLeaderUrl) {
                try {
                    await sendStroke(currentLeaderUrl);
                    return;
                } catch (err) {
                    console.warn("[GATEWAY] Stroke failed on current leader, rediscovering leader...");
                }
            }

            const leaderInfo = await discoverLeaderFromReplicas();
            if (leaderInfo) {
                await refreshLeaderState(leaderInfo.leaderId, leaderInfo.port, leaderInfo.log);
                try {
                    await sendStroke(currentLeaderUrl);
                    return;
                } catch (err) {
                    console.error("[GATEWAY] Stroke retry failed on discovered leader", err.message);
                }
            }

            console.error("[GATEWAY] Stroke failed: no leader available or stroke could not be delivered");
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        // Update everyone with the new smaller class size
        const classMsg = JSON.stringify({ type: 'class_update', count: clients.size });
        clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(classMsg));
    });
});

app.post('/leader', async (req, res) => {
    const { leaderId, port } = req.body;
    currentLeaderId = leaderId;
    currentLeaderUrl = leaderId ? `http://${leaderId}:${port}` : null;
    console.log(`[GATEWAY] leader update received: ${leaderId} (${port})`);
    
    // Notify clients about the leader
    const leaderMsg = JSON.stringify({ type: 'leader_update', leaderId });
    clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(leaderMsg));

    // IMPORTANT: If a new leader is elected, fetch its log and sync everyone.
    // This fixes the "blank screen" bug during failover.
    if (currentLeaderUrl) {
        try {
            const stateRes = await axios.get(`${currentLeaderUrl}/state`, { timeout: 1000 });
            committedLog.length = 0;
            if (Array.isArray(stateRes.data.log)) {
                committedLog.push(...stateRes.data.log);
            }
            console.log(`[GATEWAY] synced ${committedLog.length} log entries from new leader`);
            const syncMsg = JSON.stringify({ type: 'sync', data: committedLog });
            clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(syncMsg));
        } catch (err) {
            console.error("[GATEWAY] Failed to sync state from new leader", err.message);
        }
    }

    res.sendStatus(200);
});

app.post('/broadcast', (req, res) => {
    const data = req.body;
    const strokes = data.type === 'batch' ? data.strokes : [data];
    if (Array.isArray(strokes) && strokes.length > 0) {
        committedLog.push(...strokes);
        console.log(`[GATEWAY] broadcast ${strokes.length} committed strokes, cache size=${committedLog.length}`);
    }

    const msg = JSON.stringify({ 
        type: 'stroke', 
        data: strokes
    });

    clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(msg));
    res.sendStatus(200);
});

server.listen(3000, () => console.log("Gateway listening on 3000"));