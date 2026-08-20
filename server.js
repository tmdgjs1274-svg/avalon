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

// 재접속 승인 대기 목록을 진행자 화면에 그대로 보여준다 (신청자 이름 + 요청ID만 노출)
function sendPendingRejoins(room) {
  io.to(room.hostSocketId).emit(
    'pending_rejoins',
    (room.pendingRejoins || []).map((r) => ({ requestId: r.requestId, name: r.name }))
  );
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
      bundle: null,
      started: false,
      pendingRejoins: [],
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

    const trimmedName = (name || '').trim().slice(0, 20) || `플레이어${room.players.length + 1}`;
    const nameLower = trimmedName.toLowerCase();

    if (room.started) {
      // 이미 배정이 시작된 방에는 새로 들어올 수 없고, 배정 후 나갔던 사람이 같은 닉네임으로
      // 재접속을 "요청"하는 것만 허용한다. 실제 입장은 진행자가 승인해야 이루어진다.
      const leftMatch = room.players.find((p) => p.left && p.name.toLowerCase() === nameLower);
      if (!leftMatch) {
        return cb && cb({ ok: false, error: '이미 역할 배정이 시작된 방입니다.' });
      }
      room.pendingRejoins = room.pendingRejoins || [];
      const already = room.pendingRejoins.find((r) => r.matchedPlayerId === leftMatch.id);
      if (already) {
        return cb && cb({ ok: false, error: '이미 재접속 승인을 기다리고 있습니다. 진행자의 승인을 기다려 주세요.' });
      }
      const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      room.pendingRejoins.push({ requestId, socketId: socket.id, name: trimmedName, matchedPlayerId: leftMatch.id });
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.role = 'player_pending';
      cb && cb({ ok: true, code, pending: true });
      sendPendingRejoins(room);
      return;
    }

    // 배정 전(대기실)에는 같은 닉네임으로 중복 입장할 수 없다.
    const dup = room.players.some((p) => !p.left && p.name.toLowerCase() === nameLower);
    if (dup) {
      return cb && cb({ ok: false, error: '이미 사용 중인 닉네임입니다. 다른 이름을 입력해 주세요.' });
    }

    room.players.push({ id: socket.id, name: trimmedName, left: false });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'player';
    cb && cb({ ok: true, code });
    sendHostState(room);
  });

  socket.on('respond_rejoin', ({ code, requestId, approve }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb && cb({ ok: false, error: '권한이 없습니다.' });

    room.pendingRejoins = room.pendingRejoins || [];
    const idx = room.pendingRejoins.findIndex((r) => r.requestId === requestId);
    if (idx === -1) return cb && cb({ ok: false, error: '요청을 찾을 수 없습니다 (이미 처리되었을 수 있습니다).' });
    const req = room.pendingRejoins[idx];
    room.pendingRejoins.splice(idx, 1);
    sendPendingRejoins(room);

    const targetSocket = io.sockets.sockets.get(req.socketId);

    if (!approve) {
      if (targetSocket) {
        targetSocket.data.roomCode = null;
        targetSocket.data.role = null;
        targetSocket.leave(code);
        io.to(req.socketId).emit('rejoin_denied');
      }
      return cb && cb({ ok: true });
    }

    const player = room.players.find((p) => p.id === req.matchedPlayerId);
    if (!player) {
      io.to(req.socketId).emit('rejoin_denied');
      return cb && cb({ ok: false, error: '대상 참가자를 찾을 수 없습니다.' });
    }

    // 기존 참가자 슬롯을 새 소켓으로 그대로 이어받는다 (이름/이미 배정된 역할 유지).
    // assignment/bundle이 (예전) 소켓ID를 키로 갖고 있으므로, 새 소켓ID로 키를 옮겨준다.
    const oldId = player.id;
    if (room.assignment && Object.prototype.hasOwnProperty.call(room.assignment, oldId)) {
      room.assignment[req.socketId] = room.assignment[oldId];
      delete room.assignment[oldId];
    }
    if (room.bundle && Object.prototype.hasOwnProperty.call(room.bundle, oldId)) {
      room.bundle[req.socketId] = room.bundle[oldId];
      delete room.bundle[oldId];
    }
    player.id = req.socketId;
    player.left = false;

    if (targetSocket) {
      targetSocket.data.role = 'player';
    }

    const bundleEntry = room.bundle ? room.bundle[req.socketId] : null;
    if (bundleEntry) {
      // 배정 당시 받았던 것과 완전히 동일한 역할/카드 이미지/관련 정보를 다시 보내준다.
      io.to(req.socketId).emit('your_role_bundle', { ...bundleEntry, captureId: room.captureId });
    }

    sendHostState(room);
    cb && cb({ ok: true });
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
    room.bundle = bundle; // 나중에 재접속 승인 시, 재계산 없이 그때 받은 것과 동일한 카드를 다시 보내주기 위해 보관
    room.pendingRejoins = [];

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
    // 재접속 승인을 기다리던 요청이 남아있다면, 초기화로 그 요청 자체가 의미없어지므로 거절 처리한다.
    (room.pendingRejoins || []).forEach((r) => io.to(r.socketId).emit('rejoin_denied'));

    room.players = room.players.filter((p) => !p.left);
    room.assignment = null;
    room.bundle = null;
    room.started = false;
    room.captureId = null;
    room.pendingRejoins = [];
    room.players.forEach((p) => io.to(p.id).emit('room_reset'));
    sendHostState(room);
    sendPendingRejoins(room);
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
    } else if (socket.data.role === 'player_pending') {
      // 승인 대기 중에 창을 닫는 등으로 나가면, 대기 목록에서도 지워서 진행자 화면에 남지 않게 한다
      room.pendingRejoins = (room.pendingRejoins || []).filter((r) => r.socketId !== socket.id);
      sendPendingRejoins(room);
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
