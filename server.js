const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("client"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* =====================
   CONSTANTS
===================== */
const suits = ["♠","♥","♦","♣"];
const ranks = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

const rooms = {};

/* =====================
   HELPERS
===================== */
const power = c => ranks.indexOf(c.slice(1));

const createDeck = () =>
  suits.flatMap(s => ranks.map(r => s + r))
       .sort(() => Math.random() - 0.5);

function broadcast(room, obj) {
  [...room.players, ...room.spectators].forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  });
}

function sendSpectators(room) {
  broadcast(room, {
    type: "SPECTATORS",
    spectators: room.spectators.map(s => s.name),
    count: room.spectators.length
  });
}

/* =====================
   DEAL
===================== */
function deal(room) {
  const deck = createDeck();
  room.table = [];
  room.turn = 0;

  room.players.forEach((p, i) => {
    room.hands[p.name] = deck.slice(i * 13, (i + 1) * 13);
    p.send(JSON.stringify({
      type: "hand",
      cards: room.hands[p.name]
    }));
  });

  broadcast(room, {
    type: "turn",
    player: room.players[room.turn].name
  });
}

/* =====================
   WEBSOCKET
===================== */
wss.on("connection", ws => {

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    /* ===== CHAT ===== */
    if (data.type === "chat") {
      const room = rooms[data.room];
      if (!room) return;
      broadcast(room, { type:"chat", name:data.name, text:data.text });
      return;
    }

    /* ===== SPECTATE ===== */
    if (data.type === "SPECTATE") {
      const room = rooms[data.room];
      if (!room) return;

      ws.name = data.name || "Зрител";
      ws.room = data.room;
      ws.isSpectator = true;

      room.spectators.push(ws);
      sendSpectators(room);
      return;
    }

    /* ===== CREATE ===== */
    if (data.type === "CREATE_ROOM") {
      rooms[data.room] = {
        players:[ws],
        spectators:[],
        hands:{},
        scores:{ [data.name]:0 },
        table:[],
        turn:0
      };
      ws.name = data.name;
      ws.room = data.room;
      ws.isSpectator = false;

      ws.send(JSON.stringify({ type:"PLAYER_JOINED", count:1 }));
      return;
    }

    /* ===== JOIN ===== */
    if (data.type === "JOIN_ROOM") {
      const room = rooms[data.room];
      if (!room || room.players.length === 4) return;

      ws.name = data.name;
      ws.room = data.room;
      ws.isSpectator = false;

      room.players.push(ws);
      room.scores[ws.name] = 0;

      broadcast(room, { type:"PLAYER_JOINED", count:room.players.length });

      if (room.players.length === 4) deal(room);
      return;
    }

    const room = rooms[ws.room];
    if (!room) return;

    /* ===== PLAY ===== */
    if (data.type === "play") {
      if (ws.isSpectator) return;

      if (room.players[room.turn] !== ws) return;

      const card = data.card;
      const hand = room.hands[ws.name];
      if (!hand.includes(card)) return;

      room.hands[ws.name] = hand.filter(c => c !== card);
      room.table.push({ player: ws.name, card });

      broadcast(room, { type:"played", player:ws.name, card });

      room.turn = (room.turn + 1) % room.players.length;
      broadcast(room, { type:"turn", player:room.players[room.turn].name });
    }
  });

  ws.on("close", () => {
    const room = rooms[ws.room];
    if (!room) return;

    if (ws.isSpectator) {
      room.spectators = room.spectators.filter(s => s !== ws);
      sendSpectators(room);
    }
  });
});

server.listen(process.env.PORT || 8080, () =>
  console.log("Server running")
);
