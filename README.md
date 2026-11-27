# Codex Delegate

在 Antigravity 会话与 `/swarm` 多智能体编队中管理并调度本机 ChatGPT 登录态下的 OpenAI Codex CLI 模型。既能让 Codex 在隔离的 Git Worktree 中作为 **Builder / Author（`workspace-write`）** 参与构建与提交，也能作为 **Verifier / Auditor（`read-only`）** 进行高信噪比代码审查与交叉二审。

## 核心能力（v0.3.2）

- **Swarm 混合编队管理（Builder + Verifier）**：
  - **模型目录与限流查询（`codex_swarm` `models`）**：通过 `codex app-server` 读取当前 ChatGPT 登录态下可用的 Codex 模型列表（及 `low`～`ultra` 推理档位）和窗口配额状态；严格剥离 `OPENAI_API_KEY` / `CODEX_API_KEY`，仅使用本地 ChatGPT 订阅态。
  - **可写构建节点与 Git Worktree 隔离**。构建节点须先在花名册绑定 `sandbox: "workspace-write"`，并使用 `swarm{action:"add", workspace:"share"}` 分配独立工作副本。绑定时省略 `workspace`，首次调用会固定实际目录。后续轮次沿用该目录，单轮可传 `sandbox: "read-only"` 临时降为只读。
  - **Git 写入范围**。Codex 在分配的工作副本里改文件、运行测试并提交到该副本的分支。链接式工作树的专用 Git 目录与公共 Git 元数据目录都会通过 `--add-dir` 加入写入范围，供 Git 写入索引、对象和引用。按分配的分支和文件范围提交可保留主工作区及父分支的独立性。提交依赖本机 Git 作者身份及仓库 hooks。
  - **Swarm 消息板协作**。Swarm worker 收到 `@name` 消息后，直接调用预加载的 `mcp_codex-delegate_worker_codex_swarm_turn`，把任务内容放在 `prompt` 中。Antigravity 管理后台任务的 `toolSummary`，Codex 完成后由 worker 在消息板汇报结果。
  - **动态换模、上下文分叉与持久化**。用 `codex_swarm` 的 `configure` 指定下一轮的模型和推理档位，用 `fork_from` 从已有 Codex 会话分叉。花名册与累计用量保存在 `${PLUGIN_DATA}/swarms/<swarm_id>.json`。并发限制、运行状态和取消由执行任务的 MCP 进程管理，同一编队的运行中任务应在发起任务的 Antigravity 客户端管理。
- **零轮询后台唤醒与只读二审**：
  - 保留独立的 `codex-auditor` 子智能体与 `codex_consult` / `codex_review` 只读工具，统一采用 `background: "always"` 与 `timeoutSeconds: 660` 响应式唤醒，支持 `output_schema`、`AbortSignal` 进程组取消联动、`stderr` 故障透传与 `${PLUGIN_DATA}/history.jsonl` 审计日志。

## 安装与更新

需要 Antigravity App 或 CLI（`agy`）、本机 Node.js 22+，以及已用 ChatGPT 登录的 Codex CLI：

```bash
codex login status
npm ci && npm run build
agy plugin validate --strict .
agy plugin install .
```

更新后，在 Antigravity 中开启新会话。若现有 App 进程仍加载旧版 MCP 工具声明，在插件面板关闭再开启 Codex Delegate，确认已加载 `0.3.2` 后重试。

## 使用方式

### 1. 在 `/swarm` 中混编管理 ChatGPT Codex 模型

```text
/swarm 列出本机 ChatGPT 可用的 Codex 模型；用 gpt-6.2-sol（high）作为 auth-builder 在 share worktree 实现登录校验修复并提交，再用只读 Codex verifier 交叉审查。
```

若通用 `call_mcp_tool` 返回 `not enabled`，让 worker 直接调用 `mcp_codex-delegate_worker_codex_swarm_turn`，并使用 `prompt` 参数提交任务。

### 2. 单会话代码审查与只读审计

```text
/codex-delegate 用本地 Codex 审查当前未提交的 Git 改动，并核实最关键的三个风险点。
```

```text
派 codex-auditor 子智能体并行检查 src/ 下的并发控制与错误处理，返回带行号证据的二审结论。
```

### 3. 插件组件清单

| 组件 | 名称 | 说明 |
| --- | --- | --- |
| **Rule** | `rules/codex-swarm.md` | `model_decision` 按需触发，指导 Swarm Coordinator 用 `codex_swarm` 管理 Codex 构建/审校节点。 |
| **Skill** | `codex-swarm-worker` | Swarm 宿体 Worker 专用协议（`disable-model-invocation: true`），负责零轮询消息转发。 |
| **Skill** | `codex-delegate` | 通用工作流入口，涵盖 Swarm 编队、Subagent 委派与直接工具调用。 |
| **Subagent** | `codex-auditor` | 只读审计子智能体（Flash），在独立上下文调用 Codex 并核验 `file:line` 引用。 |
| **MCP 工具** | `codex_swarm` | 前台控制面：`models` / `status` / `bind` / `configure` / `release`。 |
| **MCP 工具** | `codex_swarm_turn` | 按 `member` 在后台续用或分叉 Codex 会话，支持 `workspace-write`。 |
| **MCP 工具** | `codex_consult` / `codex_review` | 独立只读分析与原生 Git 审查工具。 |

## 开发验证

```bash
npm test
agy plugin validate --strict .
```

`npm test` 会重新打包 `dist/mcp-server.mjs`，并通过替身进程验证：`app-server` 模型与 ChatGPT 鉴权检查、`workspace-write` + Git worktree `--add-dir` 并发读写与锁一致性、`configure` 保留 `session_id` 热换模、`fork_from` 分叉、`release` 终止、跨重启续问、`codex_review` 校验、`stderr` 诊断与 `notifications/cancelled` 信号回收。

打包依赖的许可声明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
