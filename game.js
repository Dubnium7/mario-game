'use strict';
/* =====================================================================
   超级马里奥 · 网页版（单机离线可玩）
   纯原生 JavaScript + Canvas，无任何外部依赖
   模块顺序：工具 → 输入 → 音频 → 像素资源 → 关卡 → 物理 → 实体 → 主循环
===================================================================== */

/* ============================ 1. 基础与工具 ============================ */
const TILE = 16;                 // 瓦片尺寸
const VW = 512, VH = 272;        // 逻辑分辨率
const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d');
ctx.imageSmoothingEnabled = false;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd = (a, b) => a + Math.random() * (b - a);

// 游戏全局状态量
let frame = 0;                   // 总帧计数
let state = 'title';             // title / play / dying / flag / clear / gameover / win
let paused = false;
let score = 0, coins = 0, lives = 3, timeLeft = 300, timeTick = 0;
let hiscore = 0;
try { hiscore = +localStorage.getItem('smb_hiscore') || 0; } catch (e) { }
let curLevel = 0;
let camX = 0;
let stateTimer = 0;              // 各状态的计时器
let flagBonusY = 0;

// ---- 模式（经典版 / 恶搞版）----
let curMode = 0;                 // 0=经典 1=恶搞
let modeSelect = 0;              // 标题画面菜单光标
let trollDeaths = 0;             // 恶搞版累计死亡数
let deathMsg = '';               // 本次死亡嘲讽语
let flashT = 0;                  // 惊吓白屏
let shakeT = 0;                  // 震屏
let reverseT = 0;                // 操控反转剩余帧

// ---- 恶搞版运行时实体 ----
let triggers = [];               // 触发器 {x,y,w,h,action,opts,armed}
let checkpoints = [];            // 存档点 {x,y,idx,on}
let fallingObjs = [];            // 天降物 {x,y,vy,warnT,kind}
let chasers = [];                // 假旗杆追杀怪
let crumbles = [];               // 塌陷中的裂纹段 {gx0,gx1,t}
let tombstones = [];             // 墓碑教学 {lv,x,y,cause}
let fakeFlags = [];              // 假旗杆 {x,triggered}
let rainState = null;            // 连续落物 {t,interval}
const activatedCP = [[], []];    // [mode][level] 已激活存档点索引
let respawnMark = null;          // 当前重生点 {x,y}

