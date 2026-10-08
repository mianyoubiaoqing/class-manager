import { createInterface } from 'node:readline';
import { readFileSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// This helper ships beside the Electron runtime. Stdout is reserved for MCP JSON-RPC.
const connectionPath = process.argv[process.argv.indexOf('--connection') + 1];
const client = randomUUID();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
let exceeded = false;
process.stdin.on('data', (chunk: Buffer) => {
  if (chunk.length > 256 * 1024) {
    exceeded = true;
    process.stderr.write('MCP request exceeds limit\n');
    process.exitCode = 1;
    lines.close();
  }
});
lines.on('line', (line) => {
  chain = chain.then(async () => {
    if (exceeded || !line.trim()) return;
    let id: string | number | null = null;
    try {
      if (Buffer.byteLength(line) > 256 * 1024) throw new Error('Request exceeds limit');
      const request = JSON.parse(line) as { id?: string | number };
      id = request.id ?? null;
      if (!connectionPath || connectionPath === process.argv[0])
        throw new Error('Missing --connection');
      const stat = lstatSync(connectionPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
        throw new Error('Invalid connection file');
      const connection = JSON.parse(readFileSync(connectionPath, 'utf8')) as {
        url: string;
        token: string;
      };
      if (
        !/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/.test(connection.url) ||
        !/^[a-f0-9]{64}$/.test(connection.token)
      )
        throw new Error('Invalid local endpoint');
      const response = await fetch(connection.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json',
          'x-cm-client': client,
        },
        body: line,
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
      if (response.status === 204) return;
      if (!response.ok) throw new Error('Local connection unavailable');
      const body = await response.text();
      if (body.length > 32 * 1024 * 1024) throw new Error('Response exceeds limit');
      JSON.parse(body);
      process.stdout.write(`${body}\n`);
    } catch {
      if (id !== null)
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: '本地工作台未连接。请先启动程序，并在智能对话中点击开始连接；首次需在 WorkBuddy 授权本机服务。' } })}\n`,
        );
      else process.stderr.write('MCP request could not be handled\n');
    }
  });
});
