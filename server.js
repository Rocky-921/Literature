const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

// ─── Game Constants ────────────────────────────────────────────────────────
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const BOOKS = {
  high: ['A', 'K', 'Q', 'J', '10', '9'],
  low: ['7', '6', '5', '4', '3', '2'],
};
const BOOK_KEYS = [];
for (const suit of SUITS) {
  BOOK_KEYS.push(`${suit}_high`);
  BOOK_KEYS.push(`${suit}_low`);
}

const BOOK_LABEL_SERVER = {
  hearts_high: '♥ High (A-9)', hearts_low: '♥ Low (7-2)',
  diamonds_high: '♦ High (A-9)', diamonds_low: '♦ Low (7-2)',
  spades_high: '♠ High (A-9)', spades_low: '♠ Low (7-2)',
  clubs_high: '♣ High (A-9)', clubs_low: '♣ Low (7-2)',
};

function cardBook(card) {
  const { suit, rank } = card;
  const highRanks = ['A', 'K', 'Q', 'J', '10', '9'];
  return `${suit}_${highRanks.includes(rank) ? 'high' : 'low'}`;
}

function buildDeck() {
  const ranks = ['A', 'K', 'Q', 'J', '10', '9', '7', '6', '5', '4', '3', '2'];
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of ranks) {
      deck.push({ suit, rank, id: `${rank}_${suit}` });
    }
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Rooms ─────────────────────────────────────────────────────────────────
const rooms = {};

// sessionToken -> { playerId, roomCode, name, seatIndex, team, hand, reconnectTimer }
const sessionStore = {};

const RECONNECT_GRACE_MS = 90_000; // 90 seconds to reconnect

function generateToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function createRoom(code) {
  return {
    code,
    phase: 'lobby',  // lobby | playing | ended
    players: [],     // { id, name, ws, team, seatIndex, hand: [], sessionToken }
    currentTurn: null,
    books: { A: [], B: [] },
    revokedBooks: [],          // books forfeited due to wrong declaration
    log: [],
    bookOwnership: {},  // bookKey -> { team, cards: {playerId: [cards]} } once declared
  };
}

function broadcastRoom(room) {
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      const state = buildStateFor(room, p.id);
      p.ws.send(JSON.stringify({ type: 'state', state }));
    }
  }
}

function getAskableCards(player) {
  const booksOwned = new Set(player.hand.map(c => cardBook(c)));

  const possible = [];

  for (const suit of SUITS) {
    for (const rank of [...BOOKS.high, ...BOOKS.low]) {
      const id = `${rank}_${suit}`;
      const book = cardBook({ suit, rank });

      if (!booksOwned.has(book)) continue; // must own book
      if (player.hand.some(c => c.id === id)) continue; // cannot ask owned card

      possible.push(id);
    }
  }

  return possible;
}

function buildStateFor(room, playerId) {
  const player = getPlayer(room, playerId);
  return {
    phase: room.phase,
    code: room.code,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      seatIndex: p.seatIndex,
      cardCount: p.hand.length,
      hand: p.id === playerId ? p.hand : new Array(p.hand.length).fill({ back: true }),
      disconnected: p.ws.readyState === -1,
    })),
    currentTurn: room.currentTurn,
    books: room.books,
    revokedBooks: room.revokedBooks || [],
    log: room.log.slice(-30),
    myId: playerId,
    askableCards: player ? getAskableCards(player) : [],
  };
}

function addLog(room, msg, type = 'info') {
  room.log.push({ msg, type, ts: Date.now() });
}

function getPlayer(room, id) {
  return room.players.find(p => p.id === id);
}

function teamOf(room, id) {
  return getPlayer(room, id)?.team;
}

function teammates(room, id) {
  const team = teamOf(room, id);
  return room.players.filter(p => p.team === team && p.id !== id);
}

function opponents(room, id) {
  const team = teamOf(room, id);
  return room.players.filter(p => p.team !== team);
}