/* ============================ 2. 输入 ============================ */
const keys = {};
const pressedBuf = {};
addEventListener('keydown', e => {
  if (!e.repeat) pressedBuf[e.code] = true;
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => keys[e.code] = false);
function jp(code) { if (pressedBuf[code]) { pressedBuf[code] = false; return true; } return false; }
// 原始方向输入
const inLeftRaw = () => keys.ArrowLeft || keys.KeyA;
const inRightRaw = () => keys.ArrowRight || keys.KeyD;
// 恶搞版毒蘑菇：操控反转
const inLeft = () => reverseT > 0 ? inRightRaw() : inLeftRaw();
const inRight = () => reverseT > 0 ? inLeftRaw() : inRightRaw();
const inDown = () => keys.ArrowDown || keys.KeyS;
const inRun = () => keys.KeyX || keys.KeyJ || keys.ShiftLeft;
const inJumpHeld = () => keys.KeyZ || keys.KeyK || keys.Space || keys.ArrowUp;
function inJumpPress() {
  return jp('KeyZ') || jp('KeyK') || jp('Space') || jp('ArrowUp');
}

/* ============================ 3. 音频 ============================ */
let AC = null, musicGain = null, sfxGain = null, muted = false;
function initAudio() {
  if (!AC) {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      musicGain = AC.createGain(); musicGain.gain.value = 0.5; musicGain.connect(AC.destination);
      sfxGain = AC.createGain(); sfxGain.gain.value = 0.6; sfxGain.connect(AC.destination);
    } catch (e) { }
  }
  if (AC && AC.state === 'suspended') AC.resume();
}
// 单音：f0 起始频率 → f1 结束频率，dur 秒
function tone(f0, f1, dur, type, vol, when, dest) {
  if (!AC || muted) return;
  const t0 = AC.currentTime + (when || 0);
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'square';
  o.frequency.setValueAtTime(f0, t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
  g.gain.setValueAtTime(vol || 0.2, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(dest || sfxGain);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function noiseHit(dur, vol, when) {
  if (!AC || muted) return;
  const t0 = AC.currentTime + (when || 0);
  const len = Math.max(1, (dur * AC.sampleRate) | 0);
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = AC.createBufferSource(); src.buffer = buf;
  const g = AC.createGain(); g.gain.value = vol || 0.25;
  src.connect(g); g.connect(sfxGain);
  src.start(t0);
}
// 音名转频率：note('E5') → Hz
function noteFreq(n) {
  const NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const m = n.match(/^([A-G][b#]?)(\d)$/);
  if (!m) return 440;
  const semis = NAMES[m[1]] + (+m[2] - 4) * 12 - 9;
  return 440 * Math.pow(2, semis / 12);
}
// 音效表
const SFX = {
  jump() { tone(320, 780, 0.16, 'square', 0.22); },
  coin() { tone(noteFreq('B5'), 0, 0.07, 'square', 0.22); tone(noteFreq('E6'), 0, 0.24, 'square', 0.22, 0.07); },
  stomp() { tone(500, 120, 0.14, 'triangle', 0.35); noiseHit(0.08, 0.15); },
  kick() { tone(220, 90, 0.12, 'square', 0.28); noiseHit(0.06, 0.18); },
  bump() { tone(160, 90, 0.09, 'square', 0.3); },
  brick() { noiseHit(0.22, 0.32); tone(300, 80, 0.18, 'square', 0.2); },
  sprout() { tone(200, 600, 0.3, 'square', 0.18); },
  powerup() { ['C5', 'E5', 'G5', 'C6', 'E6', 'G6'].forEach((n, i) => tone(noteFreq(n), 0, 0.1, 'square', 0.2, i * 0.06)); },
  powerdown() { ['G5', 'E5', 'C5', 'G4'].forEach((n, i) => tone(noteFreq(n), 0, 0.12, 'square', 0.2, i * 0.08)); },
  fireball() { tone(880, 220, 0.1, 'sawtooth', 0.16); },
  oneup() { ['E6', 'G6', 'E7'].forEach((n, i) => tone(noteFreq(n), 0, 0.12, 'triangle', 0.3, i * 0.09)); },
  die() { stopMusic(); ['B4', 'F5', 'F5', 'F5', 'E5', 'D5', 'C5'].forEach((n, i) => tone(noteFreq(n), 0, i < 3 ? 0.1 : 0.16, 'square', 0.24, 0.1 + i * 0.13)); },
  clear() { stopMusic(); ['C5', 'D5', 'E5', 'G5', 'C6', 'E6', 'G6'].forEach((n, i) => tone(noteFreq(n), 0, i === 6 ? 0.5 : 0.13, 'square', 0.22, i * 0.11)); },
  gameover() { stopMusic(); ['C5', 'G4', 'E4', 'C4'].forEach((n, i) => tone(noteFreq(n), 0, 0.3, 'triangle', 0.3, i * 0.25)); },
  tick() { tone(noteFreq('C6'), 0, 0.04, 'square', 0.1); },
  warning() { tone(880, 880, 0.08, 'square', 0.2); tone(880, 880, 0.08, 'square', 0.2, 0.15); },
  pause() { tone(660, 660, 0.06, 'square', 0.15); tone(880, 880, 0.06, 'square', 0.15, 0.08); },
  // ---- 恶搞版 ----
  warn() { tone(1200, 1200, 0.05, 'square', 0.22); tone(1200, 1200, 0.05, 'square', 0.22, 0.09); },   // 陷阱预警"咔哒"
  smash() { noiseHit(0.3, 0.4); tone(90, 40, 0.25, 'square', 0.35); },                                 // 天降物砸地
  shatter() { noiseHit(0.12, 0.2); tone(500, 200, 0.1, 'triangle', 0.2); },                            // 假砖碎裂
  poison() { tone(400, 900, 0.3, 'sawtooth', 0.2); tone(900, 300, 0.3, 'sawtooth', 0.2, 0.3); },      // 中毒反转
  scare() { tone(1800, 300, 0.35, 'sawtooth', 0.3); noiseHit(0.2, 0.3); },                             // 惊吓
  ghost() { tone(700, 60, 0.9, 'sawtooth', 0.28); },                                                    // 鬼畜死亡下滑
  cpGet() { ['G5', 'C6'].forEach((n, i) => tone(noteFreq(n), 0, i ? 0.25 : 0.08, 'triangle', 0.28, i * 0.08)); }, // 存档点
  chase() { tone(220, 440, 0.18, 'sawtooth', 0.25); tone(220, 440, 0.18, 'sawtooth', 0.25, 0.2); },    // 追杀怪登场
};
function playSfx(name) { if (AC && SFX[name]) SFX[name](); }

// ---- 恶搞版死亡嘲讽语录 ----
const TAUNTS = [
  '急了急了，他急了',
  '典中典之原地去世',
  '孝死，菜就多练',
  '乐，这都能死？',
  '绷不住了，家人们',
  '蚌埠住了兄弟们',
  '你说得对，但你死了',
  '小丑竟是你自己',
  '《手残的一百种死法》',
  '铁球：谢谢款待',
  '遥遥领先的死亡次数',
  '鼠鼠我啊，又没了',
  '这波啊，这波是白给',
  '建议直接卸载重开',
  '差亿点点就对了吧',
  '存档点都救不了你',
];
function randomTaunt() { return TAUNTS[(Math.random() * TAUNTS.length) | 0]; }
function deathRank(n) {
  if (n <= 19) return '猫里奥见习生';
  if (n <= 49) return '坑中老油条';
  if (n <= 99) return '不屈战神';
  return '受虐大师';
}

/* ---- 背景音乐：前瞻调度器，循环播放音符序列 ---- */
// 自创欢快小曲（避免版权旋律）
const SONG_OVER = {
  tempo: 0.115,
  lead: ('E5 G5 C6 G5 E5 G5 . .  D5 F5 B5 F5 D5 F5 . . ' +
    'C5 E5 G5 E5 C5 E5 . .  G4 B4 D5 B4 G4 B4 . . ' +
    'A4 C5 E5 C5 A4 C5 . .  F4 A4 C5 A4 F4 A4 . . ' +
    'G4 B4 D5 G5 . D5 B4 G4  C5 . G4 . E4 . C4 . ').trim().split(/\s+/),
  bass: ('C3 G3 C3 G3 C3 G3 C3 G3  G2 D3 G2 D3 G2 D3 G2 D3 ' +
    'C3 G3 C3 G3 C3 G3 C3 G3  G2 D3 G2 D3 G2 D3 G2 D3 ' +
    'A2 E3 A2 E3 A2 E3 A2 E3  F2 C3 F2 C3 F2 C3 F2 C3 ' +
    'G2 D3 G2 D3 G2 D3 B2 D3  C3 G3 E3 G3 C3 . . . ').trim().split(/\s+/)
};
const SONG_UNDER = {
  tempo: 0.14,
  lead: ('C4 . C5 . A3 . A4 .  Bb3 . Bb4 . . . . . ' +
    'C4 . C5 . A3 . A4 .  Bb3 . Bb4 . . . . . ').trim().split(/\s+/),
  bass: ('C2 . . . C2 . . .  F1 . . . F1 . . . ' +
    'C2 . . . C2 . . .  F1 . . . G1 . . . ').trim().split(/\s+/)
};
const SONG_NIGHT = {
  tempo: 0.16,
  lead: ('E5 . G5 . A5 . G5 .  E5 . C5 . D5 . . . ' +
    'E5 . G5 . A5 . C6 .  B5 . G5 . E5 . . . ').trim().split(/\s+/),
  bass: ('C3 . G2 . C3 . G2 .  A2 . E2 . A2 . E2 . ' +
    'F2 . C3 . F2 . C3 .  G2 . D3 . G2 . B2 . ').trim().split(/\s+/)
};
const SONG_STAR = {
  tempo: 0.075,
  lead: ('C5 D5 E5 G5 E5 D5 C5 D5  E5 G5 A5 G5 E5 D5 C5 . ').trim().split(/\s+/),
  bass: ('C3 C3 G2 G2 C3 C3 G2 G2  A2 A2 E2 E2 F2 F2 G2 G2 ').trim().split(/\s+/)
};
let music = null; // 当前音乐运行时状态
function startMusic(kind) {
  if (!AC) return;                       // 音频未初始化时静默跳过
  const songs = { over: SONG_OVER, under: SONG_UNDER, night: SONG_NIGHT, star: SONG_STAR };
  const song = songs[kind];
  if (!song) return;
  music = { song, idx: 0, bidx: 0, nextLead: AC.currentTime + 0.05, nextBass: AC.currentTime + 0.05, kind };
}
function stopMusic() { music = null; }
function updateMusic() {
  if (!music || !AC) return;
  const ahead = AC.currentTime + 0.18;
  const L = music.song.lead, B = music.song.bass;
  while (music.nextLead < ahead) {
    const n = L[music.idx % L.length];
    if (n !== '.' && !muted) tone(noteFreq(n), 0, music.song.tempo * 0.92, 'square', 0.12, music.nextLead - AC.currentTime, musicGain);
    music.idx++; music.nextLead += music.song.tempo;
  }
  while (music.nextBass < ahead) {
    const n = B[music.bidx % B.length];
    if (n !== '.' && !muted) tone(noteFreq(n), 0, music.song.tempo * 0.9, 'triangle', 0.22, music.nextBass - AC.currentTime, musicGain);
    music.bidx++; music.nextBass += music.song.tempo;
  }
}

/* ============================ 4. 像素精灵 ============================ */
function makeSprite(rows, pal) {
  const h = rows.length;
  const w = Math.max(...rows.map(r => r.length));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  for (let y = 0; y < h; y++)
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch === '.' || ch === ' ') continue;
      g.fillStyle = pal[ch] || '#ff00ff';
      g.fillRect(x, y, 1, 1);
    }
  return c;
}
// 马里奥调色板：普通 / 火力形态
const PAL_MARIO = { R: '#e93c2e', H: '#6b3410', S: '#ffcda5', O: '#2a5fd0', Y: '#ffd84d', K: '#141414', W: '#ffffff' };
const PAL_FIRE = { R: '#ffffff', H: '#6b3410', S: '#ffcda5', O: '#e93c2e', Y: '#ffd84d', K: '#141414', W: '#ffffff' };

// —— 小马里奥（12×16）——
const SM_HEAD = [
  "...RRRRRR...",
  "..RRRRRRRRR.",
  "...HHHSSK...",
  "..HSHSSSKS..",
  "..HSHHSSSS..",
  "..HHSSSSSS..",
  "....SSSS....",
];
const SM_IDLE = SM_HEAD.concat([
  "...RRORR....",
  "..RRROORRR..",
  ".RRRROORRRR.",
  ".SSRROOORRS.",
  ".SSOOOOOOSS.",
  "..OOOOOOOO..",
  "..OOO..OOO..",
  ".HHH....HHH.",
  "HHHH....HHHH",
]);
const SM_WALK = SM_HEAD.concat([
  "...RRORR....",
  "..RRROORRR..",
  ".RRRROORRRR.",
  ".SSRROOORRS.",
  ".SSOOOOOOSS.",
  "..OOOOOOO...",
  "...OOOO.HH..",
  "..HHH..HHHH.",
  "..HHH...HHH.",
]);
const SM_JUMP = SM_HEAD.concat([
  "..RRORRR.SS.",
  ".RRROOORRSS.",
  ".RRROOOORR..",
  ".SSROOOOO...",
  ".SSOOOOOO...",
  "..OOOOOOO...",
  "..OOOOOOO...",
  ".HHHH.HHH...",
  ".HHHH..HHH..",
]);
const SM_DEAD = SM_HEAD.concat([
  ".SS.RRRR.SS.",
  ".SSRROORRSS.",
  "..RRROORRR..",
  "...ROOOOR...",
  "...OOOOOO...",
  "..OOO..OOO..",
  "..OO....OO..",
  ".HHH....HHH.",
  ".HHH....HHH.",
]);

// —— 大马里奥（14×24）——
const BG_HEAD = [
  "....RRRRRR....",
  "...RRRRRRRRR..",
  "...RRRRRRRRR..",
  "...HHHSSSK....",
  "..HHSHSSSSKS..",
  "..HSSHSSSSKS..",
  "..HHSSSSSSSS..",
  "....SSSSSS....",
];
const BG_IDLE = BG_HEAD.concat([
  "...RRRRRRR....",
  "..RRRRRRRRR...",
  ".RRRRRRRRRRR..",
  ".RROOOOOOOORR.",
  ".RROOOOOOOORR.",
  "SSRROOOOOORRSS",
  "SSROOYOOYOORSS",
  "...OOOOOOOO...",
  "...OOOOOOOO...",
  "..OOOOOOOOOO..",
  "..OOOO..OOOO..",
  "..OOO....OOO..",
  "..OOO....OOO..",
  ".HHHH....HHHH.",
  ".HHHH....HHHH.",
  "HHHHH....HHHHH",
]);
const BG_WALK = BG_HEAD.concat([
  "...RRRRRRR....",
  "..RRRRRRRRR...",
  ".RRRRRRRRRRR..",
  ".RROOOOOOOORR.",
  ".RROOOOOOOORR.",
  "SSRROOOOOORRSS",
  "SSROOYOOYOORSS",
  "...OOOOOOOO...",
  "...OOOOOOOO...",
  "..OOOO.OOOO...",
  "..OOO...OOO...",
  ".OOO.....OOO..",
  ".HHHH...HHHH..",
  "HHHHH...HHHHH.",
  "HHHH.....HHHH.",
]);
const BG_JUMP = BG_HEAD.concat([
  "...RRRRRRR.SS.",
  "..RRRRRRRRRSS.",
  ".RRROOOOORRR..",
  "SSRROOOOOORR..",
  "SSROOOOOOOOR..",
  "..OOOYOOYOO...",
  "...OOOOOOOO...",
  "...OOOOOOOO...",
  "..OOOOOOOOO...",
  "..OOOO.OOOO...",
  "..OOO...OOO...",
  ".OOO....OOO...",
  ".HHHH..HHHH...",
  "HHHHH..HHHHH..",
  "HHHH....HHHH..",
]);
const BG_CROUCH = [
  "....RRRRRR....",
  "...RRRRRRRRR..",
  "...HHHSSSK....",
  "..HHSHSSSSKS..",
  "..HHSSSSSSSS..",
  "....SSSSSS....",
  ".RRRRRRRRRRR..",
  "SSRROOOOOORRSS",
  "..OOOOOOOOOO..",
  ".HHHH....HHHH.",
  "HHHHH....HHHHH",
];

function buildMarioSet(pal) {
  return {
    idle: makeSprite(SM_IDLE, pal), walk: makeSprite(SM_WALK, pal),
    jump: makeSprite(SM_JUMP, pal), dead: makeSprite(SM_DEAD, pal),
  };
}
function buildBigSet(pal) {
  return {
    idle: makeSprite(BG_IDLE, pal), walk: makeSprite(BG_WALK, pal),
    jump: makeSprite(BG_JUMP, pal), crouch: makeSprite(BG_CROUCH, pal),
  };
}

// —— 敌人与道具 ——
const PAL_GOOMBA = { E: '#a05a1c', D: '#472506', W: '#ffffff', K: '#141414' };
const GOOMBA_A = [
  "....EEEEEE....",
  "..EEEEEEEEEE..",
  ".EEEEEEEEEEEE.",
  ".EEWWWEEWWWEE.",
  "EEEWWKEEKWWEEE",
  "EEEEKEEEEKEEEE",
  "EEEEEEEEEEEEEE",
  ".EEEEEEEEEEEE.",
  "..EEEEEEEEEE..",
  ".DDDD....DDDD.",
  "DDDDD....DDDDD",
];
const GOOMBA_B = [
  "....EEEEEE....",
  "..EEEEEEEEEE..",
  ".EEEEEEEEEEEE.",
  ".EEWWWEEWWWEE.",
  "EEEWWKEEKWWEEE",
  "EEEEKEEEEKEEEE",
  "EEEEEEEEEEEEEE",
  ".EEEEEEEEEEEE.",
  "..EEEEEEEEEE..",
  "...DDDD.DDDD..",
  "..DDDD...DDDD.",
];
const GOOMBA_SQ = [
  "....EEEEEE....",
  ".EEEEEEEEEEEE.",
  "EEKWEEEEEEWKWE",
  ".EEEEEEEEEEEE.",
  "DDDDD....DDDDD",
];
const PAL_KOOPA_G = { G: '#2fa84f', L: '#9be04a', Y: '#ffd84d', W: '#ffffff', K: '#141414' };
const PAL_KOOPA_R = { G: '#e93c2e', L: '#ffb35a', Y: '#ffd84d', W: '#ffffff', K: '#141414' };
function koopaRows(step) {
  const head = [
    ".....GGG......",
    "....GGGGG.....",
    "....GWKGG.....",
    "....GGGGG.....",
    ".....GGG......",
  ];
  const body = [
    "..LLLLLLLL....",
    ".LLWLLLLWLLL..",
    ".LLLLLLLLLLLL.",
    ".LWLLWLLWLLLL.",
    ".LLLLLLLLLLLL.",
    ".LLWLLWLLWLLL.",
    "..LLLLLLLL....",
    "..YYYYYYYY....",
  ];
  const feet = step === 0
    ? ["..YY....YY....", ".YYY....YYY..."]
    : ["...YY...YY....", "..YYY..YYY...."];
  return head.concat(body, feet);
}
const SHELL_ROWS = [
  "...LLLLLLLL...",
  ".LLLLLLLLLLLL.",
  ".LWLLWLLWLLLL.",
  "LLLLLLLLLLLLLL",
  "LLWLLWLLWLLWLL",
  "LLLLLLLLLLLLLL",
  ".LLLLLLLLLLLL.",
  "..YYYYYYYYYY..",
];
const PAL_SHELL_G = { L: '#2fa84f', W: '#9be04a', Y: '#ffd84d' };
const PAL_SHELL_R = { L: '#e93c2e', W: '#ffb35a', Y: '#ffd84d' };
const WING_A = ["..WWW...", ".WWWWW..", "WWWWWWW.", "WWWWWW..", ".WWW....", "........"];
const WING_B = ["........", "..WWW...", ".WWWWW..", "WWWWWWW.", "WWWWWW..", ".WWW...."];

const PAL_MUSH = { R: '#e93c2e', W: '#ffffff', S: '#ffe3b3', K: '#141414' };
const MUSH_ROWS = [
  "....RRRRRR....",
  "..RRRWWRRRR...",
  ".RWWRWWRRWWR..",
  ".RWWRRRRRRWWR.",
  "RRRRRRRRRRRRRR",
  "RRWWRRRRRRWWRR",
  "RRWWRRRRRRWWRR",
  "RRRRRRRRRRRRRR",
  ".SSSSSSSSSSSS.",
  ".SSKSSSSSSKSS.",
  ".SSKSSSSSSKSS.",
  ".SSSSSSSSSSSS.",
  "..SSSSSSSSSS..",
  "...SSSSSSSS...",
];
const PAL_FLOWER = { W: '#ffffff', R: '#ff7b1f', G: '#2fa84f', O: '#ffd84d' };
const FLOWER_ROWS = [
  "....WWWWWW....",
  "..WWWRRRRWWW..",
  ".WWRRROORRRWW.",
  ".WRROOOOORRWW.",
  ".WRROOOOORRW..",
  ".WWRRROORRRW..",
  "..WWWRRRWWW...",
  "....WWWWWW....",
  "......GG......",
  "..G...GG...G..",
  ".GGG..GG..GGG.",
  "..GGGGGGGGGG..",
  "....GGGGGG....",
  "......GG......",
];
const STAR_ROWS = [
  "......YY......",
  "......YY......",
  ".....YYYY.....",
  ".....YYYY.....",
  "YYYYYKYYYYKYYY",
  ".YYYYYYYYYYYY.",
  "..YYYYYYYYYY..",
  "...YYYYYYYY...",
  "...YYYYYYYY...",
  "..YYYY..YYYY..",
  ".YYY......YYY.",
  ".YY........YY.",
];
const PAL_STAR = { Y: '#ffd84d', K: '#141414' };

function coinFrames() {
  const full = [
    "...YYYY...",
    ".YYYYYYYY.",
    ".YYWWYYYY.",
    "YYYWWYYYYY",
    "YYYYYYYYYY",
    "YYYYYYYYYY",
    "YYYYYYYYYY",
    "YYYYYYYYYY",
    "YYYWWYYYYY",
    ".YYWWYYYY.",
    ".YYYYYYYY.",
    "...YYYY...",
  ];
  const mid = [
    "....YY....",
    "...YYYY...",
    "...YWWY...",
    "...YWWY...",
    "...YYYY...",
    "...YYYY...",
    "...YYYY...",
    "...YYYY...",
    "...YYYY...",
    "...YWWY...",
    "...YYYY...",
    "....YY....",
  ];
  const thin = [];
  for (let i = 0; i < 12; i++) thin.push("....YY....");
  const P = { Y: '#ffd84d', W: '#fff3b0' };
  return [makeSprite(full, P), makeSprite(mid, P), makeSprite(thin, P), makeSprite(mid, P)];
}
const FIREBALL_ROWS = [
  "..RRR...",
  ".RRYYR..",
  "RRYYYYR.",
  "RYWWYYR.",
  "RYYYYYR.",
  ".RYYYR..",
  "..RRR...",
  "........",
];
const FLAG_ROWS = [
  "GGGGGGGGGGG...",
  "GGGGGGGGGGGG..",
  "GGWWGGGGGGGGG.",
  "GGWWWGGGGGGGG.",
  "GGWWGGGGGGGGG.",
  "GGGGGGGGGGGG..",
  "GGGGGGGGGGG...",
];
const QMARK_ROWS = [
  "..QQQQ..",
  ".QQ..QQ.",
  ".QQ..QQ.",
  "....QQ..",
  "...QQ...",
  "...QQ...",
  "........",
  "...QQ...",
  "...QQ...",
];

// 构建全部精灵
const SPR = {
  small: { n: buildMarioSet(PAL_MARIO), f: buildMarioSet(PAL_FIRE) },
  big: { n: buildBigSet(PAL_MARIO), f: buildBigSet(PAL_FIRE) },
  goomba: {
    a: makeSprite(GOOMBA_A, PAL_GOOMBA), b: makeSprite(GOOMBA_B, PAL_GOOMBA),
    squash: makeSprite(GOOMBA_SQ, PAL_GOOMBA),
  },
  koopa: {
    ga: makeSprite(koopaRows(0), PAL_KOOPA_G), gb: makeSprite(koopaRows(1), PAL_KOOPA_G),
    ra: makeSprite(koopaRows(0), PAL_KOOPA_R), rb: makeSprite(koopaRows(1), PAL_KOOPA_R),
    shellG: makeSprite(SHELL_ROWS, PAL_SHELL_G), shellR: makeSprite(SHELL_ROWS, PAL_SHELL_R),
  },
  wing: [makeSprite(WING_A, { W: '#ffffff' }), makeSprite(WING_B, { W: '#ffffff' })],
  mush: makeSprite(MUSH_ROWS, PAL_MUSH),
  oneup: makeSprite(MUSH_ROWS, { R: '#2fa84f', W: '#ffffff', S: '#ffe3b3', K: '#141414' }),
  flower: makeSprite(FLOWER_ROWS, PAL_FLOWER),
  star: makeSprite(STAR_ROWS, PAL_STAR),
  coin: coinFrames(),
  fireball: makeSprite(FIREBALL_ROWS, { R: '#e93c2e', Y: '#ffd84d', W: '#ffffff' }),
  flag: makeSprite(FLAG_ROWS, { G: '#2fa84f', W: '#ffffff' }),
  qmark: makeSprite(QMARK_ROWS, { Q: '#ffffff' }),
};

// 绘制精灵（支持水平翻转）
function drawSprite(img, x, y, flip) {
  x = Math.round(x); y = Math.round(y);
  if (flip) {
    ctx.save();
    ctx.translate(x + img.width, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  } else ctx.drawImage(img, x, y);
}

/* ============================ 5. 关卡数据 ============================
   采用「关卡构建器」程序化生成地图（杜绝字符画对齐错误）。
   坐标单位为瓦片格；y=15,16 为地面层；每关由指令序列搭建。        */

/* ---- 瓦片类型枚举 ---- */
const T = {
  EMPTY: 0, GROUND: 1, BRICK: 2, QCOIN: 3, QPOWER: 4, QSTAR: 5,
  HIDDEN: 6, SOLID: 7, PIPE_TL: 8, PIPE_TR: 9, PIPE_L: 10, PIPE_R: 11,
  USED: 12, POLE: 13, POLETOP: 14, PLAT: 15, SPIKE: 16,
  CRACK: 17,       // 裂纹地面（踩上塌陷）——恶搞版
  FAKEBRICK: 18,   // 假砖：接触即碎（外观与真砖一致）——恶搞版
  QBAD: 19,        // 陷阱宝箱：顶了弹怪（外观与金币问号一致）——恶搞版
  QPOISON: 20,     // 毒蘑菇块（外观与道具问号一致）——恶搞版
};
const SOLIDS = new Set([T.GROUND, T.BRICK, T.QCOIN, T.QPOWER, T.QSTAR, T.SOLID, T.PIPE_TL, T.PIPE_TR, T.PIPE_L, T.PIPE_R, T.USED, T.CRACK, T.QBAD, T.QPOISON]);

/* ---- 运行时关卡容器 ---- */
let lv = null;          // 当前关卡的瓦片与信息
let spawns = [];        // 敌人出生点
let coinsEnt = [];      // 场景金币实体
let startPt = { x: 48, y: 100 };
let flagX = 0, castleX = 0, flagTopY = 0, flagBaseY = 0;

class LB {
  constructor(w, theme, name) {
    this.w = w; this.h = 17;
    this.tiles = [];
    for (let y = 0; y < this.h; y++) this.tiles.push(new Array(w).fill(T.EMPTY));
    this.spawns = []; this.coinsEnt = [];
    this.checkpoints = []; this.triggers = []; this.fakeFlags = [];
    this.start = { x: 48, y: 200 };
    this.flagX = 0; this.castleX = 0;
    this.theme = theme; this.name = name;
  }
  put(x, y, t) { if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.tiles[y][x] = t; return this; }
  box(x0, y0, x1, y1, t) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.put(x, y, t); return this; }
  row(x0, x1, y, t) { return this.box(x0, y, x1, y, t); }
  ground(x0, x1) { return this.box(x0, 15, x1, 16, T.GROUND); }
  pipe(x, h) {   // 两格宽管道，管口在地面上方 h 格
    const top = 15 - h;
    this.put(x, top, T.PIPE_TL).put(x + 1, top, T.PIPE_TR);
    for (let y = top + 1; y <= 14; y++) { this.put(x, y, T.PIPE_L); this.put(x + 1, y, T.PIPE_R); }
    return this;
  }
  stairUp(x0, n) { for (let i = 0; i < n; i++) this.box(x0 + i, 14 - i, x0 + i, 14, T.SOLID); return this; }
  stairDown(x0, n) { for (let i = 0; i < n; i++) this.box(x0 + i, 14 - (n - 1 - i), x0 + i, 14, T.SOLID); return this; }
  plat(x0, x1, y) { return this.row(x0, x1, y, T.PLAT); }
  coins(x0, x1, y) { for (let x = x0; x <= x1; x++) this.coinsEnt.push(makeCoin(x * TILE + 3, y * TILE + 1)); return this; }
  coin(x, y) { this.coinsEnt.push(makeCoin(x * TILE + 3, y * TILE + 1)); return this; }
  en(type, gx, gy) {   // 敌人出生点（进入屏幕右侧时激活）
    const py = gy * TILE + (type === 'goomba' ? 4 : type === 'koopa' ? -4 : 0);
    this.spawns.push({ type, x: gx * TILE + 1, y: py });
    return this;
  }
  player(gx, gy) { this.start = { x: gx * TILE, y: gy * TILE }; return this; }
  flag(gx) {           // 旗杆：顶部圆球 + 杆 + 底座硬块
    this.flagX = gx * TILE + 8;
    this.put(gx, 4, T.POLETOP);
    for (let y = 5; y <= 13; y++) this.put(gx, y, T.POLE);
    this.put(gx, 14, T.SOLID);
    return this;
  }
  castle(gx) { this.castleX = gx * TILE; return this; }

  /* ---- 恶搞版专用指令 ---- */
  checkpoint(gx) {   // 自动存档点小旗
    this.checkpoints.push({ x: gx * TILE + 2, y: 13 * TILE, idx: this.checkpoints.length, on: false });
    return this;
  }
  trigger(gx, gy, gw, gh, action, opts) {   // 隐形感应区（玩家进入即执行动作）
    this.triggers.push({
      x: gx * TILE, y: gy * TILE, w: gw * TILE, h: gh * TILE,
      action, opts: opts || {}, armed: true,
    });
    return this;
  }
  crack(gx0, gx1) {   // 裂纹地面：踩上抖动后整段塌陷成深渊
    for (let x = gx0; x <= gx1; x++) { this.put(x, 15, T.CRACK); this.put(x, 16, T.CRACK); }
    return this;
  }
  crackAt(gx0, gx1, gy) {   // 单行裂纹（用于桥面破洞）
    for (let x = gx0; x <= gx1; x++) this.put(x, gy, T.CRACK);
    return this;
  }
  fakebrick(gx0, gx1, gy) {   // 假砖排：外观与真砖一致，接触即碎
    return this.row(gx0, gx1, gy, T.FAKEBRICK);
  }
  qbad(gx, gy) { this.put(gx, gy, T.QBAD); return this; }        // 弹怪宝箱
  qpoison(gx, gy) { this.put(gx, gy, T.QPOISON); return this; }  // 毒蘑菇块
  fakeflag(gx) {   // 假旗杆：碰到变红掉落并召唤追杀怪
    this.fakeFlags.push({ x: gx * TILE + 8, triggered: false });
    this.put(gx, 4, T.POLETOP);
    for (let y = 5; y <= 13; y++) this.put(gx, y, T.POLE);
    this.put(gx, 14, T.SOLID);
    // 感应区覆盖旗杆左右各2格、高度全杆
    this.trigger(gx - 1, 5, 4, 10, 'fakeflag', { idx: this.fakeFlags.length - 1 });
    return this;
  }
  dropAt(gx, kind) {   // 天降物感应区：走到该列附近头顶先闪阴影再砸落
    return this.trigger(gx - 1, 8, 3, 8, 'drop', { x: (gx + 0.5) * TILE - 8, kind: kind || 'ball' });
  }
}

/* ---- 第 1 关：绿野入门（白天草原主题）---- */
function buildLevel1() {
  const b = new LB(214, 'over', '1-1');
  b.player(3, 12)
    .ground(0, 57).ground(60, 89).ground(93, 153).ground(158, 213)
    // 开局教学问号 + 砖排
    .put(18, 9, T.QCOIN)
    .put(23, 9, T.BRICK).put(24, 9, T.QCOIN).put(25, 9, T.BRICK)
    .put(26, 9, T.QPOWER).put(27, 9, T.BRICK)
    .put(25, 5, T.QCOIN)
    // 三根渐高管道 + 栗子怪
    .pipe(34, 2).pipe(41, 3).pipe(49, 4)
    .en('goomba', 37, 14).en('goomba', 46, 14).en('goomba', 47.5, 14)
    // 道具砖 + 高处金币
    .put(66, 9, T.BRICK).put(67, 9, T.QPOWER).put(68, 9, T.BRICK).coins(66, 68, 5)
    .row(78, 81, 9, T.BRICK).en('koopa', 83, 14)
    // 第一座阶梯
    .stairUp(100, 4).box(104, 11, 105, 14, T.SOLID).stairDown(106, 3)
    // 金币弧线 + 问号三连
    .coin(116, 10).coin(117, 9).coin(118, 8).coin(119, 9).coin(120, 10)
    .put(123, 9, T.QCOIN).put(126, 9, T.QPOWER).put(129, 9, T.QCOIN)
    .en('goomba', 124, 14).en('goomba', 125.5, 14)
    .pipe(135, 3)
    .en('para', 142, 7)
    // 云台飞跃段
    .plat(144, 146, 12).plat(149, 152, 9).coins(149, 151, 8)
    .plat(156, 159, 7).coins(156, 159, 6)
    .en('goomba', 168, 14).en('goomba', 169.5, 14)
    .put(171, 9, T.QSTAR)
    // 终点大金字塔 + 旗杆城堡
    .stairUp(178, 8).box(186, 7, 187, 14, T.SOLID)
    .flag(196).castle(203);
  return b;
}

/* ---- 第 2 关：地下矿洞（蓝砖洞穴主题）---- */
function buildLevel2() {
  const b = new LB(208, 'under', '1-2');
  b.player(3, 13)
    .box(0, 0, 163, 1, T.GROUND)                    // 洞顶（出口区开放）
    .ground(0, 59).ground(63, 87).ground(92, 157).ground(162, 207)
    .row(8, 11, 9, T.BRICK).coins(8, 11, 8)
    .put(14, 9, T.QCOIN)
    .row(20, 23, 14, T.SPIKE)                       // 尖刺沟
    .en('goomba', 28, 14).en('goomba', 29.5, 14)
    .plat(34, 44, 12).coins(34, 44, 11)             // 低空金币走廊
    .en('koopa', 48, 14).en('koopa', 52, 14)
    .put(56, 9, T.QPOWER)
    .stairUp(66, 4).box(70, 11, 73, 14, T.SOLID).stairDown(74, 3)
    .put(80, 9, T.QSTAR)
    .put(84, 9, T.HIDDEN)                           // 彩蛋隐形砖：1UP蘑菇
    .plat(89, 90, 11)
    .pipe(96, 2).en('goomba', 100, 14)
    .pipe(104, 4).en('goomba', 109, 14).en('goomba', 110.5, 14)
    .pipe(113, 3);
  for (let x = 120; x <= 132; x += 2) b.coin(x, (x % 4 < 2) ? 9 : 8);   // 金币波浪
  b.en('goomba', 138, 14).en('goomba', 141, 14).en('goomba', 144, 14)
    .plat(152, 155, 7).put(153, 5, T.QPOWER)
    .stairUp(170, 8).box(178, 7, 179, 14, T.SOLID)
    .flag(188).castle(196);
  return b;
}

/* ---- 第 3 关：星夜险境（夜晚高难主题）---- */
function buildLevel3() {
  const b = new LB(236, 'night', '1-3');
  b.player(2, 12)
    // 开局连续断崖云台
    .ground(0, 5).plat(7, 8, 11).plat(13, 14, 9)
    .ground(16, 41).en('goomba', 18, 14)
    .box(22, 13, 23, 14, T.SOLID).box(24, 10, 27, 14, T.SOLID).put(25, 8, T.QPOWER)
    .en('para', 32, 8).en('koopa', 36, 14)
    // 高架长桥（桥下是深渊）
    .row(42, 64, 12, T.SOLID)
    .en('goomba', 48, 11).en('goomba', 54, 11).en('goomba', 60, 11)
    .put(63, 10, T.QSTAR)
    .ground(66, 72)
    .put(78, 9, T.BRICK).put(79, 9, T.QCOIN).put(80, 9, T.QPOWER).put(81, 9, T.QCOIN).put(82, 9, T.BRICK)
    .en('para', 85, 7)
    .ground(88, 107)
    .row(90, 93, 14, T.SPIKE).row(97, 100, 14, T.SPIKE).row(104, 105, 14, T.SPIKE)
    .plat(113, 114, 11)
    .ground(122, 149).coins(124, 132, 12)
    .en('goomba', 136, 14).en('goomba', 139, 14).en('goomba', 142, 14).en('goomba', 145, 14)
    .put(148, 9, T.QSTAR)
    // 大坑三连跳台
    .plat(151, 152, 12).plat(154, 155, 9).plat(158, 159, 7)
    .ground(162, 191)
    .stairUp(166, 8).stairDown(175, 8)              // 双峰夹缝
    .en('goomba', 186, 14).en('goomba', 187.5, 14)
    .ground(196, 235)
    .stairUp(200, 8).box(208, 7, 209, 14, T.SOLID)
    .flag(216).castle(224);
  return b;
}

/* ---- 恶搞 坑-1「熟悉又陌生」：开局故意让你放松警惕 ---- */
function buildTroll1() {
  const b = new LB(176, 'over', '坑-1');
  b.player(3, 12)
    .ground(0, 45).ground(49, 89).ground(93, 175)
    .checkpoint(14)
    .trigger(17, 8, 2, 7, 'scare')                                   // 第一次惊吓：白屏+鬼叫
    // 宝箱阵：真蘑菇混着弹怪宝箱
    .put(24, 10, T.QCOIN).put(25, 10, T.QCOIN).put(26, 10, T.QPOWER)
    .qbad(27, 10).put(28, 10, T.QCOIN)
    .dropAt(36, 'ball')                                              // 天降铁球（有阴影预警）
    // 坑上假砖桥：看着像垫脚桥，踩上去全碎
    .fakebrick(46, 48, 12)
    .en('goomba', 53, 14)
    .crack(58, 61)                                                   // 裂纹地面：快速冲跳或塌陷
    // 金币诱饵：捡币正欢时砧板砸下
    .coins(68, 71, 9).dropAt(69, 'anvil')
    .pipe(76, 2).en('goomba', 80, 14)
    .trigger(86, 4, 9, 11, 'rain')                                   // 天降物走廊
    .checkpoint(97)
    .coins(104, 106, 11)
    .put(112, 9, T.QSTAR)                                            // 星星补偿玩家
    .checkpoint(120)
    .en('koopa', 126, 14).en('goomba', 130, 14)
    .stairUp(130, 4).box(134, 11, 135, 14, T.SOLID).stairDown(136, 3)
    .flag(152).castle(162);
  return b;
}

/* ---- 恶搞 坑-2「信任危机」：地面和道具都不可信 ---- */
function buildTroll2() {
  const b = new LB(208, 'under', '坑-2');
  b.player(3, 13)
    .box(0, 0, 163, 1, T.GROUND)
    .ground(0, 33).ground(39, 79).ground(84, 163).ground(167, 207)
    .checkpoint(6)
    .en('koopa', 10, 14)                                             // 存档点旁蹲敌人（最损）
    .qpoison(16, 9)                                                  // 毒蘑菇块：操控反转!
    .row(24, 27, 14, T.SPIKE)                                        // 反转状态下过刺阵……
    .crack(34, 38)
    .checkpoint(42)
    // 假砖天梯：下半真砖上半假砖，爬到一半全碎
    .box(48, 12, 49, 14, T.BRICK).fakebrick(50, 53, 9).row(48, 49, 11, T.BRICK)
    // 宝箱阵混弹怪
    .put(60, 9, T.QCOIN).qbad(61, 9).put(62, 9, T.QCOIN).put(63, 9, T.QPOWER).put(64, 9, T.QCOIN)
    .dropAt(70, 'ball').dropAt(74, 'ball')                           // 双铁球连击
    .crack(80, 83)
    .checkpoint(88)
    .fakeflag(100)                                                   // 第一次假旗杆 + 追杀怪!
    .pipe(120, 2).en('goomba', 125, 14)
    .pipe(128, 4).en('goomba', 133, 14)
    .pipe(136, 3)
    .put(146, 9, T.QSTAR)                                            // 星星安抚
    .crack(154, 157)
    .checkpoint(162)
    .stairUp(170, 7).box(177, 8, 178, 14, T.SOLID)
    .flag(186).castle(194);
  return b;
}

/* ---- 恶搞 坑-3「终极背叛」：把前两关学到的全部推翻 ---- */
function buildTroll3() {
  const b = new LB(224, 'night', '坑-3');
  b.player(2, 12)
    .ground(0, 30).ground(34, 62).ground(92, 148).ground(158, 223)
    .plat(6, 8, 11).plat(11, 13, 9)
    .dropAt(16, 'anvil')                                             // 刚落地就砸
    .checkpoint(20)
    // 上层假砖阵：顶了碎一地
    .row(26, 30, 9, T.BRICK).fakebrick(26, 30, 5)
    .qpoison(32, 10)
    .row(38, 41, 14, T.SPIKE).row(45, 48, 14, T.SPIKE)
    .trigger(54, 4, 8, 11, 'rain')
    .checkpoint(62)
    // 高架长桥，中段是破损桥板（踩上塌）
    .row(66, 88, 12, T.SOLID).crackAt(74, 77, 12)
    .en('goomba', 70, 11).en('goomba', 84, 11)
    .checkpoint(92)
    .coins(96, 99, 11)
    .fakeflag(110)                                                   // 双假旗杆连环计
    .put(120, 9, T.QSTAR)                                            // 两旗之间给星星续命
    .fakeflag(130)
    // 真终点前最后考验
    .plat(151, 152, 12)
    .row(156, 159, 14, T.SPIKE)
    .trigger(160, 4, 6, 11, 'rain')
    .checkpoint(166)
    .stairUp(172, 8).box(180, 7, 181, 14, T.SOLID).stairDown(182, 8)
    .en('goomba', 192, 14).en('goomba', 193.5, 14)
    .flag(202).castle(212);
  return b;
}

const CLASSIC_LEVELS = [
  { name: '1-1', theme: 'over', time: 300, build: buildLevel1 },
  { name: '1-2', theme: 'under', time: 300, build: buildLevel2 },
  { name: '1-3', theme: 'night', time: 300, build: buildLevel3 },
];
const TROLL_LEVELS = [
  { name: '坑-1', theme: 'over', time: 300, build: buildTroll1 },
  { name: '坑-2', theme: 'under', time: 300, build: buildTroll2 },
  { name: '坑-3', theme: 'night', time: 300, build: buildTroll3 },
];
const MODES = [
  { label: '经典版', levels: CLASSIC_LEVELS },
  { label: '恶搞版', levels: TROLL_LEVELS },
];
function modeLevels() { return MODES[curMode].levels; }
function levelCount() { return MODES[curMode].levels.length; }

/* ---- 由构建器产出运行时关卡 ---- */
function levelFromBuilder(def) {
  const b = def.build();
  spawns = b.spawns;
  coinsEnt = b.coinsEnt;
  startPt = b.start;
  flagX = b.flagX; castleX = b.castleX;
  flagTopY = 4 * TILE; flagBaseY = 14 * TILE;
  checkpoints = b.checkpoints || [];
  triggers = b.triggers || [];
  fakeFlags = b.fakeFlags || [];
  // 恢复本关已激活的存档点（死亡重生后保持点亮）
  const saved = activatedCP[curMode][curLevel];
  if (saved) for (const c of checkpoints) if (saved.includes(c.idx)) c.on = true;
  return { w: b.w, h: b.h, tiles: b.tiles, theme: def.theme, name: def.name, time: def.time };
}

/* ============================ 6. 物理与瓦片 ============================ */
function tileAt(tx, ty) {
  if (!lv) return T.EMPTY;
  if (tx < 0 || tx >= lv.w) return T.SOLID;
  if (ty < 0 || ty >= lv.h) return T.EMPTY;
  return lv.tiles[ty][tx];
}
function setTile(tx, ty, v) {
  if (tx >= 0 && tx < lv.w && ty >= 0 && ty < lv.h) lv.tiles[ty][tx] = v;
}
const isSolidT = t => SOLIDS.has(t);

// 水平移动 + 瓦片碰撞。返回是否撞墙
function moveX(e) {
  e.x += e.vx;
  if (e.vx === 0) return false;
  const dir = e.vx > 0 ? 1 : -1;
  const edge = e.vx > 0 ? e.x + e.w : e.x;
  const tx = Math.floor(edge / TILE);
  const ys = [e.y + 2, e.y + e.h / 2, e.y + e.h - 2];
  for (const py of ys) {
    const t = tileAt(tx, Math.floor(py / TILE));
    if (isSolidT(t)) {
      e.x = e.vx > 0 ? tx * TILE - e.w - 0.01 : (tx + 1) * TILE + 0.01;
      return true;
    }
  }
  void dir;
  return false;
}
// 垂直移动 + 瓦片碰撞。马里奥额外收集顶到的砖
function moveY(e, isMario) {
  const prevBottom = e.y + e.h;
  e.y += e.vy;
  e.onGround = false;
  if (e.vy > 0) {
    const ty = Math.floor((e.y + e.h) / TILE);
    const xs = [e.x + 1, e.x + e.w / 2, e.x + e.w - 1];
    for (const px of xs) {
      const tx = Math.floor(px / TILE);
      const t = tileAt(tx, ty);
      const platOk = t === T.PLAT && prevBottom <= ty * TILE + 0.01 && !e.dropThru;
      if (isSolidT(t) || platOk) {
        e.y = ty * TILE - e.h; e.vy = 0; e.onGround = true;
        return;
      }
    }
  } else if (e.vy < 0) {
    const ty = Math.floor(e.y / TILE);
    const hits = [];
    const xs = [e.x + 1, e.x + e.w / 2, e.x + e.w - 1];
    for (const px of xs) {
      const tx = Math.floor(px / TILE);
      const t = tileAt(tx, ty);
      if (isSolidT(t) || (t === T.HIDDEN && isMario)) {
        if (!hits.some(h => h.tx === tx)) hits.push({ tx, ty, t });
      }
    }
    if (hits.length) {
      e.y = (ty + 1) * TILE + 0.01; e.vy = 0;
      if (isMario) e.ceilHits = hits;
    }
  }
}
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/* ============================ 7. 特效对象 ============================ */
let particles = [];   // {x,y,vx,vy,g,life,color,size,rot,vr}
let floaters = [];    // {x,y,text,life}
let bumps = [];       // {tx,ty,t} 顶砖动画
let popCoins = [];    // 从砖块弹出的金币动画

function addParticle(x, y, vx, vy, color, size, life, g) {
  particles.push({ x, y, vx, vy, color, size: size || 3, life: life || 40, g: g == null ? 0.25 : g, rot: Math.random() * 6, vr: rnd(-0.3, 0.3) });
}
function brickBits(tx, ty) {
  for (let i = 0; i < 4; i++)
    addParticle(tx * TILE + 4 + (i % 2) * 8, ty * TILE + 4 + ((i / 2) | 0) * 8,
      (i % 2 ? 1 : -1) * rnd(0.8, 1.8), rnd(-5, -3), '#c85c20', 6, 60, 0.3);
}
function addFloater(x, y, text) { floaters.push({ x, y, text, life: 50 }); }
function addScore(n, x, y) {
  score += n;
  if (x != null) addFloater(x, y, '' + n);
}

/* ============================ 8. 马里奥 ============================ */
const mario = {
  x: 0, y: 0, w: 12, h: 14, vx: 0, vy: 0,
  form: 0,           // 0 小 1 大 2 火
  dir: 1, onGround: false,
  invulnT: 0, starT: 0, transformT: 0,
  coyote: 0, buffer: 0, dropThru: 0, crouch: false,
  comboN: 0, ceilHits: [], animT: 0, fireCD: 0,
};
function resetMario(fullForm) {
  mario.x = startPt.x; mario.y = startPt.y;
  mario.vx = 0; mario.vy = 0; mario.dir = 1;
  mario.form = fullForm ? 0 : mario.form;
  applyMarioSize();
  mario.invulnT = 0; mario.starT = 0; mario.transformT = 0;
  mario.comboN = 0; mario.crouch = false;
}
function applyMarioSize() {
  const bottom = mario.y + mario.h;
  if (mario.form === 0) mario.h = 14; else mario.h = 22;
  mario.w = 12;
  mario.y = bottom - mario.h;
}
function marioDie(cause) {
  state = 'dying'; stateTimer = 0;
  mario.vy = -8.5; mario.vx = 0;
  playSfx('die');
  // 恶搞版：死亡计数、鬼畜音效、随机嘲讽、墓碑教学
  if (curMode === 1) {
    trollDeaths++;
    deathMsg = randomTaunt();
    playSfx('ghost');
    tombstones.push({ lv: curLevel, x: mario.x, y: mario.y, cause: cause || '不明原因' });
  }
}
function marioHurt() {
  if (mario.invulnT > 0 || mario.starT > 0 || mario.transformT > 0) return;
  if (mario.form > 0) {
    mario.form--; applyMarioSize();
    mario.invulnT = 120; mario.transformT = 30;
    playSfx('powerdown');
  } else marioDie();
}

function updateMario() {
  const M = mario;
  // 变身冻结期间只闪烁不移动
  if (M.transformT > 0) { M.transformT--; return; }

  const onGroundPrev = M.onGround;
  // —— 水平输入 ——
  M.crouch = (M.form > 0) && inDown() && M.onGround;
  const acc = inRun() ? 0.14 : 0.09;
  const maxV = M.crouch ? 0 : (inRun() ? 3.1 : 1.8);
  if (!M.crouch) {
    if (inLeft()) { M.vx -= acc; M.dir = -1; }
    if (inRight()) { M.vx += acc; M.dir = 1; }
  }
  if (!inLeft() && !inRight()) M.vx *= M.onGround ? 0.83 : 0.96;
  if (Math.abs(M.vx) < 0.05) M.vx = 0;
  M.vx = clamp(M.vx, -maxV, maxV);
  // 打滑急停
  if (M.onGround && ((inLeft() && M.vx > 1) || (inRight() && M.vx < -1))) M.vx *= 0.72;

  // —— 跳跃（含土狼时间与缓冲）——
  if (M.onGround) M.coyote = 6; else if (M.coyote > 0) M.coyote--;
  if (inJumpPress()) M.buffer = 7;
  if (M.buffer > 0) {
    M.buffer--;
    if (M.onGround || M.coyote > 0) {
      M.vy = -(7.4 + Math.abs(M.vx) * 0.26);
      M.onGround = false; M.coyote = 0; M.buffer = 0;
      playSfx('jump');
    }
  }
  // 可变跳跃高度：松开跳跃键则提前下落
  const grav = (M.vy < 0 && inJumpHeld()) ? 0.3 : 0.44;
  M.vy = Math.min(M.vy + grav, 7);

  // 下穿平台
  if (M.dropThru > 0) M.dropThru--;
  if (M.onGround && inDown()) {
    const ty = Math.floor((M.y + M.h + 1) / TILE);
    const xs = [Math.floor((M.x + 1) / TILE), Math.floor((M.x + M.w - 1) / TILE)];
    if (xs.every(tx => tileAt(tx, ty) === T.PLAT)) M.dropThru = 12;
  }

  // —— 发射火球 ——
  if (M.fireCD > 0) M.fireCD--;
  if (M.form === 2 && !M.crouch && jp('KeyX') || M.form === 2 && !M.crouch && jp('KeyJ')) {
    if (fireballs.length < 2 && M.fireCD === 0) {
      fireballs.push({ x: M.x + (M.dir > 0 ? M.w : -6), y: M.y + 6, w: 6, h: 6, vx: 5 * M.dir, vy: 1, life: 220 });
      M.fireCD = 14;
      playSfx('fireball');
    }
  }

  // —— 位移与碰撞 ——
  M.ceilHits = [];
  moveX(M);
  moveY(M, true);
  if (M.ceilHits.length) {
    // 选距离头部中心最近的砖触发
    const cx = M.x + M.w / 2;
    let best = M.ceilHits[0], bd = 1e9;
    for (const h of M.ceilHits) {
      const d = Math.abs((h.tx + 0.5) * TILE - cx);
      if (d < bd) { bd = d; best = h; }
    }
    bumpBlock(best.tx, best.ty);
  }
  // 落地尘
  if (!onGroundPrev && M.onGround && M.vy >= 0) {
    M.comboN = 0;
    for (let i = 0; i < 3; i++) addParticle(M.x + M.w / 2 + rnd(-5, 5), M.y + M.h, rnd(-0.6, 0.6), rnd(-1, -0.2), '#ddd', 2, 14, 0.05);
  }

  // 计时器
  if (M.invulnT > 0) M.invulnT--;
  if (M.starT > 0) {
    M.starT--;
    if (M.starT === 0) startMusic(lv.theme === 'under' ? 'under' : lv.theme === 'night' ? 'night' : 'over');
  }

  // 掉坑
  if (M.y > lv.h * TILE + 32) marioDie();

  // 尖刺：扫描身体覆盖的所有格子
  if (M.invulnT === 0 && M.starT === 0) {
    const x0 = Math.floor(M.x / TILE), x1 = Math.floor((M.x + M.w - 1) / TILE);
    const y0 = Math.floor(M.y / TILE), y1 = Math.floor((M.y + M.h - 1) / TILE);
    let spiked = false;
    for (let ty = y0; ty <= y1 && !spiked; ty++)
      for (let tx = x0; tx <= x1; tx++)
        if (tileAt(tx, ty) === T.SPIKE) { spiked = true; break; }
    if (spiked) marioHurt();
  }

  // 抵达旗杆
  if (state === 'play' && flagX && M.x + M.w > flagX - 2 && M.x < flagX + 4) {
    enterFlag();
  }
}

function drawMario(cam) {
  const M = mario;
  if (M.invulnT > 0 && (frame >> 2 & 1) && state !== 'dying') return; // 受伤闪烁
  const palKey = M.form === 2 ? 'f' : 'n';
  let set = M.form === 0 ? SPR.small[palKey] : SPR.big[palKey];
  let img;
  if (state === 'dying') img = SPR.small.n.dead;
  else if (M.form > 0 && M.crouch) img = set.crouch;
  else if (!M.onGround) img = set.jump;
  else if (Math.abs(M.vx) > 0.2) img = (frame >> 3 & 1) ? set.walk : set.idle;
  else img = set.idle;

  const sw = img.width, sh = img.height;
  const dx = M.x + M.w / 2 - sw / 2 - cam;
  const dy = M.y + M.h - sh;
  ctx.save();
  if (M.starT > 0 && !(M.starT < 120 && (frame >> 2 & 1))) {
    try { ctx.filter = `hue-rotate(${(frame * 25) % 360}deg)`; } catch (e) { }
  } else if (M.transformT > 0 && (frame >> 2 & 1)) {
    ctx.globalAlpha = 0.5;
  }
  drawSprite(img, dx, dy, M.dir < 0);
  ctx.restore();
}

/* ============================ 9. 敌人与物品 ============================ */
let enemies = [], items = [], fireballs = [], shells = [];
let spawnQueue = [];

function spawnEnemiesIfVisible() {
  for (let i = spawnQueue.length - 1; i >= 0; i--) {
    const s = spawnQueue[i];
    if (s.x < camX + VW + 32) {
      if (s.type === 'goomba')
        enemies.push({ kind: 'goomba', x: s.x, y: s.y, w: 12, h: 11, vx: -0.5, vy: 0, alive: true, squashT: 0, flipDie: 0 });
      else if (s.type === 'koopa')
        enemies.push({ kind: 'koopa', x: s.x, y: s.y, w: 12, h: 15, vx: -0.45, vy: 0, alive: true, flipDie: 0 });
      else if (s.type === 'para')
        enemies.push({ kind: 'para', x: s.x, y: s.y, w: 12, h: 15, vx: -0.4, vy: 0, alive: true, baseY: s.y, phase: Math.random() * 6, red: true, flipDie: 0 });
      spawnQueue.splice(i, 1);
    }
  }
}

function killEnemyFlip(e, pts) {
  e.flipDie = 1; e.vy = -5; e.vx = 1 * (Math.random() < 0.5 ? -1 : 1);
  addScore(pts, e.x, e.y);
  playSfx('kick');
}

function updateEnemies() {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.flipDie) {          // 被火球/星星/龟壳击杀：翻转飞出
      e.vy += 0.35; e.x += e.vx; e.y += e.vy;
      if (e.y > lv.h * TILE + 60) enemies.splice(i, 1);
      continue;
    }
    if (e.squashT > 0) { e.squashT--; if (e.squashT === 0) enemies.splice(i, 1); continue; }

    // 激活后才更新（进入屏幕）
    if (e.x > camX + VW + 16 || e.x + e.w < camX - 64) { if (e.x > camX + VW + 16) continue; }

    if (e.kind === 'para') {
      e.phase += 0.06;
      e.y = e.baseY + Math.sin(e.phase) * 26;
      e.x += e.vx;
      if (moveX(e)) e.vx = -e.vx;
    } else {
      e.vy = Math.min(e.vy + 0.3, 7);
      if (moveX(e)) e.vx = -e.vx;
      moveY(e, false);
    }
    if (e.y > lv.h * TILE + 60) { enemies.splice(i, 1); continue; }

    // 与其他敌人互撞换向
    for (const o of enemies) {
      if (o === e || o.flipDie || o.squashT > 0 || o.kind === 'para') continue;
      if (overlap(e, o)) {
        const el = e.x < o.x;
        e.vx = el ? -Math.abs(e.vx) : Math.abs(e.vx);
        o.vx = el ? Math.abs(o.vx) : -Math.abs(o.vx);
      }
    }

    // 与马里奥交互
    if (state !== 'play' || overlap(mario, e)) {
      if (state !== 'play') continue;
      if (mario.starT > 0) { killEnemyFlip(e, 200); continue; }
      const stomping = mario.vy > 0 && (mario.y + mario.h) - e.y < 10;
      if (stomping) {
        mario.vy = inJumpHeld() ? -6.5 : -4.2;
        mario.comboN = Math.min(mario.comboN + 1, 6);
        const comboPts = [100, 200, 400, 800, 1000, 2000, 4000][mario.comboN - 1] || 4000;
        if (e.kind === 'goomba') {
          e.squashT = 26; addScore(comboPts, e.x, e.y - 8); playSfx('stomp');
        } else if (e.kind === 'koopa') {
          toShell(e); addScore(comboPts, e.x, e.y - 8); playSfx('stomp');
        } else if (e.kind === 'para') {
          // 变成走路乌龟
          e.kind = 'koopa'; e.red = true; e.baseY = e.y; e.vy = 0;
          addScore(comboPts, e.x, e.y - 8); playSfx('stomp');
        }
      } else if (mario.invulnT === 0) {
        marioHurt();
      }
    }
  }

  // —— 龟壳单独处理 ——
  updateShells();

  // —— 火球 ——
  for (let i = fireballs.length - 1; i >= 0; i--) {
    const f = fireballs[i];
    f.life--;
    f.vy = Math.min(f.vy + 0.3, 6);
    if (moveX(f)) { fireballs.splice(i, 1); poof(f); continue; }
    moveY(f, false);
    if (f.onGround) f.vy = -3.6;
    if (f.life <= 0 || f.y > lv.h * TILE) { fireballs.splice(i, 1); continue; }
    let hit = false;
    for (const e of enemies) {
      if (!e.flipDie && e.squashT === 0 && overlap(f, e)) {
        killEnemyFlip(e, 200); hit = true; break;
      }
    }
    for (const s of shells) {
      if (!s.flipDie && overlap(f, s)) { killShellFlip(s); hit = true; break; }
    }
    if (hit) { fireballs.splice(i, 1); poof(f); }
  }
}
function poof(f) {
  for (let i = 0; i < 4; i++) addParticle(f.x + 3, f.y + 3, rnd(-1.5, 1.5), rnd(-1.5, 1.5), '#ffb35a', 3, 16, 0.05);
}
function toShell(e) {
  shells.push({
    x: e.x, y: e.y + e.h - 10, w: 13, h: 10, vx: 0, vy: 0,
    moving: false, wakeT: 0, flipDie: 0,
  });
  e.alive = false;
  enemies.splice(enemies.indexOf(e), 1);
}
function killShellFlip(s) {
  s.flipDie = 1; s.vy = -5;
  addScore(200, s.x, s.y);
  playSfx('kick');
}
function updateShells() {
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i];
    if (s.flipDie) { s.vy += 0.35; s.x += s.vx; s.y += s.vy; if (s.y > lv.h * TILE + 60) shells.splice(i, 1); continue; }
    s.vy = Math.min(s.vy + 0.3, 7);
    if (moveX(s)) { s.vx = -s.vx; playSfx('bump'); }
    moveY(s, false);
    if (s.y > lv.h * TILE + 60) { shells.splice(i, 1); continue; }
    if (s.moving) {
      // 撞敌人消灭
      for (const e of enemies) {
        if (!e.flipDie && e.squashT === 0 && overlap(s, e)) killEnemyFlip(e, 400);
      }
      for (const o of shells) {
        if (o !== s && !o.flipDie && o.moving && overlap(s, o)) { killShellFlip(o); killShellFlip(s); }
      }
    } else {
      s.wakeT++;
      if (s.wakeT > 480) { // 龟壳复活成乌龟
        enemies.push({ kind: 'koopa', x: s.x, y: s.y - 5, w: 12, h: 15, vx: -0.45, vy: 0, alive: true, flipDie: 0 });
        shells.splice(i, 1); continue;
      }
    }
    // 与马里奥
    if (state === 'play' && overlap(mario, s)) {
      if (mario.starT > 0) { killShellFlip(s); continue; }
      const stomping = mario.vy > 0 && (mario.y + mario.h) - s.y < 10;
      if (!s.moving) {
        s.moving = true;
        s.vx = (mario.x + mario.w / 2 < s.x + s.w / 2) ? 5.5 : -5.5;
        addScore(400, s.x, s.y); playSfx('kick');
        if (stomping) mario.vy = -4.5;
      } else if (stomping) {
        s.moving = false; s.vx = 0; s.wakeT = 0;
        mario.vy = -4.5; playSfx('stomp');
      } else if (mario.invulnT === 0) {
        marioHurt();
      }
    }
  }
}

