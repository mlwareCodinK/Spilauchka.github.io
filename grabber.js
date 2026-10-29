// Достаёт видео со страницы с плеером DPlayer.
// Открывает страницу в чистом браузере (без куки), запускает воспроизведение,
// ждёт буферизации (по умолчанию 60 сек), ловит ссылку на видео и скачивает его.
const fs = require('fs');
const path = require('path');
const { UA, sleep, safeName, downloadFile, downloadHls, grabDirect, isDirectVideoUrl, tsOffset, remuxToMp4 } = require('./common');
const { grabLite } = require('./lite');

const VIDEO_URL_RE = /\.(mp4|m3u8|webm|flv|mkv|mpd)(\?|#|$)|\/m3u8?(\/|\?|$)/i;
const PLAYLIST_CT_RE = /mpegurl/i;
// Слайдер-проверка («拖拽滑块验证» и подобные): ищем ползунок и протягиваем до края дорожки.
async function findSlider(frame, custom) {
  return frame
    .evaluate((custom) => {
      document.querySelectorAll('[data-dl-handle],[data-dl-track]').forEach((e) => {
        e.removeAttribute('data-dl-handle');
        e.removeAttribute('data-dl-track');
      });
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      };
      const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && el.className.toString() ? '.' + el.className.toString().trim().split(/\s+/).join('.') : '');
      const textRe = /拖|滑块|滑動|滑动|验证|驗證|slide|drag|swipe|unlock|verify/i;
      const clsRe = /slid|drag|swipe|unlock|verif|captcha|track|handle|knob|thumb/i;
      const all = [...document.querySelectorAll('body *')].filter(visible);
      let tracks;
      if (custom) {
        const t = document.querySelector(custom);
        if (!t) return null;
        tracks = [t];
      } else {
        tracks = all.filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 150 || r.width > 900 || r.height < 28 || r.height > 130 || r.width / r.height < 3) return false;
          const hay = (el.innerText || '').slice(0, 40) + ' ' + el.id + ' ' + el.className;
          return textRe.test(hay) || clsRe.test(hay);
        });
        // самая внутренняя дорожка не нужна: берём наибольшую по площади из подходящих
        tracks.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
      }
      for (const track of tracks) {
        const tr = track.getBoundingClientRect();
        const root = track.parentElement && track.parentElement.parentElement ? track.parentElement.parentElement : document.body;
        const cands = [...root.querySelectorAll('*')].filter((el) => {
          if (el === track || !visible(el)) return false;
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          return (
            r.width >= 24 && r.width <= 140 && r.width / r.height > 0.6 && r.width / r.height < 1.6 &&
            r.height >= tr.height * 0.55 && r.height <= tr.height * 1.4 &&
            cx < tr.left + tr.width * 0.35 && cx > tr.left - 10 && Math.abs(r.top + r.height / 2 - (tr.top + tr.height / 2)) < tr.height
          );
        });
        const score = (el) => (/grab|pointer|move/.test(getComputedStyle(el).cursor) ? 2 : 0) + (clsRe.test(el.className + ' ' + el.id) ? 1 : 0);
        cands.sort((a, b) => score(b) - score(a));
        const handle = custom ? track : cands[0];
        if (handle) {
          handle.setAttribute('data-dl-handle', '1');
          track.setAttribute('data-dl-track', '1');
          return { handle: desc(handle), track: desc(track) };
        }
      }
      // запасной вариант: обычный <input type=range>
      const range = [...document.querySelectorAll('input[type=range]')].find(visible);
      if (range) {
        range.value = range.max || 100;
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
        return { range: true };
      }
      return null;
    }, custom || '')
    .catch(() => null);
}

// Плавное протягивание от точки до точки: мышью или настоящим касанием (через CDP).
async function dragBetween(page, context, x0, y0, x1, y1, useTouch) {
  const pts = [];
  for (let i = 1; i <= 30; i++) {
    const p = i / 30;
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    pts.push([x0 + (x1 - x0) * ease, y0 + (y1 - y0) * ease + (Math.random() - 0.5) * 2]);
  }
  if (!useTouch) {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (const [x, y] of pts) {
      await page.mouse.move(x, y);
      await sleep(15 + Math.random() * 15);
    }
    await page.mouse.up();
    return;
  }
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', x0, y0);
  for (const [x, y] of pts) {
    await touch('touchMove', x, y);
    await sleep(15 + Math.random() * 15);
  }
  await touch('touchEnd', x1, y1);
}

