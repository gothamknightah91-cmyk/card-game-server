const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.static("client"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ================== CONSTANTS ================== */
const suits = ["♠","♥","♦","♣"];
const ranks = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

const GAME_NAMES = [
  "Без купи","Без ръце","Без мъже","Без дами",
  "Без поп купа","Без последни 2 ръце","Без всичко"
];

const rooms = {};

/* ================== HELPERS ================== */
const power = c => ranks.indexOf(c.slice(1));
const uid = () => crypto.randomUUID();

function createDeck() {
  return suits.flatMap(s => ranks.map(r => s + r))
    .sort(() => Math.random() - 0.5);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  [...room.players, ...room.spectators].forEach(p => send(p.ws, obj));
}

/* ================== ROOM ================== */
function createRoom(code) {
  rooms[code] = {
    code,
    players: [],
    spectators: [],
    hands: {},
    scores: {},
    table: [],
    phase: 1,
    gameIndex: 0,
    trumpSuit: null,
    turn: 0,
    trick: 0,
    solitaireRound: 1,
    finished: []
  };
}

/* ================== DEAL ================== */
function deal(room, open = false) {
  const deck = createDeck();
  room.table = [];
  room.trick = 0;

  room.players.forEach((p, i) => {
    room.hands[p.id] = deck.slice(i * 13, (i + 1) * 13);
    send(p.ws, {
      type: "HAND",
      cards: room.hands[p.id],
      open
    });
  });

  broadcast(room, {
    type: "STATUS",
    text: room.phase === 1 ? GAME_NAMES[room.gameIndex] :
          room.phase === 2 ? "Игра с коз" :
          "Пасианс"
  });

  broadcast(room, {
    type: "TURN",
    player: room.players[room.turn].name
  });
}

/* ================== WS ================== */
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    /* ===== CONNECT ===== */
    if (data.type === "CONNECT") {
      if (!rooms[data.room]) createRoom(data.room);
      const room = rooms[data.room];

      let user = room.players.find(p => p.id === data.playerId) ||
                 room.spectators.find(p => p.id === data.playerId);

      if (user) {
        user.ws = ws;
        send(ws, { type:"RECONNECTED" });
      } else {
        user = {
          id: data.playerId || uid(),
          name: data.name,
          ws
        };
        if (room.players.length < 4) {
          room.players.push(user);
          room.scores[user.id] = 0;
        } else {
          room.spectators.push(user);
        }
      }

      ws.user = user;
      ws.room = room;

      broadcast(room, {
        type: "ROOM_INFO",
        players: room.players.map(p => p.name),
        spectators: room.spectators.length
      });

      if (room.players.length === 4 && !room.started) {
        room.started = true;
        deal(room);
      }
      return;
    }

    const room = ws.room;
    if (!room) return;

    /* ===== CHAT ===== */
    if (data.type === "CHAT") {
      broadcast(room, {
        type:"CHAT",
        name: ws.user.name,
        text: data.text
      });
    }

    /* ===== PLAY ===== */
    if (data.type === "PLAY") {
      const pIndex = room.players.findIndex(p => p.id === ws.user.id);
      if (pIndex !== room.turn) return;

      const hand = room.hands[ws.user.id];
      if (!hand.includes(data.card)) return;

      room.hands[ws.user.id] = hand.filter(c => c !== data.card);
      room.table.push({ player: ws.user, card: data.card });

      broadcast(room, {
        type:"PLAYED",
        player: ws.user.name,
        card: data.card
      });

      if (room.table.length < 4) {
        room.turn = (room.turn + 1) % 4;
        broadcast(room, {
          type:"TURN",
          player: room.players[room.turn].name
        });
        return;
      }

      let win = room.table[0];
      room.table.forEach(t => {
        if (
          t.card[0] === win.card[0] &&
          power(t.card) > power(win.card)
        ) win = t;
      });

      room.scores[win.player.id] -= 2;
      broadcast(room, { type:"SCORES", scores:room.scores });

      room.turn = room.players.findIndex(p => p.id === win.player.id);
      room.table = [];
      broadcast(room, { type:"CLEAR" });

      if (++room.trick === 13) {
        room.gameIndex++;
        if (room.gameIndex < 7) deal(room);
        else broadcast(room,{ type:"GAME_OVER", scores:room.scores });
      } else {
        broadcast(room,{ type:"TURN", player:room.players[room.turn].name });
      }
    }
  });

  ws.on("close", () => {
    if (ws.user) ws.user.disconnected = true;
  });
});

/* ===== HEARTBEAT ===== */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(8080, () => console.log("Server running on 8080"));