/* —— 道具（蘑菇/花/星/1UP/弹出金币）—— */
function makeCoin(x, y) { return { x, y, w: 10, h: 13, got: false }; }
function updateItems() {
  // 场景金币收集
  for (const c of coinsEnt) {
    if (c.got) continue;
    if (overlap(mario, c)) {
      c.got = true; gainCoin();
      addParticle(c.x + 5, c.y + 6, 0, -1.5, '#ffd84d', 3, 18, 0.02);
    }
  }
  coinsEnt = coinsEnt.filter(c => !c.got);

  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.riseT > 0) { it.riseT--; it.y -= 0.5; continue; }  // 从块中升起
    if (it.kind === 'coinpop') {
      it.vy += 0.4; it.y += it.vy;
      if (it.life-- <= 0) items.splice(i, 1);
      continue;
    }
    if (it.kind === 'star') {
      it.vy = Math.min(it.vy + 0.25, 5);
      if (moveX(it)) it.vx = -it.vx;
      moveY(it, false);
      if (it.onGround) it.vy = -5.2;   // 星星不停蹦跳
    } else {
      it.vy = Math.min(it.vy + 0.3, 6);
      if (moveX(it)) it.vx = -it.vx;
      moveY(it, false);
    }
    if (it.y > lv.h * TILE + 40) { items.splice(i, 1); continue; }
    if (state === 'play' && overlap(mario, it)) {
      if (it.kind === 'mush') {
        if (mario.form === 0) { mario.form = 1; applyMarioSize(); }
        addScore(1000, it.x, it.y); playSfx('powerup'); mario.transformT = 24;
      } else if (it.kind === 'flower') {
        if (mario.form === 0) { mario.form = 1; applyMarioSize(); } else mario.form = 2;
        addScore(1000, it.x, it.y); playSfx('powerup'); mario.transformT = 24;
      } else if (it.kind === 'oneup') {
        lives++; playSfx('oneup'); addFloater(it.x, it.y, '1UP!');
      } else if (it.kind === 'star') {
        mario.starT = 600; addScore(1000, it.x, it.y);
        playSfx('powerup'); startMusic('star');
      } else if (it.kind === 'pmush') {          // 毒蘑菇：操控反转
        reverseT = 300;
        addFloater(it.x - 6, it.y - 8, '反转!');
        playSfx('poison');
      }
      items.splice(i, 1);
    }
  }
}
function gainCoin() {
  coins++; score += 200; playSfx('coin');
  if (coins >= 100) { coins -= 100; lives++; playSfx('oneup'); }
}

