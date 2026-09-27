'use strict';

/* 控制台前端：全部数据经真实 REST 接口读写，2s 轮询 + 手动刷新。 */

const $ = (id) => document.getElementById(id);
const els = {
  health: $('health-badge'),
  term: $('term-badge'),
  leader: $('leader-badge'),
  size: $('cluster-size'),
  create: $('btn-create'),
  reset: $('btn-reset'),
  controller: $('controller-id'),
  termBtn: $('btn-term'),
  revoke: $('btn-revoke'),
  leaseState: $('lease-state'),
  leaseRemaining: $('lease-remaining'),
  termQuorum: $('term-quorum'),
  cmdTerm: $('cmd-term'),
  cmdRequestId: $('cmd-request-id'),
  cmdPayload: $('cmd-payload'),
  cmdCrash: $('cmd-crash'),
  submit: $('btn-submit'),
  result: $('cmd-result'),
  refresh: $('btn-refresh'),
  committedIndex: $('committed-index'),
  lastCommit: $('last-commit'),
  committedSeq: $('committed-seq'),
  activeConfig: $('active-config'),
  retiredNodes: $('retired-nodes'),
  nodes: $('nodes'),
  toast: $('toast'),
  migId: $('mig-id'),
  migTarget: $('mig-target'),
  migPhase: $('mig-phase'),
  migOldVoters: $('mig-old-voters'),
  migNewVoters: $('mig-new-voters'),
  migOldConfirmed: $('mig-old-confirmed'),
  migNewConfirmed: $('mig-new-confirmed'),
  migOldMajority: $('mig-old-majority'),
  migNewMajority: $('mig-new-majority'),
  migBegin: $('btn-mig-begin'),
  migFinalize: $('btn-mig-finalize'),
  migAbort: $('btn-mig-abort'),
  migResult: $('mig-result'),
};

let lastState = null;

let toastTimer = null;
function toast(msg, isErr) {
  els.toast.textContent = msg;
  els.toast.className = isErr ? 'toast err' : 'toast';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 4200);
}

async function api(path, method, body) {
  const opts = { method: method || 'GET', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data.error && data.error.message) || `HTTP ${res.status}`);
    e.status = res.status;
    e.code = data.error && data.error.code;
    e.data = data;
    throw e;
  }
  return data;
}

function chip(text, muted) {
  return `<span class="chip${muted ? ' muted' : ''}">${text}</span>`;
}

function entryHtml(e, committed) {
  const ts = e.ts ? new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  return `<div class="entry${committed ? '' : ' pending'}">
    <span class="idx">#${e.index}</span>
    <span class="rid">${escapeHtml(e.requestId)}</span>
    <span class="pl">${escapeHtml(e.payload)}</span>
    <span class="tm">T${e.term} ${committed ? '已提交' : '未提交'} ${ts}</span>
  </div>`;
}

const CONFIG_LABEL = { joint: '联合配置 C_old,new', final: '最终配置 C_new', rollback: '回滚配置 C_old' };
function configEntryHtml(e) {
  const ts = e.ts ? new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  const list = e.configOp === 'joint'
    ? `旧 ${e.oldVoters.join('/')} → 新 ${e.newVoters.join('/')}`
    : `名单 ${(e.config || []).join('/')}`;
  return `<div class="entry config">
    <span class="idx">#${e.index}</span>
    <span class="rid cfg">⚙ ${CONFIG_LABEL[e.configOp] || '配置'}</span>
    <span class="pl">${escapeHtml(list)}</span>
    <span class="tm">T${e.term} ${escapeHtml(e.migrationId || '')} ${ts}</span>
  </div>`;
}

function confirmedChips(all, confirmed) {
  const set = new Set(confirmed || []);
  return all.map((id) =>
    set.has(id) ? chip(`${id} ✓`) : `<span class="chip muted">${id} ○</span>`).join('');
}

let targetSelection = null; // 勾选的目标投票节点；null 表示尚未初始化

