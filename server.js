const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("client"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ===================== CONSTANTS ===================== */
const suits = ["♠","♥","♦","♣"];
const ranks = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

const GAME_NAMES = [
  "Без купи",
  "Без ръце",
  "Без мъже",
  "Без дами",
  "Без поп купа",
  "Без последни 2 ръце",
  "Без всичко"
];

const rooms = {};

/* ===================== HELPERS ===================== */
const power = c => ranks.indexOf(c.slice(1));

function createDeck() {
  return suits.flatMap(s => ranks.map(r => s + r))
    .sort(() => Math.random() - 0.5);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  [...room.players, ...room.spectators]
    .forEach(p => send(p.ws, obj));
}

/* ===================== ROOM ===================== */
function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      players: [],
      spectators: [],
      hands: {},
      scores: {},
      table: [],
      leadSuit: null,
      turn: 0,
      trickCount: 0,

      phase: 1,
      gameIndex: 0,
      trumpSuit: null,
      trumpCaller: 0,

      solitaireRound: 0,
      solitaireFinished: [],

      started: false
    };
  }
  return rooms[code];
}

/* ===================== DEAL ===================== */
function deal(room, open = false) {
  const deck = createDeck();
  room.table = [];
  room.leadSuit = null;
  room.trickCount = 0;

  room.players.forEach((p, i) => {
    room.hands[p.name] = deck.slice(i * 13, (i + 1) * 13);
    send(p.ws, {
      type: "hand",
      cards: room.hands[p.name],
      open
    });
  });

  if (room.phase === 1) {
    broadcast(room, {
      type: "game",
      text: GAME_NAMES[room.gameIndex]
    });
  }

  if (room.phase === 2) {
    broadcast(room, {
      type: "TRUMP_SELECT",
      player: room.players[room.trumpCaller].name
    });
  }

  if (room.phase === 3) {
    broadcast(room, {
      type: "SOLITAIRE_START",
      round: room.solitaireRound
    });
  }

  broadcast(room, {
    type: "turn",
    player: room.players[room.turn].name
  });
}

/* ===================== SCORING ===================== */
function scoreTrick(room, winner, cards, isLast) {
  let pts = 0;

  if (room.phase === 2) {
    pts = 5;
  } else if (room.phase === 1) {
    const g = room.gameIndex;

    if ((g === 0 || g === 6))
      pts += cards.filter(c => c[0] === "♥").length * -2;

    if ((g === 1 || g === 6))
      pts += -2;

    if ((g === 2 || g === 6))
      pts += cards.filter(c =>
        ["J","K"].includes(c.slice(1))
      ).length * -3;

    if ((g === 3 || g === 6))
      pts += cards.filter(c => c.slice(1) === "Q").length * -7;

    if ((g === 4 || g === 6) && cards.includes("♥K"))
      pts += -18;

    if ((g === 5 || g === 6) && isLast)
      pts += -17;
  }

  room.scores[winner] += pts;
}