function startGame(room) {
  const deck = shuffle(buildDeck());
  room.players.sort((a, b) => a.seatIndex - b.seatIndex);
  for (let i = 0; i < 6; i++) {
    room.players[i].hand = deck.slice(i * 8, (i + 1) * 8);
  }
  room.phase = 'playing';
  room.currentTurn = room.players.find(p => p.hand.length > 0)?.id;
  addLog(room, `Game started! ${room.players[0].name} goes first.`, 'system');
  broadcastRoom(room);
}

function parseCard(cardId) {
  const [rank, suit] = cardId.split('_');
  if (!rank || !suit) return null;

  const validRanks = ['A','K','Q','J','10','9','7','6','5','4','3','2'];
  if (!SUITS.includes(suit) || !validRanks.includes(rank)) return null;

  return { rank, suit, id: cardId };
}

function handleAsk(room, askerId, targetId, cardId) {
  const asker = getPlayer(room, askerId);
  const target = getPlayer(room, targetId);

  if (!asker || !target) return { ok: false, msg: 'Player not found' };
  if (room.currentTurn !== askerId) return { ok: false, msg: 'Not your turn' };
  if (teamOf(room, askerId) === teamOf(room, targetId)) return { ok: false, msg: 'Cannot ask a teammate' };
  if (target.hand.length === 0) return { ok: false, msg: 'That player has no cards' };

  // Parse cardId
  const card = parseCard(cardId);
  if (!card) return { ok: false, msg: 'Invalid card' };
  const book = cardBook(card);

  if (asker.hand.length === 0) {
    return { ok: false, msg: 'You have no cards' };
  }

  // Asker must have at least one card of same book
  const hasBookCard = asker.hand.some(c => cardBook(c) === book);
  if (!hasBookCard) return { ok: false, msg: 'You must have a card from that book to ask for one' };

  if (
    room.books.A.includes(book) ||
    room.books.B.includes(book)
  ) {
    return { ok: false, msg: 'That book is already completed' };
  }

  // Asker cannot ask for a card they already have
  if (asker.hand.some(c => c.id === cardId)) return { ok: false, msg: 'You already have that card!' };

  const idx = target.hand.findIndex(c => c.id === cardId);
  if (idx !== -1) {
    // Target has the card
    const [given] = target.hand.splice(idx, 1);
    asker.hand.push(given);
    addLog(room, `${asker.name} asked ${target.name} for ${card.rank} of ${card.suit} — ✓ Got it!`, 'success');
    // Asker keeps the turn
  } else {
    // Target doesn't have it
    addLog(room, `${asker.name} asked ${target.name} for ${card.rank} of ${card.suit} — ✗ Not here. ${target.name}'s turn now.`, 'fail');
    // Turn passes to target
    room.currentTurn = targetId;
    // If target has no cards, find a teammate with cards
    if (target.hand.length === 0) {
      const tm = teammates(room, targetId).find(p => p.hand.length > 0);
      if (tm) {
        room.currentTurn = tm.id;
        addLog(room, `${target.name} has no cards — ${tm.name} takes the turn.`, 'system');
      }
    }
  }

  broadcastRoom(room);
  return { ok: true };
}

