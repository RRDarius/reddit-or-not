// ── Config ────────────────────────────────────────────────────────────────────
//
// Flip MOCK_MODE to false and set API_BASE to your Azure Function App URL
// when the backend is deployed. Everything else stays the same.
//
const MOCK_MODE = false;
const API_BASE  = 'https://reddit-or-not-api.azurewebsites.net/api';

// ── App state ─────────────────────────────────────────────────────────────────
//
// This is the single source of truth for the frontend. It gets updated every
// time poll() fetches fresh state from the server (or mock).
//
let state = {
  roomCode:     null,
  playerId:     null,
  isHost:       false,
  phase:        'home',          // home | lobby | question | reveal | final
  players:      [],              // [{ name, totalScore }]
  currentQ:     0,               // 0-indexed question number
  totalQ:       0,
  question:     null,            // { text, options: [{ text }] }
  answers:      null,            // reveal only: [{ playerName, answerText, redditScore }]
  hasAnswered:  false,
  answeredCount: 0,
  totalPlayers: 0,
  selectedOption: null,          // local UI only — which button the user clicked
};

let pollTimer = null;

// ── Mock data ─────────────────────────────────────────────────────────────────
//
// Three sample questions so you can play through the full game loop locally
// without a backend. The real backend reads from data/questions.json and picks
// 10 at random — the mock just uses these three for speed.
//
const MOCK_QUESTIONS = [
  {
    text: "Your go-to Friday night movie genre?",
    options: [
      { text: "Sci-fi / dystopian",  redditScore: 92 },
      { text: "Action / Marvel",     redditScore: 80 },
      { text: "Horror",              redditScore: 45 },
      { text: "Rom-com",             redditScore: 8  },
    ],
  },
  {
    text: "What do you actually read?",
    options: [
      { text: "Sci-fi (Dune, Asimov, Liu Cixin)",   redditScore: 91 },
      { text: "Fantasy epics (Sanderson, Tolkien)",  redditScore: 88 },
      { text: "Literary fiction",                    redditScore: 25 },
      { text: "I don't really read",                 redditScore: 10 },
    ],
  },
  {
    text: "What's on your desk?",
    options: [
      { text: "Custom PC with a mechanical keyboard I spec'd myself", redditScore: 96 },
      { text: "A gaming laptop",                                       redditScore: 68 },
      { text: "MacBook Pro",                                           redditScore: 44 },
      { text: "Whatever my job gave me",                               redditScore: 10 },
    ],
  },
];

// ── Mock server state ─────────────────────────────────────────────────────────
//
// This object simulates what Azure Table Storage would hold. The mock API
// functions read and write to it instead of making HTTP calls.
//
let mockGame = null;

function initMockGame(hostName) {
  mockGame = {
    hostId:    'host-guid',
    phase:     'lobby',
    currentQ:  0,
    totalQ:    MOCK_QUESTIONS.length,
    questions: MOCK_QUESTIONS,
    players: [
      { playerId: 'host-guid', name: hostName, totalScore: 0 },
      { playerId: 'bot-alice',  name: 'Alice',  totalScore: 0 },
      { playerId: 'bot-jordan', name: 'Jordan', totalScore: 0 },
    ],
    answers: {},  // { playerId: { answerIndex, redditScore } }
  };
}

// ── Mock API ──────────────────────────────────────────────────────────────────

async function mockCreateRoom(name) {
  initMockGame(name);
  return { roomCode: 'TEST', playerId: 'host-guid', isHost: true };
}

async function mockJoinRoom(_code, name) {
  if (!mockGame) initMockGame('Host');
  // In mock, joining always gives you the host role so you can control the game.
  return { roomCode: 'TEST', playerId: 'host-guid', isHost: true };
}

async function mockGetState() {
  if (!mockGame) return null;
  const g = mockGame;
  const q = g.questions[g.currentQ];

  const base = {
    phase:        g.phase,
    players:      g.players.map(p => ({ name: p.name, totalScore: p.totalScore })),
    currentQ:     g.currentQ,
    totalQ:       g.totalQ,
    answeredCount: Object.keys(g.answers).length,
    totalPlayers: g.players.length,
    hasAnswered:  'host-guid' in g.answers,
  };

  if (g.phase === 'question' || g.phase === 'reveal') {
    // In question phase we strip redditScore from options — players shouldn't
    // be able to see which answer is most reddit before they pick.
    base.question = {
      text:    q.text,
      options: q.options.map(o => ({ text: o.text })),
    };
  }

  if (g.phase === 'reveal') {
    base.answers = g.players
      .filter(p => p.playerId in g.answers)
      .map(p => {
        const a = g.answers[p.playerId];
        return {
          playerName:  p.name,
          answerIndex: a.answerIndex,
          answerText:  q.options[a.answerIndex].text,
          redditScore: a.redditScore,
        };
      });
  }

  return base;
}

