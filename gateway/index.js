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
const clientIdentityMap = new Map(); // Store persistent clientId -> studentNumber
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
    clients.forEach((studentId, ws) => ws.readyState === WebSocket.OPEN && ws.send(leaderMsg));
}

function broadcastSync(logData) {
    const syncMsg = JSON.stringify({ type: 'sync', leaderId: currentLeaderId, data: logData });
    clients.forEach((studentId, ws) => ws.readyState === WebSocket.OPEN && ws.send(syncMsg));
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
    let assignedStudentId = null;

    function sendCurrentState() {
        if (assignedStudentId === null) return;
        ws.send(JSON.stringify({ type: 'identity_update', studentId: assignedStudentId }));
        ws.send(JSON.stringify({ type: 'leader_update', leaderId: currentLeaderId }));
        ws.send(JSON.stringify({ type: 'sync', leaderId: currentLeaderId, data: committedLog }));
    }

    ws.on('message', async msg => {
        const parsed = JSON.parse(msg);

        if (parsed.type === 'identify' && parsed.clientId) {
            if (clientIdentityMap.has(parsed.clientId)) {
                assignedStudentId = clientIdentityMap.get(parsed.clientId);
            } else {
                studentIdCounter++;
                assignedStudentId = studentIdCounter;
                clientIdentityMap.set(parsed.clientId, assignedStudentId);
            }
            clients.set(ws, assignedStudentId);

            const classMsg = JSON.stringify({ type: 'class_update', count: clients.size });
            clients.forEach((studentId, clientWs) => clientWs.readyState === WebSocket.OPEN && clientWs.send(classMsg));

            sendCurrentState();
            return;
        }

        if (parsed.type !== 'stroke') return;

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
    });

    ws.on('close', () => {
        clients.delete(ws);
        const classMsg = JSON.stringify({ type: 'class_update', count: clients.size });
        clients.forEach((studentId, clientWs) => clientWs.readyState === WebSocket.OPEN && clientWs.send(classMsg));
    });
});

app.post('/leader', async (req, res) => {
    const { leaderId, port } = req.body;
    currentLeaderId = leaderId;
    currentLeaderUrl = leaderId ? `http://${leaderId}:${port}` : null;
    console.log(`[GATEWAY] leader update received: ${leaderId} (${port})`);
    
    // Notify clients about the leader and sync the full log.
    broadcastLeaderUpdate(leaderId);

    if (currentLeaderUrl) {
        try {
            const stateRes = await axios.get(`${currentLeaderUrl}/state`, { timeout: 1000 });
            committedLog.length = 0;
            if (Array.isArray(stateRes.data.log)) {
                committedLog.push(...stateRes.data.log);
            }
            console.log(`[GATEWAY] synced ${committedLog.length} log entries from new leader`);
            broadcastSync(committedLog);
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