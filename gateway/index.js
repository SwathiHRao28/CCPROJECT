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

    if (currentLeaderUrl) {
        axios.get(`${currentLeaderUrl}/state`, { timeout: 1000 })
            .then(res => ws.send(JSON.stringify({ type: 'sync', data: res.data.log })))
            .catch(() => {});
    }

    ws.on('message', async msg => {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'stroke' && currentLeaderUrl) {
            try {
                // Increased timeout to 2s to survive single-node failures
                await axios.post(`${currentLeaderUrl}/stroke`, parsed.data, { timeout: 2000 });
            } catch (err) {
                console.error("[GATEWAY] Stroke failed: Leader likely busy/down");
            }
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
    
    // Notify clients about the leader
    const leaderMsg = JSON.stringify({ type: 'leader_update', leaderId });
    clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(leaderMsg));

    // IMPORTANT: If a new leader is elected, fetch its log and sync everyone.
    // This fixes the "blank screen" bug during failover.
    if (currentLeaderUrl) {
        try {
            const stateRes = await axios.get(`${currentLeaderUrl}/state`, { timeout: 1000 });
            const syncMsg = JSON.stringify({ type: 'sync', data: stateRes.data.log });
            clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(syncMsg));
        } catch (err) {
            console.error("[GATEWAY] Failed to sync state from new leader");
        }
    }

    res.sendStatus(200);
});

app.post('/broadcast', (req, res) => {
    const data = req.body;
    // Handle both single strokes and batches
    const msg = JSON.stringify({ 
        type: 'stroke', 
        data: data.type === 'batch' ? data.strokes : [data] 
    });

    clients.forEach((id, c) => c.readyState === WebSocket.OPEN && c.send(msg));
    res.sendStatus(200);
});

server.listen(3000, () => console.log("Gateway listening on 3000"));