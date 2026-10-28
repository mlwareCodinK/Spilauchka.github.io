// Достаёт видео со страницы с плеером DPlayer.
// Открывает страницу в чистом браузере (без куки), запускает воспроизведение,
// ждёт буферизации (по умолчанию 60 сек), ловит ссылку на видео и скачивает его.
const fs = require('fs');
const path = require('path');
const { UA, sleep, safeName, downloadFile, downloadHls } = require('./common');
const { grabLite } = require('./lite');

const VIDEO_URL_RE = /\.(mp4|m3u8|webm|flv|mkv|mpd)(\?|#|$)/i;
const PLAYLIST_CT_RE = /mpegurl/i;
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

async function grab(pageUrl, opts = {}) {
  const {
    outDir = path.join(process.cwd(), 'downloads'),
    waitMs = 60000,
    log = console.log,
    onProgress,
    headless = true,
  } = opts;
  fs.mkdirSync(outDir, { recursive: true });

  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  } catch (e) {
    log('Браузер недоступен (' + e.message.split('\n')[0] + ') — работаю без браузера.');
    return grabLite(pageUrl, opts);
  }
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
    const seen = []; // для отладки: что вообще грузила страница
    page.on('response', async (res) => {
      const url = res.url();
      const h = res.headers();
      const ct = h['content-type'] || '';
      if (/^(blob|data):/.test(url)) return;
      const type = res.request().resourceType();
      if (seen.length < 60 && ['xhr', 'fetch', 'media', 'other'].includes(type)) seen.push(`${type} ${res.status()} ${ct.split(';')[0]} ${url.slice(0, 110)}`);
      if (/\.(ts|m4s)(\?|#|$)/i.test(url)) return; // сегменты не нужны, нужен плейлист
      const size = h['content-range'] ? Number(h['content-range'].split('/')[1]) : Number(h['content-length']) || 0;
      if (VIDEO_URL_RE.test(url) || /^video\//i.test(ct) || PLAYLIST_CT_RE.test(ct) || type === 'media') {
        add(url, kindOf(url, ct), size);
        return;
      }
      // плейлист без .m3u8 в адресе и с обычным content-type: смотрим на начало тела
      if (['xhr', 'fetch', 'other'].includes(type) && res.status() === 200 && size < 2e6 && !/image|font|css|javascript/i.test(ct)) {
        try {
          const body = await res.text();
          if (body.trimStart().startsWith('#EXTM3U')) add(url, 'hls', size);
        } catch {}
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
    if (!best) {
      log('--- Запросы страницы (для отладки) ---');
      seen.forEach((s) => log(s));
      throw new Error('Видео не найдено. Список запросов страницы выше в логе.');
    }
    if (best.kind === 'dash') throw new Error('Найден DASH (.mpd) — такой формат пока не поддерживается.');

    const headers = { 'User-Agent': UA, Referer: pageUrl };
    const cookies = await context.cookies(best.url);
    if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const base = safeName(title);
    let dest;
    if (best.kind === 'hls') {
      log('Скачиваю HLS-поток...');
      dest = await downloadHls(best.url, headers, outDir, base, log);
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
