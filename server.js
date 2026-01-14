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

const ROUNDS = [
  { id:"NO_HEARTS", name:"Без купи" },
  { id:"NO_TRICKS", name:"Без ръце" },
  { id:"NO_MEN", name:"Без мъже" },
  { id:"NO_QUEENS", name:"Без дами" },
  { id:"NO_KING_HEART", name:"Без поп купа" },
  { id:"NO_LAST_2", name:"Без последни 2 ръце" },
  { id:"NO_ALL", name:"Без всичко" }
];

const rooms = {};

/* =====================
   HELPERS
===================== */
const power = c => ranks.indexOf(c.slice(1));

const createDeck = () =>
  suits.flatMap(s => ranks.map(r => s + r))
       .sort(() => Math.random() - 0.5);

function broadcast(room, obj) {
  room.players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) {
      p.send(JSON.stringify(obj));
    }
  });
}

function error(ws, msg) {
  ws.send(JSON.stringify({ type:"ERROR", message: msg }));
}

/* =====================
   ROUND VALIDATION
===================== */
function validateRoundPlay(room, card) {
  const r = ROUNDS[room.state.roundIndex]?.id;

  if (r === "NO_QUEENS" && card.slice(1) === "Q")
    return "Рунд Без Дами – не може да играеш дама";

  return null;
}

/* =====================
   SCORING
===================== */
function scoreTrick(room, winner, cards, isLast) {
  let pts = 0;
  const g = room.state.roundIndex;

  if (room.state.phase === 2) {
    pts = 5;
  }

  if (room.state.phase === 1) {
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

  room.state.trickCount = 0;
  room.state.leadSuit = null;
  room.table = [];

  room.players.forEach((p,i) => {
    room.hands[p.name] = deck.slice(i*13, (i+1)*13);
    p.send(JSON.stringify({
      type:"hand",
      cards: room.hands[p.name],
      open
    }));
  });

  broadcast(room,{
    type:"ROUND_START",
    phase: room.state.phase,
    round: ROUNDS[room.state.roundIndex]?.id,
    name: ROUNDS[room.state.roundIndex]?.name
  });

  if (room.state.phase === 2) {
    broadcast(room,{
      type:"TRUMP_SELECT",
      player: room.players[room.trumpCaller].name
    });
  }

  broadcast(room,{
    type:"turn",
    player: room.players[room.state.turn].name
  });
}

/* =====================
   WEBSOCKET
===================== */
wss.on("connection", ws => {

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    /* ===== CHAT (INDEPENDENT) ===== */
    if (data.type === "chat") {
      const room = rooms[data.room];
      if (!room) return;
      broadcast(room,{
        type:"chat",
        name:data.name,
        text:data.text
      });
      return;
    }

    /* ===== CREATE ===== */
    if (data.type === "CREATE_ROOM") {
      rooms[data.room] = {
        players:[ws],
        hands:{},
        scores:{ [data.name]:0 },
        table:[],
        trumpSuit:null,
        trumpCaller:0,
        solitaireFinished:[],
        state:{
          phase:1,
          roundIndex:0,
          turn:0,
          trickCount:0,
          leadSuit:null
        }
      };
      ws.name = data.name;
      ws.room = data.room;
      ws.send(JSON.stringify({ type:"PLAYER_JOINED", count:1 }));
      return;
    }

    /* ===== JOIN ===== */
    if (data.type === "JOIN_ROOM") {
      const room = rooms[data.room];
      if (!room || room.players.length === 4) return;
      ws.name = data.name;
      ws.room = data.room;
      room.players.push(ws);
      room.scores[ws.name] = 0;
      broadcast(room,{ type:"PLAYER_JOINED", count:room.players.length });
      if (room.players.length === 4) deal(room);
      return;
    }

    const room = rooms[ws.room];
    if (!room) return;

    /* ===== SET TRUMP ===== */
    if (data.type === "SET_TRUMP" && room.state.phase === 2) {
      room.trumpSuit = data.suit;
      broadcast(room,{ type:"TRUMP_SET", suit:data.suit });
      deal(room);
      return;
    }

    /* ===== PLAY ===== */
    if (data.type === "play" && room.state.phase < 3) {
      if (room.players[room.state.turn] !== ws)
        return error(ws,"Не си на ход");

      const hand = room.hands[ws.name];
      if (!hand.includes(data.card))
        return error(ws,"Нямаш тази карта");

      const roundErr = validateRoundPlay(room, data.card);
      if (roundErr) return error(ws, roundErr);

      if (room.state.leadSuit) {
        const has = hand.some(c => c[0] === room.state.leadSuit);
        if (has && data.card[0] !== room.state.leadSuit)
          return error(ws,"Трябва да отговориш на боя");
      }

      if (!room.state.leadSuit) room.state.leadSuit = data.card[0];

      room.hands[ws.name] = hand.filter(c => c !== data.card);
      room.table.push({ player:ws.name, card:data.card });

      broadcast(room,{ type:"played", player:ws.name, card:data.card });

      if (room.table.length < 4) {
        room.state.turn = (room.state.turn + 1) % 4;
        broadcast(room,{ type:"turn", player:room.players[room.state.turn].name });
        return;
      }

      let win = room.table[0];
      room.table.forEach(t => {
        const trump = room.state.phase === 2 && t.card[0] === room.trumpSuit;
        const winTrump = room.state.phase === 2 && win.card[0] === room.trumpSuit;
        if ((trump && !winTrump) ||
            (t.card[0] === win.card[0] && power(t.card) > power(win.card)))
          win = t;
      });

      scoreTrick(room, win.player, room.table.map(x=>x.card), room.state.trickCount >= 11);
      broadcast(room,{ type:"scores", scores:room.scores });
      broadcast(room,{ type:"clearTable" });

      room.state.turn = room.players.findIndex(p=>p.name===win.player);
      room.state.trickCount++;
      room.table = [];
      room.state.leadSuit = null;

      if (room.state.trickCount === 13) {
        if (room.state.phase === 1 && room.state.roundIndex < 6) {
          room.state.roundIndex++;
          deal(room);
        } else if (room.state.phase === 1) {
          room.state.phase = 2;
          deal(room);
        }
      } else {
        broadcast(room,{ type:"turn", player:room.players[room.state.turn].name });
      }
    }
  });
});

server.listen(process.env.PORT || 8080, () =>
  console.log("Server running")
);
