# dcae-oc — DCAE-OC 确定性开发内核（OpenCode V2 插件）

**让 LLM 编码会话在受控流水线中可信地交付真实项目。**

DCAE-OC 是一个运行在 OpenCode V2 服务器内的确定性内核插件：它把已批准的计划变成任务 DAG，在隔离的 git worktree 中以最小权限会话运行每个任务，用门禁与证据验收工作，经受控合并列车集成，并把所有判断性决策送入人类收件箱。LLM 会话负责规划、实现与审查；**内核掌管状态、范围、证据与排序**。

> 实现依据：DCAE-OC 1.4 设计稿 + 项目设计/架构设计 v1.0（代码注释中以 `1.4 §x`、`架构设计 §x` 标注对应章节）

## 适用场景

- 多步骤真实项目（如"参考现有项目实现一个新服务/工具"），需要 LLM 会话长期、分阶段、可审计地交付
- 对"会话改了什么、为什么可信、谁批准的"有严格要求的团队或个人
- 希望 LLM 会话**最小权限运行**（写范围限定、命令白名单、审查闭环）而非自由操作

**不适合**：单文件小改动、交互式问答、无 git 的目录。

## 安装

**前置**：OpenCode V2（≥2.3.0）、Bun、目标项目是 git 仓库。

```sh
# 方式 A：npm 发布后（推荐）
opencode plugin add dcae-oc
# 方式 B：git 仓库（HTTPS 不可达时用 SSH）
opencode plugin add git+ssh://git@github.com/Cikaros/dcae-oc.git#0.1.1
# 方式 C：本地目录（开发态）
# 目标项目 opencode.json → "plugins": ["<path-to-plugin>"]
```

> **全局安装是安全的**：插件只对**探测到的 DCAE 项目**激活（`.dcae/`、`gates.yaml`、`tasks/*.yaml`、
> `opencode.json` 顶层 `dcae` 键或角色智能体文件任一命中）。普通项目里它静默跳过，不报错、不写入、
> 不建内核。因此可以全局安装后在任意项目使用，不会干扰非 DCAE 项目。

## 使用流程（五步）

### ① 初始化目标项目

```sh
cd <目标项目>
npx dcae-oc init --model <provider/model> --plugin <插件引用>
# 例：npx dcae-oc init . --model <provider/model> --plugin <path-to-plugin>
git add -A && git commit -m "dcae init"
```

若插件已全局安装，也可直接在 OpenCode 会话内执行 **`/dcae-init`** 完成同样初始化（无需 `npx`）。

产出：四角色智能体（`.opencode/agents/dcae-*.md`）、`opencode.json`（插件引用 + 权限 + `dcae.model`）、`gates.yaml`（门禁命令表，**人类所有，按项目实际修改**）、AGENTS.md 协议块、目录骨架。

### ② 编写计划产物（人类为作者）

- `specs/<ID>.md`：规范（YAML front-matter `status: approved` + 正文）——**只有人类能把规范置为 approved**
- `tasks/<ID>.yaml`：任务定义（目标、依赖 DAG、写范围 scope.write、shell 白名单引用、验收 checks、预算）
- `gates.yaml`：命令表（validate 会强制 checks 只能引用这里的命令 id）

```sh
dcae validate    # 静态校验：引用合法性/保护路径重叠/DAG 无环
dcae plan-approve <TASK-ID>...   # 批准计划（任务进入流水线）
```

### ③ 启动 OpenCode，内核自动运转

```sh
opencode        # 或 opencode serve --port <N>
```

内核自动：调度 READY 任务 → 创建隔离 worktree + 最小权限会话（模型/权限/环境原子施加）→ dev 实现并 `dcae_submit` → 门禁执行（`bun test` 等）→ 审查会话出 verdict → 冻结 ref → 合并列车 → `MERGED`。

全程观察：

```sh
dcae status             # 任务状态投影
# TUI 内：/dcae-status   # 内核概览与任务明细
git -C <项目> log --oneline          # 内核提交与合并记录
git -C <项目> for-each-ref refs/dcae  # accepted/<task> 与 integration
```

### ④ 处理收件箱（判断性决策）

会话受阻/审查升级/预算耗尽时，内核创建收件箱项并暂停任务：

```sh
dcae inbox list                          # 查看
dcae decide INBOX-000001 --option <id>   # 决策（≤5s 生效）
```

TUI 内等价：`/dcae-inbox`、`/dcae-decide INBOX-000001 <option>`。

### ⑤ 发布

```sh
dcae promote [--branch main]   # 重跑全局门禁后把 integration fast-forward 到主分支（人工执行）
```

## 命令参考

| CLI（`dcae <cmd>`） | TUI 斜杠命令 | 作用 |
| --- | --- | --- |
| `init` | — | 目标项目脚手架 |
| `validate` | — | 计划静态校验 |
| `plan-approve <TASK>...` | `/dcae-plan-approve` | 批准计划 |
| `status` | `/dcae-status` | 状态投影 |
| `inbox list` | `/dcae-inbox` | 收件箱清单 |
| `decide INBOX-ID --option X` | `/dcae-decide` | 决策 |
| `retry / revalidate <TASK>` | — | 失败重试 / 重验证 |
| `approve-spec <SPEC-ID>` | `/dcae-approve-spec` | 批准规范 |
| `promote` | — | integration → 主分支 |
| `verify` | — | 无状态只读核查（CI 可用） |

## 真实验证记录（2026-11-16/17，OpenCode v2.3.0）

- M0 平台契约：**14 PASS / 0 FAIL / 2 LLM 依赖待补**（`test/contract/results/2026-11-17-snapshot.md`）
- 单元测试 **85/85**；`tsc --noEmit` 全绿；安装态包（npm pack → 独立 `npm i`）加载验证通过
- 安装态全链 e2e：全新项目经安装态插件包推进至 **MERGED**，且**审查闭环零人工**（无 retry / decision 事件；`test/contract/results/2026-11-17-real-scenario-test.md`）
- 真实多任务项目 e2e：双任务 DAG（含 deps 依赖）均推进至 **MERGED**（真实 LLM 会话实现 + 门禁 + 审查 + 合并列车），事件链完整留痕 `.dcae/state/events.jsonl`
- 已知限制与排障见 `test/contract/results/2026-11-17-review.md` 与 `2026-11-17-real-scenario-test.md`

## 许可

MIT（见 `LICENSE`）。

## 排障

| 症状 | 处理 |
| --- | --- |
| 插件未装载 | 设 `DCAE_CONTRACT=1` 重启，查 `<项目>/.dcae/setup-probe.log`；确认 opencode.json plugins 路径存在且为**纯 JSON**（中文注释 jsonc 解析会失败） |
| 会话长时间无进展 | `dcae status` 看状态；内核会在无提交空闲时注入提醒、预算到点强制 FAILED（可 `dcae retry`） |
| 心跳停更（`.dcae/lock.json` heartbeat 陈旧） | serve 进程假死——重启 serve 即可，follower 接管修复会自动恢复领导权 |
| 收件箱决策未生效 | 确认 serve 在跑且从**目标项目目录**执行 dcae 命令（无显式目录时以 cwd 定位项目） |