function handleDeclare(room, declarerId, bookKey, guess) {
  // guess: { [playerId]: [cardIds] }
  const declarer = getPlayer(room, declarerId);
  if (!declarer) return { ok: false, msg: 'Player not found' };

  // Must be declarer's team's turn
  const currentPlayer = getPlayer(room, room.currentTurn);
  if (!currentPlayer || currentPlayer.team !== declarer.team) {
    return { ok: false, msg: "Can only declare on your team's turn" };
  }

  const [suit, side] = bookKey.split('_');
  const ranks = side === 'high' ? BOOKS.high : BOOKS.low;
  const expectedCards = ranks.map(r => `${r}_${suit}`);

  // Find where all 6 cards actually are
  const actualLocation = {};
  for (const p of room.players) {
    for (const card of p.hand) {
      if (expectedCards.includes(card.id)) {
        actualLocation[card.id] = p;
      }
    }
  }

  // Check if any card is with the other team
  const otherTeam = declarer.team === 'A' ? 'B' : 'A';
  const cardsWithOther = Object.entries(actualLocation).filter(([, p]) => p.team === otherTeam);

  if (cardsWithOther.length > 0) {
    // Other team wins the book
    room.books[otherTeam].push(bookKey);
    addLog(room, `${declarer.name} declared ${BOOK_LABEL_SERVER[bookKey] || bookKey} — cards were with Team ${otherTeam}! Team ${otherTeam} wins the book. 📕`, 'fail');
    removeBookCards(room, bookKey, expectedCards);
    checkEnd(room);
    broadcastRoom(room);
    return { ok: true };
  }

  // All cards are within declarer's team — check the guess
  // Build actual map: playerId -> cardIds
  const actualMap = {};
  for (const [cardId, player] of Object.entries(actualLocation)) {
    if (!actualMap[player.id]) actualMap[player.id] = [];
    actualMap[player.id].push(cardId);
  }

  // Compare guess vs actual
  let guessCorrect = true;
  const allGuessedCards = new Set();
  for (const [pid, cards] of Object.entries(guess)) {
    for (const cid of cards) allGuessedCards.add(cid);
    const actualCards = (actualMap[pid] || []).sort().join(',');
    const guessedCards = [...cards].sort().join(',');
    if (actualCards !== guessedCards) {
      guessCorrect = false;
      break;
    }
  }
  // Also check all 6 cards are accounted for in guess
  if (allGuessedCards.size !== 6 || !expectedCards.every(c => allGuessedCards.has(c))) {
    guessCorrect = false;
  }

  if (!guessCorrect) {
    // Forfeited — no one gets the book, mark revoked
    room.revokedBooks = room.revokedBooks || [];
    room.revokedBooks.push(bookKey);
    addLog(room, `${declarer.name} declared ${BOOK_LABEL_SERVER[bookKey] || bookKey} with wrong distribution — book forfeited! ❌`, 'fail');
    removeBookCards(room, bookKey, expectedCards);
    checkEnd(room);
    broadcastRoom(room);
    return { ok: true };
  }

  // Correct!
  room.books[declarer.team].push(bookKey);
  addLog(room, `${declarer.name} correctly declared ${BOOK_LABEL_SERVER[bookKey] || bookKey}! Team ${declarer.team} wins the book! 🎉`, 'success');
  removeBookCards(room, bookKey, expectedCards);
  checkEnd(room);
  broadcastRoom(room);
  return { ok: true };
}

function removeBookCards(room, bookKey, cardIds) {
  for (const p of room.players) {
    p.hand = p.hand.filter(c => !cardIds.includes(c.id));
  }
  // If current turn player has no cards, pass to a teammate
  const curr = getPlayer(room, room.currentTurn);
  if (curr && curr.hand.length === 0) {
    const tm = teammates(room, curr.id).find(p => p.hand.length > 0);
    if (tm) {
      room.currentTurn = tm.id;
      addLog(room, `${curr.name} ran out of cards — ${tm.name} takes the turn.`, 'system');
    } else {
      // Whole team out
      const opp = opponents(room, curr.id).find(p => p.hand.length > 0);
      if (opp) {
        room.currentTurn = opp.id;
        addLog(room, `Team ${curr.team} has no cards — ${opp.name} takes the turn.`, 'system');
      }
    }
  }
}

function checkEnd(room) {
  const total = room.books.A.length + room.books.B.length;
  if (total === 8) {
    room.phase = 'ended';
    const winner = room.books.A.length > room.books.B.length ? 'A' : room.books.B.length > room.books.A.length ? 'B' : 'Tie';
    addLog(room, `Game over! ${winner === 'Tie' ? "It's a tie!" : `Team ${winner} wins with ${room.books[winner].length} books!`}`, 'system');
  }
}

