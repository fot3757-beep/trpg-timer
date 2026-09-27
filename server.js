const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

// ===== 환경 변수 =====
const PORT = process.env.PORT || 3000;
const KP_KEY = process.env.KP_KEY || 'changeme';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048);
// Railway 볼륨을 연결하면 RAILWAY_VOLUME_MOUNT_PATH가 자동으로 잡혀서 그곳에 저장됨
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

fs.mkdirSync(VIDEO_DIR, { recursive: true });

// ===== 상태 (파일로 저장되어 재시작해도 유지) =====
const state = {
  // 실행 중이면 endAt(서버 시각 ms) 기준, 정지 중이면 remaining(초) 기준
  timer: { initial: 0, remaining: 0, running: false, endAt: null },
  // position(초)은 updatedAt(서버 시각 ms) 시점의 재생 위치
  media: { currentId: null, playing: false, position: 0, updatedAt: Date.now() },
  // 올려둔 영상 목록
  library: [],
};

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(state.timer, saved.timer || {});
    Object.assign(state.media, saved.media || {});
    state.library = Array.isArray(saved.library) ? saved.library : [];
  } catch {}

  // 실제 파일이 없는 항목 제거, 목록에 없는 파일(업로드 중단 등) 정리
  state.library = state.library.filter((v) => fs.existsSync(path.join(VIDEO_DIR, v.file)));
  const known = new Set(state.library.map((v) => v.file));
  for (const f of fs.readdirSync(VIDEO_DIR)) {
    if (!known.has(f)) fs.rm(path.join(VIDEO_DIR, f), { force: true }, () => {});
  }
  if (!state.library.some((v) => v.id === state.media.currentId)) state.media.currentId = null;

  // 서버가 꺼져 있던 동안 영상이 계속 흘러가지 않도록 마지막 위치에서 일시정지
  state.media.playing = false;
  state.media.updatedAt = Date.now();
  sortLibrary();
}

let saveTimer = null;
function writeStateSync() {
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { console.error('상태 저장 실패:', e.message); }
}
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStateSync, 300);
}

function sortLibrary() {
  state.library.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
}

loadState();

// ===== 서버 =====
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const { timer, media } = state;

const libraryPayload = () =>
  state.library.map(({ id, name, size, file }) => ({ id, name, size, url: `/media/${file}` }));

function mediaPayload() {
  const v = state.library.find((x) => x.id === media.currentId);
  return { ...media, url: v ? `/media/${v.file}` : null, name: v ? v.name : null };
}

const emitTimer = () => { io.emit('timer:state', timer); saveState(); };
const emitMedia = () => { io.emit('media:state', mediaPayload()); saveState(); };
const emitLibrary = () => { io.emit('library', libraryPayload()); saveState(); };
const emitPresence = () => io.emit('presence', { count: io.engine.clientsCount });

function setMedia(patch) {
  Object.assign(media, patch, { updatedAt: Date.now() });
  emitMedia();
}

const toNum = (v, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0;
};

// 타이머 종료 감지
setInterval(() => {
  if (timer.running && Date.now() >= timer.endAt) {
    timer.running = false;
    timer.remaining = 0;
    timer.endAt = null;
    emitTimer();
  }
}, 250);

// ===== HTTP =====
app.get('/health', (req, res) => res.send('ok'));
app.use('/media', express.static(VIDEO_DIR, { maxAge: '7d' })); // Range 요청 지원
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: VIDEO_DIR,
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('영상 파일만 올릴 수 있습니다.')),
});

function requireKP(req, res, next) {
  if (req.get('x-kp-key') !== KP_KEY) return res.status(403).json({ error: 'KP 키가 올바르지 않습니다.' });
  next();
}

app.post('/api/upload', requireKP, (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `파일이 너무 큽니다. 최대 ${MAX_UPLOAD_MB}MB까지 올릴 수 있습니다.` : err.message,
      });
    }
    if (!req.file) return res.status(400).json({ error: '파일이 전송되지 않았습니다.' });

    let name = req.file.originalname;
    try { name = decodeURIComponent(req.get('x-file-name') || name); } catch {}

    const item = { id: crypto.randomUUID(), name, file: req.file.filename, size: req.file.size, uploadedAt: Date.now() };
    state.library.push(item);
    sortLibrary();
    emitLibrary();
    if (!media.currentId) setMedia({ currentId: item.id, playing: false, position: 0 });
    res.json({ ok: true, id: item.id });
  });
});

