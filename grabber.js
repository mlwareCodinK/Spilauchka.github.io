// Достаёт видео со страницы с плеером DPlayer.
// Открывает страницу в чистом браузере (без куки), запускает воспроизведение,
// ждёт буферизации (по умолчанию 60 сек), ловит ссылку на видео и скачивает его.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const VIDEO_URL_RE = /\.(mp4|m3u8|webm|flv|mkv|mpd)(\?|#|$)/i;
const PLAYLIST_CT_RE = /mpegurl/i;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (s) =>
  (s || 'video').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video';

// Нажимаем play во всех фреймах: DPlayer часто лежит в iframe.
async function startPlayback(page) {
  for (const frame of page.frames()) {
    for (const sel of ['.dplayer-mobile-play', '.dplayer-play-icon', '.dplayer-video-wrap']) {
      try {
        await frame.click(sel, { timeout: 500, force: true });
        break;
      } catch {}
    }
    try {
      await frame.evaluate(() => {
        document.querySelectorAll('video').forEach((v) => {
          v.muted = true;
          v.play().catch(() => {});
        });
      });
    } catch {}
  }
}

async function domVideoSources(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const srcs = await frame.evaluate(() =>
        [...document.querySelectorAll('video')].flatMap((v) => [
          v.currentSrc,
          v.src,
          ...[...v.querySelectorAll('source')].map((s) => s.src),
        ])
      );
      for (const s of srcs) if (s && /^https?:/i.test(s)) out.push(s);
    } catch {}
  }
  return out;
}

function pickBest(cands) {
  const playlists = cands.filter((c) => c.kind === 'hls');
  if (playlists.length) {
    // мастер-плейлист (без номера качества) лучше: ffmpeg выберет лучшее качество сам
    return playlists.find((c) => !/(\d{3,4}p?)\.m3u8/i.test(c.url)) || playlists[0];
  }
  const files = cands.filter((c) => c.kind === 'file');
  files.sort((a, b) => (b.size || 0) - (a.size || 0));
  return files[0];
}

function kindOf(url, ct = '') {
  if (/\.m3u8(\?|#|$)/i.test(url) || PLAYLIST_CT_RE.test(ct)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
  return 'file';
}

async function downloadFile(url, headers, dest, log, onProgress) {
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} при скачивании ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    onProgress && onProgress(done, total);
  });
  await pipeline(body, fs.createWriteStream(dest));
  log(`Скачано ${(done / 1048576).toFixed(1)} МБ`);
}

function runFfmpeg(url, headers, dest, log) {
  return new Promise((resolve, reject) => {
    const hdr = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const args = ['-y', '-loglevel', 'error', '-stats', '-headers', hdr, '-i', url, '-c', 'copy'];
    if (dest.endsWith('.mp4')) args.push('-bsf:a', 'aac_adtstoasc');
    args.push(dest);
    const p = spawn('ffmpeg', args);
    p.stderr.on('data', (d) => {
      const m = String(d).match(/time=(\S+)/);
      if (m) log(`ffmpeg: ${m[1]}`);
    });
    p.on('error', (e) => reject(new Error('Не удалось запустить ffmpeg (он установлен?): ' + e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg завершился с кодом ' + code))));
  });
}

async function grab(pageUrl, opts = {}) {
  const {
    outDir = path.join(process.cwd(), 'downloads'),
    waitMs = 60000,
    log = console.log,
    onProgress,
    headless = true,
  } = opts;
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    // Новый контекст = чистый профиль без куки/кэша/localStorage
    const context = await browser.newContext({ userAgent: UA });
    await context.clearCookies();
    const page = await context.newPage();

    const cands = new Map();
    const add = (url, kind, size) => {
      if (!cands.has(url)) {
        cands.set(url, { url, kind, size });
        log(`Найдено (${kind}): ${url.slice(0, 120)}`);
      }
    };
    page.on('response', (res) => {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';
      if (/^(blob|data):/.test(url)) return;
      if (/\.(ts|m4s)(\?|#|$)/i.test(url)) return; // сегменты не нужны, нужен плейлист
      if (VIDEO_URL_RE.test(url) || /^video\//i.test(ct) || PLAYLIST_CT_RE.test(ct)) {
        const range = res.headers()['content-range'];
        const size = range ? Number(range.split('/')[1]) : Number(res.headers()['content-length']) || 0;
        add(url, kindOf(url, ct), size);
      }
    });

    log('Открываю страницу в чистом браузере (куки очищены)...');
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await page.title();

    const end = Date.now() + waitMs;
    let tick = 0;
    while (Date.now() < end) {
      if (tick % 5 === 0) await startPlayback(page);
      if (tick % 5 === 4) for (const s of await domVideoSources(page)) add(s, kindOf(s), 0);
      if (tick % 10 === 0) log(`Жду буферизацию: осталось ${Math.ceil((end - Date.now()) / 1000)} сек`);
      await sleep(1000);
      tick++;
    }
    for (const s of await domVideoSources(page)) add(s, kindOf(s), 0);

    const best = pickBest([...cands.values()]);
    if (!best) throw new Error('Видео не найдено. Попробуй увеличить время ожидания или проверь ссылку.');
    if (best.kind === 'dash') throw new Error('Найден DASH (.mpd) — такой формат пока не поддерживается.');

    const headers = { 'User-Agent': UA, Referer: pageUrl };
    const cookies = await context.cookies(best.url);
    if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const base = safeName(title);
    let dest;
    if (best.kind === 'hls') {
      dest = path.join(outDir, base + '.mp4');
      log('Скачиваю HLS-поток через ffmpeg...');
      try {
        await runFfmpeg(best.url, headers, dest, log);
      } catch (e) {
        log('mp4 не получился (' + e.message + '), пробую .ts');
        dest = path.join(outDir, base + '.ts');
        await runFfmpeg(best.url, headers, dest, log);
      }
    } else {
      const ext = (best.url.split('?')[0].match(/\.(\w{2,4})$/) || [, 'mp4'])[1];
      dest = path.join(outDir, `${base}.${ext}`);
      log('Скачиваю файл...');
      await downloadFile(best.url, headers, dest, log, onProgress);
    }
    log('Готово: ' + dest);
    return { file: dest, title, source: best.url };
  } finally {
    await browser.close(); // вместе с браузером уничтожается и весь профиль с куки
  }
}

module.exports = { grab };

if (require.main === module) {
  const [url, wait] = process.argv.slice(2);
  if (!url) {
    console.error('Использование: node grabber.js <ссылка на страницу> [секунд ожидания, по умолчанию 60]');
    process.exit(1);
  }
  grab(url, { waitMs: (Number(wait) || 60) * 1000 }).catch((e) => {
    console.error('Ошибка:', e.message);
    process.exit(1);
  });
}
