# 轨道编队主控切换共识模拟

值班员控制台 + Raft 式共识内核：创建 3–5 个模拟控制节点，设置不可达节点，以控制器标识
申请任期（租约），提交带稳定请求标识的指令；页面经真实 REST 接口展示现役任期、
法定确认节点与各节点已接受的指令序列。支持安全退役控制节点：以联合共识（C_old,new）
迁移投票名单，旧、新名单各自多数确认后才完成最终切换。

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
| 任期申请 | 多数节点可达才授予；他人租约未失效则拒绝；本人申请为续期 |
| 租约失效 | TTL 到期或 `POST /api/lease/revoke`；失效后旧任期只能追赶不能提交 |
| 栅栏 | 旧任期 / 未授予任期 / 非主控 / 租约失效的提交一律 409，节点日志不增长 |
| 提交 | 条目落盘到多数节点才判定 committed，响应前持久化，崩溃重启不丢 |
| 幂等 | 同 requestId 同内容重传返回原结论不重复追加；改换内容返回 409 冲突 |
| 追赶 | 节点恢复可达即按 canonical 日志收敛（截断分叉、补齐缺失） |
| 名单迁移 | 联合共识 C_old,new：先进入联合配置，配置条目须旧名单与新名单**各自**多数（当前可达）持久确认；联合期间普通指令同样按双名单多数确认 |
| 最终切换 | 配置条目拿到双名单多数的一刻原子完成名单切换（退役节点退出并清理日志）；在此之前现役名单、任期、节点日志不因提案改变 |
| 迁移幂等 | 同 migrationId 同目标集合重传返回原结论（joint 或已完成的归档结论），不重复追加；改换目标 409；迁移进行中另开迁移被拒 |
| 失败迁移 | 配置条目未获联合多数时，现役主控可中止：截断联合尾部、移除新节点，回到旧名单单一名单规则；任期与已提交前缀不变 |
| 迁移崩溃 | 联合阶段进程退出，重启从持久日志恢复**唯一**在途迁移阶段；恢复后节点回归即自动推进或可中止 |

## REST 接口

```
GET    /health                         健康路径
GET    /api/state                      现役任期/法定确认节点/各节点已接受序列
POST   /api/cluster        {size:3..5} 创建编队
POST   /api/reset                      清空编队
POST   /api/term           {controllerId}
POST   /api/lease/revoke   {}
POST   /api/nodes/:id/reachability {reachable:bool}
POST   /api/commands       {controllerId, term, requestId, payload, crash?}
POST   /api/migrations     {controllerId, term, migrationId, targetVoterIds, crash?}
POST   /api/migrations/abort {controllerId, term}
```

`crash: true` 在多数确认落盘后、响应前退出进程，用于演练「崩溃后重启仍已提交」。
迁移接口的 `crash: true` 则在联合配置持久化后退出，演练「重启恢复唯一迁移阶段」。

### 迁移接口

```
POST /api/migrations
  { "controllerId": "C", "term": 3,
    "migrationId": "mig-retire-n3",       // 稳定迁移标识（幂等键）
    "targetVoterIds": ["n1","n2","n4"],  // 3-5 个目标投票节点，须与现役名单至少重叠 1 个
    "crash": false }
```

- 成功且双名单多数当场凑齐：`200`，`status:"committed"`, `phase:"stable"`，含
  `oldRoster/newRoster/confirmedByOld/confirmedByNew/retiredVoters/joinedVoters`。
- 任一名单多数不可达：`202`，`status:"joint"`, `phase:"joint"`，给出双名单各自确认
  节点（`oldAck/newAck`）与多数门槛；现役名单、任期、节点日志均不改变。
- 同 `migrationId` 同目标重传：返回原结论且 `duplicate:true`；改换目标 `409 CONFLICT`；
  迁移进行中提交另一个迁移 `409 MIGRATION_ACTIVE`。
- `POST /api/migrations/abort` 中止未获联合多数的在途迁移（截断联合尾部、移除新节点）；
  配置条目若已联合提交则名单已原子切换，无在途迁移可中止。

`GET /api/state` 额外提供：`config.phase`（stable/joint）、`config.voters`（现役名单）、
`migration`（在途迁移的旧/新名单、各自确认节点与阶段），各节点带 `inOldConfig/
inNewConfig/retiring/joining` 标记，供控制台实时渲染。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8080 | 容器内监听端口 |
| `HOST_PORT` | 8080 | Compose 宿主机映射端口 |
| `DATA_DIR` | ./data（容器 /data） | 持久化目录（cluster.json + node-*.json） |
| `LEASE_MS` | 120000（容器）/ 60000（本地） | 租约时长 |

## 目录

```
src/cluster.js   共识内核（任期/租约/栅栏/幂等/持久化/追赶）
src/server.js    HTTP 层（REST + 静态控制台）
public/          值班员控制台页面
test/            node:test 代码测试（崩溃恢复/旧主控迟到/重传冲突等）
verify/smoke.js  HTTP 冒烟验收（退出码报告结果）
```