function renderTargetSelector(state) {
  if (!state) return;
  const selectable = state.nodes.map((n) => n.id);
  if (targetSelection === null || !targetSelection.every((id) => selectable.includes(id))) {
    // 默认选中当前现役名单（编队重建后旧选择含已不存在的节点时也重置）
    targetSelection = state.config.slice();
  }
  els.migTarget.innerHTML = state.nodes.map((n) => {
    const on = targetSelection.includes(n.id);
    const cls = `pick${on ? ' on' : ''}${n.retired ? ' retired' : ''}`;
    return `<button type="button" class="${cls}" data-voter="${n.id}">${n.id}${
      n.retired ? '（已退役）' : ''
    }${on ? ' ✓' : ''}</button>`;
  }).join('');
  els.migTarget.querySelectorAll('.pick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.voter;
      if (targetSelection.includes(id)) targetSelection = targetSelection.filter((x) => x !== id);
      else targetSelection.push(id);
      renderTargetSelector(lastState);
    });
  });
}

function renderMigration(mig) {
  renderTargetSelector(lastState);
  if (!mig) {
    els.migPhase.textContent = '无进行中迁移';
    els.migPhase.style.color = 'var(--muted)';
    els.migOldVoters.innerHTML = chip('—', true);
    els.migNewVoters.innerHTML = chip('—', true);
    els.migOldConfirmed.innerHTML = chip('—', true);
    els.migNewConfirmed.innerHTML = chip('—', true);
    els.migOldMajority.textContent = '';
    els.migNewMajority.textContent = '';
    els.migFinalize.disabled = true;
    els.migAbort.disabled = true;
    els.migBegin.disabled = false;
    return;
  }
  const phaseText = mig.phase === 'joint' ? '联合配置 C_old,new（双名单确认中）' : '最终配置 C_new（已切换，可用新标识发起下一次迁移）';
  els.migPhase.textContent = phaseText;
  els.migPhase.style.color = mig.phase === 'joint' ? 'var(--warn)' : 'var(--ok)';
  els.migOldMajority.textContent = `（多数 ${mig.oldMajority}，已确认 ${mig.oldConfirmed.length}）`;
  els.migNewMajority.textContent = `（多数 ${mig.newMajority}，已确认 ${mig.newConfirmed.length}）`;
  els.migOldVoters.innerHTML = mig.oldVoters.map((id) =>
    mig.oldConfirmed.includes(id) ? chip(`${id} ✓`) : `<span class="chip muted">${id} ○</span>`).join('');
  els.migNewVoters.innerHTML = mig.newVoters.map((id) =>
    mig.newConfirmed.includes(id) ? chip(`${id} ✓`) : `<span class="chip muted">${id} ○</span>`).join('');
  els.migOldConfirmed.innerHTML = confirmedChips(mig.oldVoters, mig.oldConfirmed);
  els.migNewConfirmed.innerHTML = confirmedChips(mig.newVoters, mig.newConfirmed);
  const jointDone = mig.oldJointConfirmed && mig.newJointConfirmed;
  els.migFinalize.disabled = mig.phase !== 'joint' || !jointDone;
  els.migAbort.disabled = mig.phase !== 'joint';
  // 最终阶段是既成事实：允许用新的稳定标识发起下一次迁移。
  els.migBegin.disabled = false;
  // 联合阶段自动带出进行中的迁移标识；最终阶段不覆盖操作员为下一次迁移输入的新标识。
  if (mig.phase === 'joint' && !els.migId.value) els.migId.value = mig.migrationId;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function refreshState() {
  let state;
  try {
    state = await api('/api/state');
    els.health.textContent = '健康: 正常';
    els.health.className = 'badge badge-ok';
  } catch (e) {
    els.health.textContent = '健康: 异常';
    els.health.className = 'badge badge-bad';
    return;
  }

  if (!state.initialized) {
    els.term.textContent = '现役任期: —';
    els.leader.textContent = '主控: —';
    els.leaseState.textContent = '—';
    els.leaseRemaining.textContent = '—';
    els.termQuorum.innerHTML = chip('未创建编队', true);
    els.committedIndex.textContent = '—';
    els.lastCommit.innerHTML = chip('—', true);
    els.activeConfig.innerHTML = chip('—', true);
    els.retiredNodes.innerHTML = chip('—', true);
    els.committedSeq.innerHTML = '<span class="hint">尚未创建编队，请先在 ① 创建。</span>';
    lastState = null;
    renderMigration(null);
    els.nodes.innerHTML = '';
    return;
  }

  lastState = state;

  els.term.textContent = `现役任期: ${state.activeTerm}`;
  els.leader.textContent = `主控: ${state.leader || '—'}`;
  els.leader.className = state.leaseValid ? 'badge badge-ok' : 'badge badge-muted';
  els.leaseState.textContent = state.leaseValid ? '有效' : '已失效';
  els.leaseState.style.color = state.leaseValid ? 'var(--ok)' : 'var(--danger)';
  els.leaseRemaining.textContent = state.leaseValid ? `${(state.leaseRemainingMs / 1000).toFixed(1)} s` : '—';
  els.termQuorum.innerHTML = state.termQuorum.length
    ? state.termQuorum.map((n) => chip(n)).join('')
    : chip('—', true);

  els.committedIndex.textContent = `#${state.committedIndex}`;
  els.lastCommit.innerHTML = state.lastCommit
    ? state.lastCommit.confirmedBy.map((n) => chip(n)).join('') +
      `<span class="hint">（#${state.lastCommit.index} ${escapeHtml(state.lastCommit.requestId)}${
        state.lastCommit.configChange ? ' · 配置' : ''
      }）</span>`
    : chip('—', true);

  els.activeConfig.innerHTML = state.config.length
    ? state.config.map((n) => chip(n)).join('')
    : chip('—', true);
  els.retiredNodes.innerHTML = state.retiredNodes.length
    ? state.retiredNodes.map((n) => `<span class="chip muted">${n} 已退役</span>`).join('')
    : chip('无', true);

  els.committedSeq.innerHTML = state.committedSequence.length
    ? state.committedSequence.map((e) => entryHtml(e, true)).join('')
    : '<span class="hint">暂无已提交指令</span>';

  renderMigration(state.migration);

  els.nodes.innerHTML = state.nodes.map((n) => {
    const tags = [];
    if (n.retired) tags.push('<span class="tag tag-retired">已退役</span>');
    else if (n.voter) tags.push('<span class="tag tag-voter">投票</span>');
    else tags.push('<span class="tag tag-muted">非投票</span>');
    if (n.inOldConfig) tags.push('<span class="tag tag-old">旧名单</span>');
    if (n.inNewConfig) tags.push('<span class="tag tag-new">新名单</span>');
    const log = n.log.length
      ? n.log.map((e) => (e.kind === 'config' ? configEntryHtml(e, e.index <= state.committedIndex)
        : entryHtml(e, e.index <= state.committedIndex))).join('')
      : '<div class="empty">（空日志）</div>';
    return `<div class="node${n.reachable ? '' : ' down'}">
      <div class="node-head">
        <b>${n.id}</b>
        <span class="node-tags">${tags.join('')}</span>
        <label class="switch" title="可达性">
          <input type="checkbox" data-node="${n.id}" ${n.reachable ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>
      ${log}
    </div>`;
  }).join('');

  els.nodes.querySelectorAll('input[type=checkbox]').forEach((box) => {
    box.addEventListener('change', async () => {
      try {
        await api(`/api/nodes/${box.dataset.node}/reachability`, 'POST', { reachable: box.checked });
        toast(`节点 ${box.dataset.node} 已${box.checked ? '恢复可达（触发追赶）' : '置为不可达'}`);
        refreshState();
      } catch (e) {
        toast(`设置可达性失败: ${e.message}`, true);
        box.checked = !box.checked;
      }
    });
  });

  if (!els.cmdTerm.value) els.cmdTerm.value = state.activeTerm;
}

function showResult(data, isErr) {
  els.result.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  els.result.className = isErr ? 'result err' : 'result ok';
}

els.create.addEventListener('click', async () => {
  try {
    await api('/api/cluster', 'POST', { size: parseInt(els.size.value, 10) });
    toast(`已创建 ${els.size.value} 节点编队`);
    els.cmdTerm.value = '';
    els.migId.value = '';
    targetSelection = null;
    showMigResult('—', false);
    refreshState();
  } catch (e) {
    toast(`创建失败: ${e.message}`, true);
  }
});

els.reset.addEventListener('click', async () => {
  try {
    await api('/api/reset', 'POST', {});
    toast('编队已清空');
    els.migId.value = '';
    targetSelection = null;
    showMigResult('—', false);
    refreshState();
  } catch (e) {
    toast(`清空失败: ${e.message}`, true);
  }
});

els.termBtn.addEventListener('click', async () => {
  try {
    const r = await api('/api/term', 'POST', { controllerId: els.controller.value.trim() });
    els.cmdTerm.value = r.term;
    toast(r.renewed ? `任期 ${r.term} 已续期` : `获得任期 ${r.term}，法定节点: ${r.quorum.join(', ')}`);
    refreshState();
  } catch (e) {
    toast(`申请任期失败: ${e.message}`, true);
  }
});

els.revoke.addEventListener('click', async () => {
  try {
    await api('/api/lease/revoke', 'POST', {});
    toast('租约已失效');
    refreshState();
  } catch (e) {
    toast(`操作失败: ${e.message}`, true);
  }
});

els.submit.addEventListener('click', async () => {
  const body = {
    controllerId: els.controller.value.trim(),
    term: parseInt(els.cmdTerm.value, 10),
    requestId: els.cmdRequestId.value.trim(),
    payload: els.cmdPayload.value,
    crash: els.cmdCrash.checked,
  };
  try {
    const r = await api('/api/commands', 'POST', body);
    showResult(r, false);
    toast(r.duplicate ? `重传去重：#${r.index}（原结论 ${r.status}）` : `指令 #${r.index} ${r.status}`);
  } catch (e) {
    if (e instanceof TypeError && body.crash) {
      showResult('多数确认后进程已退出（模拟崩溃），请等待重启后刷新查看已提交状态', false);
    } else {
      showResult(e.data ? e.data : e.message, true);
      toast(`提交被拒: ${e.message}`, true);
    }
  }
  refreshState();
});

els.refresh.addEventListener('click', refreshState);

function controllerAndTerm() {
  return { controllerId: els.controller.value.trim(), term: parseInt(els.cmdTerm.value, 10) };
}

function showMigResult(data, isErr) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  els.migResult.textContent = text;
  els.migResult.className = isErr ? 'result err' : (text === '—' ? 'result' : 'result ok');
}

