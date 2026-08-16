const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  getTeamSplit,
  getQuestSizes,
  validateRoleOptions,
  assignRoles,
  buildRoleInfoBundle,
  isEvil,
} = require('./roles');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 개발 중 수정한 파일이 폰/브라우저에 캐시되어 옛날 화면이 계속 보이는 걸 막기 위해
// 정적 파일을 캐시하지 않도록 설정 (이 앱은 로컬 소규모 사용이라 성능에 영향 없음)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));

// room code -> room state
const rooms = new Map();

// "이미지로 저장" 시 우측 하단에 찍는 원정 번호. 한 번의 "역할 배정"마다 번호를 하나만 발급해서,
// 그 배정에 참여한 모든 참가자가 이미지를 저장하면 전부 같은 번호가 찍히도록 한다
// (나중에 "이 번호 = 몇 번째 배정에서 누가 어떤 역할이었는지"를 대조할 수 있게 하기 위함).
// 서버가 켜져 있는 동안 계속 증가하고, 재시작하면 001부터 다시 시작.
let captureCounter = 0;
function nextCaptureId() {
  captureCounter += 1;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const seq = String(captureCounter).padStart(3, '0');
  return `${y}${m}${d}_${seq}`;
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자 제외
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicPlayerList(room) {
  return room.players.map((p) => {
    const role = room.started && room.assignment ? room.assignment[p.id] : null;
    return {
      id: p.id,
      name: p.name,
      left: !!p.left,
      role,
      side: role ? (isEvil(role) ? '악' : '선') : null,
    };
  });
}

function sendHostState(room) {
  io.to(room.hostSocketId).emit('room_state', {
    code: room.code,
    players: publicPlayerList(room),
    options: room.options,
    started: room.started,
    teamSplit: getTeamSplit(room.players.length),
    questSizes: getQuestSizes(room.players.length),
  });
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.role = null; // 'host' | 'player'

  socket.on('create_room', (_payload, cb) => {
    const code = genCode();
    const room = {
      code,
      hostSocketId: socket.id,
      players: [],
      options: { merlin: true, percival: false, mordred: false, morgana: false, oberon: false, assassin: true },
      assignment: null,
      started: false,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'host';
    cb && cb({ ok: true, code });
    sendHostState(room);
  });

  socket.on('join_room', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: '방을 찾을 수 없습니다. 코드를 확인해 주세요.' });
    if (room.started) return cb && cb({ ok: false, error: '이미 역할 배정이 시작된 방입니다.' });
    const trimmedName = (name || '').trim().slice(0, 20) || `플레이어${room.players.length + 1}`;
    room.players.push({ id: socket.id, name: trimmedName, left: false });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'player';
    cb && cb({ ok: true, code });
    sendHostState(room);
  });

  socket.on('set_options', ({ code, options }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb && cb({ ok: false, error: '권한이 없습니다.' });
    room.options = { ...room.options, ...options };
    sendHostState(room);
    cb && cb({ ok: true });
  });

  socket.on('kick_player', ({ code, playerId }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb && cb({ ok: false, error: '권한이 없습니다.' });
    room.players = room.players.filter((p) => p.id !== playerId);
    io.to(playerId).emit('kicked');
    sendHostState(room);
    cb && cb({ ok: true });
  });

  socket.on('assign_roles', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb && cb({ ok: false, error: '권한이 없습니다.' });

    const validation = validateRoleOptions(room.players.length, room.options);
    if (!validation.ok) return cb && cb({ ok: false, error: validation.error });

    const assignment = assignRoles(room.players, room.options);
    room.assignment = assignment;
    room.started = true;
    room.captureId = nextCaptureId(); // 이번 배정 전체가 공유하는 하나의 번호

    const bundle = buildRoleInfoBundle(assignment, room.players);

    room.players.forEach((p) => {
      io.to(p.id).emit('your_role_bundle', { ...bundle[p.id], captureId: room.captureId });
    });

    sendHostState(room);
    cb && cb({ ok: true });
  });

  socket.on('reset_room', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb && cb({ ok: false, error: '권한이 없습니다.' });
    // 초기화 시점에는 이미 나간(연결이 끊긴) 참가자는 목록에서 정리하고,
    // 현재 실제로 접속해 있는 참가자만 남긴다.
    room.players = room.players.filter((p) => !p.left);
    room.assignment = null;
    room.started = false;
    room.captureId = null;
    room.players.forEach((p) => io.to(p.id).emit('room_reset'));
    sendHostState(room);
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.role === 'host') {
      io.to(code).emit('host_left');
      rooms.delete(code);
    } else if (room.started) {
      // 배정이 끝난 뒤에 나간 참가자는 목록에서 지우지 않고 "나감"으로만 표시한다
      // (진행자가 누가 무슨 역할이었는지 계속 볼 수 있어야 함). 목록 정리는 "다시 배정"할 때 한다.
      const player = room.players.find((p) => p.id === socket.id);
      if (player) player.left = true;
      sendHostState(room);
    } else {
      room.players = room.players.filter((p) => p.id !== socket.id);
      sendHostState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`아발론 역할+정보 동시배정 서버 실행 중: http://localhost:${PORT}`);
  console.log('같은 와이파이의 폰에서 접속하려면, 이 컴퓨터의 로컬 IP를 확인해서 http://<IP>:3000 으로 접속하세요.');
});
