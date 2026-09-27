'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cluster, ERR } = require('../src/cluster');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'formation-mig-'));
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function nodeLog(dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, `node-${id}.json`), 'utf8'));
}

function expectErr(code, fn) {
  assert.throws(fn, (e) => e.code === code);
}

function freshCluster(leaseMs = 60000) {
  const dir = tmpDir();
  const clock = fakeClock();
  const c = new Cluster(dir, { leaseMs, now: clock.now });
  c.create(3);
  c.requestTerm('A');
  return { dir, clock, c };
}

test('提交迁移进入联合配置：旧、新名单及各自确认节点可查，现役名单暂不切换', () => {
  const { c } = freshCluster();
  const m = c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n2'] });
  assert.equal(m.status, 'joint');
  assert.equal(m.duplicate, false);
  assert.deepEqual(m.oldVoters, ['n1', 'n2', 'n3']);
  assert.deepEqual(m.newVoters, ['n1', 'n2']);
  assert.deepEqual(m.oldConfirmed, ['n1', 'n2', 'n3']);
  assert.deepEqual(m.newConfirmed, ['n1', 'n2']);
  assert.equal(m.oldMajority, 2);
  assert.equal(m.newMajority, 2);

  const s = c.getState();
  // 最终切换前现役名单仍是旧名单。
  assert.deepEqual(s.config, ['n1', 'n2', 'n3']);
  assert.equal(s.migration.phase, 'joint');
});

test('联合配置条目落盘到旧∪新节点，且节点日志中带稳定迁移标识', () => {
  const { dir, c } = freshCluster();
  c.submit({ controllerId: 'A', term: 1, requestId: 'r0', payload: 'p0' });
  c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n2'] });
  for (const id of ['n1', 'n2', 'n3']) {
    const log = nodeLog(dir, id);
    const joint = log.find((e) => e.kind === 'config' && e.configOp === 'joint');
    assert.ok(joint, `${id} 应持有联合配置条目`);
    assert.equal(joint.migrationId, 'mg-1');
    assert.deepEqual(joint.oldVoters, ['n1', 'n2', 'n3']);
    assert.deepEqual(joint.newVoters, ['n1', 'n2']);
  }
});