// Команда, присланная из веб-формы: протянуть или кликнуть по координатам скриншота.
async function runCommand(page, context, c, log) {
  const r = (n) => Math.round(n);
  if (c.type === 'click') {
    log(`Команда: клик (${r(c.x0)}, ${r(c.y0)})`);
    await page.mouse.click(c.x0, c.y0);
  } else {
    log(`Команда: протянуть (${r(c.x0)}, ${r(c.y0)}) → (${r(c.x1)}, ${r(c.y1)})${c.touch ? ' касанием' : ''}`);
    await dragBetween(page, context, c.x0, c.y0, c.x1, c.y1, !!c.touch);
  }
}

async function dragSlider(page, context, frame, log) {
  const h = await frame.$('[data-dl-handle]');
  const t = await frame.$('[data-dl-track]');
  if (!h || !t) return false;
  const hb = await h.boundingBox();
  const tb = await t.boundingBox();
  if (!hb || !tb) return false;
  const y = hb.y + hb.height / 2;
  const x0 = hb.x + hb.width / 2;
  const x1 = tb.x + tb.width - hb.width / 2 - 1;
  const dist = x1 - x0;
  const moved = async () => {
    const after = await h.boundingBox().catch(() => null);
    return !after || after.x + after.width / 2 - x0 > dist * 0.6 || !(await h.isVisible().catch(() => false));
  };
  await dragBetween(page, context, x0, y, x1, y, false);
  await sleep(700);
  if (await moved()) return true;
  log('Мышью не вышло, пробую касанием...');
  await dragBetween(page, context, x0, y, x1, y, true);
  await sleep(700);
  return moved();
}

async function solveSlider(page, context, log, custom) {
  for (const frame of page.frames()) {
    const found = await findSlider(frame, custom);
    if (!found) continue;
    log(`Нашёл слайдер: ползунок ${found.handle || 'range'}, дорожка ${found.track || '-'}`);
    if (found.range) return true;
    try {
      const ok = await dragSlider(page, context, frame, log);
      log(ok ? 'Слайдер пройден.' : 'Слайдер не поддался, попробую ещё раз.');
      return ok;
    } catch (e) {
      log('Ошибка при протягивании слайдера: ' + e.message.split('\n')[0]);
    }
  }
  return false;
}

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

// Крутим видео на максимальной скорости, чтобы плеер быстро подгрузил все куски.
async function boostPlayback(page) {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        document.querySelectorAll('video').forEach((v) => {
          v.muted = true;
          v.playbackRate = 16;
          if (v.paused && !v.ended) v.play().catch(() => {});
        });
      })
      .catch(() => {});
  }
}

