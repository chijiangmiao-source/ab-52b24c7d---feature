'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cluster, ERR } = require('../src/cluster');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'formation-'));
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

test('多数确认后崩溃：重启恢复仍显示已提交，各节点日志收敛', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c1 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c1.create(3);
  c1.requestTerm('A');
  const r1 = c1.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'burn:prograde:12s' });
  assert.equal(r1.status, 'committed');
  assert.deepEqual(r1.confirmedBy, ['n1', 'n2', 'n3']);
  const r2 = c1.submit({ controllerId: 'A', term: 1, requestId: 'r2', payload: 'burn:radial:3s' });
  assert.equal(r2.status, 'committed');

  // 模拟多数确认落盘后、响应前进程退出：以同一数据目录重建实例（= 重启）。
  const c2 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  const s = c2.getState();
  assert.equal(s.activeTerm, 1);
  assert.equal(s.leader, 'A');
  assert.equal(s.committedIndex, 2);
  assert.deepEqual(s.committedSequence.map((e) => e.requestId), ['r1', 'r2']);
  for (const n of s.nodes) {
    assert.deepEqual(n.log.map((e) => e.requestId), ['r1', 'r2'], `${n.id} 日志应与已提交序列一致`);
  }
});

test('崩溃时未落盘的分叉尾部在重启后被截断（已提交前缀不受影响）', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c1 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c1.create(3);
  c1.requestTerm('A');
  c1.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'x' });

  // 模拟崩溃窗口：某节点文件被写入了 canonical 之外的未提交条目。
  fs.writeFileSync(path.join(dir, 'node-n3.json'), JSON.stringify([
    { index: 1, term: 1, requestId: 'r1', payload: 'x', ts: 1 },
    { index: 2, term: 1, requestId: 'ghost', payload: 'y', ts: 1 },
  ]));

  const c2 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  const s = c2.getState();
  assert.equal(s.committedIndex, 1);
  assert.deepEqual(s.nodes.find((n) => n.id === 'n3').log.map((e) => e.requestId), ['r1']);
});

test('旧主控迟到：旧任期提交被栅栏拒绝，任一节点日志均不得新增旧指令', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c.create(3);
  c.requestTerm('A');
  c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });

  // A 租约失效，B 取得更高任期并提交新指令。
  c.revokeLease();
  const t2 = c.requestTerm('B');
  assert.equal(t2.term, 2);
  c.submit({ controllerId: 'B', term: 2, requestId: 'r2', payload: 'beta' });

  // A 以旧任期重试 -> 栅栏拒绝。
  expectErr(ERR.FENCED_TERM, () =>
    c.submit({ controllerId: 'A', term: 1, requestId: 'r-old', payload: 'stale-cmd' }));

  const s = c.getState();
  assert.equal(s.activeTerm, 2);
  assert.equal(s.committedIndex, 2);
  for (const n of s.nodes) {
    assert.equal(n.log.length, 2, `${n.id} 日志不得新增旧指令`);
    assert.ok(!n.log.some((e) => e.requestId === 'r-old'));
  }
  // 从未被授予的更高任期同样被拒绝。
  expectErr(ERR.UNKNOWN_TERM, () =>
    c.submit({ controllerId: 'B', term: 99, requestId: 'r-x', payload: 'z' }));
  // 非主控以现役任期提交 -> 拒绝。
  expectErr(ERR.NOT_LEADER, () =>
    c.submit({ controllerId: 'A', term: 2, requestId: 'r-y', payload: 'z' }));
});

test('重传冲突：同标识同内容返回原结论且不重复追加，改换内容返回冲突', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c.create(3);
  c.requestTerm('A');
  const first = c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'burn:10s' });
  assert.equal(first.status, 'committed');
  assert.equal(first.duplicate, false);

  const replay = c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'burn:10s' });
  assert.equal(replay.status, 'committed', '重传应返回原结论');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.index, first.index);

  const s = c.getState();
  assert.equal(s.committedSequence.length, 1, '不得重复追加');
  for (const n of s.nodes) assert.equal(n.log.length, 1, `${n.id} 日志不得重复追加`);

  expectErr(ERR.CONFLICT, () =>
    c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'burn:99s' }));
});

