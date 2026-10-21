import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finished(bridge, id) {
  for (let i = 0; i < 150; i++) { const job = bridge.get(id); if (!['running', 'cancelling'].includes(job.state)) return job; await pause(40); }
  throw new Error('test timeout');
}
function setup(source) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-'));
  const entry = join(root, 'fake.mjs');
  const workspace = join(root, 'project with spaces'); mkdirSync(workspace);
  writeFileSync(entry, source);
  return { workspace, bridge: new Bridge({ command: process.execPath, entry, home: root, data: join(root, 'runs') }) };
}
test('中文和 shell 字符经 stdin 原样传输，工作目录正确，输出可恢复', async () => {
  const { bridge, workspace } = setup(`import {writeFileSync} from 'node:fs'; let text='';for await(const chunk of process.stdin)text+=chunk;writeFileSync('received.txt',text);console.log(process.cwd());`);
  const prompt = '中文 "quotes" $() & | `backticks`\n第二行';
  const { id } = await bridge.start({ workspace, prompt });
  const result = await finished(bridge, id);
  assert.equal(result.state, 'completed');
  assert.ok(result.stdout.includes(workspace));
  assert.ok(readFileSync(join(workspace, 'received.txt'), 'utf8').includes(prompt));
  assert.equal(new Bridge(bridge.config).get(id).state, 'completed');
});
test('同目录并发被阻止，取消终止进程', async () => {
  const { bridge, workspace } = setup('process.stdin.resume();setInterval(()=>{},1000);');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  await assert.rejects(bridge.start({ workspace, prompt: 'duplicate' }), /已有 DSH 任务/);
  bridge.cancel(id);
  assert.equal((await finished(bridge, id)).state, 'cancelled');
});
test('非零退出报告失败，目录和 ID 校验', async () => {
  const { bridge, workspace } = setup('console.error("provider unavailable");process.exit(7);');
  await assert.rejects(bridge.start({ workspace: '.', prompt: 'task' }), /绝对路径/);
  assert.throws(() => bridge.get('../outside'), /无效任务/);
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const job = await finished(bridge, id);
  assert.equal(job.state, 'failed'); assert.equal(job.exitCode, 7); assert.match(job.stderr, /provider unavailable/);
});