/* ============================ 10. 顶砖交互 ============================ */
function bumpBlock(tx, ty) {
  const t = tileAt(tx, ty);
  if (t === T.EMPTY || t === T.USED) return;
  // 弹起砖上的敌人
  const zone = { x: tx * TILE, y: ty * TILE - 4, w: TILE, h: 6 };
  for (const e of enemies)
    if (!e.flipDie && e.squashT === 0 && overlap(e, zone)) killEnemyFlip(e, 100);
  for (const s of shells)
    if (!s.flipDie && overlap(s, zone)) killShellFlip(s);

  if (t === T.BRICK) {
    if (mario.form > 0) {
      setTile(tx, ty, T.EMPTY);
      brickBits(tx, ty); addScore(50); playSfx('brick');
    } else {
      bumps.push({ tx, ty, t: 0 }); playSfx('bump');
    }
  } else if (t === T.QCOIN) {
    setTile(tx, ty, T.USED);
    items.push({ kind: 'coinpop', x: tx * TILE + 3, y: ty * TILE - 12, w: 10, h: 13, vy: -5, life: 30, riseT: 0 });
    gainCoin(); bumps.push({ tx, ty, t: 0 });
  } else if (t === T.QPOWER) {
    setTile(tx, ty, T.USED);
    const kind = mario.form === 0 ? 'mush' : 'flower';
    items.push({ kind, x: tx * TILE + 1, y: ty * TILE, w: 14, h: 14, vx: 0.6, vy: 0, riseT: 32 });
    playSfx('sprout'); bumps.push({ tx, ty, t: 0 });
  } else if (t === T.QSTAR) {
    setTile(tx, ty, T.USED);
    items.push({ kind: 'star', x: tx * TILE + 1, y: ty * TILE, w: 14, h: 12, vx: 1.2, vy: -3, riseT: 32 });
    playSfx('sprout'); bumps.push({ tx, ty, t: 0 });
  } else if (t === T.HIDDEN) {
    setTile(tx, ty, T.USED);
    items.push({ kind: 'oneup', x: tx * TILE + 1, y: ty * TILE, w: 14, h: 14, vx: 0.6, vy: 0, riseT: 32 });
    playSfx('sprout');
  } else if (t === T.QBAD) {
    // 恶搞版：陷阱宝箱——音效正常，弹出的却是怪物
    setTile(tx, ty, T.USED);
    playSfx('sprout'); bumps.push({ tx, ty, t: 0 });
    for (let i = 0; i < 2; i++)
      enemies.push({
        kind: i ? 'koopa' : 'goomba', red: true,
        x: tx * TILE + (i ? 8 : -8), y: ty * TILE - 14,
        w: 12, h: 15, vx: (i ? 1 : -1) * 0.9, vy: -3, alive: true, flipDie: 0,
      });
    playSfx('chase');
  } else if (t === T.QPOISON) {
    // 恶搞版：毒蘑菇块——外观与道具块一致
    setTile(tx, ty, T.USED);
    items.push({ kind: 'pmush', x: tx * TILE + 1, y: ty * TILE, w: 14, h: 14, vx: 0.6, vy: 0, riseT: 32 });
    playSfx('sprout'); bumps.push({ tx, ty, t: 0 });
  } else {
    playSfx('bump');
  }
}