test('多数节点不可达：申请任期失败，现役任期与各节点日志保持不变', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c.create(3);
  c.requestTerm('A');
  c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });

  c.setReachable('n2', false);
  c.setReachable('n3', false);
  const before = c.getState();
  expectErr(ERR.NO_MAJORITY, () => c.requestTerm('B'));
  const after = c.getState();
  assert.equal(after.activeTerm, before.activeTerm, '现役任期保持不变');
  assert.equal(after.leader, 'A');
  assert.deepEqual(
    after.nodes.map((n) => n.log.map((e) => e.requestId)),
    before.nodes.map((n) => n.log.map((e) => e.requestId)),
    '各节点日志保持不变'
  );
});

test('旧任期恢复后只能追赶不能提交：节点收敛，过期租约提交被拒', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c = new Cluster(dir, { leaseMs: 5000, now: clock.now });
  c.create(3);
  c.requestTerm('A');
  c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });

  // 多数不可达期间租约自然到期；期间少数派上接受的条目未提交。
  c.setReachable('n2', false);
  c.setReachable('n3', false);
  clock.advance(6000);
  expectErr(ERR.NO_MAJORITY, () => c.requestTerm('B'));

  // 恢复可达 -> 触发追赶，各节点日志收敛一致。
  c.setReachable('n2', true);
  c.setReachable('n3', true);
  const converged = c.getState();
  for (const n of converged.nodes) {
    assert.deepEqual(n.log.map((e) => e.requestId), ['r1'], `${n.id} 应追赶到一致序列`);
  }

  // 旧任期租约已失效：只能追赶，不能提交。
  expectErr(ERR.LEASE_EXPIRED, () =>
    c.submit({ controllerId: 'A', term: 1, requestId: 'r2', payload: 'beta' }));
  for (const n of c.getState().nodes) assert.equal(n.log.length, 1);

  // 重新申请任期后可正常提交，并连带提交此前未提交的前缀。
  const t = c.requestTerm('B');
  assert.equal(t.term, 2);
  const r = c.submit({ controllerId: 'B', term: 2, requestId: 'r2', payload: 'beta' });
  assert.equal(r.status, 'committed');
  assert.equal(c.getState().committedIndex, 2);
});

test('租约持有期间他人申请任期被拒；本人可续期；到期后他人方可接任', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c = new Cluster(dir, { leaseMs: 5000, now: clock.now });
  c.create(5);
  c.requestTerm('A');
  expectErr(ERR.LEASE_HELD, () => c.requestTerm('B'));
  const renew = c.requestTerm('A');
  assert.equal(renew.renewed, true);
  assert.equal(renew.term, 1);
  clock.advance(6000);
  const t = c.requestTerm('B');
  assert.equal(t.term, 2);
  assert.equal(t.quorum.length, 5);
});

test('少数派确认的指令处于已接受未提交，恢复后随后续提交一并收敛', () => {
  const dir = tmpDir();
  const clock = fakeClock();
  const c = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c.create(3);
  c.requestTerm('A');
  c.setReachable('n2', false);
  c.setReachable('n3', false);
  const r1 = c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });
  assert.equal(r1.status, 'accepted');
  assert.deepEqual(r1.confirmedBy, ['n1']);
  assert.equal(c.getState().committedIndex, 0);

  c.setReachable('n2', true);
  c.setReachable('n3', true);
  for (const n of c.getState().nodes) assert.equal(n.log.length, 1, '恢复后应追赶补齐');

  const r2 = c.submit({ controllerId: 'A', term: 1, requestId: 'r2', payload: 'beta' });
  assert.equal(r2.status, 'committed');
  assert.equal(c.getState().committedIndex, 2, '提交新条目连带提交此前前缀');
});

test('非法规模与参数校验', () => {
  const dir = tmpDir();
  const c = new Cluster(dir, { now: fakeClock().now });
  expectErr(ERR.NO_CLUSTER, () => c.requestTerm('A'));
  expectErr(ERR.BAD_REQUEST, () => c.create(2));
  expectErr(ERR.BAD_REQUEST, () => c.create(6));
  c.create(4);
  assert.equal(c.getState().majority, 3);
  expectErr(ERR.BAD_REQUEST, () => c.submit({ controllerId: 'A', term: 0, requestId: '', payload: 'x' }));
});

// ---------- 名单迁移（联合共识 C_old,new） ----------

function boot(clock, size = 3, leader = 'A') {
  const dir = tmpDir();
  const c = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  c.create(size);
  c.requestTerm(leader);
  return { dir, c };
}

