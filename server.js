require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const POINTS_PER_CORRECT = parseFloat(process.env.POINTS_PER_CORRECT || '10');
const USD_PER_POINT = parseFloat(process.env.USD_PER_POINT || '0.005');
const MIN_WITHDRAWAL_USD = parseFloat(process.env.MIN_WITHDRAWAL_USD || '5.00');

const PAYPAL_MODE = process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
const PAYPAL_BASE = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// ---------- Flat-file JSON storage helpers ----------
// DATA_DIR should point at a Render persistent disk mount (e.g. /data) in production.
// Without it, this defaults back to the app folder, which is WIPED on every deploy/restart —
// that's what was causing "User not found" and login failures after registering.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WITHDRAWALS_FILE = path.join(DATA_DIR, 'withdrawals.json');

// Make sure the data directory exists (Render persistent disks are pre-created,
// but this keeps local/dev usage working without manual setup)
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, '[]');
}
if (!fs.existsSync(WITHDRAWALS_FILE)) {
  fs.writeFileSync(WITHDRAWALS_FILE, '[]');
}

function readJSON(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getUsers() { return readJSON(USERS_FILE); }
function saveUsers(users) { writeJSON(USERS_FILE, users); }
function getWithdrawals() { return readJSON(WITHDRAWALS_FILE); }
function saveWithdrawals(w) { writeJSON(WITHDRAWALS_FILE, w); }

// ---------- Auth middleware ----------
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------- Auth routes ----------
app.post('/api/register', async (req, res) => {
  const { username, email, password, paypalEmail } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password are required' });
  }
  const users = getUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = {
    id: crypto.randomUUID(),
    username,
    email,
    passwordHash,
    paypalEmail: paypalEmail || email,
    balanceUsd: 0,
    totalCorrect: 0,
    totalAnswered: 0,
    bestStreak: 0,
    currentStreak: 0,
    createdAt: new Date().toISOString()
  };
  users.push(newUser);
  saveUsers(users);

  const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: publicUser(newUser) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const users = getUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const users = getUsers();
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    paypalEmail: u.paypalEmail,
    balanceUsd: Number(u.balanceUsd.toFixed(4)),
    totalCorrect: u.totalCorrect,
    totalAnswered: u.totalAnswered,
    bestStreak: u.bestStreak,
    currentStreak: u.currentStreak
  };
}

// ---------- Math game logic ----------
// In-memory pending-question map: userId -> { answer, expiresAt }
const pendingQuestions = new Map();

function generateQuestion(difficultyLevel) {
  const ops = ['+', '-', '*'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let a, b;
  const maxRange = 10 + difficultyLevel * 5;

  if (op === '*') {
    a = Math.floor(Math.random() * (5 + difficultyLevel * 2)) + 1;
    b = Math.floor(Math.random() * (5 + difficultyLevel * 2)) + 1;
  } else {
    a = Math.floor(Math.random() * maxRange) + 1;
    b = Math.floor(Math.random() * maxRange) + 1;
  }

  if (op === '-' && b > a) [a, b] = [b, a]; // avoid negative results

  let answer;
  if (op === '+') answer = a + b;
  else if (op === '-') answer = a - b;
  else answer = a * b;

  return { text: `${a} ${op} ${b}`, answer };
}

app.post('/api/game/question', authMiddleware, (req, res) => {
  const users = getUsers();
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const difficultyLevel = Math.min(Math.floor(user.currentStreak / 5), 10);
  const q = generateQuestion(difficultyLevel);

  pendingQuestions.set(req.userId, {
    answer: q.answer,
    expiresAt: Date.now() + 30000 // 30s to answer
  });

  res.json({ question: q.text, difficultyLevel, timeLimitSeconds: 30 });
});

app.post('/api/game/submit', authMiddleware, (req, res) => {
  const { answer } = req.body;
  if (answer === undefined || answer === null || isNaN(Number(answer))) {
    return res.status(400).json({ error: 'A numeric answer is required' });
  }

  const pending = pendingQuestions.get(req.userId);
  if (!pending) {
    return res.status(400).json({ error: 'No active question. Request a new one first.' });
  }
  pendingQuestions.delete(req.userId);

  const users = getUsers();
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const expired = Date.now() > pending.expiresAt;
  const correct = !expired && Number(answer) === pending.answer;

  user.totalAnswered += 1;

  let earnedUsd = 0;
  if (correct) {
    user.totalCorrect += 1;
    user.currentStreak += 1;
    user.bestStreak = Math.max(user.bestStreak, user.currentStreak);

    const streakBonusMultiplier = 1 + Math.min(user.currentStreak * 0.02, 0.5); // up to +50%
    const pointsEarned = POINTS_PER_CORRECT * streakBonusMultiplier;
    earnedUsd = pointsEarned * USD_PER_POINT;
    user.balanceUsd += earnedUsd;
  } else {
    user.currentStreak = 0;
  }

  saveUsers(users);

  res.json({
    correct,
    expired,
    correctAnswer: pending.answer,
    earnedUsd: Number(earnedUsd.toFixed(4)),
    balanceUsd: Number(user.balanceUsd.toFixed(4)),
    currentStreak: user.currentStreak,
    bestStreak: user.bestStreak
  });
});

// ---------- PayPal Payouts integration ----------
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials are not configured on the server');
  }
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await axios.post(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  return response.data.access_token;
}

