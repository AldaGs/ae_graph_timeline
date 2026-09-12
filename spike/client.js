// Transport to the resident AE agent (jsx/agent.jsx from ExtendBlueNode).
// Protocol: 8 ASCII hex chars = payload length, then that many bytes of UTF-8 JSON.
const net = require('net');

const PORT = Number(process.env.EBN_AGENT_PORT) || 7879;
const HOST = '127.0.0.1';

function pad8(n) {
  return n.toString(16).padStart(8, '0');
}

// One short-lived connection per request, exactly like electron/main.js does.
function send(payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.concat([Buffer.from(pad8(body.length), 'ascii'), body]);
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let expected = null;
    const t0 = process.hrtime.bigint();

    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('agent timeout')); });
    sock.on('error', (err) => reject(err));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (expected === null && buf.length >= 8) {
        expected = parseInt(buf.subarray(0, 8).toString('ascii'), 16);
        buf = buf.subarray(8);
      }
      if (expected !== null && buf.length >= expected) {
        const rttMs = Number(process.hrtime.bigint() - t0) / 1e6;
        sock.destroy();
        let parsed;
        try { parsed = JSON.parse(buf.subarray(0, expected).toString('utf8')); }
        catch (e) { return reject(new Error('bad JSON from agent: ' + e.message)); }
        resolve({ rttMs, result: parsed });
      }
    });
    sock.connect(PORT, HOST, () => sock.write(frame));
  });
}

const ping = () => send({ op: 'ping' });
const run = (script) => send({ op: 'run', script });

module.exports = { send, ping, run, PORT, HOST };