test('任一名单多数不可达：迁移被拒且现役名单、任期、节点日志均不变', () => {
  const { dir, c } = freshCluster();
  c.submit({ controllerId: 'A', term: 1, requestId: 'r0', payload: 'p0' });
  // 新名单 [n1,n3] 需 2 个多数；n3 不可达时新名单仅 n1 可达 -> 拒绝。
  c.setReachable('n3', false);
  const before = {
    term: c.getState().activeTerm,
    logs: ['n1', 'n2', 'n3'].map((id) => nodeLog(dir, id).length),
  };
  expectErr(ERR.NO_MAJORITY, () =>
    c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-bad', voters: ['n1', 'n3'] }));
  const s = c.getState();
  assert.equal(s.activeTerm, before.term, '任期不变');
  assert.equal(s.leader, 'A');
  assert.deepEqual(s.config, ['n1', 'n2', 'n3'], '现役名单不变');
  assert.equal(s.migration, null, '不留下迁移阶段');
  assert.deepEqual(
    ['n1', 'n2', 'n3'].map((id) => nodeLog(dir, id).length),
    before.logs,
    '节点日志不增长'
  );
});

test('联合配置期间普通指令须双名单多数：新名单多数缺失时不提交，恢复后可提交', () => {
  const { c } = freshCluster();
  c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n2'] });

  // 三节点全可达：旧 3 需 2、新 2 需 2，同时满足 -> committed。
  const ok = c.submit({ controllerId: 'A', term: 1, requestId: 'j-cmd-1', payload: 'attitude:1' });
  assert.equal(ok.status, 'committed');
  assert.deepEqual(ok.confirmedBy, ['n1', 'n2', 'n3']);

  // n2 不可达：旧名单 n1,n3 仍够多数，但新名单 [n1,n2] 只剩 n1 -> 不得按单一名单提交。
  c.setReachable('n2', false);
  const blocked = c.submit({ controllerId: 'A', term: 1, requestId: 'j-cmd-2', payload: 'attitude:2' });
  assert.equal(blocked.status, 'accepted');
  assert.deepEqual(blocked.confirmedBy, ['n1', 'n3']);
  assert.equal(c.getState().committedIndex, ok.index, 'committedIndex 不得前进');

  // 双名单未齐时最终切换同样被拒，现役名单不变。
  expectErr(ERR.NO_MAJORITY, () =>
    c.finalizeMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1' }));
  assert.deepEqual(c.getState().config, ['n1', 'n2', 'n3']);

  // 恢复可达：追赶补齐，联合配置确认视图从持久日志重建。
  c.setReachable('n2', true);
  const m = c.getState().migration;
  assert.deepEqual(m.oldConfirmed, ['n1', 'n2', 'n3']);
  assert.deepEqual(m.newConfirmed, ['n1', 'n2']);
  const again = c.submit({ controllerId: 'A', term: 1, requestId: 'j-cmd-3', payload: 'attitude:3' });
  assert.equal(again.status, 'committed');
});

test('联合配置期间申请任期也须双名单多数可达', () => {
  const { c } = freshCluster();
  c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n2'] });
  c.revokeLease();
  c.setReachable('n2', false);
  expectErr(ERR.NO_MAJORITY, () => c.requestTerm('B'));
  c.setReachable('n2', true);
  const t = c.requestTerm('B');
  assert.equal(t.term, 2);
});

test('双名单多数确认后完成最终切换：旧成员退役且日志冻结，提交按新名单确认', () => {
  const { dir, c } = freshCluster();
  c.submit({ controllerId: 'A', term: 1, requestId: 'r0', payload: 'p0' });
  c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n2'] });
  const f = c.finalizeMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1' });
  assert.equal(f.status, 'final');
  assert.deepEqual(f.newVoters, ['n1', 'n2']);
  assert.deepEqual(f.retiredNodes, ['n3']);

  const s = c.getState();
  assert.deepEqual(s.config, ['n1', 'n2']);
  assert.deepEqual(s.retiredNodes, ['n3']);
  assert.equal(s.migration.phase, 'final');
  const n3 = s.nodes.find((n) => n.id === 'n3');
  assert.equal(n3.retired, true);
  assert.equal(n3.voter, false);

  // 切换后普通指令只需新名单多数；退役节点 n3 不再收到任何条目。
  const frozenLen = nodeLog(dir, 'n3').length;
  const r = c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'p1' });
  assert.equal(r.status, 'committed');
  assert.deepEqual(r.confirmedBy, ['n1', 'n2']);
  assert.equal(nodeLog(dir, 'n3').length, frozenLen, 'n3 日志必须冻结');

  // 切换退役节点可达性不触发追赶、不改变其日志。
  c.setReachable('n3', false);
  c.setReachable('n3', true);
  assert.equal(nodeLog(dir, 'n3').length, frozenLen);
});

test('迁移标识幂等：重传只返回原结论不重复追加；改换名单冲突；进行中不得开新迁移', () => {
  const { dir, c } = freshCluster();
  const first = c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n2'] });
  const replay = c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n2', 'n1'] });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.phase, 'joint');
  assert.equal(replay.configIndex, first.configIndex);
  // 只有一条联合配置条目。
  assert.equal(nodeLog(dir, 'n1').filter((e) => e.kind === 'config').length, 1);

  expectErr(ERR.CONFLICT, () =>
    c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n3'] }));
  expectErr(ERR.MIGRATION_ACTIVE, () =>
    c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-2', voters: ['n1'] }));

  // 完成最终切换后，同一稳定标识的重传仍只返回原结论（幂等），不能开启第二次迁移。
  c.finalizeMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1' });
  const after = c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n2'] });
  assert.equal(after.duplicate, true);
  assert.equal(after.phase, 'final');
  assert.equal(nodeLog(dir, 'n1').filter((e) => e.kind === 'config' && e.configOp === 'joint').length, 1);

  // 新迁移必须使用新的稳定标识（此处把刚退役的 n3 重新纳入投票名单）。
  const m2 = c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-2', voters: ['n1', 'n2', 'n3'] });
  assert.equal(m2.status, 'joint');
});

test('finalize 重传（含租约失效后）只返回原结论', () => {
  const { c } = freshCluster();
  c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1', voters: ['n1', 'n2'] });
  c.finalizeMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1' });
  c.revokeLease();
  const replay = c.finalizeMigration({ controllerId: 'A', term: 1, migrationId: 'mg-1' });
  assert.equal(replay.status, 'final');
  assert.equal(replay.duplicate, true);
});

test('崩溃恢复：联合阶段从持久日志重建唯一阶段与双名单确认，重传返回原结论', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c1 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c1.create(3);
  c1.requestTerm('A');
  c1.submit({ controllerId: 'A', term: 1, requestId: 'r0', payload: 'p0' });
  c1.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-crash', voters: ['n1', 'n2'] });

  // 多数确认落盘后、响应前崩溃 -> 同目录重建。
  const c2 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  const s = c2.getState();
  assert.equal(s.migration.phase, 'joint', '恢复出唯一联合阶段');
  assert.equal(s.migration.migrationId, 'mg-crash');
  assert.deepEqual(s.migration.oldConfirmed, ['n1', 'n2', 'n3']);
  assert.deepEqual(s.migration.newConfirmed, ['n1', 'n2']);
  assert.deepEqual(s.config, ['n1', 'n2', 'n3'], '未完成切换前名单不变');

  const replay = c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mg-crash', voters: ['n1', 'n2'],
  });
  assert.equal(replay.duplicate, true, '重传只返回原结论');
  assert.equal(replay.phase, 'joint');
  assert.equal(nodeLog(dir, 'n1').filter((e) => e.kind === 'config').length, 1, '不重复追加');

  c2.finalizeMigration({ controllerId: 'A', term: 1, migrationId: 'mg-crash' });
  assert.deepEqual(c2.getState().config, ['n1', 'n2']);
});