async function videoState(page) {
  let any = null;
  for (const frame of page.frames()) {
    const st = await frame
      .evaluate(() => {
        const v = [...document.querySelectorAll('video')].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
        return v ? { t: v.currentTime, d: v.duration, ended: v.ended } : null;
      })
      .catch(() => null);
    if (st && (!any || (st.d || 0) > (any.d || 0))) any = st;
  }
  return any;
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
  if (/\.m3u8(\?|#|$)|\/m3u8?(\/|\?|$)/i.test(url) || PLAYLIST_CT_RE.test(ct)) return 'hls';
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
    sliderSelector = '',
    referer, // (только для прямой ссылки) с какого адреса якобы грузим видео
    onShot, // (jpegBuffer) => void — отдаёт кадры страницы в веб-форму
    recordSegments = false, // ловить и склеивать куски видео, пока оно играет
    recordIdleMs = 30000, // сколько ждать новых кусков до остановки записи
    takeCommands, // () => [{type,x0,y0,x1,y1,touch}] — ручные команды из веб-формы
  } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  if (isDirectVideoUrl(pageUrl)) return grabDirect(pageUrl, { outDir, log, onProgress, referer });

  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  } catch (e) {
    log('Браузер недоступен (' + e.message.split('\n')[0] + ') — работаю без браузера.');
    return grabLite(pageUrl, opts);
  }
  let partsDir = null; // временная папка с записанными кусками
  try {
    // Новый контекст = чистый профиль без куки/кэша/localStorage
    const context = await browser.newContext({ userAgent: UA, hasTouch: true, viewport: { width: 1280, height: 720 } });
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
    // --- запись кусков видео (MPEG-TS) по мере того, как их грузит плеер ---
    const SEG_TYPES = ['xhr', 'fetch', 'other'];
    const segUrls = new Set();
    const reqSeq = new Map();
    let seqCounter = 0;
    let segCount = 0;
    let segBytes = 0;
    page.on('request', (r) => {
      if (SEG_TYPES.includes(r.resourceType())) reqSeq.set(r, ++seqCounter);
    });
    const captureSegment = async (res, url, ct) => {
      if (segUrls.has(url) || /m3u8|mpegurl/i.test(url + ct)) return false;
      const len = Number(res.headers()['content-length']) || 0;
      if (len && (len < 4000 || len > 80e6)) return false;
      try {
        let buf = await res.body();
        // Chromium портит двоичный ответ, если сайт отдал его с «текстовым» типом: перекачиваем куски заново
        const h = res.headers();
        const clen = Number(h['content-length']) || 0;
        if ((clen && !h['content-encoding'] && buf.length !== clen) || /^text\//i.test(ct)) {
          const again = await context.request.get(url, { headers: { Referer: page.url() }, timeout: 30000 }).catch(() => null);
          if (again && again.ok()) buf = await again.body();
        }
        const off = tsOffset(buf);
        if (off < 0) return false;
        segUrls.add(url);
        if (!partsDir) {
          partsDir = path.join(outDir, '.parts-' + Date.now());
          fs.mkdirSync(partsDir, { recursive: true });
        }
        const seq = reqSeq.get(res.request()) || ++seqCounter;
        fs.writeFileSync(path.join(partsDir, String(seq).padStart(8, '0') + '.ts'), buf.subarray(off));
        segCount++;
        segBytes += buf.length - off;
        lastSegAt = Date.now();
        if (segCount === 1) log('Плеер грузит куски видео — записываю их.');
        return true;
      } catch {
        return false;
      }
    };
    let lastSegAt = Date.now();
    page.on('response', async (res) => {
      const url = res.url();
      const h = res.headers();
      const ct = h['content-type'] || '';
      if (/^(blob|data):/.test(url)) return;
      const type = res.request().resourceType();
      if (seen.length < 60 && ['xhr', 'fetch', 'media', 'other'].includes(type)) seen.push(`${type} ${res.status()} ${ct.split(';')[0]} ${url.slice(0, 110)}`);
      if (SEG_TYPES.includes(type) && [200, 206].includes(res.status()) && (await captureSegment(res, url, ct))) return;
      if (/\.(ts|m4s)(\?|#|$)/i.test(url)) return; // сегменты в плейлист-режиме не нужны
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
    // диагностика в лог: почему страница может быть пустой
    let problems = 0;
    page.on('requestfailed', (r) => {
      if (problems++ < 12) log(`Не загрузилось: ${r.url().slice(0, 100)} — ${r.failure() && r.failure().errorText}`);
    });
    page.on('pageerror', (e) => {
      if (problems++ < 12) log('Ошибка скрипта на странице: ' + String(e.message).slice(0, 150));
    });
    try {
      const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      log(`Ответ сайта: HTTP ${resp ? resp.status() : '?'}, адрес: ${page.url().slice(0, 100)}`);
    } catch (e) {
      log('Страница не загрузилась полностью: ' + e.message.split('\n')[0]);
    }
    const title = await page.title().catch(() => '');
    log(`Заголовок страницы: "${title}"`);
    const probe = async (label) => {
      const info = await page
        .evaluate(() => ({ text: (document.body && document.body.innerText.trim().length) || 0, els: document.querySelectorAll('*').length, frames: document.querySelectorAll('iframe').length, videos: document.querySelectorAll('video').length }))
        .catch(() => null);
      if (info) log(`${label}: текста ${info.text} симв., элементов ${info.els}, iframe ${info.frames}, video ${info.videos}`);
    };

    let end = Date.now() + waitMs;
    let tick = 0;
    let sliderDone = false;
    let sliderTries = 0;
    // ручные команды из веб-формы; true, если что-то выполнили
    const handleCommands = async () => {
      let did = false;
      for (const c of (takeCommands && takeCommands()) || []) {
        try {
          await runCommand(page, context, c, log);
          did = true;
          sliderDone = true; // раз руками что-то сделали, автоподбор больше не лезет
          await sleep(800);
          await startPlayback(page);
        } catch (e) {
          log('Ошибка команды: ' + e.message.split('\n')[0]);
        }
      }
      return did;
    };
    const shoot = async () => {
      if (!onShot) return;
      const shot = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 4000 }).catch(() => null);
      if (shot) onShot(shot);
    };
    while (Date.now() < end) {
      if (await handleCommands()) {
        end = Date.now() + waitMs; // после ручного действия ждём буферизацию заново
        log(`Жду буферизацию ${Math.round(waitMs / 1000)} сек после действия`);
      }
      if (!sliderDone && sliderTries < 8 && tick % 3 === 1) {
        sliderDone = await solveSlider(page, context, log, sliderSelector);
        if (sliderDone) await startPlayback(page);
        else {
          sliderTries++;
          log(`Слайдер автоматически не найден (попытка ${sliderTries}/8) — можно протянуть вручную на скриншоте`);
        }
      }
      if (tick === 4 || tick === 15) await probe('Состояние страницы');
      await shoot();
      if (tick % 5 === 0) await startPlayback(page);
      if (tick % 5 === 4) for (const s of await domVideoSources(page)) add(s, kindOf(s), 0);
      if (tick % 10 === 0) log(`Жду буферизацию: осталось ${Math.ceil((end - Date.now()) / 1000)} сек`);
      await sleep(1000);
      tick++;
    }
    for (const s of await domVideoSources(page)) add(s, kindOf(s), 0);

    const best = pickBest([...cands.values()]);
    const base = safeName(title);

    if (segCount > 0 && (recordSegments || !best)) {
      log('Записываю куски, пока видео играет (воспроизведение ускорено)...');
      const cap = Date.now() + (Number(process.env.MAX_RECORD_MIN) || 60) * 60000;
      let lastCount = -1;
      let idleSince = Date.now();
      let rt = 0;
      while (Date.now() < cap) {
        await handleCommands();
        await boostPlayback(page);
        const st = await videoState(page);
        if (segCount !== lastCount) {
          lastCount = segCount;
          idleSince = Date.now();
        }
        if (rt % 5 === 0) {
          const pos = st && isFinite(st.d) ? `, видео ${Math.round(st.t)}/${Math.round(st.d)} сек` : '';
          log(`Куски: ${segCount} (${(segBytes / 1048576).toFixed(1)} МБ)${pos}`);
        }
        const finished = st && (st.ended || (isFinite(st.d) && st.d > 0 && st.t >= st.d - 1));
        if (finished && Date.now() - idleSince > 4000) break;
        if (Date.now() - idleSince > recordIdleMs) {
          log('Новых кусков нет — заканчиваю запись.');
          break;
        }
        await shoot();
        await sleep(1000);
        rt++;
      }
      const files = fs.readdirSync(partsDir).sort();
      const ts = path.join(outDir, base + '.ts');
      const out = fs.createWriteStream(ts);
      for (const f of files) {
        if (!out.write(fs.readFileSync(path.join(partsDir, f)))) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((r) => out.end(r));
      let dest = ts;
      const mp4 = path.join(outDir, base + '.mp4');
      if (await remuxToMp4(ts, mp4, log)) {
        fs.rmSync(ts, { force: true });
        dest = mp4;
      }
      log(`Склеено кусков: ${files.length}. Готово: ${dest}`);
      return { file: dest, title, source: 'segments' };
    }

    if (!best) {
      log('--- Запросы страницы (для отладки) ---');
      seen.forEach((s) => log(s));
      throw new Error('Видео не найдено. Список запросов страницы выше в логе.');
    }
    if (best.kind === 'dash') throw new Error('Найден DASH (.mpd) — такой формат пока не поддерживается.');

    const headers = { 'User-Agent': UA, Referer: pageUrl };
    const cookies = await context.cookies(best.url);
    if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

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
    if (partsDir) fs.rmSync(partsDir, { recursive: true, force: true });
    await browser.close(); // вместе с браузером уничтожается и весь профиль с куки
  }
}

module.exports = { grab };

if (require.main === module) {
  const [url, wait, slider, record] = process.argv.slice(2);
  if (!url) {
    console.error('Использование: node grabber.js <ссылка на страницу> [секунд ожидания, по умолчанию 60] [css-селектор слайдера или -] [record — всегда записывать куски]');
    process.exit(1);
  }
  grab(url, { waitMs: (Number(wait) || 60) * 1000, sliderSelector: slider === '-' ? '' : slider, recordSegments: record === 'record', recordIdleMs: Number(process.env.RECORD_IDLE_MS) || 30000 }).catch((e) => {
    console.error('Ошибка:', e.message);
    process.exit(1);
  });
}