async function sendPayPalPayout({ recipientEmail, amountUsd, senderBatchId, note }) {
  const accessToken = await getPayPalAccessToken();
  const body = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'You have a payout from Math Arcade!',
      email_message: 'Your withdrawal has been processed. Thanks for playing!'
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: amountUsd.toFixed(2), currency: 'USD' },
        note: note || 'Math Arcade winnings withdrawal',
        receiver: recipientEmail
      }
    ]
  };

  const response = await axios.post(
    `${PAYPAL_BASE}/v1/payments/payouts`,
    body,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

app.post('/api/withdraw', authMiddleware, async (req, res) => {
  const { amountUsd, paypalEmail } = req.body;
  const amount = parseFloat(amountUsd);

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'A valid withdrawal amount is required' });
  }
  if (amount < MIN_WITHDRAWAL_USD) {
    return res.status(400).json({ error: `Minimum withdrawal is $${MIN_WITHDRAWAL_USD.toFixed(2)}` });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (amount > user.balanceUsd) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const targetEmail = paypalEmail || user.paypalEmail;
  const withdrawals = getWithdrawals();
  const senderBatchId = `mathgame-${user.id}-${Date.now()}`;

  const record = {
    id: crypto.randomUUID(),
    userId: user.id,
    amountUsd: amount,
    paypalEmail: targetEmail,
    senderBatchId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null
  };

  // Deduct balance immediately to prevent double-spend, refund on failure
  user.balanceUsd -= amount;
  saveUsers(users);

  try {
    const payoutResult = await sendPayPalPayout({
      recipientEmail: targetEmail,
      amountUsd: amount,
      senderBatchId,
      note: 'Math Arcade withdrawal'
    });

    record.status = 'submitted';
    record.completedAt = new Date().toISOString();
    record.paypalBatchStatus = payoutResult.batch_header && payoutResult.batch_header.batch_status;
    withdrawals.push(record);
    saveWithdrawals(withdrawals);

    res.json({
      message: 'Withdrawal submitted to PayPal',
      withdrawal: record,
      balanceUsd: Number(user.balanceUsd.toFixed(4))
    });
  } catch (err) {
    // Refund the user since the payout failed
    const freshUsers = getUsers();
    const freshUser = freshUsers.find(u => u.id === req.userId);
    if (freshUser) {
      freshUser.balanceUsd += amount;
      saveUsers(freshUsers);
    }

    record.status = 'failed';
    record.error = (err.response && err.response.data) ? JSON.stringify(err.response.data) : err.message;
    withdrawals.push(record);
    saveWithdrawals(withdrawals);

    res.status(502).json({
      error: 'PayPal payout failed. Your balance has been refunded.',
      details: record.error
    });
  }
});

app.get('/api/withdrawals', authMiddleware, (req, res) => {
  const withdrawals = getWithdrawals().filter(w => w.userId === req.userId);
  res.json({ withdrawals });
});

// ---------- Health check ----------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', paypalMode: PAYPAL_MODE });
});

app.listen(PORT, () => {
  console.log(`Math Arcade server running on port ${PORT} (PayPal mode: ${PAYPAL_MODE})`);
});