/* ============================ 11. 流程控制 ============================ */
function loadLevel(idx, keepForm, at) {
  const def = MODES[curMode].levels[idx];
  lv = levelFromBuilder(def);
  spawnQueue = spawns.slice();
  enemies = []; items = []; fireballs = []; shells = [];
  particles = []; floaters = []; bumps = []; popCoins = [];
  fallingObjs = []; chasers = []; crumbles = []; rainState = null;
  flashT = 0; shakeT = 0; reverseT = 0; deathMsg = '';
  timeLeft = def.time; timeTick = 0;
  if (at) { startPt = { x: at.x, y: at.y }; respawnMark = { x: at.x, y: at.y }; }
  else respawnMark = null;
  resetMario(!keepForm);
  camX = clamp(mario.x - VW * 0.4, 0, lv.w * TILE - VW);
  startMusic(def.theme === 'under' ? 'under' : def.theme === 'night' ? 'night' : 'over');
}
function enterFlag() {
  state = 'flag'; stateTimer = 0;
  mario.x = flagX - mario.w + 2;
  mario.vx = 0; mario.vy = 0;
  stopMusic();
  const relH = clamp(1 - (mario.y - flagTopY) / (flagBaseY - flagTopY), 0, 1);
  const bonus = [100, 200, 400, 800, 2000, 4000][Math.min(5, (relH * 6) | 0)];
  addScore(bonus, flagX + 8, mario.y);
  flagBonusY = mario.y;
}
let lastTimeBonus = 0;
function afterClear() {
  lastTimeBonus = timeLeft * 10;
  score += lastTimeBonus; timeLeft = 0;
  state = 'clear'; stateTimer = 0;
  playSfx('clear');
}