// ─── Restart ───────────────────────────────────────────────────────────────
function restartRoom(room) {
  room.phase = 'lobby';
  room.currentTurn = null;
  room.books = { A: [], B: [] };
  room.revokedBooks = [];
  room.log = [];
  room.bookOwnership = {};
  for (const p of room.players) {
    p.hand = [];
    p.seatIndex = null;
    p.team = null;
  }
  addLog(room, 'Game restarted! Pick your seats.', 'system');
  broadcastRoom(room);
}

// ─── WebSocket Handling ────────────────────────────────────────────────────
let playerCount = 0;

wss.on('connection', (ws) => {
  const playerId = `p${++playerCount}_${Math.random().toString(36).slice(2, 6)}`;
  let roomCode = null;

  // Native WS-level heartbeat — kills truly dead sockets (mobile backgrounded)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'create') {
      roomCode = Math.random().toString(36).slice(2, 6).toUpperCase();
      rooms[roomCode] = createRoom(roomCode);
      const room = rooms[roomCode];
      const token = generateToken();
      const player = { id: playerId, name: msg.name || 'Player', ws, team: null, seatIndex: null, hand: [], sessionToken: token };
      room.players.push(player);
      sessionStore[token] = { playerId, roomCode, name: player.name };
      ws.send(JSON.stringify({ type: 'joined', playerId, roomCode, sessionToken: token }));
      broadcastRoom(room);
    }

    else if (msg.type === 'leaveRoom') {
      // Player voluntarily leaves during lobby so someone else can join
      const room = rooms[roomCode];
      if (!room || room.phase !== 'lobby') return;
      const player = getPlayer(room, playerId);
      if (!player) return;
      addLog(room, `${player.name} left the room.`, 'system');
      room.players = room.players.filter(p => p.id !== playerId);
      const token = player.sessionToken;
      if (token) delete sessionStore[token];
      roomCode = null;
      if (room.players.length === 0) delete rooms[room.code];
      else broadcastRoom(room);
      ws.send(JSON.stringify({ type: 'leftRoom' }));
    }

    else if (msg.type === 'join') {
      roomCode = msg.code?.toUpperCase();
      const room = rooms[roomCode];
      if (!room) return ws.send(JSON.stringify({ type: 'error', msg: 'Room not found' }));
      if (room.players.length >= 6) return ws.send(JSON.stringify({ type: 'error', msg: 'Room is full' }));
      if (room.phase !== 'lobby') return ws.send(JSON.stringify({ type: 'error', msg: 'Game already started' }));
      const token = generateToken();
      const player = { id: playerId, name: msg.name || 'Player', ws, team: null, seatIndex: null, hand: [], sessionToken: token };
      room.players.push(player);
      sessionStore[token] = { playerId, roomCode, name: player.name };
      ws.send(JSON.stringify({ type: 'joined', playerId, roomCode, sessionToken: token }));
      addLog(room, `${player.name} joined the room.`, 'system');
      broadcastRoom(room);
    }

    else if (msg.type === 'rejoin') {
      const token = msg.sessionToken;
      const session = sessionStore[token];
      if (!session) return ws.send(JSON.stringify({ type: 'error', msg: 'Session not found or expired. Please join fresh.' }));

      roomCode = session.roomCode;
      const room = rooms[roomCode];
      if (!room) return ws.send(JSON.stringify({ type: 'error', msg: 'Room no longer exists.' }));

      // Cancel pending removal timer
      if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
      }

      // Find existing player slot (may still be in players array as disconnected)
      let player = room.players.find(p => p.sessionToken === token);

      if (player) {
        // Swap in new ws
        player.ws = ws;
        player.id = session.playerId; // keep same id
      } else {
        // Player was removed — restore from session snapshot
        if (!session.snapshot) {
          return ws.send(JSON.stringify({ type: 'error', msg: 'Reconnect window expired.' }));
        }
        const snap = session.snapshot;
        player = {
          id: snap.id,
          name: snap.name,
          ws,
          team: snap.team,
          seatIndex: snap.seatIndex,
          hand: snap.hand,
          sessionToken: token,
        };
        room.players.push(player);
        addLog(room, `${player.name} reconnected.`, 'system');
      }

      // Update global playerId reference for this connection
      const rejoiningId = player.id;

      ws.send(JSON.stringify({ type: 'joined', playerId: rejoiningId, roomCode, sessionToken: token }));
      broadcastRoom(room);

      // Re-bind message handler with correct playerId/roomCode
      // We do this by updating the closure variables:
      ws.removeAllListeners('message');
      ws.removeAllListeners('close');
      setupPlayerHandlers(ws, rejoiningId, roomCode, token);
      return;
    }

    else if (msg.type === 'assignSeat') {
      const room = rooms[roomCode];
      if (!room || room.phase !== 'lobby') return;
      const player = getPlayer(room, playerId);
      if (!player) return;
      const seat = parseInt(msg.seat);
      if (isNaN(seat) || seat < 0 || seat > 5) return;
      if (room.players.some(p => p.seatIndex === seat && p.id !== playerId)) {
        return ws.send(JSON.stringify({ type: 'error', msg: 'Seat taken' }));
      }
      player.seatIndex = seat;
      player.team = seat % 2 === 0 ? 'A' : 'B';
      broadcastRoom(room);
    }

    else if (msg.type === 'startGame') {
      const room = rooms[roomCode];
      if (!room || room.phase !== 'lobby') return;
      if (room.players.length !== 6) return ws.send(JSON.stringify({ type: 'error', msg: 'Need exactly 6 players' }));
      if (room.players.some(p => p.seatIndex === null)) return ws.send(JSON.stringify({ type: 'error', msg: 'All players must pick a seat' }));
      startGame(room);
    }

    else if (msg.type === 'ask') {
      const room = rooms[roomCode];
      if (!room) return;
      const result = handleAsk(room, playerId, msg.targetId, msg.cardId);
      if (!result.ok) ws.send(JSON.stringify({ type: 'error', msg: result.msg }));
    }

    else if (msg.type === 'declare') {
      const room = rooms[roomCode];
      if (!room) return;
      const result = handleDeclare(room, playerId, msg.bookKey, msg.guess);
      if (!result.ok) ws.send(JSON.stringify({ type: 'error', msg: result.msg }));
    }

    else if (msg.type === 'passTurn') {
      const room = rooms[roomCode];
      if (!room || room.currentTurn !== playerId) return;
      const player = getPlayer(room, playerId);
      const tm = teammates(room, playerId).find(p => p.hand.length > 0);
      if (tm) {
        room.currentTurn = tm.id;
        addLog(room, `${player.name} passed the turn to ${tm.name}.`, 'system');
        broadcastRoom(room);
      }
    }

    else if (msg.type === 'restartGame') {
      const room = rooms[roomCode];
      if (room) restartRoom(room);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws, playerId, roomCode);
  });
});

