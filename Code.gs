function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function setupTeacherSettings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('TeacherSettings');
  if (!sheet) {
    sheet = ss.insertSheet('TeacherSettings');
    sheet.getRange('A1').setValue('Keep this spreadsheet private. Do not publish or share it with students.');
    sheet.getRange('A2').setValue('Teacher passphrase (at least 12 characters)');
    sheet.getRange('B2').setNumberFormat('@');
    sheet.getRange('A3').setValue('Set B2 privately. Changing it invalidates every teacher session.');
  }
  return sheet;
}

function teacherFingerprint() {
  var value = String(setupTeacherSettings().getRange('B2').getValue() || '');
  if (value.length < 12 || value.length > 256) return null;
  return digest(value);
}

function digest(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}

function validTeacher(token) {
  if (!token || typeof token !== 'string') return false;
  var cached = CacheService.getScriptCache().get('teacher_' + digest(token));
  var fingerprint = teacherFingerprint();
  return Boolean(fingerprint && cached === fingerprint);
}

function loginTeacher(body) {
  var fingerprint = teacherFingerprint();
  if (!fingerprint) return { ok: false, error: 'TEACHER_SETUP_REQUIRED' };
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  var attempts = JSON.parse(props.getProperty('TEACHER_LOGIN_ATTEMPTS') || '{"count":0,"until":0}');
  if (attempts.until > now && attempts.count >= 5) return { ok: false, error: 'LOGIN_RATE_LIMITED' };
  if (attempts.until <= now) attempts = { count: 0, until: now + 60000 };
  if (typeof body.passphrase !== 'string' || body.passphrase.length > 256 || digest(body.passphrase) !== fingerprint) {
    attempts.count++;
    props.setProperty('TEACHER_LOGIN_ATTEMPTS', JSON.stringify(attempts));
    return { ok: false, error: 'INVALID_PASSPHRASE' };
  }
  props.deleteProperty('TEACHER_LOGIN_ATTEMPTS');
  var token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('teacher_' + digest(token), fingerprint, 3600);
  return { ok: true, teacherToken: token, expiresAt: now + 3600000 };
}

function visibleState(state, teacher, deviceToken) {
  if (!state) return null;
  var copy = JSON.parse(JSON.stringify(state));
  if (copy.lastHauntEvent && Date.now() - copy.lastHauntEvent.timestamp >= 3200) {
    copy.players.forEach(function(p) { p.haunted = false; });
  }
  if (teacher) return copy;
  var viewer = state.players.find(function(p) { return deviceToken && p.deviceToken === deviceToken; });
  copy.revealRolesOnGodPanel = false;
  copy.players.forEach(function(player) {
    var own = deviceToken && player.deviceToken === deviceToken;
    var teammate = viewer && viewer.role === 'IMPACTOR' && player.role === 'IMPACTOR';
    if (!own && !teammate && state.phase !== 'gameover') player.role = 'CITIZEN';
    delete player.deviceToken;
    if (!own) {
      player.nightTarget = null;
      delete player.investigatedResult;
    }
  });
  return copy;
}