test('联合迁移：全体可达时配置条目获双名单多数，当场完成名单切换', () => {
  const clock = fakeClock();
  const { c } = boot(clock, 3);
  c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });

  const r = c.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-add-n4', targetVoterIds: ['n1', 'n2', 'n3', 'n4'],
  });
  assert.equal(r.status, 'committed');
  assert.equal(r.phase, 'stable');
  assert.deepEqual(r.newRoster, ['n1', 'n2', 'n3', 'n4']);
  assert.deepEqual(r.joinedVoters, ['n4']);
  assert.deepEqual(r.retiredVoters, []);
  assert.deepEqual(r.confirmedByOld.sort(), ['n1', 'n2', 'n3']);
  assert.deepEqual(r.confirmedByNew.sort(), ['n1', 'n2', 'n3', 'n4']);

  const s = c.getState();
  assert.equal(s.config.phase, 'stable');
  assert.deepEqual(s.config.voters, ['n1', 'n2', 'n3', 'n4']);
  assert.equal(s.migration, null);
  assert.equal(s.committedIndex, 2, '配置条目 #2 已提交');
  assert.equal(s.committedSequence[1].kind, 'config');
  for (const n of s.nodes) {
    assert.deepEqual(n.log.map((e) => e.requestId), ['r1', 'mig-add-n4'], `${n.id} 应含配置条目`);
  }

  // 新名单 4 节点多数为 3：只剩两节点可达时不得提交。
  c.setReachable('n3', false);
  c.setReachable('n4', false);
  const blocked = c.submit({ controllerId: 'A', term: 1, requestId: 'r2', payload: 'beta' });
  assert.equal(blocked.status, 'accepted');
  assert.equal(c.getState().committedIndex, 2);
  // 恢复第三个节点后按新名单多数提交，旧的三节点多数规则不再适用。
  c.setReachable('n3', true);
  const ok = c.submit({ controllerId: 'A', term: 1, requestId: 'r3', payload: 'gamma' });
  assert.equal(ok.status, 'committed');
  assert.equal(c.getState().committedIndex, 4);
});

test('联合阶段：旧名单多数不可达则配置与普通指令都不能提交，现役名单/任期不变', () => {
  const clock = fakeClock();
  const { c } = boot(clock, 3);
  c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });

  // 旧名单 [n1,n2,n3] 多数不可达；目标 [n1,n4,n5] 新节点可达。
  c.setReachable('n2', false);
  c.setReachable('n3', false);
  const before = c.getState();

  const r = c.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-1', targetVoterIds: ['n1', 'n4', 'n5'],
  });
  assert.equal(r.status, 'joint');
  assert.equal(r.phase, 'joint');
  assert.equal(r.oldConfirmed, false, '旧名单仅 n1 可达，不足多数');
  assert.equal(r.newConfirmed, true, '新名单 n1/n4/n5 均可达');
  assert.equal(r.canFinalize, false);

  const mid = c.getState();
  assert.equal(mid.config.phase, 'joint');
  assert.deepEqual(mid.config.voters, ['n1', 'n2', 'n3'], '现役名单在联合期间不得改变');
  assert.equal(mid.activeTerm, before.activeTerm, '现役任期不得改变');
  assert.equal(mid.leader, 'A');
  assert.equal(mid.committedIndex, 1, '配置条目不得提交');
  // n3（待退役）日志仍只有 r1，未被追加任何东西。
  assert.deepEqual(nodeLog2(mid, 'n3').map((e) => e.requestId), ['r1']);

  // 普通姿态指令：即便新名单三节点全确认（按单一名单规则已成多数），旧名单多数缺失也不得提交。
  const cmd = c.submit({ controllerId: 'A', term: 1, requestId: 'cmd-joint', payload: 'attitude:hold' });
  assert.equal(cmd.status, 'accepted');
  assert.equal(cmd.quorum, 'joint');
  assert.deepEqual(cmd.confirmedByOld, ['n1']);
  assert.deepEqual(cmd.confirmedByNew.sort(), ['n1', 'n4', 'n5']);
  assert.equal(c.getState().committedIndex, 1, '联合期间普通指令必须双名单多数，不能沿用单一名单规则');

  // 联合期间申请任期同样要求双名单多数可达。
  c.revokeLease();
  expectErr(ERR.NO_MAJORITY, () => c.requestTerm('B'));
});

function nodeLog2(state, id) {
  return state.nodes.find((n) => n.id === id).log;
}