function setupPlayerHandlers(ws, playerId, roomCode, sessionToken) {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    const room = rooms[roomCode];
    if (!room) return;

    if (msg.type === 'assignSeat') {
      if (room.phase !== 'lobby') return;
      const player = getPlayer(room, playerId);
      if (!player) return;
      const seat = parseInt(msg.seat);
      if (isNaN(seat) || seat < 0 || seat > 5) return;
      if (room.players.some(p => p.seatIndex === seat && p.id !== playerId)) {
        return ws.send(JSON.stringify({ type: 'error', msg: 'Seat taken' }));
      }
      player.seatIndex = seat;
      player.team = seat % 2 === 0 ? 'A' : 'B';
      broadcastRoom(room);
    }

    else if (msg.type === 'startGame') {
      if (room.phase !== 'lobby') return;
      if (room.players.length !== 6) return ws.send(JSON.stringify({ type: 'error', msg: 'Need exactly 6 players' }));
      if (room.players.some(p => p.seatIndex === null)) return ws.send(JSON.stringify({ type: 'error', msg: 'All players must pick a seat' }));
      startGame(room);
    }

    else if (msg.type === 'ask') {
      const result = handleAsk(room, playerId, msg.targetId, msg.cardId);
      if (!result.ok) ws.send(JSON.stringify({ type: 'error', msg: result.msg }));
    }

    else if (msg.type === 'declare') {
      const result = handleDeclare(room, playerId, msg.bookKey, msg.guess);
      if (!result.ok) ws.send(JSON.stringify({ type: 'error', msg: result.msg }));
    }

    else if (msg.type === 'passTurn') {
      if (room.currentTurn !== playerId) return;
      const player = getPlayer(room, playerId);
      const tm = teammates(room, playerId).find(p => p.hand.length > 0);
      if (tm) {
        room.currentTurn = tm.id;
        addLog(room, `${player.name} passed the turn to ${tm.name}.`, 'system');
        broadcastRoom(room);
      }
    }

    else if (msg.type === 'restartGame') {
      restartRoom(room);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws, playerId, roomCode);
  });
}

