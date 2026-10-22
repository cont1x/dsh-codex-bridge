# DSH × Codex

在 Codex 中用 GPT 理解需求和生成提示词，交给 DSH 写代码，再由 Codex 验收。

## 1.3：保留独立验收的上下文优化

提交和查询任务默认在服务端等待最多45秒，减少轮询。精简结果默认每页1600字符；`truncated=true` 时必须按 `nextOffset` 继续读完报告再验收。`reportChars`、`unreadChars` 明确报告总长度与剩余长度。DSH 文本报告从本地保存的 stdout 读取分页，不因原始查询的尾部窗口而丢掉报告开头。

查询携带上次 `revision` 作为 `afterRevision`，相同页与状态只返回 `unchanged=true`；新状态和不同页不会被跳过。`detail="full"` 可获取原始日志尾部（每路24000字符），更早内容可读取本地日志。`waitSeconds=0` 可立即返回。

Codex 必须独立审查实际代码差异、关联调用与必要上下文，并执行项目要求的检查和必要测试；DSH 自检不替代独立验收。报告不设字数上限，失败和未验证项必须保留。`reviewRequired=true` 表示仍需独立验收；报告读完或进程正常退出均不代表验收通过。`diagnosticAvailable` 提示 stderr 中有内容，可能是进度、推理输出或警告，需要核实影响。

只减少等待轮询、重复传输与无关上下文，不降低审查和测试要求，不调整 Codex 模型和思考强度。分页、去重均由本地代码完成，不额外调用模型。不能保证固定节省比例或任何任务质量绝对不变，DSH 模型调用仍按其账号规则计量。

## 使用

安装后重启 Codex 或新建聊天，输入：

> 用 dsh-code 完成这个项目的登录页，你负责整理提示词，让 DSH 实现并检查结果。

也可以明确指定项目绝对路径。执行时无需打开 DSH 窗口；这里调用的是 DSH Desktop 自带 CLI 的 headless profile，不会向桌面聊天窗口输入消息。通过附带的 `config/desktop-credentials.yml` 启用 DSH 自身的账号/凭据服务，使用已保存的桌面登录，模型配置沿用这台电脑的 `deepseek-account / deepseek-flash`。其他桌面插件不会自动加载。修改模型时调整此 YAML 的 `agent-default-model`。

工具：`dsh_health` 检查入口，`dsh_start` 提交任务，`dsh_result` 查看结果，`dsh_list` 恢复历史，`dsh_cancel` 取消。取消保留已发生的文件改动。默认 20 分钟超时，最多 2 小时。

日志默认保存在 `%USERPROFILE%/.codex/dsh-bridge/runs/<任务ID>/`：包含 `prompt.md`、`status.json`、`stdout.log`、`stderr.log`。每路日志最大 8MB，full 查询返回每路最后 24000 字符；普通查询返回报告分页。历史列表仅返回最近10次任务的关键状态。任务正常退出后仍需验收代码。

## 安装及配置

当前支持 Windows，需要 Node.js 18+、Git、Codex CLI 和已登录的 DSH Desktop。先克隆并安装依赖，再注册本地插件源：

```powershell
git clone https://github.com/cont1x/dsh-codex-bridge.git
cd dsh-codex-bridge
npm ci
codex plugin marketplace add .
codex plugin add dsh-codex@dsh-bridge
```

默认桌面安装目录 `E:\dsh\DSH Desktop`。可用环境变量 `DSH_DESKTOP_ROOT`、`DSH_NODE`、`DSH_ENTRY`、`DSH_HOME`、`DSH_BRIDGE_DATA` 覆盖。优先使用桌面自带 Node 和 DSH；不存在时回退全局安装。不会复制或输出凭据。

运行 `npm test` 验证传参、并发互斥、取消、故障和持久化；`npm run smoke` 验证真实 MCP 握手。`npm run smoke -- <测试目录>` 会调用真实 DSH 在测试目录写验收文件。

安装后重启 Codex。请保留克隆目录，以便更新源码和依赖。当前发布的是源码包，需先执行 `npm ci`，不能省略依赖安装。

卸载：`codex plugin remove dsh-codex@dsh-bridge`。源码目录和任务日志保留。

协议与打包参考：[OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)。
