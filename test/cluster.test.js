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