function handleDisconnect(ws, playerId, roomCode) {
  if (!roomCode) return;
  const room = rooms[roomCode];
  if (!room) return;
  const player = getPlayer(room, playerId);
  if (!player) return;

  const token = player.sessionToken;

  if (room.phase === 'playing') {
    // Save snapshot and keep slot but mark disconnected, give grace period
    const snapshot = {
      id: player.id,
      name: player.name,
      team: player.team,
      seatIndex: player.seatIndex,
      hand: player.hand,
    };

    if (token && sessionStore[token]) {
      sessionStore[token].snapshot = snapshot;
    }

    // Keep player in room (they'll show as disconnected) but null their ws
    player.ws = { readyState: -1, send: () => {} }; // dead socket stub
    addLog(room, `${player.name} disconnected. Waiting 90s for reconnect…`, 'system');
    broadcastRoom(room);

    // Schedule removal after grace period
    const timer = setTimeout(() => {
      const stillRoom = rooms[roomCode];
      if (!stillRoom) return;
      const stillPlayer = getPlayer(stillRoom, player.id);
      // Only remove if still using the dead stub (not reconnected)
      if (stillPlayer && stillPlayer.ws.readyState === -1) {
        stillRoom.players = stillRoom.players.filter(p => p.id !== player.id);
        addLog(stillRoom, `${player.name} was removed after timeout.`, 'system');
        if (stillRoom.players.length === 0) {
          delete rooms[roomCode];
        } else {
          broadcastRoom(stillRoom);
        }
      }
      if (token && sessionStore[token]) {
        sessionStore[token].reconnectTimer = null;
      }
    }, RECONNECT_GRACE_MS);

    if (token && sessionStore[token]) {
      sessionStore[token].reconnectTimer = timer;
    }

  } else {
    // Lobby: just remove immediately
    addLog(room, `${player.name} left the room.`, 'system');
    room.players = room.players.filter(p => p.id !== playerId);
    if (token) delete sessionStore[token];
    if (room.players.length === 0) {
      delete rooms[roomCode];
    } else {
      broadcastRoom(room);
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Literature card game server running at http://0.0.0.0:${PORT}`);
});

// ─── Server-side WS keepalive ──────────────────────────────────────────────
// Pings every 25s. If a socket hasn't responded by next ping, it's terminated.
// This cleans up truly dead connections (phone went to sleep, WiFi dropped, etc.)
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate(); // will trigger 'close' event
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);
