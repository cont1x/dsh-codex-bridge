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

test('默认等待短任务完成，精简摘要去掉重复日志并保留完整排障入口', async () => {
  const report = '完成报告'.repeat(1500);
  const { bridge, workspace } = setup(`console.error('diagnostic'.repeat(3000));console.log(JSON.stringify({subtype:'success',result:${JSON.stringify(report)}}));`);
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const summary = await bridge.compactResult(id, { waitSeconds: 2 });
  assert.equal(summary.state, 'completed'); assert.equal(summary.summary.length, 1600);
  assert.equal(summary.truncated, true); assert.equal(summary.stdout, undefined); assert.equal(summary.stderr, undefined);
  const full = await bridge.compactResult(id, { waitSeconds: 0, detail: 'full' });
  assert.ok(full.stdout.includes(report)); assert.ok(full.stderr.includes('diagnostic'));
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 5);
  assert.equal(bridge.compactList()[0].result, undefined);
});
test('等待超时返回运行状态，失败摘要保留诊断', async () => {
  const { bridge, workspace } = setup('process.stdin.resume();setInterval(()=>{},1000);');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const summary = await bridge.compactResult(id, { waitSeconds: 0 });
  assert.equal(summary.state, 'running'); assert.equal(summary.summary, undefined);
  bridge.cancel(id); await finished(bridge, id);
  const failed = setup('console.error("missing credentials");process.exit(1);');
  const job = await failed.bridge.start({ workspace: failed.workspace, prompt: 'task' });
  const result = await failed.bridge.compactResult(job.id, { waitSeconds: 2 });
  assert.equal(result.state, 'failed'); assert.match(result.diagnostic, /missing credentials/);
});
test('相同结果只返回未变化状态，翻页不会被旧revision跳过', async () => {
  const report = 'A'.repeat(1600) + '验收失败：检查未执行。' + 'B'.repeat(2000);
  const { bridge, workspace } = setup(`console.log(JSON.stringify({subtype:'success',result:${JSON.stringify(report)}}));`);
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const first = await bridge.compactResult(id, { waitSeconds: 2 });
  const same = await bridge.compactResult(id, { waitSeconds: 0, afterRevision: first.revision });
  assert.equal(same.unchanged, true); assert.equal(same.summary, undefined);
  assert.ok(JSON.stringify(same).length < JSON.stringify(first).length / 5);
  const second = await bridge.compactResult(id, { waitSeconds: 0, offset: first.nextOffset, afterRevision: first.revision });
  assert.match(second.summary, /验收失败/); assert.notEqual(second.revision, first.revision);
  assert.equal(second.unchanged, undefined);
  const third = await bridge.compactResult(id, { waitSeconds: 0, offset: second.nextOffset });
  assert.equal(first.summary + second.summary + third.summary, report);
  assert.equal(third.truncated, false);
});
test('状态改变时旧revision仍返回最新结果', async () => {
  const { bridge, workspace } = setup('setTimeout(()=>console.log(JSON.stringify({result:"done"})),300);');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const initial = await bridge.compactResult(id, { waitSeconds: 0 });
  assert.equal(initial.state, 'running');
  const result = await bridge.compactResult(id, { waitSeconds: 2, afterRevision: initial.revision });
  assert.equal(result.state, 'completed'); assert.equal(result.summary, 'done');
  assert.notEqual(result.revision, initial.revision);
});
test('DSH长文本分页保留开头、尾部失败信息和诊断提示', async () => {
  const report = 'REPORT_START' + 'A'.repeat(25000) + '未验证：测试未执行';
  const { bridge, workspace } = setup(`console.error('warning: tests skipped');console.log(${JSON.stringify(report)});`);
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const first = await bridge.compactResult(id, { waitSeconds: 2 });
  assert.ok(first.summary.startsWith('REPORT_START'));
  assert.equal(first.reviewRequired, true); assert.equal(first.diagnosticAvailable, true);
  let all = first.summary, page = first;
  while (page.truncated) {
    page = await bridge.compactResult(id, { waitSeconds: 0, offset: page.nextOffset });
    all += page.summary;
  }
  assert.equal(all.trimEnd(), report); assert.match(all, /测试未执行/);
  assert.equal(page.unreadChars, 0); assert.equal(page.reviewRequired, true);
  const full = await bridge.compactResult(id, { waitSeconds: 0, detail: 'full' });
  assert.match(full.stderr, /tests skipped/);
});
