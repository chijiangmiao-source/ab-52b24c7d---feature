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
};

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
    // 崩溃恢复：可达节点按 canonical 日志收敛（截断未提交的分叉尾部、补齐缺失条目）。
    // 不可达节点保持原样，模拟分区仍在持续。
    for (const node of this.state.nodes) {
      if (node.reachable) this._reconcileNode(node.id);
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

  _majority() {
    return Math.floor(this.state.nodes.length / 2) + 1;
  }

  _leaseValid() {
    return this.state.leader !== null && this.now() < this.state.leaseExpiresAt;
  }

  _entriesEqual(a, b) {
    return !!a && !!b && a.requestId === b.requestId && a.payload === b.payload && a.term === b.term;
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

  _requireInit() {
    if (!this.initialized) throw new ClusterError(ERR.NO_CLUSTER, '编队尚未创建');
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
      activeTerm: 0,
      leader: null,
      leaseExpiresAt: 0,
      termQuorum: [],
      log: [],
      committedIndex: 0,
      lastCommit: null,
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
    if (reachable.length < this._majority()) {
      throw new ClusterError(
        ERR.NO_MAJORITY,
        `可达节点 ${reachable.length}/${this.state.nodes.length}，不足法定多数，拒绝授予任期`,
        { reachable: reachable.map((n) => n.id), majority: this._majority() }
      );
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
    this.state.termQuorum = reachable.map((n) => n.id);
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

  /** 设置节点可达性；恢复可达时立即追赶（按 canonical 收敛该节点日志）。 */
  setReachable(nodeId, reachable) {
    this._requireInit();
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) throw new ClusterError(ERR.BAD_REQUEST, `未知节点 ${nodeId}`);
    node.reachable = !!reachable;
    if (node.reachable) this._reconcileNode(nodeId);
    this._persist();
    return this.getState();
  }

  /**
   * 主控提交指令。
   * 栅栏顺序：旧任期 -> 未知任期 -> 非主控 -> 幂等判定 -> 租约有效性 -> 复制提交。
   * 幂等判定先于租约：已提交条目的重传永远返回原结论，不产生任何写动作。
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
      return this._resultFor(existing, true);
    }

    if (!this._leaseValid()) {
      throw new ClusterError(ERR.LEASE_EXPIRED, '主控租约已失效，旧任期只能追赶不能提交，请重新申请任期');
    }

    const entry = { index: this.state.log.length + 1, term, requestId, payload, ts: this.now() };
    this.state.log.push(entry);
    const confirmedBy = [];
    for (const node of this.state.nodes) {
      if (!node.reachable) continue;
      this._appendToNode(node.id, entry);
      confirmedBy.push(node.id);
    }
    if (confirmedBy.length >= this._majority()) {
      this.state.committedIndex = entry.index;
      this.state.lastCommit = { index: entry.index, requestId, confirmedBy };
    }
    // 先落盘再响应：多数确认后即使进程退出，重启仍能从持久态恢复 committed。
    this._persist();
    return this._resultFor(entry, false, confirmedBy);
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

  /** 完整状态快照：现役任期、法定确认节点、各节点已接受指令序列。 */
  getState() {
    if (!this.initialized) return { initialized: false };
    const s = this.state;
    return {
      initialized: true,
      size: s.size,
      majority: this._majority(),
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
        log: this._readNodeLog(n.id),
      })),
      now: this.now(),
    };
  }
}

module.exports = { Cluster, ClusterError, ERR };