function handleRequest(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, error: 'SERVER_BUSY' });
  try {
    var params = e.parameter || {};
    var body = {};
    if (e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); }
      catch (error) { return jsonResponse({ ok: false, error: 'INVALID_REQUEST' }); }
    }
    var action = body.action || params.action || 'getState';
    if (action === 'teacherLogin') {
      if (!e.postData) return jsonResponse({ ok: false, error: 'POST_REQUIRED' });
      return jsonResponse(loginTeacher(body));
    }
    var teacher = validTeacher(body.teacherToken);
    if (action === 'teacherLogout') {
      if (body.teacherToken) CacheService.getScriptCache().remove('teacher_' + digest(body.teacherToken));
      return jsonResponse({ ok: true });
    }
    var room = String(body.room || params.room || 'WOLF').toUpperCase();
    if (!/^[A-Z0-9_-]{1,8}$/.test(room)) return jsonResponse({ ok: false, error: 'INVALID_ROOM' });
    var props = PropertiesService.getScriptProperties();
    var key = 'ROOM_' + room;
    var raw = props.getProperty(key);
    var state = raw ? JSON.parse(raw) : null;
    if (action === 'pushState') {
      if (!teacher) return jsonResponse({ ok: false, error: 'TEACHER_AUTH_REQUIRED' });
      if (!body.state || body.state.roomCode !== room || !Array.isArray(body.state.players)) {
        return jsonResponse({ ok: false, error: 'INVALID_STATE' });
      }
      props.setProperty(key, JSON.stringify(body.state));
      return jsonResponse({ ok: true, state: visibleState(body.state, true) });
    }
    if (action === 'playerAction') {
      if (!state) return jsonResponse({ ok: false, error: 'ROOM_NOT_FOUND' });
      if (typeof body.deviceToken !== 'string' || body.deviceToken.length < 8) {
        return jsonResponse({ ok: false, error: 'DEVICE_REQUIRED' });
      }
      var player = state.players.find(function(p) {
        return p.id === body.playerId || (body.joinIfMissing && p.name.toLowerCase() === String(body.name || '').toLowerCase());
      });
      if (player && player.deviceToken && player.deviceToken !== body.deviceToken) {
        return jsonResponse({ ok: false, error: 'SEAT_LOCKED_BY_ANOTHER_DEVICE' });
      }
      if (player && !player.deviceToken && !body.joinIfMissing) {
        return jsonResponse({ ok: false, error: 'JOIN_REQUIRED' });
      }
      if (!player && body.joinIfMissing && body.name && state.phase === 'lobby') {
        player = {
          id: Utilities.getUuid(),
          seat: Math.max.apply(null, [0].concat(state.players.map(function(p) { return Number(p.seat) || 0; }))) + 1,
          name: String(body.name).slice(0, 16), alive: true, role: 'CITIZEN',
          location: null, nightTarget: null, voteTarget: null, hauntTarget: null,
          haunted: false, hauntCount: 0
        };
        state.players.push(player);
      }
      if (!player) return jsonResponse({ ok: false, error: 'PLAYER_NOT_FOUND' });
      player.deviceToken = body.deviceToken;
      player.isBot = false;
      var active = !state.timerPaused && state.phaseEndTime > Date.now();
      var target = state.players.find(function(p) { return p.id === body.nightTarget; });
      if (body.location !== undefined) {
        if (!active || state.phase !== 'dusk' || !player.alive) return jsonResponse({ ok: false, error: 'ACTION_CLOSED' });
        player.location = String(body.location);
      }
      if (body.nightTarget !== undefined) {
        if (!active || state.phase !== 'night' || !player.alive || !target || !target.alive ||
            ['IMPACTOR', 'INVESTIGATOR', 'PROTECTOR'].indexOf(player.role) < 0) {
          return jsonResponse({ ok: false, error: 'ACTION_CLOSED' });
        }
        player.nightTarget = target.id;
        if (player.role === 'INVESTIGATOR') {
          player.investigatedResult = { targetId: target.id, isThreat: target.role === 'IMPACTOR' };
        }
      }
      if (body.voteTarget !== undefined) {
        if (!active || state.phase !== 'voting' || !player.alive ||
            !state.players.some(function(p) { return p.id === body.voteTarget && p.alive; })) {
          return jsonResponse({ ok: false, error: 'ACTION_CLOSED' });
        }
        player.voteTarget = body.voteTarget;
      }
      if (body.hauntTarget !== undefined) {
        var hTarget = state.players.find(function(p) { return p.id === body.hauntTarget && p.alive; });
        if (player.alive || !hTarget || state.phase === 'gameover' || Date.now() - (player.lastHauntAt || 0) < 6000) {
          return jsonResponse({ ok: false, error: 'HAUNT_UNAVAILABLE' });
        }
        player.lastHauntAt = Date.now();
        player.hauntTarget = hTarget.id;
        state.players.forEach(function(p) { p.haunted = false; });
        hTarget.haunted = true;
        hTarget.hauntCount = (hTarget.hauntCount || 0) + 1;
        state.lastHauntEvent = { targetId: hTarget.id, targetName: hTarget.name, timestamp: Date.now() };
      }
      if (body.taskDelta !== undefined) {
        if (!active || state.phase === 'gameover' || body.taskDelta !== 1) {
          return jsonResponse({ ok: false, error: 'TASK_CLOSED' });
        }
        state.taskProgress = Math.min(100, (state.taskProgress || 0) + 1);
        if (state.taskProgress === 100) {
          state.phase = 'gameover';
          state.timerPaused = true;
          state.announcement = 'Citizen team wins! The class completed 100% of its fortifications.';
          state.lastResult = { matchSessionId: state.matchSessionId, endedAt: Date.now(), text: state.announcement };
        }
      }
      props.setProperty(key, JSON.stringify(state));
      return jsonResponse({ ok: true, state: visibleState(state, teacher, body.deviceToken) });
    }
    if (action !== 'getState') return jsonResponse({ ok: false, error: 'UNKNOWN_ACTION' });
    return jsonResponse({
      ok: true, authVersion: 1, teacherAuthenticated: teacher,
      state: visibleState(state, teacher, body.deviceToken || params.deviceToken)
    });
  } catch (error) {
    console.error('Game request failed', error.message);
    return jsonResponse({ ok: false, error: 'SERVER_ERROR' });
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
