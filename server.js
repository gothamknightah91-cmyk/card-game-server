const express = require("express");
const http = require("http");
const WebSocket = require("ws");

/* =====================
   HTTP СЪРВЪР
===================== */
const app = express();
app.use(express.static("client"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* =====================
   КОНСТАНТИ
===================== */
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

/* =====================
   ПОМОЩНИ
===================== */
function power(card) {
  return ranks.indexOf(card.slice(1));
}

function createDeck() {
  let deck = [];
  suits.forEach(s => ranks.forEach(r => deck.push(s + r)));
  return deck.sort(() => Math.random() - 0.5);
}

function broadcast(room, obj) {
  room.players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) {
      p.send(JSON.stringify(obj));
    }
  });
}

/* =====================
   РАЗДАВАНЕ
===================== */
function deal(room) {
  const deck = createDeck();
  room.table = [];
  room.leadSuit = null;
  room.trickCount = 0;

  room.players.forEach((p, i) => {
    room.hands[p.name] = deck.slice(i * 13, (i + 1) * 13);
    p.send(JSON.stringify({
      type: "hand",
      cards: room.hands[p.name]
    }));
  });

  broadcast(room, {
    type: "game",
    text: GAME_NAMES[room.gameIndex]
  });

  room.turn = 0;
  broadcast(room, {
    type: "turn",
    player: room.players[0].name
  });
}

/* =====================
   WEBSOCKET
===================== */
wss.on("connection", ws => {

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    /* ===== CREATE ROOM ===== */
    if (data.type === "CREATE_ROOM") {
      ws.name = data.name;
      ws.room = data.room;

      rooms[ws.room] = {
        players: [],
        hands: {},
        scores: {},
        table: [],
        leadSuit: null,
        turn: 0,
        trickCount: 0,
        gameIndex: 0
      };

      rooms[ws.room].players.push(ws);
      rooms[ws.room].scores[ws.name] = 0;

      ws.send(JSON.stringify({
        type: "PLAYER_JOINED",
        count: 1
      }));
      return;
    }

    /* ===== JOIN ROOM ===== */
    if (data.type === "JOIN_ROOM") {
      const room = rooms[data.room];
      if (!room || room.players.length >= 4) {
        ws.send(JSON.stringify({ type: "ROOM_FULL" }));
        return;
      }

      ws.name = data.name;
      ws.room = data.room;

      room.players.push(ws);
      room.scores[ws.name] = 0;

      broadcast(room, {
        type: "PLAYER_JOINED",
        count: room.players.length
      });

      if (room.players.length === 4) {
        deal(room);
      }
      return;
    }

    /* ===== GAME EVENT (START GAME) ===== */
    if (data.type === "GAME_EVENT") {
      const room = rooms[data.room];
      if (!room) return;

      broadcast(room, {
        type: "GAME_EVENT",
        event: data.event
      });
      return;
    }

    /* ===== CHAT ===== */
    if (data.type === "chat") {
      const room = rooms[ws.room];
      if (!room) return;

      broadcast(room, {
        type: "chat",
        name: ws.name,
        text: data.text
      });
      return;
    }

    /* ===== ИГРА ===== */
    if (data.type === "play") {
      const room = rooms[ws.room];
      if (!room) return;
      if (room.players[room.turn] !== ws) return;

      const card = data.card;
      const hand = room.hands[ws.name];
      if (!hand || !hand.includes(card)) return;

      const suit = card[0];
      if (room.leadSuit) {
        const hasSuit = hand.some(c => c[0] === room.leadSuit);
        if (hasSuit && suit !== room.leadSuit) return;
      }

      if (!room.leadSuit) room.leadSuit = suit;

      room.hands[ws.name] = hand.filter(c => c !== card);
      room.table.push({ player: ws.name, card });

      broadcast(room, {
        type: "played",
        player: ws.name,
        card
      });

      if (room.table.length < 4) {
        room.turn = (room.turn + 1) % 4;
        broadcast(room, {
          type: "turn",
          player: room.players[room.turn].name
        });
        return;
      }

      let win = room.table[0];
      room.table.forEach(t => {
        if (t.card[0] === win.card[0] && power(t.card) > power(win.card)) {
          win = t;
        }
      });

      room.turn = room.players.findIndex(p => p.name === win.player);
      room.table = [];
      room.leadSuit = null;
      room.trickCount++;

      if (room.trickCount === 13) {
        room.gameIndex++;
        if (room.gameIndex < GAME_NAMES.length) {
          deal(room);
        }
        return;
      }

      broadcast(room, {
        type: "turn",
        player: room.players[room.turn].name
      });
    }
  });
});

/* =====================
   СТАРТ
===================== */
const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Сървърът работи на порт", PORT);
});
