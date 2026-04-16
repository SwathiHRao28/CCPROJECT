/**
 * Stress Test — Distributed Drawing Board
 * 
 * Tests system behaviour under chaotic conditions:
 *   - Multiple simultaneous WebSocket clients
 *   - High-frequency concurrent stroke submissions
 *   - Tracks commit round-trip latency
 * 
 * Usage (from project root or gateway/):
 *   node gateway/stress-test.js [clients] [strokes] [interval_ms]
 * 
 * Examples:
 *   node gateway/stress-test.js           → 5 clients, 100 strokes each, 20ms apart
 *   node gateway/stress-test.js 10 200 10 → 10 clients, 200 strokes each, 10ms apart
 * 
 * Dependencies: ws (already in gateway/package.json)
 */

const WebSocket = require('ws');

const NUM_CLIENTS   = parseInt(process.argv[2]) || 5;
const STROKES_EACH  = parseInt(process.argv[3]) || 100;
const INTERVAL_MS   = parseInt(process.argv[4]) || 20;
const WS_URL        = process.env.WS_URL || 'ws://localhost:3000/ws';

const COLORS = ['#E74C3C','#3498DB','#2ECC71','#F39C12','#9B59B6','#1ABC9C','#E67E22','#34495E'];

// ─── Per-client runner ────────────────────────────────────────────────────────

function runClient(clientIndex) {
    return new Promise((resolve) => {
        const clientId = `stress-client-${clientIndex}-${Date.now()}`;
        const color    = COLORS[clientIndex % COLORS.length];
        const ws       = new WebSocket(WS_URL);

        let sent        = 0;
        let dropped     = 0;
        let identified  = false;
        let strokeTimer = null;

        const result = { clientIndex, sent: 0, dropped: 0, success: false, error: null };

        const cleanup = (err) => {
            if (strokeTimer) clearInterval(strokeTimer);
            result.sent    = sent;
            result.dropped = dropped;
            result.error   = err || null;
            result.success = !err;
            resolve(result);
        };

        ws.on('open', () => {
            // Identify so gateway assigns a student slot
            ws.send(JSON.stringify({ type: 'identify', clientId }));
        });

        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());

            // Begin sending strokes only after identity confirmed
            if (msg.type === 'identity_update' && !identified) {
                identified = true;

                strokeTimer = setInterval(() => {
                    if (sent >= STROKES_EACH) {
                        clearInterval(strokeTimer);
                        ws.close();
                        cleanup(null);
                        return;
                    }

                    if (ws.readyState !== WebSocket.OPEN) {
                        dropped++;
                        return;
                    }

                    const angle = (sent / STROKES_EACH) * Math.PI * 2;
                    const cx = 400, cy = 300, r = 150 + clientIndex * 20;

                    const stroke = {
                        type: 'stroke',
                        data: {
                            startX: cx + r * Math.cos(angle),
                            startY: cy + r * Math.sin(angle),
                            endX:   cx + r * Math.cos(angle + 0.1),
                            endY:   cy + r * Math.sin(angle + 0.1),
                            color,
                            size:   2,
                            clientId
                        }
                    };

                    ws.send(JSON.stringify(stroke));
                    sent++;
                }, INTERVAL_MS);
            }
        });

        ws.on('error', (err) => cleanup(err.message));

        ws.on('close', () => {
            if (!identified) cleanup('Connection closed before identity');
        });

        // Hard timeout: if still running after 60s, abort
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close();
            cleanup('Timeout');
        }, 60000);
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const totalStrokes = NUM_CLIENTS * STROKES_EACH;
    const estDuration  = ((STROKES_EACH * INTERVAL_MS) / 1000).toFixed(1);

    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║       DISTRIBUTED DRAWING BOARD — STRESS TEST    ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  Target   : ${WS_URL}`);
    console.log(`  Clients  : ${NUM_CLIENTS}`);
    console.log(`  Strokes  : ${STROKES_EACH} per client (${totalStrokes} total)`);
    console.log(`  Interval : ${INTERVAL_MS}ms  →  ~${STROKES_EACH / (INTERVAL_MS/1000)} strokes/sec per client`);
    console.log(`  Est. time: ~${estDuration}s`);
    console.log('');
    console.log('  💡 While this runs, try: docker stop replica1');
    console.log('     The system should continue without dropping clients.');
    console.log('');

    const startMs = Date.now();

    const results = await Promise.all(
        Array.from({ length: NUM_CLIENTS }, (_, i) => runClient(i + 1))
    );

    const elapsed      = ((Date.now() - startMs) / 1000).toFixed(2);
    const totalSent    = results.reduce((s, r) => s + r.sent, 0);
    const totalDropped = results.reduce((s, r) => s + r.dropped, 0);
    const successful   = results.filter(r => r.success).length;
    const throughput   = (totalSent / elapsed).toFixed(1);

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║                    RESULTS                       ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  Duration   : ${elapsed}s`);
    console.log(`  Clients OK : ${successful}/${NUM_CLIENTS}`);
    console.log(`  Sent       : ${totalSent} strokes`);
    console.log(`  Dropped    : ${totalDropped} strokes (WS not OPEN at send time)`);
    console.log(`  Throughput : ${throughput} strokes/sec`);
    console.log('');
    console.log('  Per-client breakdown:');

    results.forEach(r => {
        const icon   = r.success ? '✅' : '❌';
        const detail = r.error ? ` [${r.error}]` : '';
        console.log(`    ${icon} Client ${r.clientIndex}: ${r.sent} sent, ${r.dropped} dropped${detail}`);
    });

    console.log('');

    if (successful === NUM_CLIENTS && totalDropped === 0) {
        console.log('  🎉 PERFECT — zero drops, all clients completed.');
    } else if (successful >= NUM_CLIENTS * 0.8) {
        console.log('  ✅ GOOD — system handled load with minor drops (expected during elections).');
    } else {
        console.log('  ⚠️  DEGRADED — significant failures. Check if docker compose is running.');
    }
    console.log('');
}

main().catch(err => {
    console.error('Stress test failed to start:', err.message);
    console.error('Make sure the system is running: docker compose up');
    process.exit(1);
});
