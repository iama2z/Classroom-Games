const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function harness({ storage = new Map(), fetch = async () => { throw new Error('Offline'); }, search = '' } = {}) {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {
      value: '', textContent: '', innerHTML: '', style: { setProperty(key, value) { this[key] = value; } }, children: [],
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, force) {
          const add = force === undefined ? !classes.has(name) : force;
          if (add) classes.add(name); else classes.delete(name);
        },
        contains: name => classes.has(name)
      },
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      setAttribute(key, value) { this[key] = value; }, addEventListener() {},
      focus() {}, select() {}, remove() {}
    };
  }
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element, body: element(), addEventListener() {},
    activeElement: { tagName: 'BODY' }
  };
  const window = {
    location: { search, href: 'http://localhost/index.html' + search },
    addEventListener() {}
  };
  const context = vm.createContext({
    document, window, localStorage, fetch, URLSearchParams, AbortSignal,
    console: { log() {}, warn() {}, error() {} },
    setInterval() {}, clearInterval() {},
    setTimeout(fn) { queueMicrotask(fn); return 1; }, clearTimeout() {}
  });
  vm.runInContext(script, context);
  vm.runInContext('playTone = () => {}; playRandomSpookySound = () => {};', context);
  const run = code => vm.runInContext(code, context);
  return { run, storage, document, load: () => window.onload() };
}

function server(initial) {
  let state = initial ? JSON.parse(JSON.stringify(initial)) : null;
  const writes = [];
  return {
    writes,
    get state() { return state; },
    fetch: async (_url, options = {}) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        assert.equal(body.action, 'pushState');
        state = body.state;
        writes.push(state);
        return { type: 'opaque' };
      }
      return { ok: true, json: async () => ({ ok: true, state }) };
    }
  };
}

