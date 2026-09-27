'use strict';

/**
 * HTTP 层：值班员控制台静态页 + 真实 REST 接口。
 *
 *   GET    /health                        健康路径（可配置宿主机端口映射）
 *   GET    /                              控制台页面
 *   GET    /api/state                     状态快照（现役任期/法定确认节点/各节点日志）
 *   POST   /api/cluster        {size}     创建 3-5 节点编队
 *   POST   /api/reset                     清空编队
 *   POST   /api/term           {controllerId}      申请/续期任期
 *   POST   /api/lease/revoke   {}         使租约失效
 *   POST   /api/nodes/:id/reachability {reachable} 设置节点可达性
 *   POST   /api/commands       {controllerId, term, requestId, payload, crash?}
 *                                        提交指令；crash=true 时在多数确认落盘后、
 *                                        响应前退出进程，模拟主控崩溃。
 *   POST   /api/migrations     {controllerId, term, migrationId, targetVoterIds, crash?}
 *                                        提交联合共识名单迁移（旧/新双名单多数确认）
 *   POST   /api/migrations/abort {controllerId, term}
 *                                        中止未获联合多数确认的在途迁移
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { Cluster, ClusterError } = require('./cluster');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LEASE_MS = parseInt(process.env.LEASE_MS || '60000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const cluster = new Cluster(DATA_DIR, { leaseMs: LEASE_MS });
const startedAt = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function sendError(res, err) {
  if (err instanceof ClusterError) {
    const status = { NO_MAJORITY: 503, BAD_REQUEST: 400, NO_CLUSTER: 400 }[err.code] || 409;
    sendJson(res, status, { error: { code: err.code, message: err.message, details: err.details } });
  } else {
    sendJson(res, 500, { error: { code: 'INTERNAL', message: String((err && err.message) || err) } });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      initialized: cluster.initialized,
      uptimeMs: Date.now() - startedAt,
    });
  }

  if (m === 'GET' && p === '/api/state') {
    return sendJson(res, 200, cluster.getState());
  }

  if (m === 'POST' && p === '/api/cluster') {
    const body = await readBody(req);
    return sendJson(res, 200, cluster.create(body.size));
  }

  if (m === 'POST' && p === '/api/reset') {
    return sendJson(res, 200, cluster.reset());
  }

  if (m === 'POST' && p === '/api/term') {
    const body = await readBody(req);
    return sendJson(res, 200, cluster.requestTerm(body.controllerId));
  }

  if (m === 'POST' && p === '/api/lease/revoke') {
    return sendJson(res, 200, cluster.revokeLease());
  }

  const reach = p.match(/^\/api\/nodes\/([A-Za-z0-9_-]+)\/reachability$/);
  if (m === 'POST' && reach) {
    const body = await readBody(req);
    return sendJson(res, 200, cluster.setReachable(reach[1], body.reachable));
  }

  if (m === 'POST' && p === '/api/commands') {
    const body = await readBody(req);
    const result = cluster.submit(body);
    if (body.crash === true) {
      // 多数确认已落盘、响应尚未发出：此刻退出进程，模拟主控崩溃。
      // 由容器重启策略（restart: on-failure）或外部守护拉起。
      setTimeout(() => process.exit(1), 50);
      return; // 故意不响应
    }
    return sendJson(res, result.status === 'committed' ? 200 : 202, result);
  }

  if (m === 'POST' && p === '/api/migrations') {
    const body = await readBody(req);
    const result = cluster.beginMigration(body);
    if (body.crash === true) {
      // 联合配置已持久落盘、响应尚未发出：此刻退出进程，演练「重启恢复唯一迁移阶段」。
      setTimeout(() => process.exit(1), 50);
      return; // 故意不响应
    }
    return sendJson(res, result.status === 'committed' ? 200 : 202, result);
  }

  if (m === 'POST' && p === '/api/migrations/abort') {
    const body = await readBody(req);
    return sendJson(res, 200, cluster.abortMigration(body));
  }

  if (m === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
  if (m === 'GET' && p === '/app.js') return serveStatic(res, 'app.js');
  if (m === 'GET' && p === '/style.css') return serveStatic(res, 'style.css');

  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `${m} ${p}` } });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    try {
      sendError(res, err);
    } catch (_) {
      /* 连接可能已断开 */
    }
  });
});

server.listen(PORT, () => {
  console.log(`[formation] 控制台与接口已就绪: http://0.0.0.0:${PORT} (DATA_DIR=${DATA_DIR}, LEASE_MS=${LEASE_MS})`);
});