/* ===================== WEBSOCKET ===================== */
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); }
    catch { return; }

    /* ===== CREATE / JOIN / RECONNECT ===== */
    if (data.type === "CREATE_ROOM" || data.type === "JOIN_ROOM") {
      const room = getRoom(data.room);

      ws.name = data.name;
      ws.room = room;
      ws.isSpectator = false;

      const existing =
        room.players.find(p => p.name === ws.name) ||
        room.spectators.find(p => p.name === ws.name);

      if (existing) {
        existing.ws = ws;
        ws.isSpectator = room.spectators.includes(existing);
      } else if (room.players.length < 4) {
        room.players.push(ws);
        room.scores[ws.name] ??= 0;
      } else {
        ws.isSpectator = true;
        room.spectators.push(ws);
        send(ws, { type:"SPECTATOR" });
      }

      broadcast(room, {
        type:"PLAYER_JOINED",
        count: room.players.length
      });

      broadcast(room, {
        type:"SPECTATORS",
        count: room.spectators.length
      });

      if (room.players.length === 4 && !room.started) {
        room.started = true;
        deal(room);
      }

      /* ---- FULL STATE SYNC (reconnect safe) ---- */
      send(ws, {
        type: "FULL_STATE",
        phase: room.phase,
        gameIndex: room.gameIndex,
        scores: room.scores,
        table: room.table,
        turn: room.players[room.turn]?.name
      });

      return;
    }

    const room = ws.room;
    if (!room || ws.isSpectator) return;

    /* ===== CHAT ===== */
    if (data.type === "chat") {
      broadcast(room, {
        type:"chat",
        name: ws.name,
        text: data.text
      });
      return;
    }

    /* ===== TRUMP ===== */
    if (data.type === "SET_TRUMP" && room.phase === 2) {
      room.trumpSuit = data.suit;
      broadcast(room, { type:"TRUMP_SET", suit:data.suit });
      deal(room);
      return;
    }

    /* ===== PLAY (PHASE 1 & 2) ===== */
    if (data.type === "play" && room.phase < 3) {
      if (room.players[room.turn] !== ws) return;

      const hand = room.hands[ws.name];
      if (!hand || !hand.includes(data.card)) return;

      if (room.leadSuit) {
        const hasSuit = hand.some(c => c[0] === room.leadSuit);
        if (hasSuit && data.card[0] !== room.leadSuit) return;
      }

      if (!room.leadSuit)
        room.leadSuit = data.card[0];

      room.hands[ws.name] =
        hand.filter(c => c !== data.card);

      room.table.push({
        player: ws.name,
        card: data.card
      });

      broadcast(room, {
        type:"played",
        player: ws.name,
        card: data.card
      });

      if (room.table.length < 4) {
        room.turn = (room.turn + 1) % 4;
        broadcast(room, {
          type:"turn",
          player: room.players[room.turn].name
        });
        return;
      }

      /* ---- determine winner ---- */
      let win = room.table[0];
      room.table.forEach(t => {
        const trump = room.phase === 2 && t.card[0] === room.trumpSuit;
        const winTrump = room.phase === 2 && win.card[0] === room.trumpSuit;

        if (
          (trump && !winTrump) ||
          (t.card[0] === win.card[0] &&
           power(t.card) > power(win.card))
        ) win = t;
      });

      scoreTrick(
        room,
        win.player,
        room.table.map(x => x.card),
        room.trickCount >= 11
      );

      broadcast(room, { type:"scores", scores:room.scores });
      broadcast(room, { type:"clearTable" });

      room.turn =
        room.players.findIndex(p => p.name === win.player);

      room.table = [];
      room.leadSuit = null;
      room.trickCount++;

      if (room.trickCount === 13) {
        if (room.phase === 1 && room.gameIndex < 6) {
          room.gameIndex++;
          deal(room);
        } else if (room.phase === 1) {
          room.phase = 2;
          deal(room);
        } else if (room.phase === 2) {
          room.phase = 3;
          room.solitaireRound = 1;
          deal(room, true);
        }
        return;
      }

      broadcast(room, {
        type:"turn",
        player: room.players[room.turn].name
      });
    }

    /* ===== SOLITAIRE FINISH ===== */
    if (data.type === "SOLITAIRE_FINISH" && room.phase === 3) {
      if (room.solitaireFinished.includes(ws.name)) return;

      room.solitaireFinished.push(ws.name);

      if (room.solitaireFinished.length === 4) {
        const pts = [20,10,0,-10];
        room.solitaireFinished.forEach(
          (n,i) => room.scores[n] += pts[i]
        );

        broadcast(room, {
          type:"scores",
          scores:room.scores
        });

        room.solitaireFinished = [];
        room.solitaireRound++;

        if (room.solitaireRound <= 4)
          deal(room, true);
        else
          broadcast(room, {
            type:"GAME_OVER",
            scores:room.scores
          });
      }
    }
  });

  ws.on("close", () => {
    if (!ws.room) return;
    ws.room.spectators =
      ws.room.spectators.filter(s => s !== ws);
  });
});

/* ===================== HEARTBEAT ===================== */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(process.env.PORT || 8080,
  () => console.log("Server running"));
