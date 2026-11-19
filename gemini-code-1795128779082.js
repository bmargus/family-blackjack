const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- GAME STATE ---
let gameState = {
  phase: 'LOBBY', // LOBBY, BETTING, PLAYER_TURN, DEALER_TURN, ROUND_OVER, GAME_OVER
  selectedHumans: ['Brad', 'Jarrett', 'Quinn'], // Host configures 2 or 3
  players: [], // Active seats (humans + Nerd + Cowboy)
  dealer: {
    cards: [],
    hidden: true,
    total: 0,
    status: ''
  },
  activePlayerIndex: -1,
  deck: [],
  dealerLine: "Welcome to the VIP table! Pick who's playing!",
  dealerMood: 'happy', // happy, laugh, shocked, smug
  roundNumber: 0
};

const STARTING_CHIPS = 1000;

// --- DECK & HAND HELPERS ---
function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  // 4-deck casino shoe
  for (let d = 0; d < 4; d++) {
    for (let s of suits) {
      for (let v of values) {
        deck.push({ suit: s, value: v, isRed: s === '♥' || s === '♦' });
      }
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function drawCard() {
  if (gameState.deck.length < 30) {
    gameState.deck = createDeck();
  }
  return gameState.deck.pop();
}

function calculateHand(cards) {
  let total = 0;
  let aces = 0;
  for (let c of cards) {
    if (c.value === 'A') {
      aces++;
      total += 11;
    } else if (['K', 'Q', 'J'].includes(c.value)) {
      total += 10;
    } else {
      total += parseInt(c.value, 10);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function isBlackjack(cards) {
  return cards.length === 2 && calculateHand(cards) === 21;
}

// --- DEALER HUMOR LINES ---
const DEALER_LINES = {
  betting: [
    "Place your bets! Don't bet the family farm!",
    "Toss those chips in! Papa needs a new pair of shoes!",
    "Step right up! Big money, no whammies!"
  ],
  deal: [
    "Cards are flying! Let's see who sweats first!",
    "Here we go! Try not to embarrass yourselves!",
    "Fresh cards! May the odds be slightly in my favor!"
  ],
  blackjack: [
    "BOOM! Blackjack! Somebody check their sleeves!",
    "Winner winner chicken dinner! Natural 21!",
    "Twenty-one right out of the gate! Show-off!"
  ],
  bustMild: [
    "Ooh, 22! Missed it by THAT much!",
    "Just a hair over! Gravity wins again!",
    "22! So close, yet so broke!"
  ],
  bustMedium: [
    "KABOOM! Way over 21! Did you forget how to count?",
    "Yikes! That hand exploded like a cheap toaster!",
    "Bust city! Population: YOU!"
  ],
  bustExtreme: [
    "MEGA BUST! Are we playing golf?! Highest score loses!",
    "CALL THE FIRE DEPARTMENT! That hand went nuclear!",
    "WHAT WAS THAT?! Were you aiming for 30?!"
  ],
  dealerWin: [
    "House wins! Thank you for your generous donation!",
    "Read 'em and weep! The dealer takes it all!",
    "Better luck next hand, high rollers!"
  ],
  dealerBust: [
    "OH NO, I BUSTED! Quick, nobody look at my math!",
    "Well, that's embarrassing. Take my chips!",
    "I went over! Enjoy the free money!"
  ]
};

function pickLine(category) {
  const list = DEALER_LINES[category];
  return list[Math.floor(Math.random() * list.length)];
}

function broadcastState(eventSound = null) {
  const sanitized = JSON.parse(JSON.stringify(gameState));
  if (sanitized.dealer.hidden && sanitized.dealer.cards.length === 2) {
    sanitized.dealer.cards[1] = { hidden: true };
    sanitized.dealer.total = calculateHand([gameState.dealer.cards[0]]);
  }
  io.emit('stateUpdate', { state: sanitized, sound: eventSound });
}

// --- GAME FLOW ---
function setupPlayers(selectedNames) {
  const list = [];
  selectedNames.forEach((name) => {
    list.push({
      id: name,
      name: name,
      type: 'human',
      avatar: name === 'Brad' ? '😎' : name === 'Jarrett' ? '🧢' : '🧔',
      connected: false,
      socketId: null,
      chips: STARTING_CHIPS,
      bet: 0,
      betConfirmed: false,
      cards: [],
      total: 0,
      status: '', // '', 'BLACKJACK', 'STAND', 'BUST', 'WIN', 'LOSE', 'PUSH'
      bustOverBy: 0
    });
  });

  // Always add Nerd and Cowboy bots
  list.push({
    id: 'Nerd',
    name: 'Professor Pip',
    type: 'nerd',
    avatar: '🤓',
    connected: true,
    socketId: null,
    chips: STARTING_CHIPS,
    bet: 0,
    betConfirmed: false,
    cards: [],
    total: 0,
    status: '',
    bustOverBy: 0
  });

  list.push({
    id: 'Cowboy',
    name: 'Tex',
    type: 'cowboy',
    avatar: '🤠',
    connected: true,
    socketId: null,
    chips: STARTING_CHIPS,
    bet: 0,
    betConfirmed: false,
    cards: [],
    total: 0,
    status: '',
    bustOverBy: 0
  });

  gameState.players = list;
}

function startBettingRound() {
  gameState.roundNumber++;
  gameState.phase = 'BETTING';
  gameState.activePlayerIndex = -1;
  gameState.dealer = { cards: [], hidden: true, total: 0, status: '' };
  gameState.dealerLine = pickLine('betting');
  gameState.dealerMood = 'happy';

  gameState.players.forEach((p) => {
    // Rebuy automatically if broke so nobody gets stuck sitting out
    if (p.chips < 25) {
      p.chips = 500;
    }
    p.cards = [];
    p.total = 0;
    p.status = '';
    p.bustOverBy = 0;

    if (p.type === 'human') {
      p.bet = 0;
      p.betConfirmed = false;
    } else if (p.type === 'nerd') {
      // Nerd bets conservatively
      p.bet = Math.min(50, p.chips);
      p.betConfirmed = true;
    } else if (p.type === 'cowboy') {
      // Cowboy bets big & reckless
      const wildBets = [100, 150, 200];
      const pick = wildBets[Math.floor(Math.random() * wildBets.length)];
      p.bet = Math.min(pick, p.chips);
      p.betConfirmed = true;
    }
  });

  broadcastState('chip');
}

function dealInitialCards() {
  gameState.phase = 'PLAYER_TURN';
  gameState.dealerLine = pickLine('deal');
  gameState.dealerMood = 'happy';

  // Deduct bets and deal 2 cards each
  gameState.players.forEach((p) => {
    p.chips -= p.bet;
    p.cards = [drawCard(), drawCard()];
    p.total = calculateHand(p.cards);
    if (isBlackjack(p.cards)) {
      p.status = 'BLACKJACK';
      gameState.dealerLine = `${p.name} got BLACKJACK! ${pickLine('blackjack')}`;
      gameState.dealerMood = 'shocked';
    }
  });

  gameState.dealer.cards = [drawCard(), drawCard()];
  gameState.dealer.hidden = true;
  gameState.dealer.total = calculateHand(gameState.dealer.cards);

  gameState.activePlayerIndex = -1;
  advanceTurn();
}

function advanceTurn() {
  gameState.activePlayerIndex++;

  while (gameState.activePlayerIndex < gameState.players.length) {
    const p = gameState.players[gameState.activePlayerIndex];
    if (p.status === '') {
      // Found next active player
      if (p.type !== 'human') {
        broadcastState('card');
        setTimeout(() => runBotTurn(p), 1100);
        return;
      } else {
        gameState.dealerLine = `${p.name}, your move! Hit or Stand?`;
        gameState.dealerMood = 'happy';
        broadcastState('card');
        return;
      }
    }
    gameState.activePlayerIndex++;
  }

  // All players done -> Dealer's turn
  runDealerTurn();
}

function handlePlayerHit(player) {
  const card = drawCard();
  player.cards.push(card);
  player.total = calculateHand(player.cards);

  if (player.total > 21) {
    player.status = 'BUST';
    player.bustOverBy = player.total - 21;
    gameState.dealerMood = 'laugh';

    if (player.bustOverBy <= 2) {
      gameState.dealerLine = `${player.name} busted with ${player.total}! ${pickLine('bustMild')}`;
    } else if (player.bustOverBy <= 5) {
      gameState.dealerLine = `${player.name} hit ${player.total}! ${pickLine('bustMedium')}`;
    } else {
      gameState.dealerLine = `${player.name} hit ${player.total}! ${pickLine('bustExtreme')}`;
    }

    broadcastState('bust');
    setTimeout(advanceTurn, 1800);
  } else if (player.total === 21) {
    player.status = 'STAND';
    gameState.dealerLine = `21 on the nose for ${player.name}! Smart move!`;
    broadcastState('card');
    setTimeout(advanceTurn, 1000);
  } else {
    broadcastState('card');
    if (player.type !== 'human') {
      setTimeout(() => runBotTurn(player), 1100);
    }
  }
}

function handlePlayerStand(player) {
  player.status = 'STAND';
  gameState.dealerLine = `${player.name} stays at ${player.total}.`;
  broadcastState('stand');
  setTimeout(advanceTurn, 800);
}

function handlePlayerDouble(player) {
  if (player.cards.length !== 2 || player.chips < player.bet) return;
  player.chips -= player.bet;
  player.bet *= 2;

  const card = drawCard();
  player.cards.push(card);
  player.total = calculateHand(player.cards);

  if (player.total > 21) {
    player.status = 'BUST';
    player.bustOverBy = player.total - 21;
    gameState.dealerMood = 'laugh';
    gameState.dealerLine = `DOUBLED AND BUSTED with ${player.total}! Ouch, ${player.name}!`;
    broadcastState('bust');
  } else {
    player.status = 'STAND';
    gameState.dealerLine = `${player.name} doubled down and landed on ${player.total}!`;
    broadcastState('card');
  }
  setTimeout(advanceTurn, 1500);
}

function runBotTurn(bot) {
  if (gameState.phase !== 'PLAYER_TURN') return;
  const current = gameState.players[gameState.activePlayerIndex];
  if (!current || current.id !== bot.id || bot.status !== '') return;

  const dealerUp = calculateHand([gameState.dealer.cards[0]]);

  if (bot.type === 'nerd') {
    // Basic strategy approximation
    if (bot.total < 12) {
      handlePlayerHit(bot);
    } else if (bot.total >= 12 && bot.total <= 16 && dealerUp >= 7) {
      handlePlayerHit(bot);
    } else {
      handlePlayerStand(bot);
    }
  } else if (bot.type === 'cowboy') {
    // Yeehaw! Hits aggressively up to 17
    if (bot.total <= 17) {
      handlePlayerHit(bot);
    } else {
      handlePlayerStand(bot);
    }
  }
}

function runDealerTurn() {
  gameState.phase = 'DEALER_TURN';
  gameState.dealer.hidden = false;
  gameState.dealer.total = calculateHand(gameState.dealer.cards);
  gameState.dealerLine = `Dealer flips... showing ${gameState.dealer.total}!`;
  broadcastState('card');

  const anyAlive = gameState.players.some((p) => p.status === 'STAND' || p.status === 'BLACKJACK');

  const dealerStep = () => {
    if (!anyAlive) {
      finishRound();
      return;
    }
    if (gameState.dealer.total < 17) {
      gameState.dealer.cards.push(drawCard());
      gameState.dealer.total = calculateHand(gameState.dealer.cards);
      gameState.dealerLine = `Dealer draws to ${gameState.dealer.total}...`;
      broadcastState('card');
      setTimeout(dealerStep, 1000);
    } else {
      finishRound();
    }
  };

  setTimeout(dealerStep, 1100);
}

function finishRound() {
  gameState.phase = 'ROUND_OVER';
  const dTotal = gameState.dealer.total;
  const dBlackjack = isBlackjack(gameState.dealer.cards);
  const dBust = dTotal > 21;

  if (dBust) {
    gameState.dealer.status = 'BUST';
    gameState.dealerLine = pickLine('dealerBust');
    gameState.dealerMood = 'shocked';
  } else {
    gameState.dealer.status = `${dTotal}`;
    gameState.dealerLine = pickLine('dealerWin');
    gameState.dealerMood = 'smug';
  }

  gameState.players.forEach((p) => {
    if (p.status === 'BUST') {
      p.status = 'LOSE';
      return;
    }

    if (p.status === 'BLACKJACK') {
      if (dBlackjack) {
        p.status = 'PUSH';
        p.chips += p.bet;
      } else {
        p.status = 'BLACKJACK WIN!';
        p.chips += Math.floor(p.bet * 2.5); // 3:2 payout
      }
      return;
    }

    if (dBust) {
      p.status = 'WIN';
      p.chips += p.bet * 2;
    } else if (dBlackjack) {
      p.status = 'LOSE';
    } else if (p.total > dTotal) {
      p.status = 'WIN';
      p.chips += p.bet * 2;
    } else if (p.total === dTotal) {
      p.status = 'PUSH';
      p.chips += p.bet;
    } else {
      p.status = 'LOSE';
    }
  });

  broadcastState(dBust ? 'win' : 'roundEnd');
}

// --- SOCKET.IO EVENTS ---
io.on('connection', (socket) => {
  broadcastState();

  // Host sets who is playing (2 or 3 of Brad, Jarrett, Quinn)
  socket.on('hostSetup', (selectedNames) => {
    if (!Array.isArray(selectedNames) || selectedNames.length < 2 || selectedNames.length > 3) return;
    gameState.selectedHumans = selectedNames;
    setupPlayers(selectedNames);
    gameState.deck = createDeck();
    gameState.roundNumber = 0;
    startBettingRound();
  });

  // Player claims their seat
  socket.on('claimSeat', (playerId) => {
    const player = gameState.players.find((p) => p.id === playerId && p.type === 'human');
    if (player) {
      // Release any previous seat held by this socket
      gameState.players.forEach((p) => {
        if (p.socketId === socket.id) {
          p.connected = false;
          p.socketId = null;
        }
      });
      player.connected = true;
      player.socketId = socket.id;
      gameState.dealerLine = `${player.name} just pulled up a chair!`;
      broadcastState('join');
    }
  });

  // Betting actions
  socket.on('addBet', ({ playerId, amount }) => {
    if (gameState.phase !== 'BETTING') return;
    const player = gameState.players.find((p) => p.id === playerId);
    if (!player || player.betConfirmed) return;
    if (player.bet + amount <= player.chips) {
      player.bet += amount;
      broadcastState('chip');
    }
  });

  socket.on('clearBet', (playerId) => {
    if (gameState.phase !== 'BETTING') return;
    const player = gameState.players.find((p) => p.id === playerId);
    if (!player || player.betConfirmed) return;
    player.bet = 0;
    broadcastState('chip');
  });

  socket.on('confirmBet', (playerId) => {
    if (gameState.phase !== 'BETTING') return;
    const player = gameState.players.find((p) => p.id === playerId);
    if (!player || player.bet <= 0) return;
    player.betConfirmed = true;

    const allConfirmed = gameState.players.every((p) => p.betConfirmed);
    if (allConfirmed) {
      dealInitialCards();
    } else {
      broadcastState('chip');
    }
  });

  // Turn actions
  socket.on('action', ({ playerId, type }) => {
    if (gameState.phase !== 'PLAYER_TURN') return;
    const current = gameState.players[gameState.activePlayerIndex];
    if (!current || current.id !== playerId || current.status !== '') return;

    if (type === 'HIT') handlePlayerHit(current);
    if (type === 'STAND') handlePlayerStand(current);
    if (type === 'DOUBLE') handlePlayerDouble(current);
  });

  // Next hand
  socket.on('nextRound', () => {
    if (gameState.phase === 'ROUND_OVER') {
      startBettingRound();
    }
  });

  // End game button
  socket.on('endGame', () => {
    gameState.phase = 'GAME_OVER';
    gameState.dealerLine = "Table closed! Check out the final standings!";
    gameState.dealerMood = 'happy';
    broadcastState('win');
  });

  // Reset back to lobby
  socket.on('resetLobby', () => {
    gameState.phase = 'LOBBY';
    gameState.players = [];
    gameState.dealerLine = "Welcome back! Pick who's playing!";
    broadcastState();
  });

  socket.on('disconnect', () => {
    const player = gameState.players.find((p) => p.socketId === socket.id);
    if (player) {
      player.connected = false;
      player.socketId = null;
      broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blackjack Casino running on port ${PORT}`);
});