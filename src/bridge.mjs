import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, realpathSync, statSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function discover(env = process.env) {
  const desktop = env.DSH_DESKTOP_ROOT || 'E:\\dsh\\DSH Desktop';
  const bundled = join(desktop, 'resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const global = join(env.APPDATA || join(homedir(), 'AppData/Roaming'), 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const node = join(desktop, 'resources/runtime/x64/primary-runtime/dependencies/node/bin/node.exe');
  return {
    command: env.DSH_NODE || (existsSync(node) ? node : process.execPath),
    entry: env.DSH_ENTRY || (existsSync(bundled) ? bundled : global),
    home: env.DSH_HOME || join(homedir(), '.dsh'),
    data: env.DSH_BRIDGE_DATA || join(homedir(), '.codex/dsh-bridge/runs'),
  };
}

export function makePrompt({ prompt, acceptance = [] }) {
  return `你是本次任务的代码执行者。上游 GPT/Codex 已整理以下任务，请直接在当前工作目录实现。\n遵守项目 AGENTS.md 和现有代码规范，保留无关改动。遇到缺失凭据或必须人工确认的操作，明确报告阻塞，不要假称完成。不要把实现任务再转交给 Codex。\n\n任务提示词：\n${prompt}\n\n验收标准：\n${acceptance.length ? acceptance.map((s, i) => `${i + 1}. ${s}`).join('\n') : '完成任务，并运行与改动相关的检查。'}\n\n最后用中文报告实际修改的文件、实现要点、执行过的检查及结果、失败和未验证事项。保留完整验收证据，不设字数限制，不把未执行的检查称为通过。`;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function tail(path, limit = 24000) {
  // Logs are capped by the runner; return only a context-sized tail to GPT.
  return existsSync(path) ? readFileSync(path, 'utf8').slice(-limit) : '';
}

export class Bridge {
  constructor(config = discover()) {
    this.config = config;
    this.running = new Map();
    mkdirSync(config.data, { recursive: true });
  }
  health() {
    return { ...this.config, entryExists: existsSync(this.config.entry), nodeExists: existsSync(this.config.command), transport: 'stdio', execution: 'DSH Desktop bundled CLI, headless profile' };
  }
  paths(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效任务 ID');
    const dir = join(this.config.data, id);
    return { dir, status: join(dir, 'status.json'), stdout: join(dir, 'stdout.log'), stderr: join(dir, 'stderr.log') };
  }
  save(job) {
    const target = this.paths(job.id).status;
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(job, null, 2));
    renameSync(temp, target);
  }
  get(id) {
    const paths = this.paths(id);
    if (!existsSync(paths.status)) throw new Error('找不到该任务');
    const job = JSON.parse(readFileSync(paths.status, 'utf8'));
    if (['running', 'cancelling'].includes(job.state) && !this.running.has(id) && !(job.ownerPid && alive(job.ownerPid))) {
      job.state = 'interrupted';
      job.error = '所属桥接服务已断开；执行进程可能仍在运行，请检查日志和工作区后再提交。';
    }
    return { ...job, stdout: tail(paths.stdout), stderr: tail(paths.stderr), logDirectory: paths.dir };
  }
  list() {
    return readdirSync(this.config.data).filter(id => /^[0-9a-f-]{36}$/.test(id))
      .map(id => { const { stdout, stderr, ...job } = this.get(id); return job; })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }
  async compactResult(id, { waitSeconds = 45, detail = 'summary', afterRevision, offset = 0, maxChars = 1600 } = {}) {
    const deadline = Date.now() + Math.max(0, Math.min(45, waitSeconds)) * 1000;
    let job = this.get(id);
    while (['running', 'cancelling'].includes(job.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      job = this.get(id);
    }
    if (detail === 'full') return job;
    const response = { id, state: job.state, exitCode: job.exitCode, logDirectory: job.logDirectory };
    const delta = () => {
      const revision = createHash('sha256').update(JSON.stringify(response)).digest('hex').slice(0, 16);
      return revision === afterRevision ? { id, state: job.state, revision, unchanged: true } : { ...response, revision };
    };
    if (['running', 'cancelling'].includes(job.state)) {
      response.next = '任务仍在运行；下次调用 dsh_result 使用 waitSeconds=45 并携带 afterRevision。';
      return delta();
    }
    const rawReport = readFileSync(this.paths(id).stdout, 'utf8');
    let parsed = job.result;
    if (!parsed) { try { parsed = JSON.parse(rawReport); } catch {} }
    const report = typeof parsed?.result === 'string' ? parsed.result : rawReport;
    const start = Math.max(0, Math.floor(offset));
    const size = Math.max(100, Math.min(4000, Math.floor(maxChars)));
    response.summary = report.slice(start, start + size);
    response.truncated = report.length > start + size;
    response.reportChars = report.length;
    response.unreadChars = Math.max(0, report.length - start - size);
    response.reviewRequired = true;
    response.diagnosticAvailable = Boolean(job.stderr.trim());
    // Preserve visibility of denials even when the CLI otherwise reports success.
    try {
      const raw = JSON.parse(rawReport);
      if (Array.isArray(raw.permission_denials)) response.permissionDenialCount = raw.permission_denials.length;
    } catch {}
    if (response.truncated) response.nextOffset = start + size;
    if (start) response.offset = start;
    if (job.error) response.error = String(job.error).slice(0, 800);
    if (job.state !== 'completed') response.diagnostic = job.stderr.slice(-1000);
    response.next = response.truncated ? '报告未读完；必须用 offset=nextOffset 读完再验收。' : '报告读完不等于验收通过：独立审查实际差异并执行必要测试；有诊断或权限拒绝时核实完整日志。';
    return delta();
  }
  compactList() {
    return this.list().slice(0, 10).map(({ id, state, workspace, startedAt, exitCode }) => ({ id, state, workspace, startedAt, exitCode }));
  }
  async start({ workspace, prompt, acceptance = [], timeoutSeconds = 1200 }) {
    if (!isAbsolute(workspace)) throw new Error('工作目录必须是绝对路径');
    const cwd = realpathSync(resolve(workspace));
    if (!statSync(cwd).isDirectory()) throw new Error('工作目录不是文件夹');
    if (!prompt?.trim()) throw new Error('提示词不能为空');
    if (!existsSync(this.config.entry)) throw new Error('未找到 DSH 入口，请设置 DSH_ENTRY');
    const lockKey = createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex');
    const lock = join(this.config.data, `${lockKey}.lock`);
    if (existsSync(lock)) {
      const owner = JSON.parse(readFileSync(lock, 'utf8'));
      if (alive(owner.pid) || (owner.childPid && alive(owner.childPid))) throw new Error(`该目录已有 DSH 任务：${owner.id}`);
      unlinkSync(lock);
    }
    const id = randomUUID();
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, id }));
    closeSync(fd);
    const paths = this.paths(id);
    let child;
    try {
      mkdirSync(paths.dir);
      const task = makePrompt({ prompt, acceptance });
      writeFileSync(join(paths.dir, 'prompt.md'), task);
      const overlay = fileURLToPath(new URL('../config/desktop-credentials.yml', import.meta.url));
      child = spawn(this.config.command, [this.config.entry, '--profile', 'headless', '--patch', overlay, '-'], {
        cwd, env: { ...process.env, DSH_HOME: this.config.home },
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const job = { id, ownerPid: process.pid, workspace: cwd, state: 'running', startedAt: new Date().toISOString(), pid: child.pid ?? null, exitCode: null };
      writeFileSync(lock, JSON.stringify({ pid: process.pid, childPid: child.pid, id }));
      this.save(job);
      let finished = false;
      const fds = { stdout: openSync(paths.stdout, 'w'), stderr: openSync(paths.stderr, 'w') };
      const sizes = { stdout: 0, stderr: 0 };
      for (const key of ['stdout', 'stderr']) child[key].on('data', chunk => {
        const remaining = 8 * 1024 * 1024 - sizes[key];
        if (remaining > 0) { const part = chunk.subarray(0, remaining); writeFileSync(fds[key], part); sizes[key] += part.length; }
      });
      const finish = (code, signal, error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        closeSync(fds.stdout); closeSync(fds.stderr);
        job.exitCode = code;
        job.signal = signal;
        job.state = job.state === 'cancelling' ? 'cancelled' : job.state === 'running' ? (code === 0 && !error ? 'completed' : 'failed') : job.state;
        if (error) job.error = error.message;
        job.finishedAt = new Date().toISOString();
        this.save(job);
        this.running.delete(id);
        if (existsSync(lock)) unlinkSync(lock);
      };
      const timer = setTimeout(() => { job.state = 'timed_out'; this.save(job); this.kill(child); }, timeoutSeconds * 1000);
      this.running.set(id, { child, job });
      child.once('error', error => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));
      child.stdin.on('error', error => { job.inputError = error.message; });
      child.stdin.end(task, 'utf8');
      return { ...job, logDirectory: paths.dir, next: '调用 dsh_result 查询结果；完成后检查文件差异并验证验收标准。' };
    } catch (error) {
      if (child) this.kill(child);
      if (existsSync(lock)) unlinkSync(lock);
      throw error;
    }
  }
  kill(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else child.kill('SIGTERM');
  }
  cancel(id) {
    const active = this.running.get(id);
    if (!active) throw new Error('任务未在当前服务运行；请先查询结果');
    active.job.state = 'cancelling';
    this.save(active.job);
    this.kill(active.child);
    return { id, state: 'cancelling', note: '取消不会撤回已经写入的文件。' };
  }
  shutdown() {
    for (const { child, job } of this.running.values()) {
      job.state = 'interrupted'; this.save(job); this.kill(child);
    }
  }
}
