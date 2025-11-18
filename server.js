const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",   // <--- ALLOWS EVERYONE
        methods: ['GET', 'POST'],
        allowEIO3: true
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

// Serve the HTML file at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'qbelite.html'));
});

// Party/Game management
const parties = new Map(); // partyCode -> { host, players, settings, gameState }
const playerToParty = new Map(); // playerId -> partyCode

// Utility: Generate 4-digit party code
function generatePartyCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (parties.has(code));
    return code;
}

// Utility: Get party data safely
function getParty(partyCode) {
    return parties.get(partyCode);
}

// Utility: Get player in party
function getPlayer(partyCode, playerId) {
    const party = getParty(partyCode);
    if (!party) return null;
    return party.players.find(p => p.id === playerId);
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`[${socket.id}] Client connected`);

    // ============================================================================
    // PARTY MANAGEMENT EVENTS
    // ============================================================================

    // Host creates party
    socket.on('create_party', (data, callback) => {
        const { playerName } = data;
        if (!playerName || playerName.trim() === '') {
            return callback({ success: false, error: 'Invalid player name' });
        }

        const partyCode = generatePartyCode();
        const host = {
            id: socket.id,
            name: playerName.trim(),
            score: 0,
            isHost: true,
            socketId: socket.id
        };

        parties.set(partyCode, {
            code: partyCode,
            host: host,
            players: [host],
            settings: null,
            gameState: null,
            questions: [],
            currentQuestionIndex: -1
        });

        playerToParty.set(socket.id, partyCode);
        socket.join(`party:${partyCode}`);

        console.log(`[${socket.id}] Created party: ${partyCode}`);
        callback({ success: true, partyCode, playerId: socket.id });

        // Notify other clients in party (none yet, but for consistency)
        io.to(`party:${partyCode}`).emit('party_updated', {
            partyCode,
            players: [host]
        });
    });

    // Player joins party
    socket.on('join_party', (data, callback) => {
        const { partyCode, playerName } = data;

        if (!partyCode || !playerName || playerName.trim() === '') {
            return callback({ success: false, error: 'Invalid party code or player name' });
        }

        const party = getParty(partyCode);
        if (!party) {
            return callback({ success: false, error: 'Party not found' });
        }

        if (party.players.length >= 8) {
            return callback({ success: false, error: 'Party is full (max 8 players)' });
        }

        // Check if name already exists
        if (party.players.some(p => p.name.toLowerCase() === playerName.trim().toLowerCase())) {
            return callback({ success: false, error: 'Player name already taken in this party' });
        }

        const player = {
            id: socket.id,
            name: playerName.trim(),
            score: 0,
            isHost: false,
            socketId: socket.id
        };

        party.players.push(player);
        playerToParty.set(socket.id, partyCode);
        socket.join(`party:${partyCode}`);

        console.log(`[${socket.id}] Joined party: ${partyCode} as ${playerName}`);
        callback({ success: true, playerId: socket.id, party });

        // Notify all players in party
        io.to(`party:${partyCode}`).emit('party_updated', {
            partyCode,
            players: party.players,
            gameState: party.gameState
        });
    });

    // Leave party
    socket.on('leave_party', (data, callback) => {
        const partyCode = playerToParty.get(socket.id);

        if (!partyCode) {
            return callback({ success: false, error: 'Not in a party' });
        }

        const party = getParty(partyCode);
        if (!party) {
            return callback({ success: false, error: 'Party not found' });
        }

        // Remove player
        party.players = party.players.filter(p => p.id !== socket.id);
        playerToParty.delete(socket.id);
        socket.leave(`party:${partyCode}`);

        console.log(`[${socket.id}] Left party: ${partyCode}`);
        callback({ success: true });

        // If party is empty, clean up
        if (party.players.length === 0) {
            parties.delete(partyCode);
            console.log(`[Party] Removed empty party: ${partyCode}`);
            return;
        }

        // If host left, assign new host
        if (party.host.id === socket.id) {
            party.host = party.players[0];
            party.host.isHost = true;
            console.log(`[Party] ${partyCode} assigned new host: ${party.host.name}`);
        }

        // Notify remaining players
        io.to(`party:${partyCode}`).emit('party_updated', {
            partyCode,
            players: party.players
        });
    });

    // ============================================================================
    // GAME MANAGEMENT EVENTS
    // ============================================================================

    // Host starts game with questions and settings
    socket.on('start_game', (data, callback) => {
        const partyCode = playerToParty.get(socket.id);
        if (!partyCode) {
            return callback({ success: false, error: 'Not in a party' });
        }

        const party = getParty(partyCode);
        if (!party) {
            return callback({ success: false, error: 'Party not found' });
        }

        if (party.host.id !== socket.id) {
            return callback({ success: false, error: 'Only host can start game' });
        }

        const { questions, settings } = data;
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return callback({ success: false, error: 'Invalid questions' });
        }

        party.settings = settings || {};
        party.questions = questions;
        party.currentQuestionIndex = 0;
        party.gameState = {
            status: 'active',
            buzzedPlayerId: null,
            buzzPoint: 0,
            // Track players who have already attempted this question (so they cannot re-buzz)
            attempted: new Set(),
            lastIncorrectPlayerId: null, // legacy single-last incorrect (kept for compatibility)
            startTime: Date.now(),
            buzzLocked: false
        };
        party.pendingAdvanceTimeout = null; 

        // Reset player scores
        party.players.forEach(p => { p.score = 0; });

        console.log(`[${socket.id}] Started game in party ${partyCode} with ${questions.length} questions`);
        callback({ success: true });

        // Notify all players
        io.to(`party:${partyCode}`).emit('game_started', {
            partyCode,
            questions,
            settings: party.settings
        });
    });

    // Player buzzes in
    socket.on('buzz', (data, callback) => {
        const partyCode = playerToParty.get(socket.id);
        if (!partyCode) {
            return callback({ success: false, error: 'Not in a party' });
        }

        const party = getParty(partyCode);
        if (!party || !party.gameState) {
            return callback({ success: false, error: 'Game not active' });
        }

        // Reject if buzz is already taken or buzzes are locked
        if (party.gameState.buzzedPlayerId) {
            return callback({ success: false, error: 'Someone already buzzed' });
        }

        if (party.gameState.buzzLocked) {
            return callback({ success: false, error: 'Buzzing is temporarily locked' });
        }

        // Prevent players who have already attempted this question from buzzing again
        if (party.gameState.attempted && party.gameState.attempted.has(socket.id)) {
            return callback({ success: false, error: 'You have already attempted this question' });
        }

        const { buzzPoint } = data || {};
        party.gameState.buzzedPlayerId = socket.id;
        party.gameState.buzzPoint = typeof buzzPoint === 'number' ? buzzPoint : 0;
        // clear any previous incorrect lock
        party.gameState.lastIncorrectPlayerId = null;

        console.log(`[${socket.id}] Buzzed in party ${partyCode} at char ${buzzPoint}`);
        callback({ success: true });

        // Notify all players
        io.to(`party:${partyCode}`).emit('player_buzzed', {
            playerId: socket.id,
            playerName: getPlayer(partyCode, socket.id)?.name || 'Unknown',
            buzzPoint
        });
    });

    // Sync reading progress
    socket.on('reading_progress', (data, callback) => {
        const partyCode = playerToParty.get(socket.id);
        if (!partyCode) return;

        const { charIndex } = data;
        io.to(`party:${partyCode}`).emit('reading_progress', { charIndex });
    });

    // Broadcast what player is typing
    socket.on('answer_typing', (data) => {
        const partyCode = playerToParty.get(socket.id);
        if (!partyCode) return;

        const player = getPlayer(partyCode, socket.id);
        if (!player) return;

        const { answerText } = data;
        io.to(`party:${partyCode}`).emit('answer_typing', {
            playerName: player.name,
            answerText
        });
    });

    // Player submits answer
    socket.on('submit_answer', (data, callback) => {
        const partyCode = playerToParty.get(socket.id);
        if (!partyCode) {
            return callback({ success: false, error: 'Not in a party' });
        }

        const party = getParty(partyCode);
        if (!party || !party.gameState) {
            return callback({ success: false, error: 'Game not active' });
        }

        if (party.gameState.buzzedPlayerId !== socket.id) {
            return callback({ success: false, error: 'You did not buzz in' });
        }

        const { isCorrect } = data;
        const player = getPlayer(partyCode, socket.id);
        if (!player) {
            return callback({ success: false, error: 'Player not found' });
        }

        // Compute points server-side to avoid relying on client-supplied values
        let computedPoints = 0;
        if (isCorrect) {
            const curQ = party.questions[party.currentQuestionIndex];
            const buzzPoint = party.gameState.buzzPoint || 0;
            const questionLen = curQ && curQ.question ? curQ.question.length : 1;
            computedPoints = (buzzPoint / Math.max(1, questionLen)) < 0.5 ? 15 : 10;
        } else {
            computedPoints = -5;
        }
        player.score += computedPoints;

        console.log(`[${socket.id}] Answered (${isCorrect ? 'correct' : 'incorrect'}, ${computedPoints}pts) in party ${partyCode}`);
        callback({ success: true });

        // Notify all players of the score update
        io.to(`party:${partyCode}`).emit('answer_submitted', {
            playerId: socket.id,
            playerName: player.name,
            isCorrect,
            points: computedPoints,
            newScore: player.score,
            players: party.players
        });

        if (isCorrect) {
            // CORRECT ANSWER - lock out all buzzing and auto-advance
            party.gameState.buzzLocked = true;
            party.pendingAdvanceTimeout = setTimeout(() => {
                advanceToNextQuestion(partyCode);
            }, 5000);
        } else {
            // INCORRECT ANSWER - record that this player has attempted
            console.log(`[Server] Incorrect answer in party ${partyCode} - recording attempt and unlocking for others`);
            party.gameState.buzzedPlayerId = null;
            party.gameState.buzzPoint = 0;
            // Record attempt
            if (!party.gameState.attempted) party.gameState.attempted = new Set();
            party.gameState.attempted.add(socket.id);

            // Broadcast that buzz is available again for players who haven't attempted
            const attemptedArray = Array.from(party.gameState.attempted);
            io.to(`party:${partyCode}`).emit('buzz_unlocked', {
                playerName: player.name,
                excludedPlayerId: socket.id,
                attempted: attemptedArray
            });

            // If everyone has now attempted this question, auto-advance to next question
            const numPlayers = party.players.length;
            if (party.gameState.attempted.size >= numPlayers) {
                console.log(`[Server] All players attempted question in party ${partyCode} - showing time up`);
                party.pendingAdvanceTimeout = setTimeout(() => {
                    io.to(`party:${partyCode}`).emit('time_up');
                    party.pendingAdvanceTimeout = setTimeout(() => {
                        advanceToNextQuestion(partyCode);
                    }, 5000);  // 5 seconds after Time's Up screen
                }, 1800);  // 1.8 seconds after last INCORRECT
            }
        }
    });

    // Helper: Advance to next question (used by both host and auto-advance)
    function advanceToNextQuestion(partyCode) {
        const party = getParty(partyCode);
        if (!party) return;
        
        if (party.pendingAdvanceTimeout) {
            clearTimeout(party.pendingAdvanceTimeout);
            party.pendingAdvanceTimeout = null;
        }
        
        party.currentQuestionIndex++;
        party.gameState.buzzedPlayerId = null;
        party.gameState.buzzPoint = 0;
        party.gameState.attempted = new Set();
        party.gameState.lastIncorrectPlayerId = null;
        party.gameState.buzzLocked = false;

        if (party.currentQuestionIndex >= party.questions.length) {
            party.gameState.status = 'finished';
            console.log(`[Server] Game finished in party ${partyCode}`);
            io.to(`party:${partyCode}`).emit('game_finished', {
                players: party.players.sort((a, b) => b.score - a.score)
            });
        } else {
            console.log(`[Server] Advanced to question ${party.currentQuestionIndex + 1} in party ${partyCode}`);
            io.to(`party:${partyCode}`).emit('next_question', {
                questionIndex: party.currentQuestionIndex
            });
        }
    }

    // Advance to next question (safe version)
    socket.on('next_question', (data, callback) => {
        const partyCode = playerToParty.get(socket.id);
        if (!partyCode) {
            if (typeof callback === 'function') callback({ success: false, error: 'Not in a party' });
            return;
        }

        const party = getParty(partyCode);
        if (!party || !party.gameState) {
            if (typeof callback === 'function') callback({ success: false, error: 'Game not active' });
            return;
        }

        if (party.host.id !== socket.id) {
            if (typeof callback === 'function') callback({ success: false, error: 'Only host can advance' });
            return;
        }

        advanceToNextQuestion(partyCode);

        // Only acknowledge if callback exists
        if (typeof callback === 'function') {
            const finished = party.currentQuestionIndex >= party.questions.length;
            callback({ success: true, finished });
        }
    });

    // ============================================================================
    // DISCONNECTION HANDLING
    // ============================================================================

    socket.on('disconnect', () => {
        const partyCode = playerToParty.get(socket.id);

        if (partyCode) {
            const party = getParty(partyCode);
            if (party) {
                // Remove player
                party.players = party.players.filter(p => p.id !== socket.id);
                playerToParty.delete(socket.id);

                console.log(`[${socket.id}] Disconnected from party ${partyCode}`);

                // If party is empty, clean up
                if (party.players.length === 0) {
                    parties.delete(partyCode);
                    console.log(`[Party] Removed empty party: ${partyCode}`);
                    return;
                }

                // If host disconnected, assign new host
                if (party.host.id === socket.id) {
                    party.host = party.players[0];
                    party.host.isHost = true;
                    console.log(`[Party] ${partyCode} assigned new host: ${party.host.name}`);
                }

                // Notify remaining players
                io.to(`party:${partyCode}`).emit('player_disconnected', {
                    playerId: socket.id,
                    remainingPlayers: party.players,
                    newHost: party.host
                });
            }
        }

        console.log(`[${socket.id}] Disconnected`);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', parties: parties.size });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎯 Quiz Bowl Elite Server running on http://localhost:${PORT}`);
});