test('崩溃恢复：最终切换落盘后崩溃，重启保持新名单且 finalize 重传幂等', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c1 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c1.create(3);
  c1.requestTerm('A');
  c1.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-fin', voters: ['n1', 'n2'] });
  c1.finalizeMigration({ controllerId: 'A', term: 1, migrationId: 'mg-fin' });

  const c2 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  const s = c2.getState();
  assert.deepEqual(s.config, ['n1', 'n2']);
  assert.deepEqual(s.retiredNodes, ['n3']);
  assert.equal(s.migration.phase, 'final');
  const replay = c2.finalizeMigration({ controllerId: 'A', term: 1, migrationId: 'mg-fin' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, 'final');
});

test('中止迁移：旧名单多数确认回滚配置，随后按原名单正常提交', () => {
  const { dir, c } = freshCluster();
  c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-abort', voters: ['n1', 'n2'] });
  // 联合期间的指令。
  c.submit({ controllerId: 'A', term: 1, requestId: 'j1', payload: 'j1' });
  const a = c.abortMigration({ controllerId: 'A', term: 1, migrationId: 'mg-abort' });
  assert.equal(a.status, 'aborted');
  assert.deepEqual(a.config, ['n1', 'n2', 'n3']);
  assert.equal(c.getState().migration, null);
  assert.deepEqual(c.getState().config, ['n1', 'n2', 'n3']);

  // 回滚条目落入旧名单多数（此处全部）节点。
  for (const id of ['n1', 'n2', 'n3']) {
    assert.ok(nodeLog(dir, id).some((e) => e.kind === 'config' && e.configOp === 'rollback'));
  }

  // 失败迁移后兼容提交：恢复单一名单确认规则。
  const r = c.submit({ controllerId: 'A', term: 1, requestId: 'after-abort', payload: 'x' });
  assert.equal(r.status, 'committed');
  assert.deepEqual(r.confirmedBy, ['n1', 'n2', 'n3']);

  // 中止后可用新标识重新发起迁移。
  const m2 = c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-retry', voters: ['n1', 'n2'] });
  assert.equal(m2.status, 'joint');
});

test('中止迁移时旧名单多数不可达则拒绝，阶段与名单不变', () => {
  const { c } = freshCluster();
  c.beginMigration({ controllerId: 'A', term: 1, migrationId: 'mg-x', voters: ['n1', 'n2'] });
  c.setReachable('n2', false);
  c.setReachable('n3', false);
  expectErr(ERR.NO_MAJORITY, () =>
    c.abortMigration({ controllerId: 'A', term: 1, migrationId: 'mg-x' }));
  assert.equal(c.getState().migration.phase, 'joint');
  assert.deepEqual(c.getState().config, ['n1', 'n2', 'n3']);
});

test('旧持久态（无 config/migration 字段）向后兼容加载', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c1 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c1.create(3);
  c1.requestTerm('A');
  c1.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'p1' });
  // 删掉新字段，模拟旧版本 cluster.json。
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'cluster.json'), 'utf8'));
  delete raw.config;
  delete raw.migration;
  delete raw.retiredNodes;
  fs.writeFileSync(path.join(dir, 'cluster.json'), JSON.stringify(raw));

  const c2 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  const s = c2.getState();
  assert.deepEqual(s.config, ['n1', 'n2', 'n3']);
  assert.equal(s.migration, null);
  const r = c2.submit({ controllerId: 'A', term: 1, requestId: 'r2', payload: 'p2' });
  assert.equal(r.status, 'committed');
});
