const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("client"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const suits = ["♠","♥","♦","♣"];
const ranks = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

const GAME_NAMES = [
  "Без купи","Без ръце","Без мъже","Без дами",
  "Без поп купа","Без последни 2 ръце","Без всичко"
];

const rooms = {};

/* ================= HELPERS ================= */
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

/* ================= ROOM ================= */
function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      players: [],
      spectators: [],
      hands: {},
      scores: {},
      table: [],
      phase: 1,
      gameIndex: 0,
      turn: 0,
      trick: 0,
      started: false
    };
  }
  return rooms[code];
}

/* ================= DEAL ================= */
function deal(room) {
  const deck = createDeck();
  room.table = [];
  room.trick = 0;

  room.players.forEach((p, i) => {
    room.hands[p.name] = deck.slice(i * 13, (i + 1) * 13);
    send(p.ws, {
      type: "hand",
      cards: room.hands[p.name]
    });
  });

  broadcast(room, {
    type: "game",
    text: GAME_NAMES[room.gameIndex]
  });

  broadcast(room, {
    type: "turn",
    player: room.players[room.turn].name
  });
}

/* ================= WS ================= */
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    /* ===== CREATE / JOIN ===== */
    if (data.type === "CREATE_ROOM" || data.type === "JOIN_ROOM") {
      const room = getRoom(data.room);

      ws.name = data.name;
      ws.room = room;

      const exists = room.players.find(p => p.name === ws.name);

      if (exists) {
        exists.ws = ws; // reconnection
      } else if (room.players.length < 4) {
        room.players.push(ws);
        room.scores[ws.name] = room.scores[ws.name] || 0;
      } else {
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
      return;
    }

    const room = ws.room;
    if (!room) return;

    /* ===== CHAT ===== */
    if (data.type === "chat") {
      broadcast(room, {
        type:"chat",
        name: ws.name,
        text: data.text
      });
      return;
    }

    /* ===== PLAY ===== */
    if (data.type === "play") {
      if (room.players[room.turn] !== ws) return;

      const hand = room.hands[ws.name];
      if (!hand.includes(data.card)) return;

      room.hands[ws.name] = hand.filter(c => c !== data.card);
      room.table.push({ player: ws.name, card: data.card });

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

      let win = room.table[0];
      room.table.forEach(t => {
        if (
          t.card[0] === win.card[0] &&
          power(t.card) > power(win.card)
        ) win = t;
      });

      room.scores[win.player] -= 2;

      broadcast(room, { type:"scores", scores:room.scores });
      broadcast(room, { type:"clearTable" });

      room.turn = room.players.findIndex(p => p.name === win.player);
      room.table = [];
      room.trick++;

      if (room.trick === 13) {
        room.gameIndex++;
        if (room.gameIndex < 7) deal(room);
        else broadcast(room, { type:"GAME_OVER", scores:room.scores });
      } else {
        broadcast(room, {
          type:"turn",
          player: room.players[room.turn].name
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

/* ===== HEARTBEAT ===== */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(8080, () => console.log("Server running on 8080"));
