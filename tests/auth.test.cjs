const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Code.gs'), 'utf8');

function backend() {
  const cells = new Map();
  const props = new Map();
  const cache = new Map();
  let now = 1000000;
  let created = false;
  const sheet = {
    getRange: address => ({
      setValue(value) { cells.set(address, value); },
      setNumberFormat() {},
      getValue() { return cells.get(address) || ''; }
    })
  };
  const context = vm.createContext({
    Date: { now: () => now },
    console: { error() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: () => created ? sheet : null,
      insertSheet() { created = true; return sheet; }
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props.get(key), setProperty: (key, value) => props.set(key, value),
      deleteProperty: key => props.delete(key)
    }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algo, value) => crypto.createHash('sha256').update(value).digest(),
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url')
    },
    CacheService: { getScriptCache: () => ({
      get(key) {
        const value = cache.get(key);
        return value && value.until > now ? value.data : null;
      },
      put: (key, data, seconds) => cache.set(key, { data, until: now + seconds * 1000 }),
      remove: key => cache.delete(key)
    }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: text => ({ setMimeType: () => JSON.parse(text) })
    }
  });
  vm.runInContext(source, context);
  function request(body) {
    context.request = { parameter: {}, postData: { contents: JSON.stringify(body) } };
    return vm.runInContext('handleRequest(request)', context);
  }
  function seed() {
    cells.set('B2', 'Example-only test passphrase!');
    const state = {
      roomCode: 'WOLF', theme: 'werewolf', phase: 'lobby', clientMutationId: 'save-1',
      taskProgress: 0, timerPaused: false, phaseEndTime: now + 60000,
      players: [
        { id: 'a', name: 'Alex', seat: 12, alive: false, role: 'IMPACTOR', deviceToken: 'device-token-A' },
        { id: 'b', name: 'Blair', seat: 13, alive: true, role: 'INVESTIGATOR', deviceToken: 'device-token-B' }
      ]
    };
    props.set('ROOM_WOLF', JSON.stringify(state));
    return state;
  }
  return { request, seed, cells, props, cache, advance: ms => { now += ms; } };
}

test('settings tab is created with no default credential and no response leaks its contents', () => {
  const app = backend();
  assert.equal(app.request({ action: 'teacherLogin', passphrase: '1234' }).error, 'TEACHER_SETUP_REQUIRED');
  assert.equal(app.cells.has('B2'), false);
  app.seed();
  const response = JSON.stringify(app.request({ action: 'getState', room: 'WOLF' }));
  assert.ok(!response.includes('Example-only'));
  assert.ok(!response.includes('device-token'));
});

test('login works on multiple devices but unauthorized, expired, or revoked sessions cannot push', () => {
  const app = backend();
  const state = app.seed();
  assert.equal(app.request({ action: 'pushState', room: 'WOLF', state }).error, 'TEACHER_AUTH_REQUIRED');
  const first = app.request({ action: 'teacherLogin', passphrase: 'Example-only test passphrase!' });
  const second = app.request({ action: 'teacherLogin', passphrase: 'Example-only test passphrase!' });
  assert.ok(first.teacherToken && second.teacherToken && first.teacherToken !== second.teacherToken);
  assert.equal(app.request({ action: 'pushState', room: 'WOLF', state, teacherToken: first.teacherToken }).ok, true);
  assert.equal(app.request({ action: 'getState', room: 'WOLF', teacherToken: second.teacherToken }).teacherAuthenticated, true);
  app.cells.set('B2', 'A replacement test passphrase!');
  assert.equal(app.request({ action: 'pushState', room: 'WOLF', state, teacherToken: first.teacherToken }).error, 'TEACHER_AUTH_REQUIRED');
  const third = app.request({ action: 'teacherLogin', passphrase: 'A replacement test passphrase!' });
  app.advance(3600001);
  assert.equal(app.request({ action: 'pushState', room: 'WOLF', state, teacherToken: third.teacherToken }).error, 'TEACHER_AUTH_REQUIRED');
});

test('wrong passphrases are rate limited and logout revokes the session', () => {
  const app = backend();
  app.seed();
  for (let i = 0; i < 5; i++) {
    assert.equal(app.request({ action: 'teacherLogin', passphrase: '1234' }).error, 'INVALID_PASSPHRASE');
  }
  assert.equal(app.request({ action: 'teacherLogin', passphrase: 'Example-only test passphrase!' }).error, 'LOGIN_RATE_LIMITED');
  app.advance(60001);
  const login = app.request({ action: 'teacherLogin', passphrase: 'Example-only test passphrase!' });
  app.request({ action: 'teacherLogout', teacherToken: login.teacherToken });
  assert.equal(app.request({ action: 'getState', teacherToken: login.teacherToken }).teacherAuthenticated, false);
});

