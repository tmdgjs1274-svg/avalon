// 아발론 표준 인원별 선/악 구성 (5~10명, 실제 게임용)
const TEAM_SPLIT = {
  5: { good: 3, evil: 2 },
  6: { good: 4, evil: 2 },
  7: { good: 4, evil: 3 },
  8: { good: 5, evil: 3 },
  9: { good: 6, evil: 3 },
  10: { good: 6, evil: 4 },
};

// 1~4명: 정식 밸런스가 아닌 "혼자/소수 인원 테스트용" 구성.
// 실제 대전이 아니라 앱 동작(역할 배정, 확인 화면)을 미리 확인해보는 용도.
const TEST_TEAM_SPLIT = {
  1: { good: 0, evil: 1, test: true },
  2: { good: 1, evil: 1, test: true },
  3: { good: 2, evil: 1, test: true },
  4: { good: 2, evil: 2, test: true },
};

// 인원수별 퀘스트(원정) 인원 표 (부가 정보로 함께 제공)
const QUEST_SIZES = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

function getTeamSplit(playerCount) {
  return TEAM_SPLIT[playerCount] || TEST_TEAM_SPLIT[playerCount] || null;
}

function getQuestSizes(playerCount) {
  return QUEST_SIZES[playerCount] || null;
}

// options: { merlin, percival, mordred, morgana, oberon, assassin }
function validateRoleOptions(playerCount, options) {
  const split = getTeamSplit(playerCount);
  if (!split) return { ok: false, error: '지원하지 않는 인원수입니다 (1~10명만 가능).' };

  const errors = [];
  const goodSpecials = (options.merlin ? 1 : 0) + (options.percival ? 1 : 0);
  const evilSpecials = (options.assassin ? 1 : 0) + (options.mordred ? 1 : 0) + (options.morgana ? 1 : 0) + (options.oberon ? 1 : 0);

  if (options.percival && !options.merlin) {
    errors.push('퍼시벌을 넣으려면 멀린이 반드시 있어야 합니다.');
  }
  if (goodSpecials > split.good) {
    errors.push(`선 특수役(멀린/퍼시벌)이 선 인원(${split.good}명)보다 많습니다.`);
  }
  if (evilSpecials > split.evil) {
    errors.push(`악 특수役(암살자/모드레드/모르가나/오베론)이 악 인원(${split.evil}명)보다 많습니다.`);
  }
  return { ok: errors.length === 0, error: errors.join(' '), split };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// players: [{id, name}], options: role toggles
// returns map playerId -> roleName, plus role metadata
function assignRoles(players, options) {
  const split = getTeamSplit(players.length);
  const goodRoles = [];
  const evilRoles = [];

  if (options.merlin) goodRoles.push('멀린');
  if (options.percival) goodRoles.push('퍼시벌');
  while (goodRoles.length < split.good) goodRoles.push('충성스런 신하');

  if (options.assassin) evilRoles.push('암살자');
  if (options.mordred) evilRoles.push('모드레드');
  if (options.morgana) evilRoles.push('모르가나');
  if (options.oberon) evilRoles.push('오베론');
  while (evilRoles.length < split.evil) evilRoles.push('모드레드의 수하');

  const allRoles = shuffle([...goodRoles, ...evilRoles]);
  const shuffledPlayers = shuffle(players);

  const assignment = {}; // playerId -> role
  shuffledPlayers.forEach((p, idx) => {
    assignment[p.id] = allRoles[idx];
  });

  return assignment;
}

const EVIL_ROLES = new Set(['암살자', '모드레드', '모르가나', '오베론', '모드레드의 수하']);

function isEvil(role) {
  return EVIL_ROLES.has(role);
}

// 역할별 카드 이미지 파일명 풀 (public/img/roles/ 폴더 기준).
// 배열에 이미지가 여러 개면 그 역할을 받은 사람마다 무작위로 하나를 골라 보여준다
// (예: 충성스런 신하/모드레드의 수하는 여러 명이 같은 역할이라도 서로 다른 그림을 받을 수 있음).
const ROLE_IMAGE_POOL = {
  '멀린': ['merlin.png'],
  '퍼시벌': ['percival.png'],
  '모드레드': ['mordred.png'],
  '모르가나': ['morgana.png'],
  '오베론': ['oberon.png'],
  '암살자': ['assassin.png'],
  '충성스런 신하': ['loyal_1.png', 'loyal_2.png', 'loyal_3.png'],
  '모드레드의 수하': ['minion_evil_1.png'],
};

function getRoleImage(role) {
  const pool = ROLE_IMAGE_POOL[role];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}


// 역할 배정과 동시에, 그 역할이 알아야 할 사람 정보까지 한 번에(같은 카드에서) 계산한다.
// playerId -> { role, image, related: {title, names, note} | null }
function buildRoleInfoBundle(assignment, players) {
  const byRole = {};
  players.forEach((p) => {
    const role = assignment[p.id];
    byRole[role] = byRole[role] || [];
    byRole[role].push(p);
  });

  const evilExceptOberon = players.filter((p) => isEvil(assignment[p.id]) && assignment[p.id] !== '오베론');
  const merlinPlayers = byRole['멀린'] || [];
  const morganaPlayers = byRole['모르가나'] || [];

  const visibleToMerlin = evilExceptOberon
    .filter((p) => assignment[p.id] !== '모드레드')
    .concat(byRole['오베론'] || []);

  const bundle = {};

  players.forEach((p) => {
    const role = assignment[p.id];

    if (role === '오베론') {
      bundle[p.id] = {
        role,
        side: '악',
        image: getRoleImage(role),
        related: {
          title: '악 팀원 정보 없음',
          names: [],
          note: '당신은 다른 악 팀원에게 알려지지 않고, 당신도 다른 악 팀원이 누구인지 모릅니다.',
        },
      };
      return;
    }

    if (isEvil(role)) {
      const others = evilExceptOberon.filter((x) => x.id !== p.id).map((x) => x.name);
      bundle[p.id] = {
        role,
        side: '악',
        image: getRoleImage(role),
        related: { title: '같은 편(악)', names: others, note: null },
      };
      return;
    }

    if (role === '멀린') {
      bundle[p.id] = {
        role,
        side: '선',
        image: getRoleImage(role),
        related: {
          title: '악으로 보이는 사람',
          names: visibleToMerlin.map((x) => x.name),
          note: '(모드레드가 있다면 모드레드는 이 목록에 나타나지 않습니다)',
        },
      };
      return;
    }

    if (role === '퍼시벌') {
      const candidates = shuffle([...merlinPlayers, ...morganaPlayers]).map((x) => x.name);
      bundle[p.id] = {
        role,
        side: '선',
        image: getRoleImage(role),
        related: {
          title: morganaPlayers.length > 0 ? '멀린으로 보이는 두 사람' : '멀린',
          names: candidates,
          note:
            morganaPlayers.length > 0
              ? '(둘 중 하나가 멀린이고 하나는 모르가나입니다. 누가 누구인지는 알 수 없습니다)'
              : null,
        },
      };
      return;
    }

    // 충성스런 신하 등, 알아야 할 정보 없음
    bundle[p.id] = { role, side: '선', image: getRoleImage(role), related: null };
  });

  return bundle;
}

module.exports = {
  getTeamSplit,
  getQuestSizes,
  validateRoleOptions,
  assignRoles,
  buildRoleInfoBundle,
  getRoleImage,
  isEvil,
};