test('both entry points contain identical code and unique element IDs', () => {
  assert.equal(html, fs.readFileSync(require('node:path').join(__dirname, '../chameleon_deduction_classroom_game.html'), 'utf8'));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('teacher refresh preserves elimination, rules, paused timer, and view', async () => {
  const app = harness();
  await app.load();
  app.run(`
    togglePlayerAliveState(gameState.players[0].id);
    setSpatialMode(false);
    gameState.timerSeconds = 17;
    gameState.timerPaused = true;
    switchView('projector');
  `);
  const reloaded = harness({ storage: app.storage });
  await reloaded.load();
  assert.equal(reloaded.run('gameState.players[0].alive'), false);
  assert.equal(reloaded.run('gameState.spatialMode'), false);
  assert.equal(reloaded.run('gameState.timerSeconds'), 17);
  assert.equal(reloaded.run('activeView'), 'home');
});

test('an empty roster stays empty after reload instead of reseeding bots', async () => {
  const app = harness();
  await app.load();
  app.run('confirmRemovePlayers(true); removeConfirmedPlayers();');
  assert.equal(app.run('gameState.players.length'), 0);
  const reloaded = harness({ storage: app.storage });
  await reloaded.load();
  assert.equal(reloaded.run('gameState.players.length'), 0);
});

test('removal clears references without reviving or renumbering survivors', async () => {
  const app = harness();
  await app.load();
  app.run(`
    gameState.players[1].alive = false;
    gameState.players[1].voteTarget = gameState.players[0].id;
    document.getElementById('removePlayerSelect').value = gameState.players[0].id;
    confirmRemovePlayers(false);
    removeConfirmedPlayers();
  `);
  assert.equal(app.run('gameState.players[0].seat'), 2);
  assert.equal(app.run('gameState.players[0].alive'), false);
  assert.equal(app.run('gameState.players[0].voteTarget'), null);
});

test('student refresh restores the same eliminated seat and never falls back to another player', async () => {
  const app = harness();
  await app.load();
  app.run(`
    document.getElementById('studentNameInput').value = gameState.players[2].name;
    joinGameAsStudent();
    gameState.players[2].alive = false;
    switchView('student');
  `);
  const reloaded = harness({ storage: app.storage });
  await reloaded.load();
  assert.equal(reloaded.run('studentSession.joined'), true);
  assert.equal(reloaded.run('getActiveStudentPlayer().seat'), 3);
  assert.equal(reloaded.run('getActiveStudentPlayer().alive'), false);
  assert.equal(reloaded.run('activeView'), 'student');
  reloaded.run('gameState.players = gameState.players.filter(p => p.id !== studentSession.playerId);');
  assert.equal(reloaded.run('getActiveStudentPlayer()'), null);
});

test('live refresh restores a seat after loading the shared room on a fresh student device', async () => {
  const teacher = harness();
  await teacher.load();
  const state = JSON.parse(teacher.run('JSON.stringify(gameState)'));
  state.players[3].alive = false;
  const remote = server(state);
  const storage = new Map([
    ['chameleon_seat_lock', JSON.stringify({
      roomCode: 'WOLF', matchSessionId: state.matchSessionId,
      playerId: state.players[3].id
    })]
  ]);
  const student = harness({
    storage, fetch: remote.fetch,
    search: '?mode=student&room=WOLF&backend=' + encodeURIComponent('https://script.google.com/macros/s/test/exec')
  });
  await student.load();
  assert.equal(student.run('studentSession.joined'), true);
  assert.equal(student.run('getActiveStudentPlayer().alive'), false);
  assert.equal(student.run('gameState.networkMode'), 'sheets');
  assert.equal(remote.writes.length, 0);
});

test('live saves are confirmed by readback and survive instructor refresh', async () => {
  const remote = server();
  const app = harness({ fetch: remote.fetch });
  await app.load();
  await app.run(`
    gasWebAppUrl = 'https://script.google.com/macros/s/test/exec';
    localStorage.setItem('chameleon_gas_url', gasWebAppUrl);
    gameState.networkMode = 'sheets';
    gameState.players[0].alive = false;
    pushStateToGoogleSheetIfNeeded();
  `);
  assert.equal(app.run('pendingTeacherState'), null);
  assert.equal(remote.state.players[0].alive, false);
  assert.match(app.run('syncStatus'), /confirmed/);
  const reloaded = harness({ storage: app.storage, fetch: remote.fetch });
  await reloaded.load();
  assert.equal(reloaded.run('gameState.players[0].alive'), false);
  assert.equal(remote.writes.length, 1);
});

test('offline pending teacher changes survive reload and cannot be overwritten by polling', async () => {
  const app = harness();
  await app.load();
  await app.run(`
    gasWebAppUrl = 'https://script.google.com/macros/s/test/exec';
    localStorage.setItem('chameleon_gas_url', gasWebAppUrl);
    gameState.networkMode = 'sheets';
    gameState.players[0].alive = false;
    pushStateToGoogleSheetIfNeeded();
  `);
  assert.ok(app.run('pendingTeacherState'));
  const old = JSON.parse(app.run('JSON.stringify(gameState)'));
  old.players[0].alive = true;
  const remote = server(old);
  const reloaded = harness({ storage: app.storage, fetch: remote.fetch });
  await reloaded.load();
  assert.equal(reloaded.run('gameState.players[0].alive'), false);
  assert.equal(remote.state.players[0].alive, false);
  assert.equal(reloaded.run('pendingTeacherState'), null);
});

test('an in-flight stale poll cannot undo a new teacher edit', async () => {
  let finishRead;
  let state;
  let firstRead = true;
  const app = harness({ fetch: async (_url, options = {}) => {
    if (options.method === 'POST') {
      state = JSON.parse(options.body).state;
      return { type: 'opaque' };
    }
    if (firstRead) {
      firstRead = false;
      return new Promise(resolve => { finishRead = resolve; });
    }
    return { ok: true, json: async () => ({ ok: true, state }) };
  } });
  await app.load();
  app.run(`gameState.networkMode = 'sheets'; gasWebAppUrl = 'https://script.google.com/macros/s/test/exec';`);
  const old = JSON.parse(app.run('JSON.stringify(gameState)'));
  const read = app.run('pullStateFromGoogleSheet()');
  await app.run('gameState.players[0].alive = false; pushStateToGoogleSheetIfNeeded();');
  finishRead({ ok: true, json: async () => ({ ok: true, state: old }) });
  await read;
  assert.equal(app.run('gameState.players[0].alive'), false);
});

test('rapid teacher edits are serialized and the newest snapshot is persisted', async () => {
  let releaseFirstWrite;
  let state;
  let writes = 0;
  const app = harness({ fetch: async (_url, options = {}) => {
    if (options.method === 'POST') {
      const snapshot = JSON.parse(options.body).state;
      writes++;
      if (writes === 1) await new Promise(resolve => { releaseFirstWrite = resolve; });
      state = snapshot;
      return { type: 'opaque' };
    }
    return { ok: true, json: async () => ({ ok: true, state }) };
  } });
  await app.load();
  app.run(`gameState.networkMode = 'sheets'; gasWebAppUrl = 'https://script.google.com/macros/s/test/exec';`);
  const firstSave = app.run('gameState.players[0].alive = false; pushStateToGoogleSheetIfNeeded();');
  await app.run('gameState.players[1].alive = false; pushStateToGoogleSheetIfNeeded();');
  releaseFirstWrite();
  await firstSave;
  assert.equal(writes, 2);
  assert.equal(state.players[0].alive, false);
  assert.equal(state.players[1].alive, false);
  assert.equal(app.run('pendingTeacherState'), null);
});

test('mode selection keeps the roster but never reports an unverified connection as confirmed', async () => {
  const app = harness();
  await app.load();
  app.run(`setNetworkMode('sheets');`);
  assert.equal(app.run('gameState.players.length'), 12);
  assert.match(app.document.getElementById('teacherSetupNext').textContent, /configure/);
  assert.doesNotMatch(app.document.getElementById('teacherSaveStatus').textContent, /confirmed/);
});

test('failed save acknowledgement keeps the local edit pending', async () => {
  const app = harness({ fetch: async (_url, options = {}) => options.method === 'POST'
    ? { type: 'opaque' } : { ok: true, json: async () => ({ ok: true, state: null }) } });
  await app.load();
  await app.run(`
    gameState.networkMode = 'sheets';
    gasWebAppUrl = 'https://script.google.com/macros/s/test/exec';
    gameState.players[0].alive = false;
    pushStateToGoogleSheetIfNeeded();
  `);
  assert.equal(app.run('pendingTeacherState.players[0].alive'), false);
  assert.match(app.run('syncStatus'), /not confirmed/);
});

test('missing seats are migrated consistently and new seats do not collide after removal', async () => {
  const app = harness();
  await app.load();
  app.run('delete gameState.players[0].seat; normalizePlayerSeats();');
  assert.equal(app.run('gameState.players[0].seat'), 1);
  app.run(`
    gameState.players.splice(0, 1);
    document.getElementById('newPlayerNameModalInput').value = 'New student';
    confirmAddCustomPlayer();
  `);
  assert.equal(app.run('gameState.players.at(-1).seat'), 13);
});

test('tasks still add exactly one percent and reject expired timers', async () => {
  const app = harness();
  await app.load();
  app.run(`
    document.getElementById('studentNameInput').value = 'Alex';
    joinGameAsStudent();
    gameState.phase = 'night';
    setAuthoritativeTimer(30, false);
    gameState.taskProgress = 10;
    studentSession.activeDecoyCode = '1234';
    ['1', '2', '3', '4'].forEach(pressDecoyKeypad);
  `);
  assert.equal(app.run('gameState.taskProgress'), 11);
  app.run(`
    gameState.phaseEndTime = Date.now() - 1;
    studentSession.activeDecoyCode = '1234';
    ['1', '2', '3', '4'].forEach(pressDecoyKeypad);
  `);
  assert.equal(app.run('gameState.taskProgress'), 11);
});

test('Apps Script keeps elimination and save acknowledgements when adding students after removals', () => {
  const state = {
    roomCode: 'WOLF', clientMutationId: 'save-1',
    players: [{ id: 'existing', name: 'Existing', seat: 12, alive: false }]
  };
  const properties = new Map([['ROOM_WOLF', JSON.stringify(state)]]);
  const backend = vm.createContext({
    LockService: { getScriptLock: () => ({ tryLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key),
      setProperty: (key, value) => properties.set(key, value)
    }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: text => ({ setMimeType: () => JSON.parse(text) })
    }
  });
  const code = html.match(/<textarea id="gasCodeTextarea"[^>]*>([\s\S]*?)<\/textarea>/)[1];
  vm.runInContext(code, backend);
  backend.request = {
    parameter: {},
    postData: { contents: JSON.stringify({
      action: 'playerAction', room: 'WOLF', joinIfMissing: true,
      playerId: 'new', name: 'New', deviceToken: 'new-device'
    }) }
  };
  const response = vm.runInContext('handleRequest(request)', backend);
  assert.equal(response.state.players[0].alive, false);
  assert.equal(response.state.players[1].seat, 13);
  assert.equal(response.state.clientMutationId, 'save-1');
});

test('home is the default view and the initial action says Start Game', async () => {
  const app = harness();
  await app.load();
  assert.equal(app.run('activeView'), 'home');
  assert.equal(app.document.getElementById('btnNextPhaseLabel').textContent, 'START GAME');
  assert.equal(app.run('groups.length'), 4);
  assert.equal(app.document.getElementById('viewProjector').classList.contains('hidden'), true);
  assert.equal(app.document.getElementById('homeGameStatus').textContent, 'Ready to start');
});

test('four classes isolate rosters, rules, and layouts, including after reload', async () => {
  const app = harness();
  await app.load();
  app.run(`
    gameState.players[0].name = 'First class';
    gameState.players[0].alive = false;
    gameState.spatialMode = false;
    toggleDashboardCustomization();
    selectDashboardPanel('panelRoster');
    updateDashboardPanel('width', 6);
    updateDashboardPanel('background', '#112233');
    toggleSelectedPanel();
    saveLocalGameState();
  `);
  const firstRoom = app.run('gameState.roomCode');
  const secondRoom = app.run('groups[1].code');
  await app.run(`selectGroup('${secondRoom}')`);
  assert.equal(app.run('gameState.players.length'), 0);
  assert.equal(app.run('gameState.spatialMode'), true);
  assert.equal(app.run('Object.keys(dashboardLayout).length'), 0);
  app.run(`
    document.getElementById('newPlayerNameModalInput').value = 'Second class';
    confirmAddCustomPlayer();
    toggleDashboardCustomization();
    selectDashboardPanel('panelRoster');
    updateDashboardPanel('width', 4);
  `);
  await app.run(`selectGroup('${firstRoom}')`);
  assert.equal(app.run('gameState.players[0].name'), 'First class');
  assert.equal(app.run('gameState.players[0].alive'), false);
  assert.equal(app.run('gameState.spatialMode'), false);
  assert.equal(app.run('dashboardLayout.panelRoster.width'), 6);
  assert.equal(app.run('dashboardLayout.panelRoster.hidden'), true);
  const reloaded = harness({ storage: app.storage });
  await reloaded.load();
  assert.equal(reloaded.run('dashboardLayout.panelRoster.background'), '#112233');
  await reloaded.run(`selectGroup('${secondRoom}')`);
  assert.equal(reloaded.run('gameState.players[0].name'), 'Second class');
  assert.equal(reloaded.run('dashboardLayout.panelRoster.width'), 4);
});

test('new game keeps roster, settings, layout, and recent result but clears match actions', async () => {
  const app = harness();
  await app.load();
  app.run(`
    gameState.players[0].alive = false;
    gameState.players[0].voteTarget = gameState.players[1].id;
    gameState.players[0].hauntTarget = gameState.players[1].id;
    gameState.phase = 'gameover';
    gameState.announcement = '<strong>Villagers win!</strong>';
    recordGameResult();
    gameState.spatialMode = false;
    toggleDashboardCustomization();
    updateDashboardPanel('width', 6);
    requestGroupAction('new');
    confirmGroupAction();
  `);
  assert.equal(app.run('gameState.phase'), 'lobby');
  assert.equal(app.run('gameState.players.length'), 12);
  assert.equal(app.run('gameState.players.every(p => p.alive && !p.voteTarget && !p.hauntTarget)'), true);
  assert.equal(app.run('gameState.timerPaused'), true);
  assert.equal(app.run('gameState.spatialMode'), false);
  assert.equal(app.run('dashboardLayout.panelOverview.width'), 6);
  assert.equal(app.run('gameState.lastResult.text'), 'Villagers win!');
});

test('reset settings leaves the current match and roster intact; clear affects only this class', async () => {
  const app = harness();
  await app.load();
  app.run(`
    gameState.phase = 'night';
    gameState.players[0].alive = false;
    gameState.taskProgress = 77;
    gameState.spatialMode = false;
    gameState.theme = 'scifi';
    requestGroupAction('settings');
    confirmGroupAction();
  `);
  assert.equal(app.run('gameState.phase'), 'night');
  assert.equal(app.run('gameState.taskProgress'), 77);
  assert.equal(app.run('gameState.players[0].alive'), false);
  assert.equal(app.run('gameState.spatialMode'), true);
  assert.equal(app.run('gameState.theme'), 'werewolf');
  const firstRoom = app.run('gameState.roomCode');
  await app.run('selectGroup(groups[1].code)');
  app.run('requestGroupAction("clear"); confirmGroupAction();');
  assert.equal(app.run('gameState.players.length'), 0);
  await app.run(`selectGroup('${firstRoom}')`);
  assert.equal(app.run('gameState.players.length'), 12);
  assert.equal(app.run('gameState.players[0].alive'), false);
});

test('panel editing is gated and reset layout restores hidden panels', async () => {
  const app = harness();
  await app.load();
  app.run(`
    securityState.isTeacherUnlocked = false;
    toggleDashboardCustomization();
    updateDashboardPanel('hidden', true);
  `);
  assert.equal(app.run('dashboardEditing'), false);
  assert.equal(app.run('Object.keys(dashboardLayout).length'), 0);
  app.run(`
    securityState.isTeacherUnlocked = true;
    toggleDashboardCustomization();
    toggleSelectedPanel();
  `);
  assert.equal(app.run('dashboardLayout.panelOverview.hidden'), true);
  app.run('resetDashboardLayout()');
  assert.equal(app.run('Object.keys(dashboardLayout).length'), 0);
  assert.equal(app.document.getElementById('panelOverview')['data-panel-hidden'], 'false');
});

test('student countdown matches instructor; expiry sounds once only for the instructor', async () => {
  const app = harness();
  await app.load();
  app.run(`
    let alarms = 0;
    playTone = () => { alarms++; };
    switchView('projector');
    alarms = 0;
    gameState.phase = 'night';
    setAuthoritativeTimer(2, false);
    updateProjectorTimerUI();
  `);
  assert.equal(app.document.getElementById('studentTimerDisplay').textContent,
    app.document.getElementById('projTimerDisplay').textContent);
  app.run(`
    gameState.phaseEndTime = Date.now() - 1;
    updateProjectorTimerUI();
    updateProjectorTimerUI();
  `);
  assert.equal(app.run('alarms'), 1);
  assert.equal(app.document.getElementById('studentTimerDisplay').textContent, '00:00');
  app.run(`
    switchView('student');
    alarms = 0;
    setAuthoritativeTimer(2, false);
    gameState.phaseEndTime = Date.now() - 1;
    updateProjectorTimerUI();
  `);
  assert.equal(app.run('alarms'), 0);
});

test('home code entry opens the intended room and locks student navigation', async () => {
  const app = harness();
  await app.load();
  app.run(`document.getElementById('homeRoomInput').value = 'CLASS2';`);
  await app.run('joinFromHome()');
  assert.equal(app.run('gameState.roomCode'), 'CLASS2');
  assert.equal(app.run('activeView'), 'student');
  assert.equal(app.run('securityState.isTeacherUnlocked'), false);
  app.run(`switchView('projector')`);
  assert.equal(app.run('activeView'), 'student');
  assert.equal(app.document.getElementById('teacherPinModal').classList.contains('hidden'), false);
});

test('Start Next Round continues without reassigning roles or reviving eliminated players', async () => {
  const app = harness();
  await app.load();
  const roles = app.run('JSON.stringify(gameState.players.map(p => p.role))');
  app.run(`
    gameState.phase = 'lobby_between';
    gameState.players[0].alive = false;
    advanceToNextPhase();
  `);
  assert.equal(app.run('gameState.phase'), 'dusk');
  assert.equal(app.run('gameState.players[0].alive'), false);
  assert.equal(app.run('JSON.stringify(gameState.players.map(p => p.role))'), roles);
});

test('clearing one group preserves another group seat lock and clears its own result', async () => {
  const app = harness();
  await app.load();
  app.run(`
    saveStudentSeatLock(gameState.players[0]);
    localStorage.setItem('chameleon_seat_lock_CLASS2', '{"playerId":"other"}');
    gameState.lastResult = { text: 'Old game' };
    requestGroupAction('clear');
    confirmGroupAction();
  `);
  assert.equal(app.run('gameState.lastResult'), null);
  assert.equal(app.storage.has('chameleon_seat_lock_WOLF'), false);
  assert.equal(app.storage.has('chameleon_seat_lock_CLASS2'), true);
});
