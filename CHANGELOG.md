# Changelog

本文件记录 dcae-oc 的显著变更。版本遵循语义化版本。

## 0.1.0 — 未发布

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
