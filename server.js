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
   ТОЧКУВАНЕ
===================== */
function scoreNegative(room, winner) {
  let score = 0;
  const g = room.gameIndex;
  const lastTwo = room.trickCount >= 11;

  room.table.forEach(t => {
    const suit = t.card[0];
    const rank = t.card.slice(1);

    if ((g === 0 || g === 6) && suit === "♥") score -= 2;
    if ((g === 2 || g === 6) && (rank === "J" || rank === "K")) score -= 3;
    if ((g === 3 || g === 6) && rank === "Q") score -= 7;
    if ((g === 4 || g === 6) && t.card === "♥K") score -= 18;
  });

  if (g === 1 || g === 6) score -= 2;
  if ((g === 5 || g === 6) && lastTwo) score -= 17;

  room.scores[winner] += score;
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

    /* ===== JOIN ===== */
    if (data.type === "join") {
      ws.name = data.name;
      ws.room = data.room;

      if (!rooms[ws.room]) {
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
      }

      const room = rooms[ws.room];
      room.players.push(ws);
      room.scores[ws.name] = 0;

      broadcast(room, {
        type: "chat",
        name: "Система",
        text: `${ws.name} влезе`
      });

      if (room.players.length === 4) {
        deal(room);
      }
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

    /* =====================
       ИГРА НА КАРТА
    ===================== */
    if (data.type === "play") {
      const room = rooms[ws.room];
      if (!room) return;

      // ред ли му е
      if (room.players[room.turn] !== ws) return;

      const card = data.card;
      const hand = room.hands[ws.name];
      if (!hand || !hand.includes(card)) return;

      const suit = card[0];

      // ✅ ЗАДЪЛЖИТЕЛНО ОТГОВАРЯНЕ НА БОЯ
      if (room.leadSuit) {
        const hasSuit = hand.some(c => c[0] === room.leadSuit);
        if (hasSuit && suit !== room.leadSuit) {
          // ❗ просто отказваме – клиентът НЕ маха карта
          return;
        }
      }

      if (!room.leadSuit) room.leadSuit = suit;

      // махаме картата САМО ТУК
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

      /* ===== КОЙ ПЕЧЕЛИ ===== */
      let win = room.table[0];
      room.table.forEach(t => {
        if (t.card[0] === win.card[0] && power(t.card) > power(win.card)) {
          win = t;
        }
      });

      scoreNegative(room, win.player);

      broadcast(room, {
        type: "scores",
        scores: room.scores
      });

      room.turn = room.players.findIndex(p => p.name === win.player);
      room.table = [];
      room.leadSuit = null;
      room.trickCount++;

      broadcast(room, { type: "clearTable" });

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
