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
   HELPERS
===================== */
const power = c => ranks.indexOf(c.slice(1));

const createDeck = () =>
  suits.flatMap(s => ranks.map(r => s + r))
       .sort(() => Math.random() - 0.5);

const broadcast = (room, obj) =>
  room.players.forEach(p =>
    p.readyState === WebSocket.OPEN && p.send(JSON.stringify(obj))
  );

/* =====================
   SCORING
===================== */
function scoreTrick(room, winner, cards, isLast) {
  let pts = 0;

  if (room.phase === 2) {
    pts = 5;
  } else if (room.phase === 1) {
    const g = room.gameIndex;

    if ((g === 0 || g === 6)) pts += cards.filter(c => c[0] === "♥").length * -2;
    if ((g === 1 || g === 6)) pts += -2;
    if ((g === 2 || g === 6)) pts += cards.filter(c => ["J","K"].includes(c.slice(1))).length * -3;
    if ((g === 3 || g === 6)) pts += cards.filter(c => c.slice(1) === "Q").length * -7;
    if ((g === 4 || g === 6) && cards.includes("♥K")) pts += -18;
    if ((g === 5 || g === 6) && isLast) pts += -17;
  }

  room.scores[winner] += pts;
}

/* =====================
   DEAL
===================== */
function deal(room, open=false) {
  const deck = createDeck();
  room.table = [];
  room.leadSuit = null;
  room.trickCount = 0;

  room.players.forEach((p, i) => {
    room.hands[p.name] = deck.slice(i * 13, (i + 1) * 13);
    p.send(JSON.stringify({
      type: "hand",
      cards: room.hands[p.name],
      open
    }));
  });

  if (room.phase === 1)
    broadcast(room, { type:"game", text: GAME_NAMES[room.gameIndex] });

  if (room.phase === 2)
    broadcast(room, { type:"TRUMP_SELECT", player: room.players[room.trumpCaller].name });

  if (room.phase === 3)
    broadcast(room, { type:"SOLITAIRE_START", round: room.solitaireRound });

  room.turn = room.turn || 0;
  broadcast(room, { type:"turn", player: room.players[room.turn].name });
}

/* =====================
   WEBSOCKET
===================== */
wss.on("connection", ws => {

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    /* ===== CREATE / JOIN ===== */
    if (data.type === "CREATE_ROOM") {
      rooms[data.room] = {
        players: [ws],
        hands: {},
        scores: { [data.name]: 0 },
        phase: 1,
        gameIndex: 0,
        trumpSuit: null,
        trumpCaller: 0,
        solitaireRound: 0,
        solitaireFinished: []
      };
      ws.name = data.name;
      ws.room = data.room;
      ws.send(JSON.stringify({ type:"PLAYER_JOINED", count:1 }));
      return;
    }

    if (data.type === "JOIN_ROOM") {
      const r = rooms[data.room];
      if (!r || r.players.length === 4) return;
      ws.name = data.name;
      ws.room = data.room;
      r.players.push(ws);
      r.scores[ws.name] = 0;
      broadcast(r, { type:"PLAYER_JOINED", count:r.players.length });
      if (r.players.length === 4) deal(r);
      return;
    }

    const room = rooms[ws.room];
    if (!room) return;

    /* ===== TRUMP ===== */
    if (data.type === "SET_TRUMP" && room.phase === 2) {
      room.trumpSuit = data.suit;
      broadcast(room, { type:"TRUMP_SET", suit:data.suit });
      deal(room);
      return;
    }

    /* ===== PLAY (1 & 2) ===== */
    if (data.type === "play" && room.phase < 3) {
      if (room.players[room.turn] !== ws) return;

      const card = data.card;
      const hand = room.hands[ws.name];
      if (!hand.includes(card)) return;

      if (room.leadSuit) {
        const has = hand.some(c => c[0] === room.leadSuit);
        if (has && card[0] !== room.leadSuit) return;
      }

      if (!room.leadSuit) room.leadSuit = card[0];
      room.hands[ws.name] = hand.filter(c => c !== card);
      room.table.push({ player: ws.name, card });
      broadcast(room, { type:"played", player:ws.name, card });

      if (room.table.length < 4) {
        room.turn = (room.turn + 1) % 4;
        broadcast(room, { type:"turn", player:room.players[room.turn].name });
        return;
      }

      let win = room.table[0];
      room.table.forEach(t => {
        const trump = room.phase === 2 && t.card[0] === room.trumpSuit;
        const winTrump = room.phase === 2 && win.card[0] === room.trumpSuit;
        if ((trump && !winTrump) || (t.card[0] === win.card[0] && power(t.card) > power(win.card)))
          win = t;
      });

      scoreTrick(room, win.player, room.table.map(x=>x.card), room.trickCount >= 11);
      broadcast(room, { type:"scores", scores:room.scores });
      broadcast(room, { type:"clearTable" });

      room.turn = room.players.findIndex(p => p.name === win.player);
      room.table = [];
      room.leadSuit = null;
      room.trickCount++;

      if (room.trickCount === 13) {
        if (room.phase === 1 && room.gameIndex < 6) {
          room.gameIndex++; deal(room);
        } else if (room.phase === 1) {
          room.phase = 2; deal(room);
        } else if (room.phase === 2) {
          room.phase = 3; room.solitaireRound = 1;
          deal(room, true);
        }
        return;
      }

      broadcast(room, { type:"turn", player:room.players[room.turn].name });
    }

    /* ===== SOLITAIRE FINISH ===== */
    if (data.type === "SOLITAIRE_FINISH") {
      room.solitaireFinished.push(ws.name);

      if (room.solitaireFinished.length === 4) {
        const pts = [20,10,0,-10];
        room.solitaireFinished.forEach((n,i)=> room.scores[n]+=pts[i]);

        broadcast(room,{ type:"scores", scores:room.scores });

        room.solitaireFinished = [];
        room.solitaireRound++;

        if (room.solitaireRound <= 4) deal(room, true);
        else broadcast(room,{ type:"GAME_OVER", scores:room.scores });
      }
    }
  });
});

server.listen(process.env.PORT || 8080, () =>
  console.log("Server running")
);
