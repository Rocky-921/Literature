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

function createRoom(code) {
  return {
    code,
    phase: 'lobby',  // lobby | playing | ended
    players: [],     // { id, name, ws, team, seatIndex, hand: [] }
    currentTurn: null,
    books: { A: [], B: [] },  // team A/B declared books
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
    })),
    currentTurn: room.currentTurn,
    books: room.books,
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

function nextTurnAfterPass(room, fromId) {
  // Pass turn to the player who denied (they are an opponent)
  // This is set by the calling code
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
    addLog(room, `${declarer.name} declared ${bookKey} but some cards were with the other team! Team ${otherTeam} gets the book.`, 'fail');
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
    // Forfeited — no one gets the book
    addLog(room, `${declarer.name} declared ${bookKey} with wrong distribution — book forfeited!`, 'fail');
    removeBookCards(room, bookKey, expectedCards);
    checkEnd(room);
    broadcastRoom(room);
    return { ok: true };
  }

  // Correct!
  room.books[declarer.team].push(bookKey);
  addLog(room, `${declarer.name} correctly declared ${bookKey}! Team ${declarer.team} gets the book! 🎉`, 'success');
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

// ─── WebSocket Handling ────────────────────────────────────────────────────
let playerCount = 0;

wss.on('connection', (ws) => {
  const playerId = `p${++playerCount}_${Math.random().toString(36).slice(2, 6)}`;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      roomCode = Math.random().toString(36).slice(2, 6).toUpperCase();
      rooms[roomCode] = createRoom(roomCode);
      const room = rooms[roomCode];
      const player = { id: playerId, name: msg.name || 'Player', ws, team: null, seatIndex: null, hand: [] };
      room.players.push(player);
      ws.send(JSON.stringify({ type: 'joined', playerId, roomCode }));
      broadcastRoom(room);
    }

    else if (msg.type === 'join') {
      roomCode = msg.code?.toUpperCase();
      const room = rooms[roomCode];
      if (!room) return ws.send(JSON.stringify({ type: 'error', msg: 'Room not found' }));
      if (room.players.length >= 6) return ws.send(JSON.stringify({ type: 'error', msg: 'Room is full' }));
      if (room.phase !== 'lobby') return ws.send(JSON.stringify({ type: 'error', msg: 'Game already started' }));
      const player = { id: playerId, name: msg.name || 'Player', ws, team: null, seatIndex: null, hand: [] };
      room.players.push(player);
      ws.send(JSON.stringify({ type: 'joined', playerId, roomCode }));
      addLog(room, `${player.name} joined the room.`, 'system');
      broadcastRoom(room);
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
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (!room) return;
    const player = getPlayer(room, playerId);
    if (player) {
      addLog(room, `${player.name} disconnected.`, 'system');
      room.players = room.players.filter(p => p.id !== playerId);
      if (room.players.length === 0) {
        delete rooms[roomCode];
      } else {
        broadcastRoom(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Literature card game server running at http://0.0.0.0:${PORT}`);
});
