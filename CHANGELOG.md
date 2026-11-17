# Changelog

本文件记录 dcae-oc 的显著变更。版本遵循语义化版本。

## 0.1.1

修复全局安装下的启动行为缺陷：插件不再在非 DCAE 项目里报错。

### 修复

- **非 DCAE 项目不再拒绝启动**：此前插件对 `<项目>/.opencode/agents/dcae-*.md` 做 fail-closed 检查，
  一旦缺失即 `throw` 并显示「插件拒绝启动」。全局安装的插件会在每个 location 执行 setup，
  导致在任意普通项目中打开 OpenCode 都会看到该报错——这是缺陷，不是预期。
  - 改为**项目意图探测**（只读、无副作用）：命中 `.dcae/`、`gates.yaml`、`tasks/*.yaml`、
    `opencode.json(c)` 顶层 `dcae` 键或角色智能体文件，方视为 DCAE 项目并激活内核；
  - 非 DCAE 项目**静默跳过**（不注册工具、不建内核、不抛错、无日志噪声）；
  - 探测排在建内核之前——避免旧行为在报错前已由 Kernel 构造 `mkdir .dcae/` 的副作用。
- **角色智能体缺失改为降级而非致命**：DCAE 项目但脚手架不全时，内核保持**未就绪**（不调度），
  不再抛错。
- 新增 **`/dcae-init`** 命令：任何 location 均可注册，供用户显式初始化当前项目
  （写入 `.opencode/agents`、`opencode.json`、`gates.yaml` 等脚手架）。

### 变更

- `initProject` 的 `pluginRef`/`model` 支持显式 `null`：全局安装场景不重复声明 `plugins`、
  使用宿主默认模型。
- `agentsPresent` 收敛为 `src/init/detect.ts` 中的单一定义（`init.ts` 再导出）。

### 测试

- 新增 `test/unit/detect.test.ts`（9 例）：空目录/普通项目/各信号命中/无副作用/init 后探测/
  缺 agents 降级/`null` 选项渲染。单元测试 85 → **94**。

## 0.1.0

首个可发布版本（OpenCode V2 ≥ 2.3.0）。

### 内核能力

- 任务状态机（十二态、事件溯源 `events.jsonl`、带守卫迁移、快照重建）
- 隔离 worktree + 最小权限会话（模型/权限/环境原子施加）
- 门禁管线（命令表、glob 展开、证据落盘、范围检查、依赖锁文件豁免）
- 审查闭环（reviewer dispatch → verdict → 冻结 ref → 合并列车）
- 人类收件箱（question/escalation/test-exhausted 等，决策经邮箱 ≤5s 生效）
- `dcae` CLI 与 `/dcae:*` 斜杠命令；RPC `dcae/status`
- M0 契约 14 PASS / 0 FAIL（2 项 LLM 依赖标记 INCONCLUSIVE，由全链 e2e 等效覆盖）

### 真实项目实测修复（2026-11-17，详见 `test/contract/results/2026-11-17-real-scenario-test.md`）

- **（阻断）审查闭环永不自动通过**：`session.idle` 事件负载读错字段（`properties` → `data.sessionID`），
  且 `awaitIdle` 丢失 `outcome==='succeeded'` 分支，导致正常结束的审查会话无法识别、REVIEW 必等到
  30 分钟窗口超时升级为 BLOCKED。抽出纯函数 `parseIdleEvent()` 并补回归测试。
- **（高）幽灵空任务**：外来/历史会话的请求以 `task=""` 落盘，污染投影并生成不可恢复的收件箱项。
  增加会话归属校验（fail-closed）并在投影层跳过空 task id。
- **（中）`DCAE_PROBE=1` 破坏事件循环**：调用不存在的 `probeLog`；改走 `hangProbe.probeLog`。
- **（中）`dcae promote` 永远失败**：`git fetch . <ref>:<branch>` 拒绝更新已检出的主分支；
  改用 `merge --ff-only`（分叉时给出明确提示）。

### 发布卫生

- 新增 `LICENSE`（MIT）；`files` 纳入 LICENSE
- `engines` 由 `node` 更正为 `bun`（包内以 Bun 运行 TS；`bin` shebang 为 bun）
- `@opencode/plugin` 依赖范围由 `>=2.3.0` 收紧为 `^2.3.0`
- `npm run typecheck` 归零（此前 `src/` 2 处 + `test/e2e/*` 约 107 处错误）
- README 验证记录数字与实际对齐（契约 14 PASS、单元 85/85）