/* ============================ 11.5 恶搞陷阱系统 ============================ */
// 触发器调度：玩家进入感应区 → 执行动作
function updateTriggers() {
  for (const tg of triggers) {
    if (!tg.armed) continue;
    if (!overlap(mario, tg)) continue;
    tg.armed = false;
    switch (tg.action) {
      case 'drop':   // 天降物：预警阴影后砸落
        fallingObjs.push({ x: tg.opts.x, y: -50, vy: 0, w: 16, h: 16, warnT: 32, kind: tg.opts.kind || 'ball' });
        playSfx('warn');
        break;
      case 'rain': { // 连续落物
        rainState = { t: 150, interval: 13 };
        playSfx('warn');
        break;
      }
      case 'scare':  // 纯惊吓：白屏+音效，无伤害
        flashT = 14;
        playSfx('scare');
        break;
      case 'fakeflag': { // 假旗杆：旗子变红掉落，召唤追杀怪
        const ff = fakeFlags[tg.opts.idx];
        if (ff && !ff.triggered) {
          ff.triggered = true; ff.dropY = flagTopY + 6;
          chasers.push({ x: ff.x - 10, y: mario.y - 60, w: 12, h: 15, vx: 0, vy: 0, bornT: 30 });
          playSfx('chase');
          addFloater(ff.x - 20, flagTopY + 30, '上当了吧!');
        }
        break;
      }
    }
  }
}
// 天降物（铁球 / 砧板 / 云朵）
function updateFallingObjs() {
  for (let i = fallingObjs.length - 1; i >= 0; i--) {
    const f = fallingObjs[i];
    if (f.warnT > 0) { f.warnT--; continue; }          // 预警阶段（地面闪阴影）
    f.vy = Math.min(f.vy + 0.5, 11);
    f.y += f.vy;
    const bottom = f.y + f.h;
    const ty = Math.floor(bottom / TILE), tx = Math.floor((f.x + 8) / TILE);
    const hitTile = isSolidT(tileAt(tx, ty)) || tileAt(tx, ty) === T.PLAT;
    let hitMario = overlap(mario, f);
    if (hitMario) {
      if (mario.starT > 0) { /* 无敌星直接弹碎 */ }
      else marioHurt();
    }
    if (hitTile || f.y > lv.h * TILE + 40 || (hitMario && mario.starT > 0)) {
      // 落地碎裂：粒子 + 震屏
      shakeT = 10;
      for (let k = 0; k < 8; k++)
        addParticle(f.x + 8, Math.min(bottom, ty * TILE), rnd(-2.2, 2.2), rnd(-4, -1), '#666', 4, 34, 0.3);
      playSfx('smash');
      fallingObjs.splice(i, 1);
    }
  }
  // 连续落物（雨）
  if (rainState) {
    rainState.t--;
    if (rainState.t % rainState.interval === 0 && rainState.t > 8) {
      fallingObjs.push({ x: clamp(mario.x + rnd(-50, 90), 16, lv.w * TILE - 32), y: -50, vy: 0, w: 16, h: 16, warnT: 18, kind: 'ball' });
      if (rainState.t % (rainState.interval * 3) === 0) playSfx('warn');
    }
    if (rainState.t <= 0) rainState = null;
  }
}
// 追杀怪（假旗杆召唤）
function updateChasers() {
  for (let i = chasers.length - 1; i >= 0; i--) {
    const c = chasers[i];
    if (c.bornT > 0) { c.bornT--; continue; }          // 登场蓄势
    c.vy = Math.min(c.vy + 0.35, 7);
    c.vx = (mario.x > c.x ? 1 : -1) * (1.9 + Math.min(0.7, frame % 1000 * 0.001));
    moveX(c); moveY(c, false);
    // 会跳小台阶追人
    if (c.onGround) {
      const aheadTx = Math.floor((c.x + (c.vx > 0 ? c.w + 4 : -4)) / TILE);
      const feetTy = Math.floor((c.y + c.h + 2) / TILE);
      const headTy = Math.floor((c.y + 6) / TILE);
      if (isSolidT(tileAt(aheadTx, feetTy)) && !isSolidT(tileAt(aheadTx, headTy))) c.vy = -7.2;
    }
    if (c.y > lv.h * TILE + 40) { chasers.splice(i, 1); continue; }
    if (state === 'play') {
      if (overlap(mario, c)) {
        const stomping = mario.vy > 0 && (mario.y + mario.h) - c.y < 10;
        if (stomping) {                                // 可以反踩！
          mario.vy = -6; addScore(500, c.x, c.y - 8);
          playSfx('stomp'); chasers.splice(i, 1); continue;
        } else if (mario.starT > 0) { chasers.splice(i, 1); continue; }
        else marioHurt();
      }
    }
  }
}
// 裂纹地面：踩上抖动 → 整段塌陷
function updateCrumbles() {
  if (!lv) return;
  // 检测马里奥脚下（单行 CRACK 即可触发）
  if (mario.onGround) {
    const txL = Math.floor((mario.x + 2) / TILE), txR = Math.floor((mario.x + mario.w - 2) / TILE);
    const ty = Math.floor((mario.y + mario.h + 1) / TILE);
    for (const tx of [txL, txR]) {
      if (tileAt(tx, ty) === T.CRACK) {
        let gx0 = tx, gx1 = tx;
        while (tileAt(gx0 - 1, ty) === T.CRACK) gx0--;
        while (tileAt(gx1 + 1, ty) === T.CRACK) gx1++;
        if (!crumbles.some(c => c.gx0 === gx0 && c.ty === ty)) {
          crumbles.push({ gx0, gx1, ty, t: 26 });
          playSfx('warn');
        }
        break;
      }
    }
  }
  for (let i = crumbles.length - 1; i >= 0; i--) {
    const c = crumbles[i];
    c.t--;
    if (c.t <= 0) {
      for (let x = c.gx0; x <= c.gx1; x++) {
        setTile(x, c.ty, T.EMPTY);
        if (tileAt(x, c.ty + 1) === T.CRACK) setTile(x, c.ty + 1, T.EMPTY);   // 地表双层裂纹一起塌
        for (let k = 0; k < 2; k++)
          addParticle(x * TILE + 8, c.ty * TILE + 8, rnd(-1.5, 1.5), rnd(-2, 0.5), '#9a5a28', 5, 40, 0.3);
      }
      shakeT = 12; playSfx('smash');
      crumbles.splice(i, 1);
    }
  }
}
// 假砖：与马里奥接触即连锁碎裂（外观与真砖一致）
function checkFakeBricks() {
  if (!lv) return;
  const pad = 2;
  const x0 = Math.floor((mario.x - pad) / TILE), x1 = Math.floor((mario.x + mario.w + pad) / TILE);
  const y0 = Math.floor((mario.y - pad) / TILE), y1 = Math.floor((mario.y + mario.h + pad) / TILE);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (tileAt(tx, ty) !== T.FAKEBRICK) continue;
      // 连锁碎裂相邻假砖
      const stack = [[tx, ty]];
      while (stack.length) {
        const [cx, cy] = stack.pop();
        if (tileAt(cx, cy) !== T.FAKEBRICK) continue;
        setTile(cx, cy, T.EMPTY);
        addScore(0);
        for (let k = 0; k < 3; k++)
          addParticle(cx * TILE + 8, cy * TILE + 8, rnd(-1.8, 1.8), rnd(-3, -0.5), '#c85c20', 4, 36, 0.3);
        stack.push([cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]);
      }
      playSfx('shatter');
    }
}
// 存档点
function updateCheckpoints() {
  for (const cp of checkpoints) {
    if (cp.on) continue;
    const zone = { x: cp.x - 6, y: cp.y, w: 20, h: 48 };
    if (overlap(mario, zone)) {
      cp.on = true;
      respawnMark = { x: cp.x, y: cp.y + 16 };
      if (!activatedCP[curMode][curLevel]) activatedCP[curMode][curLevel] = [];
      if (!activatedCP[curMode][curLevel].includes(cp.idx)) activatedCP[curMode][curLevel].push(cp.idx);
      playSfx('cpGet');
      addFloater(cp.x - 8, cp.y - 10, '存档!');
    }
  }
}