async function mockSubmitAnswer(_qIndex, answerIndex) {
  const q = mockGame.questions[mockGame.currentQ];

  // Record the host/player's answer.
  mockGame.answers['host-guid'] = {
    answerIndex,
    redditScore: q.options[answerIndex].redditScore,
  };

  // Bots answer randomly so the reveal screen has multiple rows to show.
  ['bot-alice', 'bot-jordan'].forEach(botId => {
    const pick = Math.floor(Math.random() * q.options.length);
    mockGame.answers[botId] = { answerIndex: pick, redditScore: q.options[pick].redditScore };
  });

  return { ok: true };
}

async function mockAdvancePhase() {
  const g = mockGame;

  if (g.phase === 'lobby') {
    g.phase = 'question';

  } else if (g.phase === 'question') {
    // Tally scores before revealing.
    g.players.forEach(p => {
      if (p.playerId in g.answers) {
        p.totalScore += g.answers[p.playerId].redditScore;
      }
    });
    g.phase = 'reveal';

  } else if (g.phase === 'reveal') {
    const isLast = g.currentQ >= g.totalQ - 1;
    if (isLast) {
      g.phase = 'final';
    } else {
      g.currentQ  += 1;
      g.answers    = {};
      g.phase      = 'question';
    }
  }

  return { ok: true };
}

// ── Real API ──────────────────────────────────────────────────────────────────

async function realCreateRoom(name) {
  return postJSON(`${API_BASE}/create-room`, { name });
}

async function realJoinRoom(roomCode, name) {
  return postJSON(`${API_BASE}/join-room`, { roomCode, name });
}

