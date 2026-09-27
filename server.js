const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

// ===== 환경 변수 =====
const PORT = process.env.PORT || 3000;
const KP_KEY = process.env.KP_KEY || 'changeme';            // 마스터 비밀키 (Railway 변수에서 꼭 바꾸세요)
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048);

// 서버 시작 시 이전 업로드 파일 정리 (상태는 메모리라 재시작하면 어차피 초기화됨)
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
for (const f of fs.readdirSync(UPLOAD_DIR)) {
  try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch {}
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===== 공유 상태 =====
// 타이머: 실행 중이면 endAt(서버 시각 ms) 기준, 정지 중이면 remaining(초) 기준
const timer = { initial: 0, remaining: 0, running: false, endAt: null };
// 영상: position(초)은 updatedAt(서버 시각 ms) 시점의 재생 위치
const media = { url: null, name: null, playing: false, position: 0, updatedAt: Date.now() };
let currentFile = null;

const emitTimer = () => io.emit('timer:state', timer);
const emitPresence = () => io.emit('presence', { count: io.engine.clientsCount });

function setMedia(patch) {
  Object.assign(media, patch, { updatedAt: Date.now() });
  io.emit('media:state', media);
}

function removeCurrentFile() {
  if (!currentFile) return;
  fs.unlink(path.join(UPLOAD_DIR, currentFile), () => {});
  currentFile = null;
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

// 업로드된 영상 (Range 요청 지원 → 탐색/스트리밍 가능)
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('video/')
      ? cb(null, true)
      : cb(new Error('영상 파일만 올릴 수 있습니다.')),
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

    removeCurrentFile();
    currentFile = req.file.filename;
    setMedia({ url: `/media/${req.file.filename}`, name, playing: false, position: 0 });
    res.json({ ok: true });
  });
});

// ===== 실시간 동기화 =====
io.on('connection', (socket) => {
  const isKP = socket.handshake.auth?.key === KP_KEY;

  socket.emit('role', { isKP });
  socket.emit('timer:state', timer);
  socket.emit('media:state', media);
  emitPresence();

  // 시계 보정용 (클라이언트-서버 시각 차이 계산)
  socket.on('time:ping', (_t0, cb) => typeof cb === 'function' && cb(Date.now()));

  const kpOnly = (event, handler) =>
    socket.on(event, (payload = {}) => { if (isKP) handler(payload); });

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
  kpOnly('media:play', ({ position }) => media.url && setMedia({ playing: true, position: toNum(position) }));
  kpOnly('media:pause', ({ position }) => media.url && setMedia({ playing: false, position: toNum(position) }));
  kpOnly('media:seek', ({ position, playing }) =>
    media.url && setMedia({ position: toNum(position), playing: !!playing }));
  kpOnly('media:clear', () => {
    removeCurrentFile();
    setMedia({ url: null, name: null, playing: false, position: 0 });
  });

  socket.on('disconnect', emitPresence);
});

server.listen(PORT, () => {
  console.log(`TRPG timer running on :${PORT}`);
  if (KP_KEY === 'changeme') console.warn('⚠️  KP_KEY 환경 변수를 설정하세요. 기본값(changeme) 사용 중');
});
