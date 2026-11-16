# dcae-oc — DCAE-OC 内核（OpenCode V2 插件）

确定性内核：把已批准的计划变成任务 DAG，在隔离 git worktree 中以最小权限会话运行每个任务；只接受内核产出的证据；受控合并列车；判断性决策进人类收件箱。含 `dcae` CLI。

上游规范与设计文档见 `E:\Code\DCAE-OC\`（1.4 规范、项目设计 v1.0、架构设计 v1.0）。

## 安装（OpenCode 官方插件形态）

按官方 Build plugins › Publish/Load：**已发布插件就是一个 npm 包**。三种安装方式：

### A. 发布后安装（标准形态）

```sh
# 发布（维护者，一次性）
cd dcae-oc && npm publish

# 用户安装（全局插件缓存，对所有项目生效）
opencode plugin add dcae-oc

# 或仅在单个项目启用：项目 opencode.json
{ "plugins": ["dcae-oc"] }
```

### B. Git 仓库安装（未发 npm 时）

```sh
opencode plugin add github:Cikaros/dcae-oc
# 或 opencode.json："plugins": ["github:Cikaros/dcae-oc"]
```

### C. 本地目录安装（开发态）

```json
{ "plugins": ["E:/Code/DCAE-OC/plugin"] }
```

## 初始化目标项目（必须）

安装插件后，在**目标项目**根目录跑一次脚手架（写入四角色智能体、`opencode.json`、`gates.yaml`、AGENTS.md 协议块、目录骨架——插件启动时校验智能体存在，缺失即拒绝加载）：

```sh
npx dcae-oc init        # 全局/缓存安装形态
# 或本地开发形态：
bun E:/Code/DCAE-OC/plugin/src/cli.ts init . --plugin "E:/Code/DCAE-OC/plugin" --runner bun
```

然后 `git add -A && git commit`（worktree 分发依赖这些文件入库），启动 OpenCode 即生效。

把 `gates.yaml` 改成项目实际的测试/typecheck 命令（**人类所有**；任务 `checks.run` 只能引用这里的命令 id）。

## CLI

```sh
dcae validate                 # 任务/门禁静态校验
dcae status                   # 任务状态投影
dcae inbox list / decide INBOX-xxxx --option y / sync
dcae retry <TASK> / revalidate <TASK> / promote [--branch main] / approve-spec <ID>
dcae verify                   # 无状态只读核查（CI）
```

## 开发

```sh
bun install && bun run typecheck && bun test    # 80 单测
bun test/contract/run.ts [--with-model]          # M0 契约测试（起真实 opencode serve 实跑十四项）
```

## 实测快照（2026-11-16，OpenCode v2.3.0）

- M0 契约十四项：12 PASS / 0 FAIL / 2 INCONCLUSIVE（需真实 LLM，`--with-model`）；结果存档 `test/contract/results/`。
- **安装后的包已按官方要求实测**（"test the installed package, not only a workspace-linked copy"）：npm pack → 独立安装 → OpenCode 加载 → setup 全阶段 + RPC 自调用 + 内核 leader 初始化全部通过。
- 平台行为注记：目标项目配置用**纯 JSON**（本平台解析带中文注释的 jsonc 失败）；插件装载由 location 首个 API 请求触发；RPC output schema 须用 JSON Schema（zod 无法被编码）。详见项目设计 D-6/D-7。
- 插件未装载排查：设 `DCAE_CONTRACT=1` 启动，查目标项目 `.dcae/setup-probe.log`。