/* ---- 恶搞实体渲染 ---- */
function drawCheckpoints(cam) {
  for (const cp of checkpoints) {
    const x = cp.x - cam;
    ctx.fillStyle = '#b8b8b8'; ctx.fillRect(x + 7, cp.y + 2, 3, 46);           // 杆
    ctx.fillStyle = cp.on ? '#2fa84f' : '#777777';
    ctx.beginPath();                                                            // 三角旗
    ctx.moveTo(x + 10, cp.y + 4); ctx.lineTo(x + 24 + (cp.on ? Math.sin(frame * 0.15) * 2 : 0), cp.y + 10); ctx.lineTo(x + 10, cp.y + 17);
    ctx.closePath(); ctx.fill();
    if (cp.on && (frame >> 4 & 1)) { ctx.fillStyle = '#ffd84d'; ctx.fillRect(x + 5, cp.y - 8, 3, 3); ctx.fillRect(x + 10, cp.y - 11, 3, 3); }
  }
}
function drawFakeFlags(cam) {
  for (const ff of fakeFlags) {
    const bx = ff.x - cam;
    ctx.fillStyle = '#b8e090'; ctx.fillRect(bx - 1, flagTopY + 8, 3, flagBaseY - flagTopY - 8);   // 杆
    ctx.fillStyle = '#ffd84d'; ctx.beginPath(); ctx.arc(bx, flagTopY + 8, 6, 0, 7); ctx.fill();   // 顶球
    let fy = flagTopY + 10;
    if (ff.triggered) fy = Math.min(flagBaseY - 24, (ff.dropY += 3));                              // 触发后旗子坠落
    drawSprite(SPR.flag, bx - 13, fy, false);
    if (ff.triggered) { ctx.fillStyle = '#e93c2e'; drawSprite(SPR.flag, bx - 13, fy, false); }     // 变红
  }
}
function drawFallingObjs(cam) {
  for (const f of fallingObjs) {
    if (f.warnT > 0) {
      // 地面预警阴影（闪烁）
      if (frame >> 2 & 1) {
        ctx.fillStyle = 'rgba(255,60,60,.55)';
        ctx.beginPath(); ctx.ellipse(f.x + 8 - cam, VH - 26, 12, 4, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#ff3c3c'; ctx.font = 'bold 12px monospace'; ctx.fillText('!', f.x + 4 - cam, VH - 34);
      }
      continue;
    }
    const sx = f.x - cam;
    if (f.kind === 'anvil') {
      ctx.fillStyle = '#3a3a44'; ctx.fillRect(sx, f.y, 16, 10);
      ctx.fillRect(sx + 2, f.y + 10, 12, 4); ctx.fillRect(sx + 5, f.y + 14, 6, 3);
      ctx.fillStyle = '#6d6d7d'; ctx.fillRect(sx + 2, f.y + 1, 4, 2);
    } else {                                                    // 铁球
      ctx.fillStyle = '#3a3a44';
      ctx.beginPath(); ctx.arc(sx + 8, f.y + 8, 9, 0, 7); ctx.fill();
      ctx.fillStyle = '#8a8a9d'; ctx.beginPath(); ctx.arc(sx + 5, f.y + 5, 3, 0, 7); ctx.fill();
    }
  }
}
function drawChasers(cam) {
  for (const c of chasers) {
    if (c.bornT > 0 && (frame >> 2 & 1)) continue;              // 登场闪烁
    drawSprite(SPR.koopa.ra, c.x - 1 - cam, c.y + c.h - SPR.koopa.ra.height, mario.x < c.x);
    if (c.bornT > 0 || frame >> 3 & 1) {                        // 头顶感叹号
      pixelText('!', c.x + 3 - cam, c.y - 4, 12, '#ff3c3c');
    }
  }
}
function drawTombstones(cam) {
  for (const tb of tombstones) {
    if (tb.lv !== curLevel) continue;
    const x = tb.x - cam, y = tb.y + mario.h - 10;
    if (x < -30 || x > VW + 30) continue;
    ctx.fillStyle = 'rgba(200,200,210,.85)';
    ctx.fillRect(x + 2, y - 8, 12, 10);
    ctx.beginPath(); ctx.arc(x + 8, y - 8, 6, Math.PI, 0); ctx.fill();
    ctx.fillStyle = 'rgba(120,120,130,.9)'; ctx.fillRect(x + 7, y - 12, 2, 6); ctx.fillRect(x + 5, y - 10, 6, 2);
    const near = Math.abs(mario.x - tb.x) < 70;
    if (near) {
      ctx.font = '9px monospace';
      const tw = ctx.measureText(tb.cause).width;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(x + 7 - tw / 2 - 3, y - 38, tw + 6, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(tb.cause, x + 7 - tw / 2, y - 27);
    }
  }
}

/* ============================ 12. 渲染 ============================ */
const THEMES = {
  over: { sky: '#63a5ff', ground: '#c85c20', groundTop: '#3ec54b', brick: '#c85c20', hill: '#3aa03a', deco: 'day' },
  under: { sky: '#04040c', ground: '#2a6db5', groundTop: '#6fb7ff', brick: '#2a6db5', hill: null, deco: 'none' },
  night: { sky: '#101235', ground: '#7a4a94', groundTop: '#c79be0', brick: '#7a4a94', hill: '#3d2a56', deco: 'night' },
};
function drawBackground(cam) {
  const th = THEMES[lv.theme] || THEMES.over;
  ctx.fillStyle = th.sky; ctx.fillRect(0, 0, VW, VH);
  if (th.deco === 'day') {
    // 云（视差）
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    for (let i = 0; i < 7; i++) {
      const cx = ((i * 173 + 40 - cam * 0.4) % (VW + 120) + VW + 120) % (VW + 120) - 60;
      const cy = 30 + (i % 3) * 26;
      cloud(cx, cy, 1 + (i % 2) * 0.4);
    }
    // 山丘与灌木
    for (let i = 0; i < 6; i++) {
      const hx = ((i * 260 + 100 - cam * 0.65) % (VW + 320) + VW + 320) % (VW + 320) - 160;
      hill(hx, VH - 32, 46 + (i % 2) * 18, th.hill);
    }
  } else if (th.deco === 'night') {
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 40; i++) {
      const sx = ((i * 97 + (i % 5) * 31) % VW);
      const sy = (i * 53) % 140;
      ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(frame * 0.02 + i));
      ctx.fillRect(sx, sy, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff7cf';
    ctx.beginPath(); ctx.arc(430 - cam * 0.1 % 80, 44, 17, 0, 7); ctx.fill();
    ctx.fillStyle = th.sky;
    ctx.beginPath(); ctx.arc(438 - cam * 0.1 % 80, 38, 15, 0, 7); ctx.fill();
    for (let i = 0; i < 5; i++) {
      const hx = ((i * 300 + 150 - cam * 0.6) % (VW + 360) + VW + 360) % (VW + 360) - 180;
      hill(hx, VH - 32, 52, th.hill);
    }
  }
  // 城堡
  if (castleX) drawCastle(castleX - cam, VH - 32);
}
function cloud(x, y, s) {
  ctx.beginPath();
  ctx.arc(x, y, 9 * s, 0, 7); ctx.arc(x + 10 * s, y - 4 * s, 11 * s, 0, 7);
  ctx.arc(x + 22 * s, y, 9 * s, 0, 7); ctx.fill();
  ctx.fillRect(x - 6 * s, y, 34 * s, 8 * s);
}
function hill(x, baseY, r, col) {
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, baseY, r, Math.PI, 0); ctx.fill();
}
function drawCastle(x, baseY) {
  if (x < -90 || x > VW + 20) return;
  const g = '#c85c20', d = '#8f3d10';
  ctx.fillStyle = g; ctx.fillRect(x, baseY - 52, 76, 52);
  ctx.fillStyle = d;
  for (let i = 0; i < 5; i++) ctx.fillRect(x + i * 16, baseY - 60, 10, 8);
  ctx.fillStyle = g; ctx.fillRect(x + 22, baseY - 84, 32, 32);
  ctx.fillStyle = d;
  for (let i = 0; i < 3; i++) ctx.fillRect(x + 23 + i * 11, baseY - 90, 7, 7);
  ctx.fillStyle = '#222';
  ctx.fillRect(x + 30, baseY - 26, 16, 26);                 // 门
  ctx.fillRect(x + 33, baseY - 78, 10, 12);                 // 窗
  ctx.strokeStyle = d;
  for (let ry = 0; ry < 4; ry++) { ctx.beginPath(); ctx.moveTo(x, baseY - 12 - ry * 13); ctx.lineTo(x + 76, baseY - 12 - ry * 13); ctx.stroke(); }
}
function drawTiles(cam) {
  const th = THEMES[lv.theme] || THEMES.over;
  const x0 = Math.max(0, Math.floor(cam / TILE)), x1 = Math.min(lv.w - 1, Math.ceil((cam + VW) / TILE));
  for (let ty = 0; ty < lv.h; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const t = lv.tiles[ty][tx];
      if (t === T.EMPTY) continue;
      let dy = 0;
      const bp = bumps.find(b => b.tx === tx && b.ty === ty);
      if (bp) dy = -Math.sin(clamp(bp.t / 12, 0, 1) * Math.PI) * 5;
      drawTileArt(t, tx * TILE - cam, ty * TILE + dy, th);
    }
}
function drawTileArt(t, x, y, th) {
  switch (t) {
    case T.GROUND:
      ctx.fillStyle = th.ground; ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = th.groundTop; ctx.fillRect(x, y, 16, 4);
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(x + 2, y + 9, 3, 2); ctx.fillRect(x + 10, y + 12, 3, 2);
      break;
    case T.BRICK:
      ctx.fillStyle = th.brick; ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(x, y + 7, 16, 1); ctx.fillRect(x, y + 15, 16, 1);
      ctx.fillRect(x + 7, y, 1, 7); ctx.fillRect(x + 3, y + 8, 1, 7); ctx.fillRect(x + 11, y + 8, 1, 7);
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(x, y, 16, 1);
      break;
    case T.QCOIN: case T.QPOWER: case T.QSTAR: {
      const bright = (frame >> 4 & 3);
      ctx.fillStyle = ['#ffa000', '#ffb43c', '#ffc863', '#ffb43c'][bright]; ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = '#8a5200'; ctx.fillRect(x, y, 16, 1); ctx.fillRect(x, y + 15, 16, 1); ctx.fillRect(x, y, 1, 16); ctx.fillRect(x + 15, y, 1, 16);
      ctx.fillStyle = '#8a5200';
      ctx.fillRect(x + 1, y + 1, 2, 2); ctx.fillRect(x + 13, y + 1, 2, 2); ctx.fillRect(x + 1, y + 13, 2, 2); ctx.fillRect(x + 13, y + 13, 2, 2);
      drawSprite(SPR.qmark, x + 4, y + 3);
      break;
    }
    case T.USED:
      ctx.fillStyle = '#8a5a28'; ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = '#6b421a'; ctx.fillRect(x + 1, y + 1, 14, 14);
      break;
    case T.SOLID:
      ctx.fillStyle = '#cfcfcf'; ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = '#efefef'; ctx.fillRect(x, y, 16, 2); ctx.fillRect(x, y, 2, 16);
      ctx.fillStyle = '#8f8f8f'; ctx.fillRect(x + 14, y, 2, 16); ctx.fillRect(x, y + 14, 16, 2);
      break;
    case T.PIPE_TL: case T.PIPE_TR: {
      const left = t === T.PIPE_TL;
      ctx.fillStyle = '#2fa84f'; ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = '#63d971'; ctx.fillRect(x + (left ? 1 : 0), y + 1, left ? 4 : 3, 14);
      ctx.fillStyle = '#156b2e';
      if (left) ctx.fillRect(x, y, 2, 16); else ctx.fillRect(x + 14, y, 2, 16);
      ctx.fillStyle = '#0d4a1f'; ctx.fillRect(x, y + 15, 16, 1);
      break;
    }
    case T.PIPE_L: case T.PIPE_R: {
      const left = t === T.PIPE_L;
      ctx.fillStyle = '#2fa84f'; ctx.fillRect(x + (left ? 2 : 0), y, 14, 16);
      ctx.fillStyle = '#63d971'; ctx.fillRect(x + (left ? 3 : 0), y, left ? 4 : 3, 16);
      ctx.fillStyle = '#156b2e';
      if (left) ctx.fillRect(x + 2, y, 2, 16); else ctx.fillRect(x + 12, y, 2, 16);
      break;
    }
    case T.POLE:
      ctx.fillStyle = '#b8e090'; ctx.fillRect(x + 7, y, 3, 16);
      break;
    case T.POLETOP:
      ctx.fillStyle = '#ffd84d'; ctx.beginPath(); ctx.arc(x + 8, y + 8, 6, 0, 7); ctx.fill();
      ctx.fillStyle = '#b8e090'; ctx.fillRect(x + 7, y + 10, 3, 6);
      break;
    case T.PLAT:
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.fillRect(x, y + 2, 16, 6);
      ctx.fillStyle = 'rgba(190,215,255,.9)';
      ctx.fillRect(x, y + 8, 16, 3);
      break;
    case T.CRACK: {
      // 外观同地面 + 黑色裂纹（塌陷中的段会抖动）
      const cm = crumbles.find(c => c.ty === Math.round(y / TILE));
      let ox = 0;
      if (cm && frame >> 1 & 1) ox = rnd(-1.2, 1.2);
      ctx.fillStyle = th.ground; ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = th.groundTop; ctx.fillRect(x, y, 16, 4);
      ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 3 + ox, y + 4); ctx.lineTo(x + 7 + ox, y + 9); ctx.lineTo(x + 5 + ox, y + 15);
      ctx.moveTo(x + 11 + ox, y + 5); ctx.lineTo(x + 9 + ox, y + 10); ctx.lineTo(x + 13 + ox, y + 14);
      ctx.stroke();
      break;
    }
    case T.FAKEBRICK:   // 与真砖渲染完全一致（精髓：看不出来）
      drawTileArt(T.BRICK, x, y, th);
      break;
    case T.QBAD:
      drawTileArt(T.QCOIN, x, y, th);
      break;
    case T.QPOISON:
      drawTileArt(T.QPOWER, x, y, th);
      break;
    case T.SPIKE:
      ctx.fillStyle = '#c9c9d8';
      ctx.beginPath();
      ctx.moveTo(x, y + 16); ctx.lineTo(x + 4, y + 4); ctx.lineTo(x + 8, y + 16);
      ctx.lineTo(x + 12, y + 4); ctx.lineTo(x + 16, y + 16); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#7d7d92'; ctx.fillRect(x, y + 14, 16, 2);
      break;
    case T.HIDDEN: break; // 隐形
  }
}
function drawFlagAndCoinEnt(cam) {
  // 场景金币
  const cf = SPR.coin[(frame >> 3) % 4];
  for (const c of coinsEnt) drawSprite(cf, c.x - cam, c.y + Math.sin(frame * 0.1 + c.x) * 1.5);
  // 弹出金币
  for (const it of items) if (it.kind === 'coinpop') drawSprite(cf, it.x - cam, it.y);
  // 旗帜（跟随下滑）
  if (flagX && lv) {
    let fy = flagTopY + 6;
    if (state === 'flag' || state === 'clear') fy = clamp(flagBonusY - 10, flagTopY + 6, flagBaseY - 22);
    drawSprite(SPR.flag, flagX - 13 - cam, fy);
  }
}
function drawEntities(cam) {
  // 道具
  for (const it of items) {
    if (it.kind === 'mush') drawSprite(SPR.mush, it.x - cam, it.y);
    else if (it.kind === 'pmush') {           // 毒蘑菇：紫黑配色 + 紫雾
      ctx.save();
      try { ctx.filter = 'hue-rotate(260deg) brightness(.75)'; } catch (e) { }
      drawSprite(SPR.mush, it.x - cam, it.y);
      ctx.restore();
      if (frame >> 3 & 1) { ctx.fillStyle = 'rgba(190,110,255,.5)'; ctx.fillRect(it.x - cam - 2, it.y - 2, 2, 2); }
    }
    else if (it.kind === 'oneup') drawSprite(SPR.oneup, it.x - cam, it.y);
    else if (it.kind === 'flower') drawSprite(SPR.flower, it.x - cam, it.y);
    else if (it.kind === 'star') {
      ctx.save(); try { ctx.filter = `hue-rotate(${(frame * 18) % 360}deg)`; } catch (e) { }
      drawSprite(SPR.star, it.x - cam, it.y); ctx.restore();
    }
  }
  // 敌人
  for (const e of enemies) {
    if (e.kind === 'goomba') {
      const img = e.squashT > 0 ? SPR.goomba.squash : ((frame >> 3 & 1) ? SPR.goomba.a : SPR.goomba.b);
      drawSprite(img, e.x - 1 - cam, e.y + e.h - img.height, e.flipDie);
    } else {
      const red = e.red || e.kind === 'para';
      const img = (frame >> 3 & 1) ? (red ? SPR.koopa.rb : SPR.koopa.gb) : (red ? SPR.koopa.ra : SPR.koopa.ga);
      drawSprite(img, e.x - 1 - cam, e.y + e.h - img.height, e.flipDie);
      if (e.kind === 'para') {
        const wf = (frame >> 2 & 1);
        drawSprite(SPR.wing[wf], e.x - 8 - cam, e.y + 2, false);
        drawSprite(SPR.wing[wf], e.x + e.w + 1 - cam, e.y + 2, true);
      }
    }
  }
  // 龟壳
  for (const s of shells) {
    const img = s.moving ? SPR.koopa.shellG : (((s.wakeT >> 3) & 1) && s.wakeT > 380 ? SPR.koopa.shellR : SPR.koopa.shellG);
    if (s.flipDie) { drawSprite(SPR.koopa.shellR, s.x - cam, s.y, true); continue; }
    drawSprite(img, s.x - cam, s.y);
    if (!s.moving && s.wakeT > 300 && (frame >> 3 & 1)) {
      ctx.fillStyle = '#fff'; ctx.fillRect(s.x + 5 - cam, s.y - 6, 2, 2); ctx.fillRect(s.x + 8 - cam, s.y - 6, 2, 2);
    }
  }
  // 火球
  for (const f of fireballs) {
    ctx.save();
    ctx.translate(f.x - cam + 3, f.y + 3);
    ctx.rotate(frame * 0.5);
    drawSprite(SPR.fireball, -4, -4);
    ctx.restore();
  }
  // 粒子
  for (const p of particles) {
    ctx.save();
    ctx.translate(p.x - cam, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    ctx.restore();
  }
  // 浮动分数
  ctx.font = 'bold 8px monospace';
  for (const fl of floaters) {
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillText(fl.text, fl.x - cam, fl.y);
  }
}
function pixelText(text, x, y, size, color, align) {
  ctx.font = `bold ${size}px monospace`;
  ctx.textAlign = align || 'left';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}
function drawWatermark() {
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.fillText('Dubnium', 10, 14);
}

function drawHUD() {
  pixelText('SCORE ' + String(score).padStart(6, '0'), 12, 28, 10, '#fff');
  drawSprite(SPR.coin[(frame >> 3) % 4], 150, 6);
  pixelText('x' + String(coins).padStart(2, '0'), 164, 28, 10, '#ffd84d');
  pixelText((curMode ? 'WORLD 坑' : 'WORLD ') + modeLevels()[curLevel].name, 240, 28, 10, '#fff');
  const tc = timeLeft <= 50 && (frame >> 3 & 1) ? '#ff5555' : '#fff';
  pixelText('TIME ' + String(timeLeft).padStart(3, '0'), 340, 28, 10, tc);
  drawSprite(SPR.mush, 436, 5);
  pixelText('x' + lives, 452, 28, 10, '#fff');
  pixelText('HI ' + String(Math.max(hiscore, score)).padStart(6, '0'), 12, 264, 8, 'rgba(255,255,255,.55)');
}

/* ---- 标题画面 ---- */
function drawTitle() {
  const trollUI = modeSelect === 1;
  ctx.fillStyle = trollUI ? '#2a1440' : '#63a5ff'; ctx.fillRect(0, 0, VW, VH);
  // 地面装饰
  const th = THEMES.over;
  for (let tx = 0; tx < VW / 16; tx++) drawTileArt(T.GROUND, tx * 16, VH - 32, th);
  if (trollUI) {
    // 恶搞版：夜空 + 偷笑的紫月亮
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 30; i++) { const sx = (i * 97) % VW, sy = (i * 53) % 150; ctx.globalAlpha = .5; ctx.fillRect(sx, sy, 2, 2); }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#c07bff'; ctx.beginPath(); ctx.arc(430, 46, 17, 0, 7); ctx.fill();
    ctx.fillStyle = '#2a1440'; ctx.beginPath(); ctx.arc(424, 40, 13, 0, 7); ctx.fill();
  } else {
    cloud(70, 60, 1.2); cloud(330, 42, 0.9); cloud(420, 90, 1.1);
  }
  hill(-20, VH - 32, 60, th.hill);
  // LOGO
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 44px monospace';
  ctx.fillStyle = '#8a3c00'; ctx.fillText('SUPER MARIO', VW / 2 + 3, 103 + 3);
  ctx.fillStyle = '#e93c2e'; ctx.fillText('SUPER MARIO', VW / 2, 103);
  ctx.font = 'bold 15px monospace';
  ctx.fillStyle = trollUI ? '#c07bff' : '#ffd84d';
  ctx.fillText(trollUI ? '· 恶 搞 版 · 坑爹警告 ·' : '· 网 页 版 ·', VW / 2, 126);
  ctx.textAlign = 'left';
  ctx.restore();
  drawSprite(SPR.big.n.idle, VW / 2 - 60, VH - 32 - 24);
  drawSprite(SPR.goomba.a, VW / 2 + 40, VH - 32 - 11);
  // 双模式菜单
  const my = 152;
  pixelText((modeSelect === 0 ? '▶ ' : '   ') + '经典版', VW / 2 - 52, my, 15, modeSelect === 0 ? '#ffffff' : 'rgba(255,255,255,.45)');
  pixelText((modeSelect === 1 ? '▶ ' : '   ') + '恶搞版', VW / 2 - 52, my + 22, 15, modeSelect === 1 ? '#7dff8a' : 'rgba(255,255,255,.45)');
  if (trollUI && frame >> 4 & 1) pixelText('小心头顶。', VW / 2 - 34, my + 44, 10, '#ff8080');
  if (!trollUI && frame >> 4 & 1) pixelText('←→ 选择模式　Enter 开始', VW / 2 - 76, my + 44, 10, '#fff');
  pixelText('←→ 移动   Z/空格 跳跃   X/J 火球·加速   ↓ 下蹲', VW / 2 - 168, 208, 10, 'rgba(255,255,255,.85)');
  pixelText('HI SCORE ' + String(hiscore).padStart(6, '0'), VW / 2 - 62, 232, 10, '#ffd84d');
  pixelText('同人致敬作品 · 仅用于学习', VW / 2 - 74, 256, 9, 'rgba(255,255,255,.5)');
  drawWatermark();
}