// ===== 실시간 동기화 =====
// 비밀번호 무차별 대입 방지: IP당 5회 틀리면 1분 잠금
const loginFails = new Map();
const ipOf = (socket) =>
  (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address;

io.on('connection', (socket) => {
  // 저장된 비밀번호로 자동 로그인 (브라우저에 저장된 값)
  socket.data.isKP = !!socket.handshake.auth?.key && socket.handshake.auth.key === KP_KEY;

  socket.emit('role', { isKP: socket.data.isKP });
  socket.emit('timer:state', timer);
  socket.emit('library', libraryPayload());
  socket.emit('media:state', mediaPayload());
  emitPresence();

  socket.on('time:ping', (_t0, cb) => typeof cb === 'function' && cb(Date.now()));

  // --- 마스터 로그인 / 로그아웃 ---
  socket.on('kp:login', (key, cb) => {
    if (typeof cb !== 'function') return;
    const ip = ipOf(socket);
    const f = loginFails.get(ip);
    if (f && f.until > Date.now()) {
      return cb({ ok: false, error: `너무 많이 틀렸습니다. ${Math.ceil((f.until - Date.now()) / 1000)}초 후 다시 시도하세요.` });
    }
    if (typeof key === 'string' && key === KP_KEY) {
      loginFails.delete(ip);
      socket.data.isKP = true;
      socket.emit('role', { isKP: true });
      return cb({ ok: true });
    }
    const count = (f && f.until === 0 ? f.count : 0) + 1; // 잠금이 풀린 뒤엔 1부터 다시
    loginFails.set(ip, { count: count >= 5 ? 0 : count, until: count >= 5 ? Date.now() + 60000 : 0 });
    cb({ ok: false, error: count >= 5 ? '5회 틀려서 1분 동안 잠깁니다.' : `비밀번호가 틀렸습니다. (${count}/5)` });
  });

  socket.on('kp:logout', () => {
    socket.data.isKP = false;
    socket.emit('role', { isKP: false });
  });

  const kpOnly = (event, handler) =>
    socket.on(event, (payload = {}) => { if (socket.data.isKP) handler(payload || {}); });

  // --- 타이머 ---
  kpOnly('timer:start', () => {
    if (timer.running || timer.remaining <= 0) return;
    timer.running = true;
    timer.endAt = Date.now() + timer.remaining * 1000;
    emitTimer();
  });
  kpOnly('timer:pause', () => {
    if (!timer.running) return;
    timer.remaining = Math.max(0, (timer.endAt - Date.now()) / 1000);
    timer.running = false;
    timer.endAt = null;
    emitTimer();
  });
  kpOnly('timer:reset', () => {
    timer.running = false;
    timer.endAt = null;
    timer.remaining = timer.initial;
    emitTimer();
  });
  kpOnly('timer:set', ({ h, m, s }) => {
    const total = Math.min(toNum(h, 99) * 3600 + toNum(m, 59) * 60 + toNum(s, 59), 359999);
    timer.initial = Math.floor(total);
    timer.remaining = timer.initial;
    timer.running = false;
    timer.endAt = null;
    emitTimer();
  });

  // --- 영상 ---
  kpOnly('media:select', ({ id }) => {
    if (!state.library.some((v) => v.id === id)) return;
    setMedia({ currentId: id, playing: false, position: 0 });
  });
  kpOnly('media:play', ({ position }) => media.currentId && setMedia({ playing: true, position: toNum(position) }));
  kpOnly('media:pause', ({ position }) => media.currentId && setMedia({ playing: false, position: toNum(position) }));
  kpOnly('media:seek', ({ position, playing }) =>
    media.currentId && setMedia({ position: toNum(position), playing: !!playing }));
  kpOnly('media:clear', () => setMedia({ currentId: null, playing: false, position: 0 }));

  kpOnly('library:delete', ({ id }) => {
    const idx = state.library.findIndex((v) => v.id === id);
    if (idx < 0) return;
    const [item] = state.library.splice(idx, 1);
    fs.rm(path.join(VIDEO_DIR, item.file), { force: true }, () => {});
    if (media.currentId === id) setMedia({ currentId: null, playing: false, position: 0 });
    emitLibrary();
  });

  socket.on('disconnect', emitPresence);
});

// 재배포/종료 시 마지막 상태를 확실히 저장
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { clearTimeout(saveTimer); writeStateSync(); process.exit(0); });
}

server.listen(PORT, () => {
  console.log(`TRPG timer running on :${PORT} (data: ${DATA_DIR})`);
  if (KP_KEY === 'changeme') console.warn('⚠️  KP_KEY 환경 변수를 설정하세요. 기본값(changeme) 사용 중');
  if (!process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR && process.env.RAILWAY_ENVIRONMENT) {
    console.warn('⚠️  Railway 볼륨이 연결되지 않았습니다. 재배포하면 영상과 타이머가 사라집니다.');
  }
});
