// Локальный сервер: страница с полем для ссылки + API, которое запускает grabber.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { grab } = require('./grabber');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.PASSWORD || '';
if (HOST !== '127.0.0.1' && !PASSWORD) {
  console.error('Для доступа снаружи задай пароль: PASSWORD=... HOST=0.0.0.0 node server.js');
  process.exit(1);
}
const OUT_DIR = path.join(__dirname, 'downloads');
const jobs = new Map();
let nextId = 1;

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (PASSWORD) {
      const given = Buffer.from((req.headers.authorization || '').slice(6), 'base64').toString();
      if (given.slice(given.indexOf(':') + 1) !== PASSWORD) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dplayer"' });
        return res.end('Нужен пароль');
      }
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'Неверный запрос' });
      }
      if (!/^https?:\/\//i.test(body.url || '')) return json(res, 400, { error: 'Нужна ссылка http(s)://...' });
      const wait = Math.min(Math.max(Number(body.wait) || 60, 5), 600);
      const id = String(nextId++);
      const job = { status: 'running', logs: [], progress: null, file: null, error: null };
      jobs.set(id, job);
      grab(body.url, {
        outDir: OUT_DIR,
        waitMs: wait * 1000,
        log: (m) => job.logs.push(m),
        onProgress: (done, total) => (job.progress = { done, total }),
      })
        .then((r) => {
          job.status = 'done';
          job.file = r.file;
        })
        .catch((e) => {
          job.status = 'error';
          job.error = e.message;
        });
      return json(res, 200, { id });
    }

    const m = url.pathname.match(/^\/api\/(status|file)\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[2]);
      if (!job) return json(res, 404, { error: 'Задача не найдена' });
      if (m[1] === 'status') {
        return json(res, 200, {
          status: job.status,
          logs: job.logs.slice(-30),
          progress: job.progress,
          error: job.error,
          name: job.file && path.basename(job.file),
        });
      }
      if (job.status !== 'done') return json(res, 409, { error: 'Ещё не готово' });
      const name = path.basename(job.file);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fs.statSync(job.file).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return fs.createReadStream(job.file).pipe(res);
    }

    json(res, 404, { error: 'Не найдено' });
  })
  .listen(PORT, HOST, () => console.log(`Открой в браузере: http://${HOST === '0.0.0.0' ? 'ВАШ_IP' : HOST}:${PORT}`));
