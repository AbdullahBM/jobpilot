// test-mcp.mjs — Smoke test: spawn the MCP server, list tools, call onboard_status.
import { spawn } from 'child_process';

const srv = spawn('node', ['mcp-server.js'], { cwd: process.cwd() });
let buf = '';
srv.stdout.on('data', d => { buf += d.toString(); });
srv.stderr.on('data', d => process.stderr.write('[srv] ' + d.toString()));

function send(obj) { srv.stdin.write(JSON.stringify(obj) + '\n'); }

setTimeout(() => send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), 4000);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'onboard_status', arguments: {} } }), 5000);

setTimeout(() => {
  console.log('=== RAW STDOUT ===');
  console.log(buf.slice(0, 2000));
  const lines = buf.split('\n').filter(Boolean);
  for (const l of lines) {
    try {
      const msg = JSON.parse(l);
      if (msg.id === 1) console.log('TOOLS:', msg.result.tools.map(t => t.name).join(', '));
      if (msg.id === 2) console.log('\nONBOARD:', (msg.result?.content?.[0]?.text || '').slice(0, 600));
    } catch {}
  }
  srv.kill();
  process.exit(0);
}, 9000);
