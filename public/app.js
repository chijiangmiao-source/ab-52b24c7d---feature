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
  nodes: $('nodes'),
  toast: $('toast'),
};

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
    els.committedSeq.innerHTML = '<span class="hint">尚未创建编队，请先在 ① 创建。</span>';
    els.nodes.innerHTML = '';
    return;
  }

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
      `<span class="hint">（#${state.lastCommit.index} ${escapeHtml(state.lastCommit.requestId)}）</span>`
    : chip('—', true);

  els.committedSeq.innerHTML = state.committedSequence.length
    ? state.committedSequence.map((e) => entryHtml(e, true)).join('')
    : '<span class="hint">暂无已提交指令</span>';

  els.nodes.innerHTML = state.nodes.map((n) => {
    const log = n.log.length
      ? n.log.map((e) => entryHtml(e, e.index <= state.committedIndex)).join('')
      : '<div class="empty">（空日志）</div>';
    return `<div class="node${n.reachable ? '' : ' down'}">
      <div class="node-head">
        <b>${n.id}</b>
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
    refreshState();
  } catch (e) {
    toast(`创建失败: ${e.message}`, true);
  }
});

els.reset.addEventListener('click', async () => {
  try {
    await api('/api/reset', 'POST', {});
    toast('编队已清空');
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

refreshState();
setInterval(refreshState, 2000);
