# 轨道编队主控切换共识模拟

值班员控制台 + Raft 式共识内核：创建 3–5 个模拟控制节点，设置不可达节点，以控制器标识
申请任期（租约），提交带稳定请求标识的指令；页面经真实 REST 接口展示现役任期、
法定确认节点与各节点已接受的指令序列。

## 快速开始

```bash
# 本地运行（Node 20+，零依赖）
npm start                      # http://localhost:8080 ，健康路径 /health

# Docker：可配置宿主机端口
HOST_PORT=9090 docker compose up app        # 控制台 http://localhost:9090

# 验收：代码测试 + 构建产物 + HTTP 冒烟，退出码即验收结果
docker compose up --build --exit-code-from verify --abort-on-container-exit verify
echo $?                        # 0 = 验收通过
```

## 共识语义

| 能力 | 行为 |
| --- | --- |
| 任期申请 | 多数节点可达才授予；他人租约未失效则拒绝；本人申请为续期。联合配置期间需旧、新名单各自多数可达 |
| 租约失效 | TTL 到期或 `POST /api/lease/revoke`；失效后旧任期只能追赶不能提交 |
| 栅栏 | 旧任期 / 未授予任期 / 非主控 / 租约失效的提交一律 409，节点日志不增长 |
| 提交 | 条目落盘到多数节点才判定 committed，响应前持久化，崩溃重启不丢 |
| 幂等 | 同 requestId 同内容重传返回原结论不重复追加；改换内容返回 409 冲突 |
| 追赶 | 节点恢复可达即按 canonical 日志收敛（截断分叉、补齐缺失）；已退役节点日志冻结 |
| 名单迁移 | 见下：联合配置 C_old,new，双名单多数确认后才最终切换 |

### 控制节点安全退役（联合共识）

不能仅凭新名单多数就让旧法定成员失去对配置变更的裁决权。主控取得有效任期后，提交带
**稳定迁移标识** `migrationId` 与**目标投票节点集合** `voters` 的迁移：

1. 服务先把编队置入**联合配置** C_old,new：旧名单与新名单各自独立计票。
2. 联合配置条目必须**同时获得旧名单与新名单的多数确认**后，才能提交 C_new 完成最终名单切换；
   旧名单中落选的节点退役、日志冻结。
3. **迁移期间普通姿态指令也必须按联合多数确认**（旧、新双名单多数），不能沿用单一名单规则。
4. **门闩**：任一名单多数不可达时迁移请求被拒（503/NO_MAJORITY），不写入任何日志——
   现役名单、任期、节点日志均不变。
5. 崩溃恢复：确认多数后进程退出，重启从持久日志重建**唯一迁移阶段**与双名单确认集合；
   迁移/切换的重传只返回原结论，不重复追加。
6. 可主动中止迁移：旧名单多数确认一条回滚配置后回到 C_old，随后恢复单一名单确认规则。

## REST 接口

```
GET    /health                         健康路径
GET    /api/state                      现役任期/投票名单/迁移阶段/各节点已接受序列
POST   /api/cluster        {size:3..5} 创建编队
POST   /api/reset                      清空编队
POST   /api/term           {controllerId}
POST   /api/lease/revoke   {}
POST   /api/nodes/:id/reachability {reachable:bool}
POST   /api/commands       {controllerId, term, requestId, payload, crash?}
POST   /api/migrations     {controllerId, term, migrationId, voters, crash?}
                                         提交迁移：进入联合配置 C_old,new
POST   /api/migrations/:id/finalize {controllerId, term, crash?}
                                         双名单多数确认后提交 C_new，完成最终切换
POST   /api/migrations/:id/abort    {controllerId, term}
                                         中止迁移：旧名单多数确认回滚 C_old
```

`crash: true` 在多数确认落盘后、响应前退出进程，用于演练「崩溃后重启仍已提交」；
迁移接口的 `crash` 分别演练联合配置阶段与最终切换阶段的崩溃恢复。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8080 | 容器内监听端口 |
| `HOST_PORT` | 8080 | Compose 宿主机映射端口 |
| `DATA_DIR` | ./data（容器 /data） | 持久化目录（cluster.json + node-*.json） |
| `LEASE_MS` | 120000（容器）/ 60000（本地） | 租约时长 |

## 目录

```
src/cluster.js   共识内核（任期/租约/栅栏/幂等/持久化/追赶/联合配置迁移）
src/server.js    HTTP 层（REST + 静态控制台）
public/          值班员控制台页面
test/            node:test 代码测试（崩溃恢复/栅栏/重传冲突/联合确认/迁移恢复/失败迁移）
verify/smoke.js  HTTP 冒烟验收（退出码报告结果）
```
