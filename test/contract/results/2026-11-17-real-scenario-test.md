# DCAE-OC 真实项目实测报告（2026-11-17 下午，OpenCode v2.3.0）

**被测对象**：`plugin/`（dcae-oc，DCAE-OC 确定性内核插件）
**测试实例**：`E:\Code\wir-mcp`（真实 TypeScript/Bun 项目，双任务 DAG）
**执行者**：接手的 OpenCode 代理（本报告作者）；测试由真实 DeepSeek 会话完成实现/审查
**结论**：**发现并修复 3 个阻断级真实缺陷**；修复后链路自动推进到 **T-WIR-001/T-WIR-002 双 MERGED**，全程无需人工介入（仅收件箱决策由人类点击一次）。

> 本轮暴露的核心教训：**前序"全链 MERGED"的结论掩盖了 REVIEW 闭环根本不工作**——旧链路是靠人工 `retry`/`decision` 反复兜底走完的；一旦接入真实的"零人工"预期，问题立即显形。

---

## 1. 缺陷台账（本轮新增，均已修复+提交）

### D-16（阻断）审查闭环永不自动通过：idle 信号双失效

| 项 | 内容 |
| --- | --- |
| 现象 | reviewer 会话正常结束（`outcome=succeeded`）后，T-WIR-001 停在 `REVIEW` 不动，直到 **30 分钟**窗口耗尽才 `review-escalated{outcome:"timeout"}` → `BLOCKED` + 收件箱 |
| 实测时间线 | 05:59:28 dispatch reviewer → 06:13:52 会话 `succeeded` → 06:33:07 `review-escalated(timeout)` |
| 根因 ① | `src/index.ts` 解析 `session.idle` 时读 `e.properties ?? e.data?.properties`，但平台负载是 `{ type, data: { sessionID } }`（见 `@opencode/client` `SessionIdle`）→ `noteSessionIdle` 从不触发 |
| 根因 ② | `src/host/opencode.ts` 的 `awaitIdle` 轮询只认 `failed`/`interrupted`，`eb8a082` 把 `if (outcome==='succeeded') return 'idle'` 分支删掉了 → 正常结束与"仍在运行"无法区分 |
| 影响 | **每个任务都必须在 REVIEW 处人工救场**，与"HANDOVER 声称全流程无需人工"直接矛盾 |
| 修复 | 抽 `parseIdleEvent()` 纯函数（`src/kernel/idle-signal.ts`）按平台 schema 逐字取值；恢复 `succeeded → idle`；补单测锁定 |
| 提交 | `45cbb17` |

### D-17（高）幽灵空任务：外来会话请求以 `task=""` 落盘

| 项 | 内容 |
| --- | --- |
| 现象 | 事件 seq 15 `task:""`（来自 T-WIR-002 旧 dev 会话的 `dcae_question`）；`dcae status` 出现空行；`INBOX-000001.ref.task=""` → 该决策无法恢复任何任务 |
| 根因 | 会话投影丢失 T-WIR-002 的 sessionId 后，`taskOf()` 反查返回空串，内核照单全收 |
| 修复 | `Kernel.processIngest` 对 non-decision 请求做**会话归属校验**（fail-closed）；`Projection.apply` 跳过空 task id |
| 提交 | `45cbb17` |

### D-18（中）`DCAE_PROBE=1` 反而破坏事件循环

| 项 | 内容 |
| --- | --- |
| 现象 | `src/index.ts` 调用 `hangProbeMod.probeLog(...)`，但模块只导出 `hangProbe`（`probeLog` 未导出）→ `TypeError`，`tsc` 亦报错 |
| 影响 | 假死排查开关本身会让事件循环崩掉；且 `bun run typecheck` 对 `src/` 失败（与评审报告"tsc 干净"不符） |
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

- **插件热重载**：保存 `src/*.ts` 后，运行中的 `serve` 会自动重载（`kernel.log` 出现新的 `实例 setup 完成`）。因此**测试期改源码会即时影响在跑实例**，也可能打断进行中的 dispatch（本轮 T-WIR-002 首轮 `execution-failed` 即发生在热重载与 dispatch 交叠的 5s 窗口内，报 `Agent not found: dcae-dev`，retry 后正常）。建议：**改插件源码时勿与关键 dispatch 并发**。
- **`dcae status` 的 CLI 依赖**：本机 `dcae` 是 scoop shim（`bun E:\Code\DCAE-OC\plugin\src\cli.ts`），直接跑本地源码，故修复即时生效；npm 安装态需重装（见 HANDOVER 陷阱 4）。
- **HANDOVER 完成标准的"双 MERGED"此前是假阳性**：因缺口被人工决策掩盖。本轮修复后才真正达成"零人工"。

---

## 2. 复现与验证

```sh
# 修复后：
cd E:\Code\wir-mcp
dcae status            # T-WIR-001 MERGED / T-WIR-002 MERGED
bun test               # 39 pass / 0 fail
dcae verify            # 通过
# MCP 三工具往返（见 §3）

cd E:\Code\DCAE-OC\plugin
bun run typecheck      # src/ 0 error（test/e2e/* 的历史类型债仍在，见下）
bun test test/unit     # 85 pass / 0 fail（含新增 5 个 idle-signal 回归用例）
```

**已知残留债**（本轮未处理，非阻断）：`test/e2e/*.ts` 有 ~109 处 TS 错误（历史诊断脚本缺 `export {}`/可选链），使 `bun run typecheck` 整体仍非 0；`src/` 已干净。

---

## 3. 端到端证据（修复后，事件实录）

```
T-WIR-001: plan-approved → deps-merged → dispatch(dev) → dcae_submit
           → gate-pass → dispatch(reviewer) → frozen-ref → review-pass
           → merge-ok            ← 审查闭环自动通过（修复前此处必超时）
T-WIR-002: plan-approved → deps-merged → dispatch → gate-pass
           → dispatch(reviewer) → frozen-ref → review-pass → merge-ok
```

- 事件数 38；`refs/dcae/accepted/T-WIR-001=0679a30`、`accepted/T-WIR-002=49716c8`、`integration=b240704`
- MCP 往返：`wir_validate`（valid:true）、`wir_normalize`（幂等规范化文本）、`wir_outline`（SECTION→PARAGRAPH 缩进大纲）三工具均正确响应

---

## 4. 对前序结论的修正

- 前序评审称"全链 MERGED，无需人工"**不成立**：REVIEW 闭环缺 idle 信号，必由人工 `retry/decision` 兜底。
- 前序称"`tsc` 干净"**仅对 `src/` 子集成立**；整体 `bun run typecheck` 会因 `test/e2e/*` 失败。
- 其余"M0 契约 12 PASS""单元 80/80"等在本轮复核中保持成立（单元已增至 85）。
