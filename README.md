# dcae-oc — DCAE-OC 内核（OpenCode V2 服务器插件）

确定性内核：把已批准的计划变成任务 DAG，在隔离 git worktree 中以最小权限会话运行每个任务；只接受内核产出的证据；受控合并列车；判断性决策进人类收件箱。上游规范：`../DCAE-OC 1.4 Divide & Conquer Agent Engineering on OpenCode V2.md`；工程计划 `../DCAE-OC 项目设计 v1.0.md`；软件架构 `../DCAE-OC 架构设计 v1.0.md`。

## 安装（目标项目）

```sh
# 在目标项目根
bun x dcae-oc init            # 或本地开发形态：bun run <本仓>/src/cli.ts init <目标项目>
```

`dcae init` 写入：`.opencode/agents/dcae-*.md`（四角色智能体）、`opencode.json`（插件引用 + V2 有序权限规则数组；**纯 JSON**——本平台 jsonc 中文注释解析失败，2026-11-16 实测）、`gates.yaml`、AGENTS.md 协议块、目录骨架。

插件加载要求：opencode.json 的 `plugins` 数组指向本目录（绝对路径）或 npm 包名。目标项目必须是 git 仓库。

## CLI

```sh
dcae validate    # 任务/门禁静态校验（引用检查、保护路径重叠、DAG 无环）
dcae status      # 任务状态投影（离线读事件日志）
dcae inbox list  # 收件箱
dcae decide INBOX-000001 --option approve --note "..."   # 决策（经邮箱，≤5s 生效）
dcae retry <TASK> / dcae revalidate <TASK> / dcae promote [--branch main]
dcae approve-spec <SPEC-ID>
dcae verify      # 无状态只读核查（CI 可用）
```

## 开发

```sh
bun install
bun run typecheck        # tsc --noEmit
bun test                 # 单元测试（80 用例，无 OpenCode 依赖）
bun test/contract/run.ts [--case=T-3 ...] [--with-model] [--keep]
                         # M0 契约测试：起真实 opencode serve 实跑十四项
```

契约测试结果存档于 `test/contract/results/`（按日期；平台升级后重跑——1.4 §3 第 8 项：通配符语义是活跃演进面）。

## 实测快照（2026-11-16，OpenCode v2.3.0）

- 十四项契约：12 PASS / 0 FAIL / 2 INCONCLUSIVE（T-9 压缩 epoch 半、T-12 idle outcome 半需真实 LLM 会话，`--with-model` 执行）。
- 平台行为观察（详见 results md）：服务器对会话创建未知字段宽松接受（OpenAPI `additionalProperties:false` 是契约层约束）；插件装载由 location 首个 API 请求触发；RPC 输出 schema 必须用 JSON Schema（zod 无法被响应编码）。
- 插件未加载时排查：设 `DCAE_CONTRACT=1` 后查看目标项目 `.dcae/setup-probe.log`。

## 里程碑状态

- M0 契约测试 ✅（2026-11-16，v2.3.0 快照）
- M1–M5 内核全组件 ✅（源码 + 80 单测；LLM 端到端冒烟待用户择时执行）
