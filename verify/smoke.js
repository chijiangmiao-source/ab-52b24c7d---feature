'use strict';

/**
 * HTTP 冒烟验收：对任期申请、指令提交、健康路径执行端到端检查。
 * 覆盖：多数确认后崩溃重启、旧主控迟到栅栏、重传冲突、多数不可达、追赶收敛、
 * 联合共识名单迁移（双名单确认/崩溃恢复唯一阶段/失败迁移中止后的兼容提交）。
 * 以退出码报告验收结果：0 通过，1 失败。
 */

const APP = process.env.APP_URL || 'http://localhost:8080';

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${APP}/health`);
      if (r.status === 200) return true;
    } catch (_) {
      /* 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function logsOf(state) {
  return state.nodes.map((n) => n.log.map((e) => e.requestId));
}

async function main() {
  console.log(`[smoke] 目标 ${APP}`);

  // 0. 健康路径
  console.log('[1] 健康路径');
  ok('GET /health -> 200', await waitHealth(20000));
  const h = await req('GET', '/health');
  ok('健康路径返回 status=ok', h.status === 200 && h.data.status === 'ok', h);

  // 1. 创建三节点编队
  console.log('[2] 创建三节点编队');
  let r = await req('POST', '/api/cluster', { size: 3 });
  ok('创建编队 200', r.status === 200 && r.data.initialized === true, r);
  ok('三节点且多数为 2', r.data.size === 3 && r.data.majority === 2, r.data);

  // 2. 控制器 A 申请任期并提交指令
  console.log('[3] A 获得多数确认并提交指令');
  r = await req('POST', '/api/term', { controllerId: 'A' });
  ok('A 获得任期 1', r.status === 200 && r.data.term === 1, r);
  ok('法定确认节点 >= 多数', Array.isArray(r.data.quorum) && r.data.quorum.length >= 2, r.data);
  r = await req('POST', '/api/commands', { controllerId: 'A', term: 1, requestId: 'cmd-1', payload: 'burn:prograde:12s' });
  ok('指令 committed', r.status === 200 && r.data.status === 'committed', r);
  ok('确认节点覆盖三节点', r.data.confirmedBy && r.data.confirmedBy.length === 3, r.data);
  let s = (await req('GET', '/api/state')).data;
  ok('唯一现役任期 = 1', s.activeTerm === 1, s.activeTerm);
  ok('三节点已提交序列一致', logsOf(s).every((l) => l.join() === 'cmd-1'), logsOf(s));
  ok('lastCommit 确认节点为三节点', s.lastCommit && s.lastCommit.confirmedBy.length === 3, s.lastCommit);

  // 3. 租约未失效时 B 申请被拒；A 租约失效后 B 取得更高任期
  console.log('[4] 租约语义与主控切换');
  r = await req('POST', '/api/term', { controllerId: 'B' });
  ok('租约有效时 B 申请被拒 409', r.status === 409 && r.data.error.code === 'LEASE_HELD', r);
  await req('POST', '/api/lease/revoke', {});
  r = await req('POST', '/api/term', { controllerId: 'B' });
  ok('B 取得更高任期 2', r.status === 200 && r.data.term === 2, r);
  r = await req('POST', '/api/commands', { controllerId: 'B', term: 2, requestId: 'cmd-2', payload: 'burn:radial:3s' });
  ok('B 提交新指令 committed', r.status === 200 && r.data.status === 'committed', r);

  // 4. 旧主控迟到：A 以旧任期重试被栅栏拒绝
  console.log('[5] 旧主控迟到栅栏');
  r = await req('POST', '/api/commands', { controllerId: 'A', term: 1, requestId: 'cmd-stale', payload: 'stale' });
  ok('旧任期提交被栅栏拒绝 409/FENCED_TERM', r.status === 409 && r.data.error.code === 'FENCED_TERM', r);
  s = (await req('GET', '/api/state')).data;
  ok('任一节点日志均未新增旧指令', s.nodes.every((n) => n.log.length === 2 && !n.log.some((e) => e.requestId === 'cmd-stale')), logsOf(s));

  // 5. 多数确认后、响应前崩溃 -> 重启后仍已提交
  console.log('[6] 多数确认后崩溃，重启恢复');
  let crashed = false;
  try {
    await fetch(`${APP}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controllerId: 'B', term: 2, requestId: 'cmd-3', payload: 'burn:normal:5s', crash: true }),
    });
  } catch (_) {
    crashed = true; // 响应前退出：连接被重置
  }
  ok('崩溃提交未收到响应（进程退出）', crashed);
  ok('重启后健康路径恢复', await waitHealth(30000));
  s = (await req('GET', '/api/state')).data;
  ok('cmd-3 重启后仍显示已提交', s.committedSequence.some((e) => e.requestId === 'cmd-3'), s.committedSequence);
  ok('重启后三节点日志收敛一致', logsOf(s).every((l) => l.join() === 'cmd-1,cmd-2,cmd-3'), logsOf(s));

  // 6. 重传：同标识同内容返回原结论不重复追加；改换内容冲突
  console.log('[7] 重传与冲突');
  r = await req('POST', '/api/commands', { controllerId: 'B', term: 2, requestId: 'cmd-3', payload: 'burn:normal:5s' });
  ok('同标识重传返回原结论 committed', r.status === 200 && r.data.status === 'committed' && r.data.duplicate === true, r);
  s = (await req('GET', '/api/state')).data;
  ok('重传不重复追加', s.nodes.every((n) => n.log.length === 3), logsOf(s));
  r = await req('POST', '/api/commands', { controllerId: 'B', term: 2, requestId: 'cmd-3', payload: 'burn:normal:99s' });
  ok('同标识改换内容返回冲突 409/CONFLICT', r.status === 409 && r.data.error.code === 'CONFLICT', r);

  // 7. 多数不可达：申请任期失败，状态不变
  console.log('[8] 多数节点不可达');
  await req('POST', '/api/nodes/n2/reachability', { reachable: false });
  await req('POST', '/api/nodes/n3/reachability', { reachable: false });
  const before = (await req('GET', '/api/state')).data;
  r = await req('POST', '/api/term', { controllerId: 'C' });
  ok('多数不可达时申请任期失败 503/NO_MAJORITY', r.status === 503 && r.data.error.code === 'NO_MAJORITY', r);
  const after = (await req('GET', '/api/state')).data;
  ok('现役任期保持不变', after.activeTerm === before.activeTerm, { before: before.activeTerm, after: after.activeTerm });
  ok('各节点日志保持不变', JSON.stringify(logsOf(after)) === JSON.stringify(logsOf(before)), logsOf(after));

  // 8. 恢复后：旧任期只能追赶不能提交，刷新读取收敛状态
  console.log('[9] 恢复后追赶与旧任期栅栏');
  await req('POST', '/api/lease/revoke', {});
  await req('POST', '/api/nodes/n2/reachability', { reachable: true });
  await req('POST', '/api/nodes/n3/reachability', { reachable: true });
  s = (await req('GET', '/api/state')).data;
  ok('恢复后各节点日志收敛一致', logsOf(s).every((l) => l.join() === 'cmd-1,cmd-2,cmd-3'), logsOf(s));
  r = await req('POST', '/api/commands', { controllerId: 'B', term: 2, requestId: 'cmd-late', payload: 'late' });
  ok('旧任期（租约失效）提交被拒 409/LEASE_EXPIRED', r.status === 409 && r.data.error.code === 'LEASE_EXPIRED', r);
  s = (await req('GET', '/api/state')).data;
  ok('旧任期提交未进入任何节点日志', s.nodes.every((n) => n.log.length === 3), logsOf(s));

  // 9. 新任期恢复提交能力
  console.log('[10] 新任期恢复提交');
  r = await req('POST', '/api/term', { controllerId: 'C' });
  ok('C 获得任期 3', r.status === 200 && r.data.term === 3, r);
  r = await req('POST', '/api/commands', { controllerId: 'C', term: 3, requestId: 'cmd-4', payload: 'burn:align:2s' });
  ok('新任期指令 committed', r.status === 200 && r.data.status === 'committed', r);
  s = (await req('GET', '/api/state')).data;
  ok('最终收敛：四指令全节点一致', logsOf(s).every((l) => l.join() === 'cmd-1,cmd-2,cmd-3,cmd-4'), logsOf(s));
  ok('最终健康路径 200', (await req('GET', '/health')).status === 200);

  // 10. 联合共识名单迁移（HTTP 端到端）
  console.log('[11] 联合共识：双名单确认后退役 n3');
  await req('POST', '/api/nodes/n3/reachability', { reachable: true });
  r = await req('POST', '/api/migrations', {
    controllerId: 'C', term: 3, migrationId: 'mig-http-1', targetVoterIds: ['n1', 'n2', 'n4'],
  });
  ok('新增 n4：全体可达时双名单多数当场达成 -> committed/stable',
    r.status === 200 && r.data.status === 'committed' && r.data.phase === 'stable', r);
  s = (await req('GET', '/api/state')).data;
  ok('现役名单切换为 n1,n2,n4，n3 已退役', JSON.stringify(s.config.voters) === JSON.stringify(['n1', 'n2', 'n4']), s.config);
  ok('状态接口暴露稳定阶段且无在途迁移', s.config.phase === 'stable' && s.migration === null, s.config);
  ok('迁移结论含旧/新名单与各自确认节点',
    JSON.stringify(r.data.oldRoster) === JSON.stringify(['n1', 'n2', 'n3']) &&
    JSON.stringify(r.data.newRoster) === JSON.stringify(['n1', 'n2', 'n4']) &&
    Array.isArray(r.data.confirmedByOld) && Array.isArray(r.data.confirmedByNew), r.data);

  // 连续第二个迁移：退役 n4、加入 n5（目标 n1,n2,n5）。
  r = await req('POST', '/api/migrations', {
    controllerId: 'C', term: 3, migrationId: 'mig-http-2', targetVoterIds: ['n1', 'n2', 'n5'],
  });
  ok('第二个迁移全体可达时 committed', r.status === 200 && r.data.status === 'committed', r);

  // 扩到 4 节点名单 n1,n2,n5,n6，作为后续僵持场景的旧名单。
  r = await req('POST', '/api/nodes/n6/reachability', { reachable: true });
  ok('对尚未入编节点设置可达性返回 400', r.status === 400, r.data);
  r = await req('POST', '/api/migrations', {
    controllerId: 'C', term: 3, migrationId: 'mig-http-3', targetVoterIds: ['n1', 'n2', 'n5', 'n6'],
  });
  ok('新增 n6 全体可达 -> committed，名单 4 节点', r.status === 200 && r.data.status === 'committed', r);
  s = (await req('GET', '/api/state')).data;
  ok('现役名单 n1,n2,n5,n6', JSON.stringify(s.config.voters) === JSON.stringify(['n1', 'n2', 'n5', 'n6']), s.config);

  // 11. 确定性僵持：提案前先让旧名单 [n1,n2,n5,n6] 掉成少数（仅 n1,n2 可达），
  //     目标 [n1,n2,n7] 的新名单 3 节点全可达 -> 旧名单多数 3 缺失，迁移确定停在 joint。
  console.log('[12] 联合僵持：普通指令按双名单多数被拦，崩溃后恢复唯一阶段');
  await req('POST', '/api/nodes/n5/reachability', { reachable: false });
  await req('POST', '/api/nodes/n6/reachability', { reachable: false });
  r = await req('POST', '/api/migrations', {
    controllerId: 'C', term: 3, migrationId: 'mig-http-stuck', targetVoterIds: ['n1', 'n2', 'n7'],
  });
  ok('旧名单多数缺失 -> 202/joint', r.status === 202 && r.data.status === 'joint' && r.data.phase === 'joint', r);
  ok('迁移结论给出双名单确认进度', r.data.oldConfirmed === false && r.data.newConfirmed === true && r.data.canFinalize === false, r.data);
  s = (await req('GET', '/api/state')).data;
  ok('僵持期间现役名单/任期不变',
    JSON.stringify(s.config.voters) === JSON.stringify(['n1', 'n2', 'n5', 'n6']) &&
    s.config.phase === 'joint' && s.activeTerm === 3, s.config);
  ok('状态接口经真实字段暴露旧、新名单与各自确认节点',
    s.migration && JSON.stringify(s.migration.oldRoster) === JSON.stringify(['n1', 'n2', 'n5', 'n6']) &&
    JSON.stringify(s.migration.newRoster) === JSON.stringify(['n1', 'n2', 'n7']) &&
    JSON.stringify(s.migration.oldAck) === JSON.stringify(['n1', 'n2']) &&
    JSON.stringify(s.migration.newAck.sort()) === JSON.stringify(['n1', 'n2', 'n7']), s.migration);

  // 联合期间普通姿态指令：即便新名单 3/3 全确认，旧名单多数缺失也不得提交。
  r = await req('POST', '/api/commands', {
    controllerId: 'C', term: 3, requestId: 'cmd-joint-http', payload: 'attitude:hold',
  });
  ok('联合期间普通指令缺旧名单多数 -> accepted 不提交（双名单多数规则）',
    r.status === 202 && r.data.status === 'accepted' && r.data.quorum === 'joint', r);
  s = (await req('GET', '/api/state')).data;
  ok('联合僵持期间 committedIndex 不前进', !s.committedSequence.some((e) => e.requestId === 'cmd-joint-http'), s.committedIndex);

  // 僵持状态下让进程在持久化之后、响应之前退出（同标识重传携带 crash）。
  let migCrashed = false;
  try {
    await fetch(`${APP}/api/migrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        controllerId: 'C', term: 3, migrationId: 'mig-http-stuck',
        targetVoterIds: ['n1', 'n2', 'n7'], crash: true,
      }),
    });
  } catch (_) { migCrashed = true; }
  ok('僵持状态重传迁移后进程退出（模拟崩溃）', migCrashed);
  ok('重启后健康路径恢复', await waitHealth(30000));
  s = (await req('GET', '/api/state')).data;
  ok('重启从持久日志恢复唯一联合阶段（同一迁移标识，名单/任期不变）',
    s.migration && s.migration.phase === 'joint' && s.migration.migrationId === 'mig-http-stuck' &&
    s.activeTerm === 3 && JSON.stringify(s.config.voters) === JSON.stringify(['n1', 'n2', 'n5', 'n6']), s.migration);

  // 重传只返回原结论：同标识同目标 duplicate=joint，不重复追加配置条目。
  r = await req('POST', '/api/migrations', {
    controllerId: 'C', term: 3, migrationId: 'mig-http-stuck', targetVoterIds: ['n1', 'n2', 'n7'],
  });
  ok('重传返回原结论 joint 且 duplicate=true', r.status === 202 && r.data.status === 'joint' && r.data.duplicate === true, r);

  // 恢复旧名单多数（n5 回归，旧名单 3/4）：配置条目与紧随的联合指令按双名单多数一并提交，完成退役。
  await req('POST', '/api/nodes/n5/reachability', { reachable: true });
  s = (await req('GET', '/api/state')).data;
  ok('双名单多数凑齐后最终切换：名单 n1,n2,n7，n5/n6 退役',
    s.config.phase === 'stable' && s.migration === null &&
    JSON.stringify(s.config.voters) === JSON.stringify(['n1', 'n2', 'n7']) &&
    !s.nodes.some((n) => n.id === 'n5' || n.id === 'n6'), s.config);
  ok('联合期间的普通指令按联合多数一并提交', s.committedSequence.some((e) => e.requestId === 'cmd-joint-http'), s.lastCommit);
  ok('最近提交记录标注 joint 双名单确认', s.lastCommit && s.lastCommit.quorum === 'joint', s.lastCommit);

  // 12. 失败迁移：新名单多数不可达 -> 中止 -> 名单/任期/日志不变 -> 兼容提交恢复
  console.log('[13] 失败迁移中止后的兼容提交');
  await req('POST', '/api/nodes/n2/reachability', { reachable: false });
  await req('POST', '/api/nodes/n7/reachability', { reachable: false });
  // 旧名单 [n1,n2,n7] 仅 n1 可达（多数 2 缺失）；新名单 [n1,n2,n7,n8] 仅 n1,n8（多数 3 缺失）。
  r = await req('POST', '/api/migrations', {
    controllerId: 'C', term: 3, migrationId: 'mig-http-fail', targetVoterIds: ['n1', 'n2', 'n7', 'n8'],
  });
  ok('双名单多数均缺失 -> 202/joint', r.status === 202 && r.data.status === 'joint', r);
  const stuckIndex = (await req('GET', '/api/state')).data.committedIndex;
  r = await req('POST', '/api/migrations/abort', { controllerId: 'C', term: 3 });
  ok('中止僵持迁移 200/aborted', r.status === 200 && r.data.status === 'aborted', r);
  s = (await req('GET', '/api/state')).data;
  ok('中止后现役名单仍 n1,n2,n7、任期 3、阶段稳定',
    JSON.stringify(s.config.voters) === JSON.stringify(['n1', 'n2', 'n7']) &&
    s.config.phase === 'stable' && s.activeTerm === 3 && s.migration === null, s.config);
  ok('中止后 n8 移除、联合尾部截断（committedIndex 不变）',
    !s.nodes.some((n) => n.id === 'n8') && s.committedIndex === stuckIndex, { committedIndex: s.committedIndex, stuckIndex });

  // 失败迁移之后的兼容提交：恢复旧名单可达即按单一名单多数规则提交。
  await req('POST', '/api/nodes/n2/reachability', { reachable: true });
  await req('POST', '/api/nodes/n7/reachability', { reachable: true });
  r = await req('POST', '/api/commands', {
    controllerId: 'C', term: 3, requestId: 'cmd-post-fail', payload: 'burn:resume:2s',
  });
  ok('失败迁移后兼容提交：旧名单多数确认 committed', r.status === 200 && r.data.status === 'committed', r);
  s = (await req('GET', '/api/state')).data;
  ok('兼容指令进入全部现役节点日志', s.nodes.every((n) => n.log.some((e) => e.requestId === 'cmd-post-fail')), logsOf(s));

  ok('收尾健康路径 200', (await req('GET', '/health')).status === 200);

  console.log(`\n[smoke] 通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke] 执行异常:', e);
  process.exit(1);
});
