'use strict';

/**
 * 轨道编队共识核心（Raft 式语义，单进程模拟 N 个控制节点）。
 *
 * - 任期(term)：由持有租约(lease)的主控控制器(leader)唯一推进；申请任期需多数节点可达
 *     （联合配置期间需旧、新两份名单各自多数可达）。
 * - 栅栏(fencing)：携带旧任期/未知任期/非主控的提交一律拒绝，任何节点日志不得增长。
 * - 幂等：指令/迁移带稳定请求标识；同标识同内容重传返回原结论且不重复追加，
 *   同标识不同内容返回冲突。
 * - 持久化：canonical 日志与任期状态落盘 cluster.json；每个节点独立 node-<id>.json，
 *   多数节点确认（落盘）后才判定 committed；崩溃重启后按 canonical 收敛各节点日志。
 * - 名单迁移（联合共识，Raft joint consensus）：
 *   提交带稳定 migrationId 与目标投票节点集合的迁移后，编队先进入联合配置 C_old,new；
 *   配置条目与迁移期间的普通指令都必须同时取得旧名单与新名单的多数确认；
 *   两份名单多数确认后才允许提交 C_new 完成最终名单切换（旧成员退役、日志冻结）。
 *   任一名单多数不可达时迁移被拒绝，现役名单、任期、节点日志均不变。
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
  NO_MIGRATION: 'NO_MIGRATION',
};

// 配置条目的稳定 payload 标识；普通指令 payload 不得与之冲突。
const JOINT_PAYLOAD = '__joint_config__';
const FINAL_PAYLOAD = '__final_config__';
const ROLLBACK_PAYLOAD = '__rollback_config__';

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

function uniqSorted(list) {
  return Array.from(new Set(list));
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
    const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    // 向后兼容：旧版本持久态没有 config / migration / retiredNodes 字段。
    if (!Array.isArray(s.config)) s.config = s.nodes.map((n) => n.id);
    if (!('migration' in s)) s.migration = null;
    if (!Array.isArray(s.retiredNodes)) s.retiredNodes = [];
    this.state = s;

    // 崩溃恢复：当前配置（联合时含新名单）的可达节点按 canonical 日志收敛
    // （截断未提交的分叉尾部、补齐缺失条目）。
    // 不在现役投票集合内的已退役节点保持冻结；其他不可达节点保持原样，模拟分区仍在持续。
    for (const node of this.state.nodes) {
      if (node.reachable && this._activeVoterIds().includes(node.id)) this._reconcileNode(node.id);
    }
    // 从持久日志重建唯一迁移阶段的确认集合：节点文件里是否已落联合配置条目是唯一事实来源。
    if (this.state.migration && this.state.migration.phase === 'joint') {
      this._rebuildMigrationAcks();
    }
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

  static majorityOf(voters) {
    return Math.floor(voters.length / 2) + 1;
  }

  /** 两个投票名单作为集合是否相同（忽略顺序）。 */
  static sameVoters(a, b) {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((id) => set.has(id));
  }

  /** 当前配置下的法定多数。 */
  _majority() {
    return Cluster.majorityOf(this.state.config);
  }

  /** 当前生效的投票节点集合：联合配置期间为旧∪新，否则为现役名单。 */
  _activeVoterIds() {
    const m = this.state.migration;
    if (m && m.phase === 'joint') return uniqSorted([...m.oldVoters, ...m.newVoters]);
    return this.state.config.slice();
  }

  _leaseValid() {
    return this.state.leader !== null && this.now() < this.state.leaseExpiresAt;
  }

  _entriesEqual(a, b) {
    return (
      !!a &&
      !!b &&
      a.requestId === b.requestId &&
      a.payload === b.payload &&
      a.term === b.term &&
      (a.kind || 'command') === (b.kind || 'command')
    );
  }

  _reachable(id) {
    const n = this.state.nodes.find((x) => x.id === id);
    return !!(n && n.reachable);
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

  /** 把 canonical 尾部复制到所有当前可达的投票节点（先对齐前缀再落盘）。 */
  _replicateTo(voterIds) {
    const acked = [];
    for (const id of voterIds) {
      if (!this._reachable(id)) continue;
      this._reconcileNode(id);
      acked.push(id);
    }
    return acked;
  }

  /** 节点日志中是否已持久化指定 canonical 位置的条目。 */
  _nodeHasEntry(id, entry) {
    const log = this._readNodeLog(id);
    const pos = entry.index - 1;
    return !!log[pos] && this._entriesEqual(log[pos], entry);
  }

  /** 依据各节点持久日志重建联合配置条目在旧、新名单上的确认集合。 */
  _rebuildMigrationAcks() {
    const m = this.state.migration;
    const joint = this.state.log[m.configIndex - 1];
    if (!joint) return;
    m.oldConfirmed = m.oldVoters.filter((id) => this._nodeHasEntry(id, joint));
    m.newConfirmed = m.newVoters.filter((id) => this._nodeHasEntry(id, joint));
  }

  _requireInit() {
    if (!this.initialized) throw new ClusterError(ERR.NO_CLUSTER, '编队尚未创建');
  }

  /** 创建三至五节点编队；重置全部任期、日志与迁移状态。 */
  create(size) {
    if (!Number.isInteger(size) || size < 3 || size > 5) {
      throw new ClusterError(ERR.BAD_REQUEST, '编队规模必须为 3、4 或 5 个节点');
    }
    // 清理上一编队遗留的节点日志，避免旧文件污染新编队。
    for (const f of fs.readdirSync(this.dir)) {
      if (/^node-.+\.json$/.test(f)) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    const ids = Array.from({ length: size }, (_, i) => `n${i + 1}`);
    this.state = {
      size,
      nodes: ids.map((id) => ({ id, reachable: true })),
      config: ids,
      retiredNodes: [],
      activeTerm: 0,
      leader: null,
      leaseExpiresAt: 0,
      termQuorum: [],
      log: [],
      committedIndex: 0,
      lastCommit: null,
      migration: null,
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
   *   联合配置期间需旧、新名单各自多数可达，不能只凭单一名单授予；
   * - 他人持有有效租约 -> LEASE_HELD；
   * - 本人续期 -> 任期不变、租约顺延；
   * - 否则任期 +1，申请人成为主控，法定确认节点为当前可达投票节点集。
   */
  requestTerm(controllerId) {
    this._requireInit();
    if (!controllerId || typeof controllerId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少控制器标识 controllerId');
    }
    const reachableVoters = this._activeVoterIds().filter((id) => this._reachable(id));
    const m = this.state.migration;
    const jointActive = !!(m && m.phase === 'joint');
    if (!jointActive && reachableVoters.length < this._majority()) {
      throw new ClusterError(
        ERR.NO_MAJORITY,
        `可达投票节点 ${reachableVoters.length}/${this.state.config.length}，不足法定多数，拒绝授予任期`,
        { reachable: reachableVoters, majority: this._majority() }
      );
    }
    if (m && m.phase === 'joint') {
      const oldReachable = m.oldVoters.filter((id) => this._reachable(id));
      const newReachable = m.newVoters.filter((id) => this._reachable(id));
      if (
        oldReachable.length < Cluster.majorityOf(m.oldVoters) ||
        newReachable.length < Cluster.majorityOf(m.newVoters)
      ) {
        throw new ClusterError(
          ERR.NO_MAJORITY,
          `联合配置下需旧、新名单各自多数可达（旧名单可达 ${oldReachable.length}/${m.oldVoters.length}、` +
            `新名单可达 ${newReachable.length}/${m.newVoters.length}），拒绝授予任期`,
          {
            joint: true,
            oldReachable: oldReachable,
            newReachable: newReachable,
            oldMajority: Cluster.majorityOf(m.oldVoters),
            newMajority: Cluster.majorityOf(m.newVoters),
          }
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
    this.state.termQuorum = reachableVoters;
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

  /** 设置节点可达性；恢复可达且仍有投票权时立即追赶（按 canonical 收敛该节点日志）。 */
  setReachable(nodeId, reachable) {
    this._requireInit();
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) throw new ClusterError(ERR.BAD_REQUEST, `未知节点 ${nodeId}`);
    node.reachable = !!reachable;
    // 不在现役投票集合内的节点（已退役且未被新名单重新纳入）日志冻结，恢复可达也不追赶。
    if (node.reachable && this._activeVoterIds().includes(nodeId)) {
      this._reconcileNode(nodeId);
      if (this.state.migration && this.state.migration.phase === 'joint') {
        this._rebuildMigrationAcks();
      }
    }
    this._persist();
    return this.getState();
  }

  /**
   * 主控提交指令。
   * 栅栏顺序：旧任期 -> 未知任期 -> 非主控 -> 幂等判定 -> 租约有效性 -> 复制提交。
   * 幂等判定先于租约：已提交条目的重传永远返回原结论，不产生任何写动作。
   * 联合配置期间，确认规则为旧名单与新名单各自多数（联合多数），不能沿用单一名单。
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

    if (term < this.state.activeTerm) {
      throw new ClusterError(ERR.FENCED_TERM, `任期 ${term} 已被现役任期 ${this.state.activeTerm} 栅栏隔离`, {
        activeTerm: this.state.activeTerm,
      });
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

    const existing = this.state.log.find((e) => e.requestId === requestId);
    if (existing) {
      if (existing.payload !== payload) {
        throw new ClusterError(ERR.CONFLICT, `请求标识 ${requestId} 已对应不同指令内容`, {
          existing,
        });
      }
      // 重传只返回原结论（不重新复制、不改变迁移阶段）。
      return this._resultFor(existing, true);
    }

    if (!this._leaseValid()) {
      throw new ClusterError(ERR.LEASE_EXPIRED, '主控租约已失效，旧任期只能追赶不能提交，请重新申请任期');
    }

    const m = this.state.migration;
    const joint = !!(m && m.phase === 'joint');
    const entry = {
      index: this.state.log.length + 1,
      term,
      requestId,
      payload,
      ts: this.now(),
    };
    this.state.log.push(entry);
    const acked = this._replicateTo(this._activeVoterIds());
    if (joint) {
      // 复制普通指令时恢复可达的节点也会补齐联合配置条目：据此刷新双名单确认视图。
      this._rebuildMigrationAcks();
    }

    let committed;
    if (joint) {
      const oldAcks = acked.filter((id) => m.oldVoters.includes(id));
      const newAcks = acked.filter((id) => m.newVoters.includes(id));
      committed =
        oldAcks.length >= Cluster.majorityOf(m.oldVoters) &&
        newAcks.length >= Cluster.majorityOf(m.newVoters);
    } else {
      committed = acked.length >= this._majority();
    }

    if (committed) {
      this.state.committedIndex = entry.index;
      this.state.lastCommit = {
        index: entry.index,
        requestId,
        confirmedBy: acked,
        joint,
      };
    }
    // 先落盘再响应：多数确认后即使进程退出，重启仍能从持久态恢复 committed。
    this._persist();
    return this._resultFor(entry, false, acked);
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

  /**
   * 提交名单迁移：带稳定 migrationId 与目标投票节点集合。
   * 成功后编队进入联合配置（C_old,new），联合配置条目须同时取得旧、新名单多数确认。
   * 任一名单多数不可达 -> NO_MAJORITY，且不写入任何日志，现役名单/任期/节点日志不变。
   * 同 migrationId 重传只返回原结论；改换目标集合或同标识不同内容 -> CONFLICT。
   */
  beginMigration({ controllerId, term, migrationId, voters }) {
    this._requireInit();
    if (!controllerId || typeof controllerId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少控制器标识 controllerId');
    }
    if (!Number.isInteger(term)) {
      throw new ClusterError(ERR.BAD_REQUEST, 'term 必须为整数');
    }
    if (!migrationId || typeof migrationId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少稳定迁移标识 migrationId');
    }
    const target = this._validateVoters(voters);

    if (term < this.state.activeTerm) {
      throw new ClusterError(ERR.FENCED_TERM, `任期 ${term} 已被现役任期 ${this.state.activeTerm} 栅栏隔离`, {
        activeTerm: this.state.activeTerm,
      });
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

    const m = this.state.migration;
    if (m && m.migrationId === migrationId) {
      // 幂等重传：内容必须一致；重发联合配置条目到恢复可达的节点，只返回原结论。
      if (m.term !== term || !Cluster.sameVoters(m.newVoters, target)) {
        throw new ClusterError(ERR.CONFLICT, `迁移标识 ${migrationId} 已对应不同的目标名单或任期`, {
          existing: { term: m.term, voters: m.newVoters },
        });
      }
      if (m.phase === 'joint') {
        this._replicateTo(uniqSorted([...m.oldVoters, ...m.newVoters]));
        this._rebuildMigrationAcks();
        this._persist();
      }
      return this._migrationView(true);
    }
    if (m && m.phase === 'joint') {
      throw new ClusterError(
        ERR.MIGRATION_ACTIVE,
        `联合配置迁移 ${m.migrationId} 尚未完成或中止，不能开启新迁移`,
        { activeMigration: m.migrationId, phase: m.phase }
      );
    }
    // 稳定迁移标识不得在历史配置条目中复用（即使上一个迁移已完成）。
    if (this.state.log.some((e) => e.kind === 'config' && e.migrationId === migrationId)) {
      throw new ClusterError(ERR.CONFLICT, `迁移标识 ${migrationId} 已被历史迁移使用，请更换稳定标识`, {
        migrationId,
      });
    }

    if (!this._leaseValid()) {
      throw new ClusterError(ERR.LEASE_EXPIRED, '主控租约已失效，请重新申请任期后再提交迁移');
    }
    if (Cluster.sameVoters(target, this.state.config)) {
      throw new ClusterError(ERR.BAD_REQUEST, '目标投票名单与现役名单一致，无需迁移');
    }

    const oldVoters = this.state.config.slice();
    const oldReach = oldVoters.filter((id) => this._reachable(id));
    const newReach = target.filter((id) => this._reachable(id));
    // 门闩：两份名单多数都可达才允许落联合配置条目；否则一个节点日志都不许动。
    if (
      oldReach.length < Cluster.majorityOf(oldVoters) ||
      newReach.length < Cluster.majorityOf(target)
    ) {
      throw new ClusterError(
        ERR.NO_MAJORITY,
        '旧名单或新名单多数节点不可达，拒绝进入联合配置；现役名单、任期与节点日志保持不变',
        {
          joint: true,
          oldVoters,
          newVoters: target,
          oldReachable: oldReach,
          newReachable: newReach,
          oldMajority: Cluster.majorityOf(oldVoters),
          newMajority: Cluster.majorityOf(target),
        }
      );
    }

    const entry = {
      index: this.state.log.length + 1,
      term,
      kind: 'config',
      configOp: 'joint',
      migrationId,
      requestId: `mig:${migrationId}:joint`,
      payload: JOINT_PAYLOAD,
      oldVoters,
      newVoters: target,
      ts: this.now(),
    };
    this.state.log.push(entry);
    const acked = this._replicateTo(uniqSorted([...oldVoters, ...target]));
    this.state.migration = {
      migrationId,
      term,
      controllerId,
      phase: 'joint',
      oldVoters,
      newVoters: target,
      configIndex: entry.index,
      finalizeIndex: null,
      oldConfirmed: acked.filter((id) => oldVoters.includes(id)),
      newConfirmed: acked.filter((id) => target.includes(id)),
      createdAt: this.now(),
    };
    this._persist();
    return this._migrationView(false);
  }

  /**
   * 完成最终名单切换：联合配置条目已获旧、新双多数确认后，提交 C_new 配置条目。
   * C_new 经新名单多数落盘后才切换现役名单；否则 NO_MAJORITY，联合配置与现役名单不变。
   */
  finalizeMigration({ controllerId, term, migrationId } = {}) {
    this._requireInit();
    const m = this.state.migration;
    if (!m) throw new ClusterError(ERR.NO_MIGRATION, '当前没有进行中的名单迁移');
    // 完成消息丢失/崩溃重启后的重传：最终阶段是已落盘的既成事实，只返回原结论。
    if (m.phase === 'final' && (migrationId == null || migrationId === m.migrationId)) {
      return this._migrationView(true);
    }
    this._fenceConfigOp(controllerId, term, migrationId, m);

    if (m.phase === 'final') {
      return this._migrationView(true);
    }

    // 重发联合配置条目给恢复可达的节点，并从持久日志重建双名单确认。
    this._replicateTo(uniqSorted([...m.oldVoters, ...m.newVoters]));
    this._rebuildMigrationAcks();
    const jointCommitted =
      m.oldConfirmed.length >= Cluster.majorityOf(m.oldVoters) &&
      m.newConfirmed.length >= Cluster.majorityOf(m.newVoters);
    const newReach = m.newVoters.filter((id) => this._reachable(id));
    if (!jointCommitted || newReach.length < Cluster.majorityOf(m.newVoters)) {
      this._persist();
      throw new ClusterError(
        ERR.NO_MAJORITY,
        '联合配置条目尚未获得旧、新双名单多数确认（或新名单多数当前不可达），不能完成最终切换',
        {
          joint: true,
          oldConfirmed: m.oldConfirmed,
          newConfirmed: m.newConfirmed,
          oldMajority: Cluster.majorityOf(m.oldVoters),
          newMajority: Cluster.majorityOf(m.newVoters),
        }
      );
    }

    const entry = {
      index: this.state.log.length + 1,
      term,
      kind: 'config',
      configOp: 'final',
      config: m.newVoters.slice(),
      migrationId: m.migrationId,
      requestId: `mig:${m.migrationId}:final`,
      payload: FINAL_PAYLOAD,
      ts: this.now(),
    };
    this.state.log.push(entry);
    const acked = this._replicateTo(m.newVoters);
    if (acked.length < Cluster.majorityOf(m.newVoters)) {
      // 理论上被前面的门闩拦截；防御性回滚内存中的 canonical 尾部，不落盘任何状态。
      this.state.log.pop();
      throw new ClusterError(ERR.NO_MAJORITY, '新名单多数确认失败，现役名单保持不变', {
        newVoters: m.newVoters,
      });
    }

    // 切换现役名单：旧名单中落选的节点退役（日志从此冻结）。
    this.state.config = m.newVoters.slice();
    const retiredNow = m.oldVoters.filter((id) => !m.newVoters.includes(id));
    this.state.retiredNodes = uniqSorted([
      ...this.state.retiredNodes.filter((id) => !m.newVoters.includes(id)),
      ...retiredNow,
    ]);
    m.phase = 'final';
    m.finalizeIndex = entry.index;
    m.retiredNodes = retiredNow;
    this.state.committedIndex = entry.index;
    this.state.lastCommit = {
      index: entry.index,
      requestId: entry.requestId,
      confirmedBy: acked,
      joint: false,
      configChange: true,
    };
    this._persist();
    return this._migrationView(false);
  }

  /**
   * 中止联合配置迁移：向旧名单多数落一条回滚配置条目（C_old），编队回到迁移前名单。
   * 旧名单多数不可达时拒绝且不改变任何状态。
   */
  abortMigration({ controllerId, term, migrationId } = {}) {
    this._requireInit();
    const m = this.state.migration;
    if (!m) {
      // 崩溃重传：回滚条目已落盘则迁移已中止，只返回原结论。
      const done = migrationId
        ? this.state.log.find((e) => e.kind === 'config' && e.configOp === 'rollback' && e.migrationId === migrationId)
        : null;
      if (done) {
        return { status: 'aborted', duplicate: true, migrationId, config: this.state.config };
      }
      throw new ClusterError(ERR.NO_MIGRATION, '当前没有进行中的名单迁移');
    }
    this._fenceConfigOp(controllerId, term, migrationId, m);
    if (m.phase === 'final') {
      throw new ClusterError(ERR.CONFLICT, `迁移 ${m.migrationId} 已完成最终切换，不能中止`, {
        phase: m.phase,
      });
    }

    const oldReach = m.oldVoters.filter((id) => this._reachable(id));
    if (oldReach.length < Cluster.majorityOf(m.oldVoters)) {
      throw new ClusterError(
        ERR.NO_MAJORITY,
        '旧名单多数节点不可达，无法确认回滚配置，迁移阶段与现役名单保持不变',
        { oldVoters: m.oldVoters, oldReachable: oldReach, oldMajority: Cluster.majorityOf(m.oldVoters) }
      );
    }

    const entry = {
      index: this.state.log.length + 1,
      term,
      kind: 'config',
      configOp: 'rollback',
      config: m.oldVoters.slice(),
      migrationId: m.migrationId,
      requestId: `mig:${m.migrationId}:rollback`,
      payload: ROLLBACK_PAYLOAD,
      ts: this.now(),
    };
    this.state.log.push(entry);
    const acked = this._replicateTo(m.oldVoters);
    this.state.committedIndex = entry.index;
    this.state.lastCommit = {
      index: entry.index,
      requestId: entry.requestId,
      confirmedBy: acked,
      configChange: true,
    };
    const aborted = m.migrationId;
    // 回到 C_old：本次联合配置期间没有节点真正退役，retiredNodes 维持原值。
    this.state.config = m.oldVoters.slice();
    this.state.migration = null;
    this._persist();
    return { status: 'aborted', duplicate: false, migrationId: aborted, config: this.state.config };
  }

  /** 配置类操作（finalize/abort）共用的栅栏校验。 */
  _fenceConfigOp(controllerId, term, migrationId, m) {
    if (!controllerId || typeof controllerId !== 'string') {
      throw new ClusterError(ERR.BAD_REQUEST, '缺少控制器标识 controllerId');
    }
    if (!Number.isInteger(term)) {
      throw new ClusterError(ERR.BAD_REQUEST, 'term 必须为整数');
    }
    if (migrationId && migrationId !== m.migrationId) {
      throw new ClusterError(ERR.CONFLICT, `进行中的迁移是 ${m.migrationId}，与请求标识 ${migrationId} 不一致`, {
        activeMigration: m.migrationId,
      });
    }
    if (term < this.state.activeTerm) {
      throw new ClusterError(ERR.FENCED_TERM, `任期 ${term} 已被现役任期 ${this.state.activeTerm} 栅栏隔离`, {
        activeTerm: this.state.activeTerm,
      });
    }
    if (term > this.state.activeTerm) {
      throw new ClusterError(ERR.UNKNOWN_TERM, `任期 ${term} 从未被授予`, { activeTerm: this.state.activeTerm });
    }
    if (this.state.leader !== controllerId) {
      throw new ClusterError(ERR.NOT_LEADER, `现役主控为 ${this.state.leader}`, { leader: this.state.leader });
    }
    if (!this._leaseValid()) {
      throw new ClusterError(ERR.LEASE_EXPIRED, '主控租约已失效，请重新申请任期后再操作迁移');
    }
  }

  _validateVoters(voters) {
    if (!Array.isArray(voters) || voters.length === 0) {
      throw new ClusterError(ERR.BAD_REQUEST, '目标投票节点集合 voters 必须为非空数组');
    }
    const known = new Set(this.state.nodes.map((n) => n.id));
    for (const id of voters) {
      if (typeof id !== 'string' || !known.has(id)) {
        throw new ClusterError(ERR.BAD_REQUEST, `目标投票节点 ${id} 不在编队中`, { voters });
      }
    }
    if (new Set(voters).size !== voters.length) {
      throw new ClusterError(ERR.BAD_REQUEST, '目标投票节点集合存在重复节点', { voters });
    }
    return voters.slice();
  }

  _migrationView(duplicate) {
    const m = this.state.migration;
    if (!m) return { status: 'aborted', duplicate, migrationId: null, config: this.state.config };
    return {
      status: m.phase === 'joint' ? 'joint' : 'final',
      duplicate,
      phase: m.phase,
      migrationId: m.migrationId,
      term: m.term,
      controllerId: m.controllerId,
      configIndex: m.configIndex,
      finalizeIndex: m.finalizeIndex,
      oldVoters: m.oldVoters,
      newVoters: m.newVoters,
      oldConfirmed: m.oldConfirmed,
      newConfirmed: m.newConfirmed,
      oldMajority: Cluster.majorityOf(m.oldVoters),
      newMajority: Cluster.majorityOf(m.newVoters),
      oldJointConfirmed: m.oldConfirmed.length >= Cluster.majorityOf(m.oldVoters),
      newJointConfirmed: m.newConfirmed.length >= Cluster.majorityOf(m.newVoters),
      retiredNodes: m.retiredNodes || [],
      // 现役名单：联合配置期间仍是旧名单，只有 final 完成后才切换。
      config: this.state.config,
    };
  }

  /** 完整状态快照：现役任期/投票名单/迁移阶段/各节点已接受指令序列。 */
  getState() {
    if (!this.initialized) return { initialized: false };
    const s = this.state;
    const m = s.migration;
    return {
      initialized: true,
      size: s.size,
      majority: this._majority(),
      config: s.config.slice(),
      retiredNodes: s.retiredNodes.slice(),
      activeTerm: s.activeTerm,
      leader: s.leader,
      leaseExpiresAt: s.leaseExpiresAt,
      leaseValid: this._leaseValid(),
      leaseRemainingMs: Math.max(0, s.leaseExpiresAt - this.now()),
      termQuorum: s.termQuorum,
      committedIndex: s.committedIndex,
      lastCommit: s.lastCommit,
      // 已提交序列只展示普通指令；配置条目（联合/最终/回滚）通过 migration 视图展示。
      committedSequence: s.log
        .slice(0, s.committedIndex)
        .filter((e) => (e.kind || 'command') === 'command'),
      migration: m
        ? {
            migrationId: m.migrationId,
            phase: m.phase,
            term: m.term,
            controllerId: m.controllerId,
            oldVoters: m.oldVoters,
            newVoters: m.newVoters,
            oldConfirmed: m.oldConfirmed,
            newConfirmed: m.newConfirmed,
            oldMajority: Cluster.majorityOf(m.oldVoters),
            newMajority: Cluster.majorityOf(m.newVoters),
            oldJointConfirmed: m.oldConfirmed.length >= Cluster.majorityOf(m.oldVoters),
            newJointConfirmed: m.newConfirmed.length >= Cluster.majorityOf(m.newVoters),
            configIndex: m.configIndex,
            finalizeIndex: m.finalizeIndex,
          }
        : null,
      nodes: s.nodes.map((n) => ({
        id: n.id,
        reachable: n.reachable,
        voter: s.config.includes(n.id),
        retired: s.retiredNodes.includes(n.id),
        inOldConfig: m ? m.oldVoters.includes(n.id) : false,
        inNewConfig: m ? m.newVoters.includes(n.id) : false,
        log: this._readNodeLog(n.id),
        commandLog: this._readNodeLog(n.id)
          .filter((e) => (e.kind || 'command') === 'command')
          .map((e) => e.requestId),
      })),
      now: this.now(),
    };
  }
}

module.exports = { Cluster, ClusterError, ERR };