/* ============================ 13. 主循环 ============================ */
let lastTs = 0, acc = 0;
function step() {
  frame++;
  if (AC) updateMusic();

  // 全局按键
  if (jp('KeyM')) { muted = !muted; }
  if (jp('KeyP') && (state === 'play')) { paused = !paused; playSfx('pause'); }

  switch (state) {
    case 'title':
      if (jp('ArrowLeft') || jp('KeyA')) { modeSelect = (modeSelect + 1) % 2; playSfx('tick'); }
      if (jp('ArrowRight') || jp('KeyD')) { modeSelect = (modeSelect + 1) % 2; playSfx('tick'); }
      if (jp('Enter') || inJumpPress()) {
        initAudio();
        curMode = modeSelect;
        activatedCP[curMode] = [];
        score = 0; coins = 0; lives = 3; curLevel = 0;
        if (curMode === 1) trollDeaths = 0;
        tombstones = [];
        loadLevel(curLevel, false);
        state = 'play'; paused = false;
      }
      break;

    case 'play': {
      if (paused) break;
      updateMusic();
      // 时间流逝
      if (++timeTick >= 24) {
        timeTick = 0; timeLeft--;
        if (timeLeft === 50) playSfx('warning');
        if (timeLeft <= 0) { timeLeft = 0; marioDie(); }
      }
      spawnEnemiesIfVisible();
      updateMario();
      updateEnemies();
      updateItems();
      // 恶搞系统
      if (curMode === 1) {
        updateTriggers();
        updateFallingObjs();
        updateChasers();
        updateCrumbles();
        checkFakeBricks();
        updateCheckpoints();
        if (flashT > 0) flashT--;
        if (reverseT > 0) reverseT--;
        if (shakeT > 0) shakeT--;
      }
      // 摄像机
      camX += (clamp(mario.x - VW * 0.42, 0, lv.w * TILE - VW) - camX) * 0.18;
      break;
    }

    case 'dying': {
      stateTimer++;
      if (stateTimer > 24) { mario.vy = Math.min(mario.vy + 0.35, 7); mario.y += mario.vy; }
      if (stateTimer > 170) {
        lives--;
        if (lives <= 0) { state = 'gameover'; stateTimer = 0; playSfx('gameover'); }
        else { loadLevel(curLevel, false, respawnMark); state = 'play'; }   // 恶搞版从存档点复活
      }
      break;
    }

    case 'flag': {
      stateTimer++;
      // 滑杆
      if (mario.y + mario.h < flagBaseY) {
        mario.y += 2.4;
        flagBonusY = mario.y;
      } else if (stateTimer > 30) {
        // 走向城堡
        mario.dir = 1;
        mario.vx = 1.4; mario.vy = Math.min(mario.vy + 0.35, 6);
        moveX(mario); moveY(mario, false);
        if (mario.x > castleX + 30 || stateTimer > 400) afterClear();
      }
      camX += (clamp(mario.x - VW * 0.42, 0, lv.w * TILE - VW) - camX) * 0.15;
      break;
    }

    case 'clear': {
      stateTimer++;
      if (stateTimer > 210) {
        curLevel++;
        if (curLevel >= levelCount()) {
          state = 'win'; stateTimer = 0;
          try { if (score > hiscore) { hiscore = score; localStorage.setItem('smb_hiscore', hiscore); } } catch (e) { }
        } else {
          loadLevel(curLevel, true); state = 'play';
        }
      }
      break;
    }

    case 'gameover': {
      stateTimer++;
      if (stateTimer > 60 && (jp('Enter') || inJumpPress())) {
        try { if (score > hiscore) { hiscore = score; localStorage.setItem('smb_hiscore', hiscore); } } catch (e) { }
        state = 'title';
      }
      break;
    }

    case 'win': {
      stateTimer++;
      if (stateTimer % 22 === 0) { // 烟花
        const fx = rnd(60, VW - 60), fy = rnd(40, 150);
        const cols = ['#ff5555', '#ffd84d', '#63d971', '#6fb7ff', '#ff9de2'];
        const col = cols[(Math.random() * cols.length) | 0];
        for (let i = 0; i < 18; i++) {
          const a = Math.PI * 2 * i / 18;
          addParticle(fx, fy, Math.cos(a) * rnd(1, 2.4), Math.sin(a) * rnd(1, 2.4), col, 3, 46, 0.03);
        }
        playSfx('coin');
      }
      if (stateTimer > 120 && (jp('Enter') || inJumpPress())) state = 'title';
      break;
    }
  }

  // 特效更新（多数状态下都跑）
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    if (--p.life <= 0) particles.splice(i, 1);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; f.y -= 0.7;
    if (--f.life <= 0) floaters.splice(i, 1);
  }
  for (let i = bumps.length - 1; i >= 0; i--)
    if (++bumps[i].t > 12) bumps.splice(i, 1);

  // 清理未消费的按键（防残留）
  for (const k in pressedBuf) pressedBuf[k] = false;
}

function render() {
  ctx.clearRect(0, 0, VW, VH);
  if (state === 'title') { drawTitle(); return; }
  if (!lv) return;
  // 恶搞版震屏
  const shX = shakeT > 0 ? rnd(-3, 3) : 0, shY = shakeT > 0 ? rnd(-2, 2) : 0;
  ctx.save();
  if (shakeT > 0) ctx.translate(shX, shY);
  drawBackground(camX);
  drawTiles(camX);
  drawFlagAndCoinEnt(camX);
  if (curMode === 1) {
    drawCheckpoints(camX);
    drawFakeFlags(camX);
    drawTombstones(camX);
    drawFallingObjs(camX);
    drawChasers(camX);
  }
  drawEntities(camX);
  if (state !== 'clear') drawMario(camX);
  ctx.restore();
  drawHUD();

  // 恶搞版：惊吓白屏 / 反转提示
  if (curMode === 1) {
    if (flashT > 0) { ctx.fillStyle = `rgba(255,255,255,${clamp(flashT / 14, 0, 1) * 0.9})`; ctx.fillRect(0, 0, VW, VH); }
    if (reverseT > 0 && frame >> 3 & 1) pixelText('操控反转!', VW - 96, 30, 11, '#c07bff');
    if (rainState) { ctx.fillStyle = 'rgba(255,80,80,.8)'; pixelText('~ 天降物来袭 ~', VW / 2 - 46, 34, 10, '#ff8080'); }
  }
  if (state === 'dying' && stateTimer <= 24) {
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(0, 0, VW, VH);
  }
  // 恶搞版：死亡嘲讽大字
  if (state === 'dying' && curMode === 1 && stateTimer > 20 && deathMsg) {
    pixelText(deathMsg, VW / 2 - deathMsg.length * 7, VH * 0.42, 16, '#ff5555');
    pixelText('已阵亡 ' + trollDeaths + ' 次', VW / 2 - 44, VH * 0.42 + 24, 10, 'rgba(255,255,255,.75)');
  }
  if (state === 'clear') {
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, VW, VH);
    pixelText('关 卡 通 过 ！', VW / 2 - 58, 110, 22, '#ffd84d');
    pixelText('TIME BONUS  +' + lastTimeBonus, VW / 2 - 66, 140, 12, '#fff');
    pixelText('SCORE ' + String(score).padStart(6, '0'), VW / 2 - 52, 162, 12, '#fff');
    if (curMode === 1) pixelText('别嘚瑟，下一关更阴间', VW / 2 - 66, 186, 11, '#ff9de2');
  }
  if (state === 'gameover') {
    ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(0, 0, VW, VH);
    pixelText('GAME OVER', VW / 2 - 82, 108, 28, '#ff5555');
    pixelText('最终得分 ' + score, VW / 2 - 40, 142, 12, '#fff');
    if (curMode === 1) {
      pixelText('本次共阵亡 ' + trollDeaths + ' 次 · 称号【' + deathRank(trollDeaths) + '】', VW / 2 - 118, 166, 11, '#c07bff');
      if (stateTimer > 60 && frame >> 4 & 1) pixelText('存档点表示爱莫能助，下次一定（骗你的）', VW / 2 - 122, 188, 10, 'rgba(255,255,255,.65)');
    }
    if (stateTimer > 60 && frame >> 4 & 1) pixelText('按 Enter 返回标题', VW / 2 - 56, curMode ? 214 : 186, 11, 'rgba(255,255,255,.8)');
  }
  if (state === 'win') {
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, VW, VH);
    if (curMode === 1) {
      pixelText('赢 了 ？ 纯 纯 运 气 ！', VW / 2 - 88, 88, 22, '#7dff8a');
      pixelText('也就死了 ' + trollDeaths + ' 次而已，好意思发朋友圈？', VW / 2 - 116, 120, 12, '#fff');
      pixelText('FINAL SCORE ' + String(score).padStart(6, '0'), VW / 2 - 76, 148, 13, '#6fe3ff');
      pixelText('官方认证称号【' + deathRank(trollDeaths) + '】（含贬义）', VW / 2 - 104, 172, 12, '#c07bff');
      if (trollDeaths === 0) pixelText('零死亡？已向系统举报你开挂', VW / 2 - 78, 194, 10, '#ffd84d');
    } else {
      pixelText('恭 喜 通 关 ！！', VW / 2 - 76, 96, 22, '#ffd84d');
      pixelText('你征服了全部 ' + levelCount() + ' 个世界！', VW / 2 - 68, 128, 13, '#fff');
      pixelText('FINAL SCORE ' + String(score).padStart(6, '0'), VW / 2 - 76, 156, 13, '#6fe3ff');
      pixelText('HI SCORE    ' + String(hiscore).padStart(6, '0'), VW / 2 - 76, 174, 13, '#ffd84d');
    }
    if (stateTimer > 120 && frame >> 4 & 1) pixelText('按 Enter 返回标题', VW / 2 - 56, curMode ? 222 : 210, 11, 'rgba(255,255,255,.85)');
  }
  if (paused && state === 'play') {
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, 0, VW, VH);
    pixelText('PAUSED', VW / 2 - 34, 132, 20, '#fff');
    pixelText('按 P 继续', VW / 2 - 30, 158, 11, 'rgba(255,255,255,.8)');
  }
  if (muted) pixelText('MUTE', VW - 46, 16, 9, 'rgba(255,255,255,.6)');
  drawWatermark();
}

function loop(ts) {
  requestAnimationFrame(loop);
  if (!lastTs) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.25) dt = 0.25;         // 失焦保护
  acc += dt;
  const STEP = 1 / 60;
  while (acc >= STEP) { step(); acc -= STEP; }
  render();
}

/* ============================ 14. 触屏适配 ============================ */
function toggleFullscreen() {
  const el = document.documentElement;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl) {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    Promise.resolve(req.call(el)).then(() => {
      // 全屏成功后尝试锁定横屏（iOS Safari 不支持则静默忽略）
      try {
        if (screen.orientation && screen.orientation.lock)
          screen.orientation.lock('landscape').catch(() => {});
      } catch (e) {}
    }).catch(() => {});
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
  }
}
function bindTouchPads() {
  const pads = document.querySelectorAll('#pads [data-k]');
  for (const btn of pads) {
    const code = btn.dataset.k;
    const isSys = code === 'KeyP' || code === 'KeyM';
    const down = e => {
      e.preventDefault();
      initAudio();                                   // 移动端音频需在触摸手势中解锁
      if (code === 'FULL') { toggleFullscreen(); return; }
      if (!keys[code]) pressedBuf[code] = true;      // 边沿检测
      keys[code] = true;
      if (!isSys) btn.classList.add('on');
    };
    const up = e => {
      e.preventDefault();
      keys[code] = false;
      if (!isSys) btn.classList.remove('on');
    };
    btn.addEventListener('touchstart', down, { passive: false });
    btn.addEventListener('touchend', up, { passive: false });
    btn.addEventListener('touchcancel', up, { passive: false });
    btn.addEventListener('mousedown', down);
    btn.addEventListener('mouseup', up);
    btn.addEventListener('mouseleave', e => { if (e.buttons === 0) up(e); });
  }
  // 点击画面本体 = Enter（标题/结算界面的"开始/确认"）
  cvs.addEventListener('touchstart', e => {
    e.preventDefault();
    initAudio();
    if (state !== 'play') pressedBuf['Enter'] = true;
  }, { passive: false });
  cvs.addEventListener('mousedown', () => {
    if (state !== 'play') pressedBuf['Enter'] = true;
  });
  // 拦截整页滚动/下拉刷新（微信内常见）
  document.body.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
}
bindTouchPads();

requestAnimationFrame(loop);