test('联合阶段：新名单多数不可达同样卡住，恢复后配置与联合指令一并提交并退役旧节点', () => {
  const clock = fakeClock();
  const { c } = boot(clock, 3);
  c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });
  c.setReachable('n2', false);
  c.setReachable('n3', false);
  c.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-1', targetVoterIds: ['n1', 'n4', 'n5'],
  });
  const jointCmd = c.submit({ controllerId: 'A', term: 1, requestId: 'cmd-joint', payload: 'attitude:hold' });
  assert.equal(jointCmd.status, 'accepted');

  // 先让新名单掉回少数，再恢复旧名单多数：迁移仍不得完成。
  c.setReachable('n4', false);
  c.setReachable('n5', false); // 新名单仅剩 n1
  c.setReachable('n2', true); // 旧名单 n1,n2 多数
  let s = c.getState();
  assert.equal(s.migration.phase, 'joint');
  assert.equal(s.migration.oldConfirmed, true);
  assert.equal(s.migration.newConfirmed, false);
  assert.equal(s.committedIndex, 1);

  // 新名单恢复多数 -> 配置条目先提交，紧随其后的联合指令按联合多数一并提交。
  c.setReachable('n4', true);
  c.setReachable('n5', true);
  s = c.getState();
  assert.equal(s.config.phase, 'stable');
  assert.deepEqual(s.config.voters, ['n1', 'n4', 'n5']);
  assert.equal(s.migration, null);
  assert.equal(s.committedIndex, 3, '配置 #2 与联合指令 #3 均已提交');
  assert.deepEqual(s.nodes.map((n) => n.id).sort(), ['n1', 'n4', 'n5'], 'n2/n3 已退役退出');
  assert.ok(!fs.existsSync(path.join(c.dir, 'node-n3.json')), '退役节点日志文件应清理');
  for (const n of s.nodes) {
    assert.deepEqual(n.log.map((e) => e.requestId), ['r1', 'mig-1', 'cmd-joint']);
  }

  // 迁移完成后的指令按新名单单一名单规则提交；重传联合期间的指令只返回原结论。
  const replay = c.submit({ controllerId: 'A', term: 1, requestId: 'cmd-joint', payload: 'attitude:hold' });
  assert.equal(replay.status, 'committed');
  assert.equal(replay.duplicate, true);
  const after = c.submit({ controllerId: 'A', term: 1, requestId: 'cmd-after', payload: 'burn:1s' });
  assert.equal(after.status, 'committed');
  c.setReachable('n5', false);
  const two = c.submit({ controllerId: 'A', term: 1, requestId: 'cmd-two', payload: 'burn:2s' });
  assert.equal(two.status, 'committed', '新名单 3 节点多数为 2，n1/n4 即可提交');
});

test('崩溃恢复：重启从持久日志恢复唯一联合阶段，重传只返回原结论', () => {
  const clock = fakeClock();
  const { dir, c } = boot(clock, 3);
  c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });
  c.setReachable('n2', false);
  c.setReachable('n3', false);
  c.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-1', targetVoterIds: ['n1', 'n4', 'n5'],
  });
  c.submit({ controllerId: 'A', term: 1, requestId: 'cmd-joint', payload: 'attitude:hold' });

  // 进程退出后以同一数据目录重启。
  const c2 = new Cluster(dir, { leaseMs: 60000, now: clock.now });
  let s = c2.getState();
  assert.ok(s.migration, '必须恢复唯一的在途迁移');
  assert.equal(s.migration.migrationId, 'mig-1');
  assert.equal(s.migration.phase, 'joint');
  assert.equal(s.committedIndex, 1, '未获双名单多数的配置条目重启后仍不得提交');
  assert.equal(s.activeTerm, 1);

  // 重传迁移请求：同标识同目标 -> 原结论（joint, duplicate）；改换目标 -> 冲突；再开一个 -> 拒绝。
  const replay = c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-1', targetVoterIds: ['n1', 'n4', 'n5'],
  });
  assert.equal(replay.status, 'joint');
  assert.equal(replay.duplicate, true);
  expectErr(ERR.CONFLICT, () => c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-1', targetVoterIds: ['n1', 'n4', 'n6'],
  }));
  expectErr(ERR.MIGRATION_ACTIVE, () => c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-other', targetVoterIds: ['n1', 'n4', 'n5'],
  }));

  // 恢复旧名单多数（n1 始终可达，n2 回归即 2/3 多数）：重启后的实例同样能推进并完成切换。
  c2.setReachable('n2', true);
  s = c2.getState();
  assert.equal(s.config.phase, 'stable');
  assert.deepEqual(s.config.voters, ['n1', 'n4', 'n5']);

  // 已完成迁移的重传返回归档的原结论。
  const archived = c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-1', targetVoterIds: ['n1', 'n4', 'n5'],
  });
  assert.equal(archived.status, 'committed');
  assert.equal(archived.duplicate, true);
});