async function realGetState() {
  const url = `${API_BASE}/get-state?roomCode=${state.roomCode}&playerId=${state.playerId}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function realSubmitAnswer(questionIndex, answerIndex) {
  return postJSON(`${API_BASE}/submit-answer`, {
    roomCode: state.roomCode,
    playerId: state.playerId,
    questionIndex,
    answerIndex,
  });
}

async function realAdvancePhase() {
  return postJSON(`${API_BASE}/advance-phase`, {
    roomCode: state.roomCode,
    playerId: state.playerId,
  });
}

async function postJSON(url, body) {
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── API dispatch ──────────────────────────────────────────────────────────────
//
// Swap all five calls at once by toggling MOCK_MODE at the top of the file.
//
const api = {
  createRoom:   MOCK_MODE ? mockCreateRoom   : realCreateRoom,
  joinRoom:     MOCK_MODE ? mockJoinRoom     : realJoinRoom,
  getState:     MOCK_MODE ? mockGetState     : realGetState,
  submitAnswer: MOCK_MODE ? mockSubmitAnswer : realSubmitAnswer,
  advancePhase: MOCK_MODE ? mockAdvancePhase : realAdvancePhase,
};

// ── Rendering ─────────────────────────────────────────────────────────────────
//
// render() is called after every poll. It merges server state into the local
// state object, then delegates to the right screen renderer.
//
function render(serverState) {
  if (!serverState) return;

  const prevPhase = state.phase;

  state.phase         = serverState.phase;
  state.players       = serverState.players;
  state.currentQ      = serverState.currentQ;
  state.totalQ        = serverState.totalQ;
  state.question      = serverState.question  ?? null;
  state.answers       = serverState.answers   ?? null;
  state.hasAnswered   = serverState.hasAnswered;
  state.answeredCount = serverState.answeredCount;
  state.totalPlayers  = serverState.totalPlayers;

  // Clear the selected-option highlight when a new question loads.
  if (state.phase === 'question' && prevPhase !== 'question') {
    state.selectedOption = null;
  }

  switch (state.phase) {
    case 'lobby':    renderLobby();    break;
    case 'question': renderQuestion(); break;
    case 'reveal':   renderReveal();   break;
    case 'final':    renderFinal();    break;
  }
}

function renderLobby() {
  showScreen('lobby');

  el('lobby-code').textContent = state.roomCode;

  // Build a shareable URL with ?room= so recipients land on the join form
  // with the code pre-filled.
  const url = `${location.origin}${location.pathname}?room=${state.roomCode}`;
  el('lobby-link').textContent = url;

  el('lobby-players').innerHTML = state.players.map((p, i) =>
    `<div class="player-chip">
       ${i === 0 ? '<span class="crown">♛</span>' : ''}
       ${esc(p.name)}
     </div>`
  ).join('');

  if (state.isHost) {
    show('lobby-host-actions');
    hide('lobby-waiting');
    el('btn-start').disabled = state.players.length < 2;
  } else {
    hide('lobby-host-actions');
    show('lobby-waiting');
  }
}

function renderQuestion() {
  showScreen('question');

  el('q-num').textContent   = state.currentQ + 1;
  el('q-total').textContent = state.totalQ;
  el('q-text').textContent  = state.question.text;

  el('q-options').innerHTML = state.question.options.map((o, i) => {
    const isSel = state.selectedOption === i;
    return `<button
      class="option-btn${isSel ? ' selected' : ''}"
      ${state.hasAnswered ? 'disabled' : ''}
      onclick="onSubmitAnswer(${i})"
    >${esc(o.text)}</button>`;
  }).join('');

  el('q-submitted').classList.toggle('hidden', !state.hasAnswered);

  if (state.isHost) {
    show('q-host-bar');
    el('q-count').textContent = `${state.answeredCount} / ${state.totalPlayers} answered`;
  } else {
    hide('q-host-bar');
  }
}

function renderReveal() {
  showScreen('reveal');

  el('r-num').textContent   = state.currentQ + 1;
  el('r-total').textContent = state.totalQ;
  el('r-text').textContent  = state.question.text;

  el('r-answers').innerHTML = (state.answers ?? []).map(a =>
    `<div class="reveal-row">
       <span class="r-name">${esc(a.playerName)}</span>
       <span class="r-answer">${esc(a.answerText)}</span>
       ${scoreBadge(a.redditScore)}
     </div>`
  ).join('');

  el('r-leaderboard').innerHTML = leaderboardHTML(state.players);

  if (state.isHost) {
    show('r-host-bar');
    const isLast = state.currentQ >= state.totalQ - 1;
    el('btn-next').textContent = isLast ? 'See Final Results' : 'Next Question';
  } else {
    hide('r-host-bar');
  }
}

function renderFinal() {
  showScreen('final');
  el('final-leaderboard').innerHTML = leaderboardHTML(state.players, true);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function leaderboardHTML(players, isFinal = false) {
  const sorted = [...players].sort((a, b) => a.totalScore - b.totalScore);
  return sorted.map((p, i) => {
    const isFirst = i === 0;
    const rank    = isFinal && isFirst ? '🏆' : i + 1;
    const suffix  = isFinal && isFirst ? ' — least reddit' : '';
    return `<div class="lb-row${isFirst ? ' first' : ''}">
      <span class="lb-rank">${rank}</span>
      <span class="lb-name">${esc(p.name)}${suffix}</span>
      <span class="lb-score">${p.totalScore} pts</span>
    </div>`;
  }).join('');
}

// Maps a 0-100 reddit score to a colour: green (low/good) → red (high/bad).
function scoreBadge(score) {
  const t   = score / 100;
  const r   = Math.round(255 * t);
  const g   = Math.round(180 * (1 - t));
  const rgb = `${r},${g},0`;
  return `<span class="score-badge"
    style="background:rgba(${rgb},0.18);color:rgb(${rgb})">
    +${score}
  </span>`;
}

// Sanitise strings before inserting into innerHTML to prevent XSS.
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function el(id)  { return document.getElementById(id); }
function show(id){ el(id).classList.remove('hidden'); }
function hide(id){ el(id).classList.add('hidden'); }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  el(`screen-${name}`).classList.remove('hidden');
}

function setError(id, msg) {
  const e = el(id);
  e.textContent = msg;
  e.classList.toggle('hidden', !msg);
}

// ── Polling ───────────────────────────────────────────────────────────────────
//
// After joining or creating a room, the frontend polls get-state every 2s.
// This is how all players stay in sync — no WebSockets needed on the free tier.
//
function startPolling() {
  stopPolling();
  poll();                                    // immediate first fetch
  pollTimer = setInterval(poll, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function poll() {
  try {
    const s = await api.getState();
    render(s);
  } catch (e) {
    console.error('poll error:', e);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function onCreateRoom() {
  const name = el('create-name').value.trim();
  if (!name) return setError('home-error', 'Enter your name.');
  setError('home-error', '');

  el('btn-create').disabled = true;
  try {
    const res = await api.createRoom(name);
    state.roomCode = res.roomCode;
    state.playerId = res.playerId;
    state.isHost   = res.isHost;
    startPolling();
  } catch (e) {
    setError('home-error', e.message || 'Failed to create room.');
    el('btn-create').disabled = false;
  }
}

async function onJoinRoom() {
  const code = el('join-code').value.trim().toUpperCase();
  const name = el('join-name').value.trim();
  if (!code) return setError('home-error', 'Enter a room code.');
  if (!name) return setError('home-error', 'Enter your name.');
  setError('home-error', '');

  el('btn-join').disabled = true;
  try {
    const res = await api.joinRoom(code, name);
    state.roomCode = res.roomCode;
    state.playerId = res.playerId;
    state.isHost   = res.isHost;
    startPolling();
  } catch (e) {
    setError('home-error', e.message || 'Failed to join room. Check the code and try again.');
    el('btn-join').disabled = false;
  }
}

async function onSubmitAnswer(index) {
  if (state.hasAnswered) return;

  // Optimistic update: mark the button selected immediately so the UI feels
  // responsive, then send the request. Roll back if it fails.
  state.selectedOption = index;
  state.hasAnswered    = true;
  renderQuestion();

  try {
    await api.submitAnswer(state.currentQ, index);
  } catch (e) {
    state.selectedOption = null;
    state.hasAnswered    = false;
    renderQuestion();
    console.error('submit error:', e);
  }
}

async function onAdvancePhase() {
  try {
    await api.advancePhase();
    await poll();  // fetch immediately instead of waiting for the next 2s tick
  } catch (e) {
    console.error('advance error:', e);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  // If someone opened a join link (?room=WXYZ), pre-fill the room code field
  // and focus the name field so they can jump straight to joining.
  const params = new URLSearchParams(location.search);
  const room   = params.get('room');
  if (room) {
    el('join-code').value = room.toUpperCase();
    el('join-name').focus();
  }
});
