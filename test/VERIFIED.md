2026-10-21 本机验收：

- Node 内置测试：中文和特殊字符经 stdin 传递、绝对工作目录、结果持久化、同目录互斥、取消进程、非零退出失败回传全部通过。
- SDK MCP Client 完成 stdio 握手并发现全部五个工具。
- 真实 DSH Desktop 内置 Node/CLI，使用已有桌面账号，通过 headless profile + 凭据覆盖配置执行任务。
- 真实任务正常退出，exitCode 0。
- 独立测试目录中的 `bridge-smoke.txt` 严格等于 `DSH_CODEX_BRIDGE_OK`，19 字节。

这是本机集成测试记录；其他电脑需安装 DSH 并完成登录。