test('失败迁移中止：截断联合尾部并移除新节点，随后兼容提交恢复正常', () => {
  const clock = fakeClock();
  const { c } = boot(clock, 3);
  c.submit({ controllerId: 'A', term: 1, requestId: 'r1', payload: 'alpha' });
  c.setReachable('n2', false);
  c.setReachable('n3', false);
  c.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-fail', targetVoterIds: ['n1', 'n4', 'n5'],
  });
  c.submit({ controllerId: 'A', term: 1, requestId: 'cmd-joint', payload: 'attitude:hold' });

  const aborted = c.abortMigration({ controllerId: 'A', term: 1 });
  assert.equal(aborted.status, 'aborted');
  assert.deepEqual(aborted.droppedVoters.sort(), ['n4', 'n5']);
  assert.equal(aborted.activeTerm, 1, '任期不变');
  const s = c.getState();
  assert.equal(s.migration, null);
  assert.equal(s.config.phase, 'stable');
  assert.deepEqual(s.config.voters, ['n1', 'n2', 'n3'], '现役名单保持旧名单');
  assert.deepEqual(s.nodes.map((n) => n.id), ['n1', 'n2', 'n3']);
  assert.deepEqual(s.committedSequence.map((e) => e.requestId), ['r1']);
  for (const n of s.nodes) {
    assert.deepEqual(n.log.map((e) => e.requestId), ['r1'], `${n.id} 联合尾部须截断`);
  }
  assert.ok(!fs.existsSync(path.join(c.dir, 'node-n4.json')));
  expectErr(ERR.MIGRATION_NOT_ACTIVE, () => c.abortMigration({ controllerId: 'A', term: 1 }));

  // 失败迁移之后的兼容提交：恢复旧名单多数即按单一名单规则提交。
  c.setReachable('n2', true);
  c.setReachable('n3', true);
  const r = c.submit({ controllerId: 'A', term: 1, requestId: 'r2', payload: 'beta' });
  assert.equal(r.status, 'committed');
  assert.equal(c.getState().committedIndex, 2);
});

test('双名单多数一旦确认即原子完成切换：已完成迁移不可中止；迁移参数校验', () => {
  const clock = fakeClock();
  const { c } = boot(clock, 3);
  c.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'mig-done', targetVoterIds: ['n1', 'n2', 'n3', 'n4'],
  });
  // 配置条目获得双名单多数的瞬间最终切换已原子完成，不存在「已提交却仍在途」的迁移。
  expectErr(ERR.MIGRATION_NOT_ACTIVE, () => c.abortMigration({ controllerId: 'A', term: 1 }));

  const { c: c2 } = boot(clock, 3);
  expectErr(ERR.BAD_REQUEST, () => c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'm', targetVoterIds: ['n1', 'n2'],
  }));
  expectErr(ERR.BAD_REQUEST, () => c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'm', targetVoterIds: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
  }));
  expectErr(ERR.BAD_REQUEST, () => c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'm', targetVoterIds: ['n1', 'n1', 'n2'],
  }));
  expectErr(ERR.BAD_REQUEST, () => c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'm', targetVoterIds: ['n1', 'n2', 'n3'],
  }), '目标与现役名单完全一致');
  expectErr(ERR.BAD_REQUEST, () => c2.beginMigration({
    controllerId: 'A', term: 1, migrationId: 'm', targetVoterIds: ['n4', 'n5', 'n6'],
  }), '新旧名单完全不相交');
  // 栅栏：旧任期 / 非主控提交迁移一律拒绝。
  expectErr(ERR.FENCED_TERM, () => c2.beginMigration({
    controllerId: 'A', term: 0, migrationId: 'm', targetVoterIds: ['n1', 'n2', 'n4'],
  }));
  expectErr(ERR.NOT_LEADER, () => c2.beginMigration({
    controllerId: 'B', term: 1, migrationId: 'm', targetVoterIds: ['n1', 'n2', 'n4'],
  }));
});

