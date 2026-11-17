# DCAE-OC 真实项目实测报告（2026-11-17，OpenCode v2.3.0）

**被测对象**：`plugin/`（dcae-oc，DCAE-OC 确定性内核插件）
**测试实例**：一个真实的 TypeScript/Bun 双任务 DAG 项目（依赖式 `deps`）
**执行者**：接手的 OpenCode 代理；实现/审查由真实 LLM 会话完成
**结论**：发现并修复 **4 个真实缺陷（含 1 个阻断级）**；修复后链路自动推进到**双任务 MERGED**，全程无需人工介入（仅一处收件箱决策由人类点击）。

> 本轮的核心教训：**"全链 MERGED"的表象可能掩盖审查闭环根本不工作**——旧链路是靠人工 `retry`/`decision` 反复兜底走完的；一旦接入真实的"零人工"预期，问题立即显形。任何"全链通过"的结论，都应显式断言事件日志中**不含**人工救场事件（`retry` / `decision-applied`），否则可能是假阳性。

---

## 1. 缺陷台账（均已修复 + 提交）

### D-16（阻断）审查闭环永不自动通过：idle 信号双失效

| 项 | 内容 |
| --- | --- |
| 现象 | reviewer 会话正常结束（`outcome=succeeded`）后，任务停在 `REVIEW` 不动，直到 **30 分钟**窗口耗尽才 `review-escalated{outcome:"timeout"}` → `BLOCKED` + 收件箱 |
| 实测时间线 | dispatch reviewer（05:59:28）→ 会话 `succeeded`（06:13:52）→ `review-escalated(timeout)`（06:33:07） |
| 根因 ① | `src/index.ts` 解析 `session.idle` 时读 `e.properties ?? e.data?.properties`，但平台负载是 `{ type, data: { sessionID } }`（见 `@opencode/client` `SessionIdle`）→ `noteSessionIdle` 从不触发 |
| 根因 ② | `src/host/opencode.ts` 的 `awaitIdle` 轮询只认 `failed`/`interrupted`，此前提交删掉了 `if (outcome==='succeeded') return 'idle'` 分支 → 正常结束与"仍在运行"无法区分 |
| 影响 | **每个任务都必须在 REVIEW 处人工救场**，与"全流程无需人工"的设计目标直接矛盾 |
| 修复 | 抽 `parseIdleEvent()` 纯函数（`src/kernel/idle-signal.ts`）按平台 schema 逐字取值；恢复 `succeeded → idle`；补回归单测锁定 |
| 提交 | `45cbb17` |

### D-17（高）幽灵空任务：外来会话请求以 `task=""` 落盘

| 项 | 内容 |
| --- | --- |
| 现象 | 事件中出现 `task:""`（来自旧 dev 会话的 `dcae_question`）；`dcae status` 出现空行；收件箱项 `ref.task=""` → 该决策无法恢复任何任务 |
| 根因 | 会话投影丢失任务 sessionId 后，`taskOf()` 反查返回空串，内核照单全收 |
| 修复 | `Kernel.processIngest` 对 non-decision 请求做**会话归属校验**（fail-closed）；`Projection.apply` 跳过空 task id |
| 提交 | `45cbb17` |

### D-18（中）`DCAE_PROBE=1` 反而破坏事件循环

| 项 | 内容 |
| --- | --- |
| 现象 | `src/index.ts` 调用 `hangProbeMod.probeLog(...)`，但模块只导出 `hangProbe`（`probeLog` 未导出）→ `TypeError`，`tsc` 亦报错 |
| 影响 | 假死排查开关本身会让事件循环崩掉；且 `typecheck` 对 `src/` 失败 |
| 修复 | 改调 `hangProbeMod.hangProbe.probeLog(...)`；`src/` 现已 typecheck-clean |
| 提交 | `45cbb17` |

### D-19（中）`dcae promote` 永远失败：向已检出分支 `fetch`

| 项 | 内容 |
| --- | --- |
| 现象 | `fatal: refusing to fetch into branch 'refs/heads/main' checked out at '<canonical>'` |
| 根因 | `promote()` 用 `git fetch . refs/dcae/integration:main`；canonical 目录常态就检出于 main，git 拒绝更新已检出分支 |
| 修复 | 检出的目标分支走 `merge --ff-only`（同时推进 ref 与工作树，非 ff 安全失败）；非检出分支先验祖先再 `update-ref`；分叉时给出明确提示 |
| 提交 | `ec59d39` |

### 观察项（非缺陷，供参考）

- **插件热重载**：保存 `src/*.ts` 后，运行中的 `serve` 会自动重载（`kernel.log` 出现新的 `实例 setup 完成`）。因此**测试期改源码会即时影响在跑实例**，也可能打断进行中的 dispatch（曾观测到热重载与 dispatch 交叠的 5 秒窗口内，会话以 `Agent not found` 收场，`retry` 后正常）。建议：**改插件源码时勿与关键 dispatch 并发**。

---

## 2. 复现与验证

```sh
# 插件仓内：
bun run typecheck      # 0 error（src 与 test 均已收敛）
bun test test/unit     # 85 pass / 0 fail（含新增 idle-signal 回归用例）
bun test/contract/run.ts   # M0 契约 14 PASS / 0 FAIL

# 目标项目内（内核管控的项目）：
dcae status            # 双任务 MERGED
dcae verify            # 通过
```

---

## 3. 端到端证据（修复后，事件实录）

```
<task-A>: plan-approved → deps-merged → dispatch(dev) → dcae_submit
          → gate-pass → dispatch(reviewer) → frozen-ref → review-pass
          → merge-ok            ← 审查闭环自动通过（修复前此处必超时）
<task-B>: plan-approved → deps-merged → dispatch → gate-pass
          → dispatch(reviewer) → frozen-ref → review-pass → merge-ok
```

- `refs/dcae/accepted/<task>` 与 `refs/dcae/integration` 均正确推进；事件链完整留痕 `.dcae/state/events.jsonl`
- 安装态包全链 e2e（npm pack → 独立 `npm i` → 真实 serve）：单任务推进至 **MERGED**，且**审查闭环零人工**（无 `retry` / `decision-applied` 事件）

---

## 4. 修复前后对照

- 修复前评审称"全链 MERGED，无需人工"**不成立**：REVIEW 闭环缺 idle 信号，必由人工 `retry`/`decision` 兜底。
- 修复前 `typecheck` **仅 `src/` 子集成立**；整体 `bun run typecheck` 会因 `test/e2e/*` 历史脚本失败（本轮已收敛为 0）。
- 修复后：真实项目双任务与安装态单任务均**零人工**到达 MERGED。