els.migBegin.addEventListener('click', async () => {
  const body = {
    ...controllerAndTerm(),
    migrationId: els.migId.value.trim(),
    voters: targetSelection || [],
  };
  if (!body.migrationId) {
    toast('请填写稳定迁移标识', true);
    return;
  }
  if (!body.voters.length) {
    toast('请至少选择一个目标投票节点', true);
    return;
  }
  try {
    const r = await api('/api/migrations', 'POST', body);
    showMigResult(r, false);
    toast(`迁移 ${r.migrationId} 已进入联合配置：旧名单 ${r.oldConfirmed.length}/${r.oldVoters.length}、新名单 ${r.newConfirmed.length}/${r.newVoters.length} 确认`);
  } catch (e) {
    showMigResult(e.data ? e.data : e.message, true);
    toast(`迁移被拒: ${e.message}`, true);
  }
  refreshState();
});

els.migFinalize.addEventListener('click', async () => {
  const mig = lastState && lastState.migration;
  if (!mig) return;
  try {
    const r = await api(`/api/migrations/${encodeURIComponent(mig.migrationId)}/finalize`, 'POST',
      controllerAndTerm());
    showMigResult(r, false);
    els.migId.value = ''; // 下一次迁移需要新的稳定标识
    toast(`最终名单已切换：${r.newVoters.join(', ')}；退役：${(r.retiredNodes || []).join(', ') || '无'}`);
  } catch (e) {
    showMigResult(e.data ? e.data : e.message, true);
    toast(`最终切换被拒: ${e.message}`, true);
  }
  refreshState();
});

els.migAbort.addEventListener('click', async () => {
  const mig = lastState && lastState.migration;
  if (!mig) return;
  try {
    const r = await api(`/api/migrations/${encodeURIComponent(mig.migrationId)}/abort`, 'POST',
      controllerAndTerm());
    showMigResult(r, false);
    els.migId.value = '';
    toast(`迁移已中止，现役名单回到 ${r.config.join(', ')}`);
  } catch (e) {
    showMigResult(e.data ? e.data : e.message, true);
    toast(`中止失败: ${e.message}`, true);
  }
  refreshState();
});

refreshState();
setInterval(refreshState, 2000);
