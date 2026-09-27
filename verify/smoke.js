'use strict';

/**
 * HTTP 冒烟验收：对任期申请、指令提交、健康路径执行端到端检查。
 * 覆盖：多数确认后崩溃重启、旧主控迟到栅栏、重传冲突、多数不可达、追赶收敛。
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

  // 10. 名单迁移：联合配置 + 崩溃恢复 + 双名单确认 + 失败迁移后兼容提交
  console.log('[11] 名单迁移（联合共识）');
  // 11.1 提交带稳定迁移标识与目标名单 [n1,n2] 的迁移，crash=true：联合配置落盘后、响应前崩溃。
  let crashedMig = false;
  try {
    await fetch(`${APP}/api/migrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controllerId: 'C', term: 3, migrationId: 'mg-retire-n3', voters: ['n1', 'n2'], crash: true }),
    });
  } catch (_) {
    crashedMig = true;
  }
  ok('迁移提交在联合配置落盘后崩溃（无响应）', crashedMig);
  ok('迁移崩溃后健康路径恢复', await waitHealth(30000));
  s = (await req('GET', '/api/state')).data;
  ok('重启恢复唯一联合阶段 joint', !!s.migration && s.migration.phase === 'joint', s.migration);
  ok('联合阶段显示旧名单 n1/n2/n3', s.migration && s.migration.oldVoters.join() === 'n1,n2,n3', s.migration);
  ok('联合阶段显示新名单 n1/n2', s.migration && s.migration.newVoters.join() === 'n1,n2', s.migration);
  ok('旧名单确认节点为 n1/n2/n3', s.migration && s.migration.oldConfirmed.join() === 'n1,n2,n3', s.migration);
  ok('新名单确认节点为 n1/n2', s.migration && s.migration.newConfirmed.join() === 'n1,n2', s.migration);
  ok('联合阶段现役名单仍是旧名单', s.config.join() === 'n1,n2,n3', s.config);

  // 11.2 重传迁移请求只返回原结论，不重复追加配置条目。
  r = await req('POST', '/api/migrations', { controllerId: 'C', term: 3, migrationId: 'mg-retire-n3', voters: ['n2', 'n1'] });
  ok('迁移重传幂等返回 joint/duplicate', r.status === 200 && r.data.phase === 'joint' && r.data.duplicate === true, r);

  // 11.3 联合配置期间普通指令必须双名单多数确认。
  r = await req('POST', '/api/commands', { controllerId: 'C', term: 3, requestId: 'cmd-j1', payload: 'burn:joint:1s' });
  ok('联合期间指令双名单多数 committed', r.status === 200 && r.data.status === 'committed', r);

  // n2 不可达：旧名单 n1/n3 仍多数，但新名单 [n1,n2] 只剩 n1 -> 不能按单一名单确认。
  await req('POST', '/api/nodes/n2/reachability', { reachable: false });
  const ciBeforeBlocked = (await req('GET', '/api/state')).data.committedIndex;
  r = await req('POST', '/api/commands', { controllerId: 'C', term: 3, requestId: 'cmd-j2', payload: 'burn:joint:blocked' });
  ok('新名单多数缺失时指令仅 accepted（联合多数，不沿用单一名单）', r.status === 202 && r.data.status === 'accepted', r);
  ok('未确认时 committedIndex 不前进', (await req('GET', '/api/state')).data.committedIndex === ciBeforeBlocked);
  r = await req('POST', '/api/migrations/mg-retire-n3/finalize', { controllerId: 'C', term: 3 });
  ok('双名单未齐时最终切换被拒 503/NO_MAJORITY', r.status === 503 && r.data.error.code === 'NO_MAJORITY', r);
  s = (await req('GET', '/api/state')).data;
  ok('被拒后现役名单仍是旧名单', s.config.join() === 'n1,n2,n3', s.config);

  // n2 恢复 -> 追赶补齐双名单确认，随后可完成最终切换。
  await req('POST', '/api/nodes/n2/reachability', { reachable: true });
  r = await req('POST', '/api/commands', { controllerId: 'C', term: 3, requestId: 'cmd-j3', payload: 'burn:joint:3s' });
  ok('恢复后联合指令 committed', r.status === 200 && r.data.status === 'committed', r);
  r = await req('POST', '/api/migrations/mg-retire-n3/finalize', { controllerId: 'C', term: 3 });
  ok('双名单多数后完成最终切换', r.status === 200 && r.data.status === 'final' && r.data.phase === 'final', r);
  s = (await req('GET', '/api/state')).data;
  ok('现役名单切换为 n1/n2', s.config.join() === 'n1,n2', s.config);
  ok('n3 标记为已退役', s.retiredNodes.includes('n3') && s.nodes.find((n) => n.id === 'n3').retired === true, s.retiredNodes);
  const n3Frozen = s.nodes.find((n) => n.id === 'n3').log.length;

  // 切换后普通指令按新名单确认，n3 日志冻结。
  r = await req('POST', '/api/commands', { controllerId: 'C', term: 3, requestId: 'cmd-post-final', payload: 'burn:newroster:1s' });
  ok('切换后指令按新名单 n1/n2 确认 committed', r.status === 200 && r.data.status === 'committed' &&
    r.data.confirmedBy.join() === 'n1,n2', r);
  s = (await req('GET', '/api/state')).data;
  ok('退役节点 n3 日志冻结', s.nodes.find((n) => n.id === 'n3').log.length === n3Frozen,
    s.nodes.find((n) => n.id === 'n3').log.map((e) => e.requestId));
  // finalize 重传只返回原结论。
  r = await req('POST', '/api/migrations/mg-retire-n3/finalize', { controllerId: 'C', term: 3 });
  ok('finalize 重传幂等返回原结论', r.status === 200 && r.data.duplicate === true && r.data.phase === 'final', r);

  // 11.4 失败迁移不得改变名单/任期/日志：新名单多数不可达时 begin 被拒。
  const beforeFail = (await req('GET', '/api/state')).data;
  await req('POST', '/api/nodes/n3/reachability', { reachable: false });
  r = await req('POST', '/api/migrations', { controllerId: 'C', term: 3, migrationId: 'mg-fail', voters: ['n1', 'n3'] });
  ok('任一名单多数不可达：迁移被拒 503/NO_MAJORITY', r.status === 503 && r.data.error.code === 'NO_MAJORITY', r);
  s = (await req('GET', '/api/state')).data;
  ok('失败迁移后现役名单不变', s.config.join() === beforeFail.config.join(), s.config);
  ok('失败迁移后任期不变', s.activeTerm === beforeFail.activeTerm, s.activeTerm);
  ok('失败迁移后节点日志不变', JSON.stringify(logsOf(s)) === JSON.stringify(logsOf(beforeFail)), logsOf(s));
  await req('POST', '/api/nodes/n3/reachability', { reachable: true });

  // 11.5 中止迁移（失败迁移）后的兼容提交：恢复单一名单确认规则。
  r = await req('POST', '/api/migrations', { controllerId: 'C', term: 3, migrationId: 'mg-abort', voters: ['n1'] });
  ok('可发起第二次迁移进入联合配置', r.status === 200 && r.data.phase === 'joint', r);
  r = await req('POST', '/api/migrations/mg-abort/abort', { controllerId: 'C', term: 3 });
  ok('中止迁移回到旧名单', r.status === 200 && r.data.status === 'aborted' && r.data.config.join() === 'n1,n2', r);
  s = (await req('GET', '/api/state')).data;
  ok('中止后无进行中迁移', s.migration === null, s.migration);
  r = await req('POST', '/api/commands', { controllerId: 'C', term: 3, requestId: 'cmd-after-fail', payload: 'burn:compat:1s' });
  ok('失败迁移后兼容提交：单一名单多数 committed', r.status === 200 && r.data.status === 'committed' &&
    r.data.confirmedBy.join() === 'n1,n2', r);

  // 11.6 最终切换阶段崩溃恢复 + 退役节点重新纳入：把 n3 加回名单，finalize 时崩溃。
  r = await req('POST', '/api/migrations', { controllerId: 'C', term: 3, migrationId: 'mg-restore-n3', voters: ['n1', 'n2', 'n3'] });
  ok('重新纳入退役节点的迁移进入联合配置', r.status === 200 && r.data.phase === 'joint' &&
    r.data.newVoters.join() === 'n1,n2,n3', r);
  let crashedFinal = false;
  try {
    await fetch(`${APP}/api/migrations/mg-restore-n3/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controllerId: 'C', term: 3, crash: true }),
    });
  } catch (_) {
    crashedFinal = true;
  }
  ok('最终切换落盘后崩溃（无响应）', crashedFinal);
  ok('最终切换崩溃后健康路径恢复', await waitHealth(30000));
  s = (await req('GET', '/api/state')).data;
  ok('重启后现役名单已恢复为 n1/n2/n3', s.config.join() === 'n1,n2,n3', s.config);
  ok('重启后退役名单为空', Array.isArray(s.retiredNodes) && s.retiredNodes.length === 0, s.retiredNodes);
  ok('重启后迁移阶段为 final', s.migration && s.migration.phase === 'final', s.migration);
  r = await req('POST', '/api/migrations/mg-restore-n3/finalize', { controllerId: 'C', term: 3 });
  ok('finalize 崩溃后重传只返回原结论', r.status === 200 && r.data.duplicate === true && r.data.phase === 'final', r);
  r = await req('POST', '/api/commands', { controllerId: 'C', term: 3, requestId: 'cmd-restored', payload: 'burn:restore:1s' });
  ok('恢复三节点名单后按三节点多数提交', r.status === 200 && r.data.status === 'committed' &&
    r.data.confirmedBy.join() === 'n1,n2,n3', r);
  s = (await req('GET', '/api/state')).data;
  ok('n3 重新收敛并收到新指令', s.nodes.find((n) => n.id === 'n3').commandLog.includes('cmd-restored'),
    s.nodes.find((n) => n.id === 'n3').commandLog);

  console.log(`\n[smoke] 通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke] 执行异常:', e);
  process.exit(1);
});
