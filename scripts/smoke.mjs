import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const client = new Client({ name: 'bridge-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))] }));
try {
  console.log('MCP tools:', (await client.listTools()).tools.map(tool => tool.name).join(', '));
  console.log(JSON.stringify(await client.callTool({ name: 'dsh_health', arguments: {} }), null, 2));
  if (process.argv[2]) {
    const result = await client.callTool({ name: 'dsh_start', arguments: {
      workspace: resolve(process.argv[2]),
      prompt: '这是桥接插件验收任务。只在当前目录创建 bridge-smoke.txt，内容为 DSH_CODEX_BRIDGE_OK，不修改其他文件。完成后读取该文件核对，并报告结果。',
      acceptance: ['bridge-smoke.txt 内容为 DSH_CODEX_BRIDGE_OK'], timeoutSeconds: 120,
    } });
    console.log(JSON.stringify(result));
    if (result.isError) process.exitCode = 1;
    else {
      const { id } = JSON.parse(result.content[0].text);
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 2500));
        const response = await client.callTool({ name: 'dsh_result', arguments: { id } });
        const job = JSON.parse(response.content[0].text);
        if (job.state !== 'running') { console.log(JSON.stringify(job, null, 2)); if (job.state !== 'completed') process.exitCode = 1; break; }
      }
    }
  }
} finally { await client.close(); }
