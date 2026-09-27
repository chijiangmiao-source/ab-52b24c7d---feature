'use strict';

/**
 * 轨道编队共识核心（Raft 式语义，单进程模拟 N 个控制节点）。
 *
 * - 任期(term)：由持有租约(lease)的主控控制器(leader)唯一推进；申请任期需多数节点可达。
 * - 栅栏(fencing)：携带旧任期/未知任期/非主控的提交一律拒绝，任何节点日志不得增长。
 * - 幂等：指令带稳定请求标识(requestId)；同标识同内容重传返回原结论且不重复追加，
 *   同标识不同内容返回冲突。
 * - 持久化：canonical 日志与任期状态落盘 cluster.json；每个节点独立 node-<id>.json，
 *   多数节点确认（落盘）后才判定 committed；崩溃重启后按 canonical 收敛各节点日志。
 * - 名单迁移(membership change)：联合共识(C_old,new)。控制器取得有效任期后可提交带稳定
 *   迁移标识(migrationId)与目标投票节点集合的迁移；服务先将编队置入联合配置，配置条目
 *   必须同时获得旧名单与新名单各自的多数确认后才完成最终名单切换。联合期间普通指令也
 *   必须按双名单多数确认。任一名单多数不可达时现役名单/任期不变；操作员可中止迁移，
 *   截断未落盘的联合尾部，回到旧名单的单一名单确认规则。
 */

const fs = require('fs');
const path = require('path');

const ERR = {
  NO_CLUSTER: 'NO_CLUSTER',
  BAD_REQUEST: 'BAD_REQUEST',
  NO_MAJORITY: 'NO_MAJORITY',
  LEASE_HELD: 'LEASE_HELD',
  FENCED_TERM: 'FENCED_TERM',
  UNKNOWN_TERM: 'UNKNOWN_TERM',
  NOT_LEADER: 'NOT_LEADER',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  CONFLICT: 'CONFLICT',
  MIGRATION_ACTIVE: 'MIGRATION_ACTIVE',
  MIGRATION_NOT_ACTIVE: 'MIGRATION_NOT_ACTIVE',
  MIGRATION_COMMITTED: 'MIGRATION_COMMITTED',
};

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

class ClusterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClusterError';
    this.code = code;
    this.details = details;
  }
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class Cluster {
  /**
   * @param {string} dir 数据目录（cluster.json + node-*.json）
   * @param {{leaseMs?: number, now?: () => number}} opts leaseMs 租约时长；now 可注入时钟便于测试
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.leaseMs = opts.leaseMs != null ? opts.leaseMs : 60000;
    this.now = opts.now || (() => Date.now());
    fs.mkdirSync(dir, { recursive: true });
    this.stateFile = path.join(dir, 'cluster.json');
    this.state = null;
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.stateFile)) return;
    this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    // 旧版本数据兼容：补全名单迁移相关字段。
    if (!Array.isArray(this.state.oldConfig)) this.state.oldConfig = this.state.nodes.map((n) => n.id);
    if (!Array.isArray(this.state.migrationHistory)) this.state.migrationHistory = [];
    if (this.state.migration === undefined) this.state.migration = null;
    // 崩溃恢复：可达节点按 canonical 日志收敛（截断未提交的分叉尾部、补齐缺失条目）。
    // 不可达节点保持原样，模拟分区仍在持续。
    for (const node of this._unionNodes()) {
      if (node && node.reachable) this._reconcileNode(node.id);
    }
    // 恢复唯一的在途迁移阶段：双名单多数在崩溃前已持久确认的，在此完成最终切换；
    // 否则保持联合阶段，等待新节点恢复或操作员中止。
    this._evaluateMigration();
    this._persist();
  }

  get initialized() {
    return this.state !== null;
  }

  _nodeFile(id) {
    return path.join(this.dir, `node-${id}.json`);
  }

  _readNodeLog(id) {
    const f = this._nodeFile(id);
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  _writeNodeLog(id, log) {
    atomicWriteJson(this._nodeFile(id), log);
  }

  _persist() {
    atomicWriteJson(this.stateFile, this.state);
  }

  /** 现役（稳定）名单的多数；联合阶段仅供旧名单/单一名单语义参考。 */
  _majority() {
    return Math.floor(this.state.oldConfig.length / 2) + 1;
  }

  static majorityOf(n) {
    return Math.floor(n / 2) + 1;
  }

  _leaseValid() {
    return this.state.leader !== null && this.now() < this.state.leaseExpiresAt;
  }

  _entriesEqual(a, b) {
    return !!a && !!b && a.requestId === b.requestId && a.payload === b.payload && a.term === b.term;
  }

  /** 联合阶段旧/新名单的并集节点；非联合阶段即全体现役节点。 */
  _unionNodes() {
    if (!this.state) return [];
    if (!this.state.migration) return this.state.nodes;
    const ids = new Set(this.state.migration.oldVoters.concat(this.state.migration.newVoters));
    return [...ids].map((id) => this.state.nodes.find((n) => n.id === id)).filter(Boolean);
  }

  /** 将单个节点日志与 canonical 对齐：截断分叉尾部，随后补齐缺失前缀。 */
  _reconcileNode(id) {
    const canonical = this.state.log;
    let log = this._readNodeLog(id);
    let divergeAt = -1;
    for (let i = 0; i < log.length; i++) {
      if (i >= canonical.length || !this._entriesEqual(log[i], canonical[i])) {
        divergeAt = i;
        break;
      }
    }
    let changed = false;
    if (divergeAt >= 0) {
      log = log.slice(0, divergeAt);
      changed = true;
    }
    if (log.length < canonical.length) {
      log = log.concat(canonical.slice(log.length));
      changed = true;
    }
    if (changed) this._writeNodeLog(id, log);
    return log;
  }

  /** 把条目写入指定节点日志；同位置冲突条目（旧任期残留）被覆盖并截断后续。 */
  _appendToNode(id, entry) {
    let log = this._readNodeLog(id);
    const pos = entry.index - 1;
    if (log.length > pos && !this._entriesEqual(log[pos], entry)) {
      log = log.slice(0, pos);
    }
    if (log.length === pos) log.push(entry);
    else log[pos] = entry;
    this._writeNodeLog(id, log);
  }

  /**
   * 统计某条目在给定投票名单中已持久落盘（确认）的节点。
   * requireReachable=true 时只计当前可达节点：任一名单多数不可达期间，
   * 即便节点文件里残留历史确认，也不得据此推进联合提交或最终切换。
   */
  _acksForEntry(entry, voterIds, requireReachable = false) {
    const acks = [];
    for (const id of voterIds) {
      if (requireReachable) {
        const node = this.state.nodes.find((n) => n.id === id);
        if (!node || !node.reachable) continue;
      }
      const log = this._readNodeLog(id);
      const at = log[entry.index - 1];
      if (at && at.requestId === entry.requestId && at.term === entry.term) acks.push(id);
    }
    return acks;
  }

  /**
   * 联合阶段推进提交线：只有连续获得旧名单与新名单各自多数（且当前可达）的条目才能提交。
   * 返回配置条目是否已在此轮达到联合多数（即可完成最终名单切换）。
   */
  _commitJointEntries(m) {
    let configReached = this.state.committedIndex >= m.configIndex;
    for (let i = this.state.committedIndex; i < this.state.log.length; i++) {
      const entry = this.state.log[i];
      const ackOld = this._acksForEntry(entry, m.oldVoters, true);
      const ackNew = this._acksForEntry(entry, m.newVoters, true);
      if (ackOld.length < Cluster.majorityOf(m.oldVoters.length)) break;
      if (ackNew.length < Cluster.majorityOf(m.newVoters.length)) break;
      this.state.committedIndex = entry.index;
      this.state.lastCommit = {
        index: entry.index,
        requestId: entry.requestId,
        kind: entry.kind || 'command',
        quorum: 'joint',
        confirmedBy: [...new Set(ackOld.concat(ackNew))],
        confirmedByOld: ackOld,
        confirmedByNew: ackNew,
      };
      if (entry.index === m.configIndex) {
        configReached = true;
        m.ackOld = ackOld;
        m.ackNew = ackNew;
      }
    }
    return configReached;
  }

  /**
   * 稳定配置下推进提交线：连续复制到现役名单可达多数的条目方可提交。
   * 仅在联合迁移刚完成切换时调用，原有（无迁移）提交时机保持不变。
   */
  _commitStableEntries(voters) {
    for (let i = this.state.committedIndex; i < this.state.log.length; i++) {
      const entry = this.state.log[i];
      const acks = this._acksForEntry(entry, voters, true);
      if (acks.length < Cluster.majorityOf(voters.length)) break;
      this.state.committedIndex = entry.index;
      this.state.lastCommit = { index: entry.index, requestId: entry.requestId, confirmedBy: acks };
    }
  }

  /**
   * 评估在途迁移：依据各节点持久日志重建双名单确认集合；配置条目一旦拿到双名单
   * 多数，则原子完成最终名单切换（退役节点退出、新名单生效）。崩溃重启同样走这里，
   * 保证全局至多一个在途迁移阶段。
   */
  _evaluateMigration() {
    const m = this.state && this.state.migration;
    if (!m) return;
    const configEntry = this.state.log[m.configIndex - 1];
    if (configEntry) {
      m.ackOld = this._acksForEntry(configEntry, m.oldVoters, true);
      m.ackNew = this._acksForEntry(configEntry, m.newVoters, true);
    }
    const reached = this._commitJointEntries(m);
    if (reached) {
      const newVoters = m.newVoters.slice();
      this._finalizeMigration(m);
      // 切换完成：配置条目之后的联合尾部按新名单可达多数继续提交。
      this._commitStableEntries(newVoters);
    }
    this._persist();
  }

  /** 完成联合共识：正式切换现役名单，清理退役节点的日志文件。 */
  _finalizeMigration(m) {
    const newVoters = m.newVoters;
    const oldSet = new Set(m.oldVoters);
    const newSet = new Set(newVoters);
    const retiredVoters = m.oldVoters.filter((id) => !newSet.has(id));
    const joinedVoters = newVoters.filter((id) => !oldSet.has(id));
    for (const id of retiredVoters) {
      fs.rmSync(this._nodeFile(id), { force: true });
    }
    this.state.nodes = this.state.nodes.filter((n) => newSet.has(n.id));
    this.state.oldConfig = newVoters.slice();
    this.state.termQuorum = newVoters.filter((id) => {
      const n = this.state.nodes.find((x) => x.id === id);
      return n && n.reachable;
    });
    const result = {
      status: 'committed',
      phase: 'stable',
      duplicate: false,
      migrationId: m.migrationId,
      requestId: m.migrationId,
      index: m.configIndex,
      term: m.term,
      oldRoster: m.oldVoters,
      newRoster: newVoters,
      joinedVoters,
      retiredVoters,
      oldMajority: Cluster.majorityOf(m.oldVoters.length),
      newMajority: Cluster.majorityOf(newVoters.length),
      confirmedByOld: m.ackOld,
      confirmedByNew: m.ackNew,
      confirmedBy: [...new Set((m.ackOld || []).concat(m.ackNew || []))],
      committedIndex: this.state.committedIndex,
    };
    m.result = result;
    this.state.migrationHistory.push(result);
    if (this.state.migrationHistory.length > 20) this.state.migrationHistory.shift();
    this.state.migration = null;
  }

  _requireInit() {
    if (!this.initialized) throw new ClusterError(ERR.NO_CLUSTER, '编队尚未创建');
  }

  _findRequest(requestId) {
    return this.state.log.find((e) => e.requestId === requestId) || null;
  }

  /** 创建三至五节点编队；重置全部任期与日志状态。 */
  create(size) {
    if (!Number.isInteger(size) || size < 3 || size > 5) {
      throw new ClusterError(ERR.BAD_REQUEST, '编队规模必须为 3、4 或 5 个节点');
    }
    // 清理上一编队遗留的节点日志，避免旧文件污染新编队。
    for (const f of fs.readdirSync(this.dir)) {
      if (/^node-.+\.json$/.test(f)) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    this.state = {
      size,
      nodes: Array.from({ length: size }, (_, i) => ({ id: `n${i + 1}`, reachable: true })),
      oldConfig: Array.from({ length: size }, (_, i) => `n${i + 1}`),
      activeTerm: 0,
      leader: null,
      leaseExpiresAt: 0,
      termQuorum: [],
      log: [],
      committedIndex: 0,
      lastCommit: null,
      migration: null,
      migrationHistory: [],
    };
    for (const node of this.state.nodes) this._writeNodeLog(node.id, []);
    this._persist();
    return this.getState();
  }

  /** 清空编队（cluster.json + 全部节点日志）。 */
  reset() {
    this.state = null;
    for (const f of fs.readdirSync(this.dir)) {
      if (f === 'cluster.json' || /^node-.+\.json$/.test(f)) {
        fs.rmSync(path.join(this.dir, f), { force: true });
      }
    }
    return { initialized: false };
  }

  /**
   * 以控制器标识申请任期。
   * - 多数节点不可达 -> NO_MAJORITY，现役任期与日志保持不变；
   * - 联合配置期间须旧、新名单多数同时可达，不能沿用单一名单规则；
   * - 他人持有有效租约 -> LEASE_HELD；
   * - 本人续期 -> 任期不变、租约顺延；
   * - 否则任期 +1，申请人成为主控，法定确认节点为当前可达节点集。
   */
  requestTerm(controllerId) {
    this._requireInit();
    if (!controllerId || typeof controllerId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少控制器标识 controllerId');
    }
    const reachable = this.state.nodes.filter((n) => n.reachable);
    const m = this.state.migration;
    const quorumDesc = m
      ? {
          quorum: 'joint',
          oldReachable: m.oldVoters.filter((id) => reachable.some((n) => n.id === id)),
          newReachable: m.newVoters.filter((id) => reachable.some((n) => n.id === id)),
          oldMajority: Cluster.majorityOf(m.oldVoters.length),
          newMajority: Cluster.majorityOf(m.newVoters.length),
        }
      : null;
    if (!m && reachable.length < this._majority()) {
      throw new ClusterError(
        ERR.NO_MAJORITY,
        `可达节点 ${reachable.length}/${this.state.nodes.length}，不足法定多数，拒绝授予任期`,
        { reachable: reachable.map((n) => n.id), majority: this._majority() }
      );
    }
    if (m) {
      const oldOk = quorumDesc.oldReachable.length >= quorumDesc.oldMajority;
      const newOk = quorumDesc.newReachable.length >= quorumDesc.newMajority;
      if (!oldOk || !newOk) {
        throw new ClusterError(
          ERR.NO_MAJORITY,
          '联合配置期间申请任期须旧名单与新名单多数同时可达',
          quorumDesc
        );
      }
    }
    if (this._leaseValid()) {
      if (this.state.leader === controllerId) {
        this.state.leaseExpiresAt = this.now() + this.leaseMs;
        this._persist();
        return {
          term: this.state.activeTerm,
          leader: controllerId,
          renewed: true,
          quorum: this.state.termQuorum,
          leaseExpiresAt: this.state.leaseExpiresAt,
        };
      }
      throw new ClusterError(ERR.LEASE_HELD, `租约仍由 ${this.state.leader} 持有，尚未失效`, {
        leader: this.state.leader,
        leaseExpiresAt: this.state.leaseExpiresAt,
      });
    }
    this.state.activeTerm += 1;
    this.state.leader = controllerId;
    this.state.leaseExpiresAt = this.now() + this.leaseMs;
    this.state.termQuorum = reachable
      .filter((n) => !m || m.oldVoters.includes(n.id) || m.newVoters.includes(n.id))
      .map((n) => n.id);
    this._persist();
    return {
      term: this.state.activeTerm,
      leader: controllerId,
      renewed: false,
      quorum: this.state.termQuorum,
      leaseExpiresAt: this.state.leaseExpiresAt,
    };
  }

  /** 使当前租约立即失效（模拟主控失联/租约到期）。 */
  revokeLease() {
    this._requireInit();
    this.state.leaseExpiresAt = 0;
    this._persist();
    return this.getState();
  }

  /** 设置节点可达性；恢复可达时立即追赶（按 canonical 收敛该节点日志），联合阶段随之推进。 */
  setReachable(nodeId, reachable) {
    this._requireInit();
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) throw new ClusterError(ERR.BAD_REQUEST, `未知节点 ${nodeId}`);
    node.reachable = !!reachable;
    if (node.reachable) this._reconcileNode(nodeId);
    // 联合阶段新（或旧）名单节点恢复可达：追赶得到的配置条目即视为持久确认，
    // 若双名单多数因此凑齐，在此完成最终切换。
    this._evaluateMigration();
    this._persist();
    return this.getState();
  }

  /**
   * 主控提交名单迁移（Raft 联合共识 C_old,new）。
   * 栅栏与普通指令一致；同迁移标识重传永远返回原结论（在途或已完成），不重复追加。
   * 成功后编队先进入 joint 阶段：配置条目复制到旧+新名单的可达节点。双名单多数均
   * 落盘确认时同步完成最终切换；否则保持联合阶段，现役名单、任期不变。
   */
  beginMigration({ controllerId, term, migrationId, targetVoterIds }) {
    this._requireInit();
    if (!controllerId || typeof controllerId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少控制器标识 controllerId');
    }
    if (!Number.isInteger(term)) throw new ClusterError(ERR.BAD_REQUEST, 'term 必须为整数');
    if (!migrationId || typeof migrationId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少稳定迁移标识 migrationId');
    }

    const voters = this._validateTargetVoters(targetVoterIds);

    // 栅栏顺序与 submit 一致：旧任期 -> 未知任期 -> 非主控。
    this._fenceLeader(controllerId, term);

    // 幂等先于一切写动作：在途迁移重传返回当前阶段原结论；已完成迁移重放返回归档结论。
    const prior = this.state.log.find((e) => e.requestId === migrationId);
    if (prior && prior.kind !== 'config') {
      throw new ClusterError(ERR.CONFLICT, `标识 ${migrationId} 已被普通指令占用，不能作为迁移标识`, {
        existing: prior,
      });
    }
    const active = this.state.migration;
    if (active) {
      if (active.migrationId !== migrationId) {
        throw new ClusterError(
          ERR.MIGRATION_ACTIVE,
          `迁移 ${active.migrationId} 尚在联合阶段，不能开启新的迁移`,
          { activeMigrationId: active.migrationId, phase: 'joint' }
        );
      }
      if (JSON.stringify(active.newVoters) !== JSON.stringify(voters)) {
        throw new ClusterError(ERR.CONFLICT, `迁移标识 ${migrationId} 已对应不同的目标投票节点集合`, {
          existing: active.newVoters,
          submitted: voters,
        });
      }
      return this._migrationView(active, true);
    }
    const archived = this.state.migrationHistory.find((x) => x.migrationId === migrationId);
    if (archived) {
      if (JSON.stringify(archived.newRoster) !== JSON.stringify(voters)) {
        throw new ClusterError(ERR.CONFLICT, `迁移标识 ${migrationId} 已对应不同的目标投票节点集合`, {
          existing: archived.newRoster,
          submitted: voters,
        });
      }
      return Object.assign({}, archived, { duplicate: true });
    }

    if (JSON.stringify(voters) === JSON.stringify(this.state.oldConfig)) {
      throw new ClusterError(ERR.BAD_REQUEST, '目标投票节点集合与现役名单完全一致，无需迁移');
    }

    if (!this._leaseValid()) {
      throw new ClusterError(ERR.LEASE_EXPIRED, '主控租约已失效，请重新申请任期后再提交迁移');
    }

    const oldVoters = this.state.oldConfig.slice();
    const oldSet = new Set(oldVoters);
    const fresh = voters.filter((id) => !oldSet.has(id));

    const entry = {
      index: this.state.log.length + 1,
      term,
      requestId: migrationId,
      kind: 'config',
      payload: JSON.stringify({ type: 'config', oldVoters, newVoters: voters }),
      ts: this.now(),
      oldVoters,
      newVoters: voters,
    };

    // 新节点先入编并追赶到 canonical，再接收配置条目；旧节点直接追加。
    for (const id of fresh) {
      this.state.nodes.push({ id, reachable: true });
      this._writeNodeLog(id, this.state.log.map((e) => Object.assign({}, e)));
    }
    this.state.log.push(entry);
    for (const node of this._unionNodes()) {
      if (node.reachable) this._appendToNode(node.id, entry);
    }

    this.state.migration = {
      migrationId,
      term,
      leader: controllerId,
      oldVoters,
      newVoters: voters,
      configIndex: entry.index,
      phase: 'joint',
      ackOld: [],
      ackNew: [],
      result: null,
    };
    // 双名单多数在提交时即已落盘（例如无节点退役且新节点都可达）-> 当场完成切换。
    this._evaluateMigration();
    const m = this.state.migration;
    if (!m) {
      const done = this.state.migrationHistory[this.state.migrationHistory.length - 1];
      return Object.assign({}, done, { duplicate: false });
    }
    this._persist();
    return this._migrationView(m, false);
  }

  /**
   * 中止在途迁移：仅当配置条目尚未获得联合多数（未提交）时允许。
   * 截断 canonical 与各节点上配置条目起的全部联合尾部，移除从未加入旧名单的新节点，
   * 回到旧名单的单一名单确认规则；现役名单、任期、主控与已提交前缀保持不变。
   */
  abortMigration({ controllerId, term } = {}) {
    this._requireInit();
    if (!Number.isInteger(term)) throw new ClusterError(ERR.BAD_REQUEST, 'term 必须为整数');
    if (!controllerId || typeof controllerId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少控制器标识 controllerId');
    }
    const m = this.state.migration;
    if (!m) {
      throw new ClusterError(ERR.MIGRATION_NOT_ACTIVE, '当前没有在途迁移');
    }
    this._fenceLeader(controllerId, term);
    if (this.state.committedIndex >= m.configIndex) {
      // 联合多数已持久确认，最终切换不可撤销。
      throw new ClusterError(
        ERR.MIGRATION_COMMITTED,
        `迁移 ${m.migrationId} 的配置条目已获双名单多数确认，不能中止`,
        this._migrationView(m, false)
      );
    }
    const oldSet = new Set(m.oldVoters);
    const fresh = m.newVoters.filter((id) => !oldSet.has(id));
    const keep = m.configIndex - 1;
    this.state.log = this.state.log.slice(0, keep);
    for (const node of this._unionNodes()) {
      const log = this._readNodeLog(node.id).slice(0, keep);
      this._writeNodeLog(node.id, log);
    }
    for (const id of fresh) {
      fs.rmSync(this._nodeFile(id), { force: true });
    }
    this.state.nodes = this.state.nodes.filter((n) => oldSet.has(n.id));
    const aborted = {
      status: 'aborted',
      phase: 'stable',
      migrationId: m.migrationId,
      index: m.configIndex,
      term: m.term,
      oldRoster: m.oldVoters,
      plannedNewRoster: m.newVoters,
      droppedVoters: fresh,
      committedIndex: this.state.committedIndex,
      activeTerm: this.state.activeTerm,
      leader: this.state.leader,
    };
    this.state.migration = null;
    this._persist();
    return aborted;
  }

  _validateTargetVoters(targetVoterIds) {
    if (!Array.isArray(targetVoterIds) || targetVoterIds.length < 3 || targetVoterIds.length > 5) {
      throw new ClusterError(ERR.BAD_REQUEST, '目标投票节点集合 targetVoterIds 必须为 3-5 个节点的数组');
    }
    const voters = [];
    for (const raw of targetVoterIds) {
      const id = String(raw);
      if (!NODE_ID_RE.test(id)) {
        throw new ClusterError(ERR.BAD_REQUEST, `非法节点标识: ${raw}`);
      }
      if (voters.includes(id)) {
        throw new ClusterError(ERR.BAD_REQUEST, `目标投票节点集合中存在重复节点: ${id}`);
      }
      voters.push(id);
    }
    // 联合共识要求新旧名单存在重叠，否则两个不相交多数可能各自做出裁决。
    if (!voters.some((id) => this.state.oldConfig.includes(id))) {
      throw new ClusterError(ERR.BAD_REQUEST, '目标投票节点集合与现役名单完全不相交，联合共识要求新旧名单至少保留一个共同节点');
    }
    return voters;
  }

  /** 任期/主控栅栏：旧任期 -> 未知任期 -> 非主控。 */
  _fenceLeader(controllerId, term) {
    if (term < this.state.activeTerm) {
      throw new ClusterError(
        ERR.FENCED_TERM,
        `任期 ${term} 已被现役任期 ${this.state.activeTerm} 栅栏隔离`,
        { activeTerm: this.state.activeTerm }
      );
    }
    if (term > this.state.activeTerm) {
      throw new ClusterError(ERR.UNKNOWN_TERM, `任期 ${term} 从未被授予`, {
        activeTerm: this.state.activeTerm,
      });
    }
    if (this.state.leader !== controllerId) {
      throw new ClusterError(ERR.NOT_LEADER, `现役主控为 ${this.state.leader}`, {
        leader: this.state.leader,
      });
    }
  }

  _migrationView(m, duplicate) {
    const oldMajority = Cluster.majorityOf(m.oldVoters.length);
    const newMajority = Cluster.majorityOf(m.newVoters.length);
    const configEntry = this.state.log[m.configIndex - 1];
    const ackOld = configEntry ? this._acksForEntry(configEntry, m.oldVoters, true) : [];
    const ackNew = configEntry ? this._acksForEntry(configEntry, m.newVoters, true) : [];
    const oldSet = new Set(m.oldVoters);
    const newSet = new Set(m.newVoters);
    return {
      status: 'joint',
      phase: 'joint',
      duplicate,
      migrationId: m.migrationId,
      requestId: m.migrationId,
      term: m.term,
      leader: m.leader,
      index: m.configIndex,
      oldRoster: m.oldVoters,
      newRoster: m.newVoters,
      oldAck: ackOld,
      newAck: ackNew,
      oldMajority,
      newMajority,
      oldConfirmed: ackOld.length >= oldMajority,
      newConfirmed: ackNew.length >= newMajority,
      joinedVoters: m.newVoters.filter((id) => !oldSet.has(id)),
      retiredVoters: m.oldVoters.filter((id) => !newSet.has(id)),
      canFinalize: ackOld.length >= oldMajority && ackNew.length >= newMajority,
      committedIndex: this.state.committedIndex,
    };
  }

  /**
   * 主控提交指令。
   * 栅栏顺序：旧任期 -> 未知任期 -> 非主控 -> 幂等判定 -> 租约有效性 -> 复制提交。
   * 幂等判定先于租约：已提交条目的重传永远返回原结论，不产生任何写动作。
   * 联合配置期间，普通姿态指令同样须获得旧名单与新名单各自多数才能提交。
   */
  submit({ controllerId, term, requestId, payload }) {
    this._requireInit();
    if (!controllerId || typeof controllerId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少控制器标识 controllerId');
    }
    if (!Number.isInteger(term)) {
      throw new ClusterError(ERR.BAD_REQUEST, 'term 必须为整数');
    }
    if (!requestId || typeof requestId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少稳定请求标识 requestId');
    }
    if (payload == null || payload === '') {
      throw new ClusterError(ERR.BAD_REQUEST, '指令内容 payload 不能为空');
    }
    if (typeof payload !== 'string') payload = JSON.stringify(payload);

    this._fenceLeader(controllerId, term);

    const existing = this.state.log.find((e) => e.requestId === requestId);
    if (existing) {
      if (existing.kind === 'config') {
        throw new ClusterError(ERR.CONFLICT, `请求标识 ${requestId} 属于名单迁移条目，不能作为普通指令重提`);
      }
      if (existing.payload !== payload) {
        throw new ClusterError(ERR.CONFLICT, `请求标识 ${requestId} 已对应不同指令内容`, {
          existing,
        });
      }
      return this._resultFor(existing, true);
    }

    if (!this._leaseValid()) {
      throw new ClusterError(ERR.LEASE_EXPIRED, '主控租约已失效，旧任期只能追赶不能提交，请重新申请任期');
    }

    const m = this.state.migration;
    const entry = { index: this.state.log.length + 1, term, requestId, payload, ts: this.now() };
    this.state.log.push(entry);
    const targets = m ? this._unionNodes() : this.state.nodes;
    const confirmedBy = [];
    for (const node of targets) {
      if (!node.reachable) continue;
      this._appendToNode(node.id, entry);
      confirmedBy.push(node.id);
    }
    if (m) {
      // 联合配置：普通指令也按双名单各自多数裁决，禁止沿用单一名单规则。
      this._evaluateMigration();
    } else if (confirmedBy.length >= this._majority()) {
      this.state.committedIndex = entry.index;
      this.state.lastCommit = { index: entry.index, requestId, confirmedBy };
    }
    // 先落盘再响应：多数确认后即使进程退出，重启仍能从持久态恢复 committed。
    this._persist();
    const result = this._resultFor(entry, false, confirmedBy);
    if (m && this.state.migration === m) {
      // 仍在联合阶段：返回双名单各自确认情况。
      const ackOld = this._acksForEntry(entry, m.oldVoters, true);
      const ackNew = this._acksForEntry(entry, m.newVoters, true);
      result.quorum = 'joint';
      result.confirmedByOld = ackOld;
      result.confirmedByNew = ackNew;
      result.oldMajority = Cluster.majorityOf(m.oldVoters.length);
      result.newMajority = Cluster.majorityOf(m.newVoters.length);
    } else if (m) {
      // 本次提交凑齐双名单多数，迁移已在评估中完成最终切换：指令按新名单确认。
      result.quorum = 'stable';
      result.activeVoters = this.state.oldConfig.slice();
    }
    return result;
  }

  _resultFor(entry, duplicate, confirmedBy) {
    const committed = entry.index <= this.state.committedIndex;
    let confirmed = confirmedBy;
    if (!confirmed && this.state.lastCommit && this.state.lastCommit.index === entry.index) {
      confirmed = this.state.lastCommit.confirmedBy;
    }
    return {
      status: committed ? 'committed' : 'accepted',
      duplicate,
      index: entry.index,
      term: entry.term,
      requestId: entry.requestId,
      committedIndex: this.state.committedIndex,
      confirmedBy: confirmed,
    };
  }

  /** 完整状态快照：现役名单/任期、迁移阶段与双名单确认、各节点已接受指令序列。 */
  getState() {
    if (!this.initialized) return { initialized: false };
    // 任何读取都先依据持久日志推进在途迁移（节点恢复、崩溃重启后的统一入口）。
    if (this.state.migration) this._evaluateMigration();
    const s = this.state;
    const m = s.migration;
    const oldSet = new Set(s.oldConfig);
    const newSet = new Set(m ? m.newVoters : s.oldConfig);
    return {
      initialized: true,
      size: s.nodes.length,
      majority: this._majority(),
      config: {
        phase: m ? 'joint' : 'stable',
        voters: s.oldConfig,
      },
      migration: m ? this._migrationView(m, false) : null,
      activeTerm: s.activeTerm,
      leader: s.leader,
      leaseExpiresAt: s.leaseExpiresAt,
      leaseValid: this._leaseValid(),
      leaseRemainingMs: Math.max(0, s.leaseExpiresAt - this.now()),
      termQuorum: s.termQuorum,
      committedIndex: s.committedIndex,
      lastCommit: s.lastCommit,
      committedSequence: s.log.slice(0, s.committedIndex),
      nodes: s.nodes.map((n) => ({
        id: n.id,
        reachable: n.reachable,
        inOldConfig: m ? m.oldVoters.includes(n.id) : oldSet.has(n.id),
        inNewConfig: newSet.has(n.id),
        retiring: m ? m.oldVoters.includes(n.id) && !m.newVoters.includes(n.id) : false,
        joining: m ? m.newVoters.includes(n.id) && !m.oldVoters.includes(n.id) : false,
        log: this._readNodeLog(n.id),
      })),
      now: this.now(),
    };
  }
}

module.exports = { Cluster, ClusterError, ERR };