test('student state hides other roles and device tokens while teacher state retains them', () => {
  const app = backend();
  app.seed();
  const publicState = app.request({ action: 'getState', room: 'WOLF' }).state;
  assert.equal(publicState.players[0].role, 'CITIZEN');
  assert.equal(publicState.players[1].deviceToken, undefined);
  const ownState = app.request({ action: 'getState', room: 'WOLF', deviceToken: 'device-token-B' }).state;
  assert.equal(ownState.players[1].role, 'INVESTIGATOR');
  assert.equal(ownState.players[0].role, 'CITIZEN');
  const login = app.request({ action: 'teacherLogin', passphrase: 'Example-only test passphrase!' });
  const teacher = app.request({ action: 'getState', teacherToken: login.teacherToken }).state;
  assert.equal(teacher.players[0].role, 'IMPACTOR');
});

test('student joins retain eliminations and allocate seats after the highest existing seat', () => {
  const app = backend();
  app.seed();
  const response = app.request({
    action: 'playerAction', room: 'WOLF', joinIfMissing: true,
    name: 'New', deviceToken: 'new-device'
  });
  assert.equal(response.ok, true);
  assert.equal(response.state.players[0].alive, false);
  assert.equal(response.state.players[2].seat, 14);
  assert.equal(response.state.clientMutationId, 'save-1');
});

test('missing or foreign device tokens cannot alter existing seats and expired tasks are rejected', () => {
  const app = backend();
  const state = app.seed();
  assert.equal(app.request({ action: 'playerAction', playerId: 'a', taskDelta: 1 }).error, 'DEVICE_REQUIRED');
  assert.equal(app.request({ action: 'playerAction', playerId: 'a', deviceToken: 'other-device', taskDelta: 1 }).error, 'SEAT_LOCKED_BY_ANOTHER_DEVICE');
  state.phaseEndTime = 0;
  app.props.set('ROOM_WOLF', JSON.stringify(state));
  assert.equal(app.request({ action: 'playerAction', playerId: 'a', deviceToken: 'device-token-A', taskDelta: 1 }).error, 'TASK_CLOSED');
});

test('embedded deployment script matches Code.gs and the QR library runs locally', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.equal(html.match(/<textarea id="gasCodeTextarea"[^>]*>([\s\S]*?)<\/textarea>/)[1].trim(), source.trim());
  const qr = require('../vendor/qrcode.js')(0, 'M');
  const backendURL = html.match(/const DEFAULT_BACKEND_URL = '([^']+)'/)[1];
  const url = 'https://iama2z.github.io/Classroom-Games/?mode=student&room=CLASS2&backend=' + encodeURIComponent(backendURL);
  qr.addData(url);
  qr.make();
  assert.ok(qr.getModuleCount() > 0);
  assert.match(qr.createSvgTag({ cellSize: 4, margin: 16 }), /<svg/);
  const scale = 6;
  const border = 4;
  const size = (qr.getModuleCount() + border * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / scale) - border;
      const col = Math.floor(x / scale) - border;
      const dark = row >= 0 && col >= 0 && row < qr.getModuleCount() && col < qr.getModuleCount() && qr.isDark(row, col);
      const offset = (y * size + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = dark ? 0 : 255;
      pixels[offset + 3] = 255;
    }
  }
  const decoded = require('jsqr')(pixels, size, size);
  assert.equal(decoded.data, url);
});

test('QR dialog is not inside the hidden group-reset dialog', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const section = html.slice(html.indexOf('<div id="groupActionModal"'), html.indexOf('CORE APPLICATION JAVASCRIPT'));
  const stack = [];
  let found = false;
  for (const match of section.matchAll(/<div\b[^>]*>|<\/div>/g)) {
    if (match[0] === '</div>') {
      stack.pop();
    } else {
      const id = match[0].match(/\bid="([^"]+)"/)?.[1] || '';
      if (id === 'studentQRModal') {
        found = true;
        assert.ok(!stack.includes('groupActionModal'));
        assert.equal(stack.length, 0);
      }
      stack.push(id);
    }
  }
  assert.ok(found);
});
