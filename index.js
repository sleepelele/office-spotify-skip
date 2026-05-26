const express = require("express");
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

/* ---------------- SUPABASE ---------------- */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/* ---------------- STATE ---------------- */

let votes = new Map();
let coinBoosts = new Map();
let bannedNames = new Set();
let bannedDevices = new Set();
let connectedUsers = new Map();
let cooldown = false;
let votingEnabled = true;
let soundEnabled = true;
let totalPeople = parseInt(process.env.TOTAL_PEOPLE) || 5;
let lastSongId = null;
let lastSkipInfo = null;

// volume votes: separate maps for up/down, same majority logic
let volUpVotes = new Map();   // userId -> name
let volDownVotes = new Map();
let volCooldown = false;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

async function saveSettings() {
  await supabase.from("settings").upsert({
    id: 1,
    total_people: totalPeople,
    voting_enabled: votingEnabled,
    sound_enabled: soundEnabled
  });
}

async function loadSettings() {
  const { data } = await supabase.from("settings").select("*").eq("id", 1).single();
  if (data) {
    totalPeople = data.total_people ?? totalPeople;
    votingEnabled = data.voting_enabled ?? votingEnabled;
    soundEnabled = data.sound_enabled ?? soundEnabled;
    console.log("Settings loaded:", { totalPeople, votingEnabled, soundEnabled });
  }
}

async function loadBannedDevices() {
  const { data } = await supabase.from("banned_devices").select("user_id");
  if (data) data.forEach(row => bannedDevices.add(row.user_id));
  console.log("Loaded banned devices:", bannedDevices.size);
}

Promise.all([loadSettings(), loadBannedDevices()]);

/* ---------------- SOCKET ---------------- */

io.on("connection", (socket) => {

  socket.on("registerUser", ({ userId, name }) => {
    if (bannedDevices.has(userId)) {
      socket.emit("device_banned");
      return;
    }
    socket.userId = userId;
    connectedUsers.set(userId, name);
    io.emit("voteUpdate", buildVoteResponse());
  });

  socket.on("disconnect", () => {
    if (socket.userId) connectedUsers.delete(socket.userId);
    io.emit("voteUpdate", buildVoteResponse());
  });

});

/* ---------------- UTIL ---------------- */

function majority() {
  return Math.floor(totalPeople / 2) + 1;
}

function totalVoteCount() {
  // regular votes + coin boosts
  const boosts = Array.from(coinBoosts.values()).reduce((a, b) => a + b, 0);
  return votes.size + boosts;
}

function buildVoteResponse(message = "") {
  return {
    count: totalVoteCount(),
    needed: majority(),
    voters: Array.from(votes.values()),
    users: Array.from(connectedUsers.values()),
    userIds: Array.from(connectedUsers.keys()),
    cooldown,
    votingEnabled,
    soundEnabled,
    message,
    volUp: volUpVotes.size,
    volDown: volDownVotes.size,
    volCooldown
  };
}

async function getAccessToken() {
  const response = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN
    }),
    {
      headers: {
        Authorization: "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64")
      }
    }
  );
  return response.data.access_token;
}

async function skipTrack() {
  const token = await getAccessToken();
  await axios.post("https://api.spotify.com/v1/me/player/next", {}, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

/* ---------------- RIGA MIDNIGHT RESET ---------------- */

function getRigaDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Riga" });
}

async function checkAndResetCoins(userId, userName) {
  const today = getRigaDateString();

  const { data, error } = await supabase
    .from("coins")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    // new user — create with 5 coins
    await supabase.from("coins").insert({
      user_id: userId,
      user_name: userName,
      balance: 5,
      last_reset: today
    });
    return 5;
  }

  // daily top-up: if balance < 5, bring it back to 5 — but never reduce
  if (data.last_reset !== today) {
    const newBalance = Math.max(data.balance, 5);
    await supabase.from("coins").update({
      balance: newBalance,
      last_reset: today,
      user_name: userName
    }).eq("user_id", userId);
    return newBalance;
  }

  return data.balance;
}

/* ---------------- VOTE ---------------- */

app.post("/vote", async (req, res) => {

  if (!votingEnabled) return res.json(buildVoteResponse("Voting disabled"));

  const { userId, name } = req.body;
  if (bannedDevices.has(userId)) return res.json(buildVoteResponse("Device banned"));
  connectedUsers.set(userId, name);

  if (bannedNames.has(name)) return res.json(buildVoteResponse(`${name} is banned`));
  if (cooldown) return res.json(buildVoteResponse("Cooldown active"));
  if (votes.has(userId)) return res.json(buildVoteResponse("Already voted"));

  votes.set(userId, name);
  io.emit("voteUpdate", buildVoteResponse());

  if (totalVoteCount() >= majority()) {
    try { await doSkip(); } catch(e) { console.error("Skip error:", e.message); }
    return res.json(buildVoteResponse("Song skipped"));
  }

  res.json(buildVoteResponse("Vote registered"));
});

/* ---------------- COIN BOOST VOTE ---------------- */

app.post("/boost-vote", async (req, res) => {

  const { userId, name } = req.body;

  if (!votingEnabled) return res.json({ success: false, message: "Voting disabled" });
  if (cooldown) return res.json({ success: false, message: "Cooldown active" });
  if (bannedDevices.has(userId)) return res.json({ success: false, message: "Device banned" });

  // check coin balance
  const balance = await checkAndResetCoins(userId, name);

  if (balance < 1) {
    return res.json({ success: false, message: "No coins left!" });
  }

  // deduct 1 coin
  await supabase.from("coins").update({ balance: balance - 1 }).eq("user_id", userId);

  // add boost
  coinBoosts.set(userId, (coinBoosts.get(userId) || 0) + 1);

  io.emit("voteUpdate", buildVoteResponse());

  if (totalVoteCount() >= majority()) {
    try { await doSkip(); } catch(e) { console.error("Boost skip error:", e.message); }
    return res.json({ success: true, newBalance: balance - 1, skipped: true });
  }

  res.json({ success: true, newBalance: balance - 1, skipped: false });
});

async function doSkip() {
  const token = await getAccessToken();
  const response = await axios.get(
    "https://api.spotify.com/v1/me/player/currently-playing",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  let songName = "Unknown";
  let songId = null;

  if (response.data?.item) {
    songName = response.data.item.name + " - " + response.data.item.artists.map(a => a.name).join(", ");
    songId = response.data.item.id;
  }

  lastSkipInfo = {
    song: songName,
    skippedBy: Array.from(votes.values()),
    time: new Date().toLocaleTimeString()
  };

  // only record skip stat if playing from the office playlist
  const context = response.data?.context;
  const isOfficePlaylist = context &&
    context.type === "playlist" &&
    context.uri === `spotify:playlist:${OFFICE_PLAYLIST_ID}`;

  if (songId && isOfficePlaylist) {
    try {
      await supabase.rpc("increment_song_skips", { p_song_id: songId });
    } catch(e) {
      console.error("Stats update error:", e.message);
    }
  }

  await skipTrack();

  votes.clear();
  coinBoosts.clear();
  volUpVotes.clear();
  volDownVotes.clear();
  cooldown = true;

  io.emit("voteUpdate", buildVoteResponse("Song skipped"));
  // tell all clients to refresh song immediately after a short delay for Spotify to update
  setTimeout(() => io.emit("songSkipped"), 1200);

  setTimeout(() => {
    cooldown = false;
    io.emit("voteUpdate", buildVoteResponse());
  }, 60000);
}

const OFFICE_PLAYLIST_ID = "7vjr14h7zkDuyGOofPjbL7";

/* ---------------- CURRENT SONG ---------------- */

app.get("/current-song", async (req, res) => {

  try {
    const token = await getAccessToken();
    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.data?.item) {
      return res.json({ title: "Nothing playing", image: null });
    }

    const item = response.data.item;
    const songId = item.id;
    const title = item.name + " - " + item.artists.map(a => a.name).join(", ");
    const albumImage = item.album.images[0]?.url || null;

    // check if playing from the office playlist
    const context = response.data.context;
    const isOfficePlaylist = context &&
      context.type === "playlist" &&
      context.uri === `spotify:playlist:${OFFICE_PLAYLIST_ID}`;

    // new song detected — clear votes regardless of playlist
    if (lastSongId && lastSongId !== songId) {
      votes.clear();
      coinBoosts.clear();
      cooldown = false;
      io.emit("voteUpdate", buildVoteResponse());
    }

    // only track stats if playing from office playlist
    if (lastSongId !== songId && isOfficePlaylist) {
      lastSongId = songId;
      const { data: existing } = await supabase
        .from("song_stats")
        .select("plays")
        .eq("song_id", songId)
        .single();

      if (existing) {
        await supabase.from("song_stats").update({ plays: existing.plays + 1, title }).eq("song_id", songId);
      } else {
        await supabase.from("song_stats").insert({ song_id: songId, title, plays: 1, skips: 0, likes: 0, dislikes: 0 });
      }
    } else if (lastSongId !== songId) {
      lastSongId = songId;
    }

    res.json({ title, image: albumImage, songId, isOfficePlaylist });

  } catch (err) {
    console.error("Spotify error:", err.response?.data || err.message);
    res.json({ title: err.response?.data?.error?.message || err.message, image: null });
  }

});

/* ---------------- SONG STATS ---------------- */

app.get("/song-stats/:songId", async (req, res) => {
  const { data } = await supabase
    .from("song_stats")
    .select("*")
    .eq("song_id", req.params.songId)
    .single();
  res.json(data || { plays: 0, skips: 0, likes: 0, dislikes: 0 });
});

app.post("/song-vote", async (req, res) => {
  const { userId, songId, sessionId, vote } = req.body; // vote: 'like' | 'dislike'

  if (!userId || !songId || !vote) return res.status(400).json({ success: false });

  // check if already voted this session
  const { data: existing } = await supabase
    .from("song_votes")
    .select("id, vote")
    .eq("user_id", userId)
    .eq("song_id", songId)
    .eq("session_id", sessionId)
    .single();

  if (existing) {
    if (existing.vote === vote) {
      // undo vote
      await supabase.from("song_votes").delete().eq("id", existing.id);
      const col = vote === "like" ? "likes" : "dislikes";
      const { data: stats } = await supabase.from("song_stats").select(col).eq("song_id", songId).single();
      if (stats) await supabase.from("song_stats").update({ [col]: Math.max(0, stats[col] - 1) }).eq("song_id", songId);
      return res.json({ success: true, action: "removed" });
    } else {
      // switch vote
      await supabase.from("song_votes").update({ vote }).eq("id", existing.id);
      const addCol = vote === "like" ? "likes" : "dislikes";
      const remCol = vote === "like" ? "dislikes" : "likes";
      const { data: stats } = await supabase.from("song_stats").select("likes,dislikes").eq("song_id", songId).single();
      if (stats) {
        await supabase.from("song_stats").update({
          [addCol]: stats[addCol] + 1,
          [remCol]: Math.max(0, stats[remCol] - 1)
        }).eq("song_id", songId);
      }
      return res.json({ success: true, action: "switched" });
    }
  }

  // new vote
  await supabase.from("song_votes").insert({ user_id: userId, song_id: songId, session_id: sessionId, vote });
  const col = vote === "like" ? "likes" : "dislikes";
  const { data: stats } = await supabase.from("song_stats").select(col).eq("song_id", songId).single();
  if (stats) await supabase.from("song_stats").update({ [col]: stats[col] + 1 }).eq("song_id", songId);

  res.json({ success: true, action: "added" });
});

/* ---------------- COINS ---------------- */

app.get("/coins/:userId", async (req, res) => {
  const { userId } = req.params;
  const { name } = req.query;
  const balance = await checkAndResetCoins(userId, name || "Unknown");
  res.json({ balance });
});

/* ---------------- VOLUME VOTE ---------------- */

app.get("/current-volume", async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await axios.get(
      "https://api.spotify.com/v1/me/player",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const volume = response.data?.device?.volume_percent ?? null;
    res.json({ volume });
  } catch {
    res.json({ volume: null });
  }
});

app.post("/vote-volume", async (req, res) => {
  const { userId, name, direction } = req.body; // direction: 'up' | 'down'
  if (!votingEnabled) return res.json(buildVoteResponse("Voting disabled"));
  if (bannedDevices.has(userId)) return res.json(buildVoteResponse("Device banned"));
  if (volCooldown) return res.json({ ...buildVoteResponse(), message: "Volume cooldown active" });

  const map = direction === "up" ? volUpVotes : volDownVotes;
  const other = direction === "up" ? volDownVotes : volUpVotes;

  // remove from opposite direction if switching
  other.delete(userId);

  if (map.has(userId)) {
    map.delete(userId); // undo vote
  } else {
    map.set(userId, name);
  }

  io.emit("voteUpdate", buildVoteResponse());

  if (map.size >= majority()) {
    try {
      const token = await getAccessToken();
      const playerRes = await axios.get(
        "https://api.spotify.com/v1/me/player",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const current = playerRes.data?.device?.volume_percent ?? 50;
      const newVol = direction === "up"
        ? Math.min(100, current + 5)
        : Math.max(0, current - 5);

      await axios.put(
        `https://api.spotify.com/v1/me/player/volume?volume_percent=${newVol}`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );

      volUpVotes.clear();
      volDownVotes.clear();
      volCooldown = true;

      io.emit("voteUpdate", buildVoteResponse(`Volume ${direction === "up" ? "▲" : "▼"} → ${newVol}%`));
      io.emit("volumeChanged", { volume: newVol });

      setTimeout(() => {
        volCooldown = false;
        io.emit("voteUpdate", buildVoteResponse());
      }, 30000);

      return res.json({ ...buildVoteResponse(), newVolume: newVol });
    } catch(e) {
      console.error("Volume error:", e.message);
    }
  }

  res.json(buildVoteResponse());
});

/* ---------------- STATUS ---------------- */

app.get("/votes", (req, res) => res.json(buildVoteResponse()));
app.get("/last-skip", (req, res) => res.json(lastSkipInfo));

app.get("/weather", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.open-meteo.com/v1/forecast?latitude=56.95&longitude=24.1&current_weather=true&hourly=precipitation_probability&daily=temperature_2m_max&timezone=auto"
    );
    const w = response.data;
    const forecast = w.daily.time.slice(1, 4).map((d, i) => ({ date: d, temp: w.daily.temperature_2m_max[i + 1] }));
    res.json({ city: "Riga, Latvia", temp: w.current_weather.temperature, wind: w.current_weather.windspeed, rain: w.hourly.precipitation_probability[0] || 0, forecast });
  } catch {
    res.json({ city: "Weather error", temp: "?", wind: "?", forecast: [] });
  }
});

app.get("/currency", async (req, res) => {
  try {
    const response = await axios.get("https://open.er-api.com/v6/latest/EUR");
    const r = response.data.rates;
    res.json({ GBP: r.GBP.toFixed(3), PLN: r.PLN.toFixed(3), USD: r.USD.toFixed(3), NOK: r.NOK.toFixed(3), SEK: r.SEK.toFixed(3), DKK: r.DKK.toFixed(3) });
  } catch {
    res.json({ GBP: null, PLN: null, USD: null, NOK: null, SEK: null, DKK: null });
  }
});

/* ---------------- ADMIN ---------------- */

app.post("/admin-auth", (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) return res.json({ success: true });
  res.status(403).json({ success: false });
});

app.post("/set-total", async (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false });
  const newTotal = parseInt(req.body.total);
  if (!isNaN(newTotal) && newTotal > 0) {
    totalPeople = newTotal;
    votes.clear();
    io.emit("voteUpdate", buildVoteResponse());
    await saveSettings();
  }
  res.json({ success: true });
});

app.post("/toggle-voting", async (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false });
  votingEnabled = !votingEnabled;
  io.emit("voteUpdate", buildVoteResponse());
  await saveSettings();
  res.json({ success: true });
});

app.post("/toggle-sound", async (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false });
  soundEnabled = !soundEnabled;
  io.emit("voteUpdate", buildVoteResponse());
  await saveSettings();
  res.json({ success: true });
});

app.post("/ban-user", (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false });
  const { name } = req.body;
  bannedNames.add(name);
  votes.forEach((value, key) => { if (value === name) votes.delete(key); });
  io.emit("voteUpdate", buildVoteResponse(`${name} banned`));
  res.json({ success: true });
});

app.post("/reset-user", (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false });
  const { userId } = req.body;
  const name = connectedUsers.get(userId) || "User";
  connectedUsers.delete(userId);
  votes.delete(userId);
  coinBoosts.delete(userId);

  // push force_rename to the target user's socket
  for (const [, socket] of io.of("/").sockets) {
    if (socket.userId === userId) {
      socket.emit("force_rename");
      break;
    }
  }

  io.emit("voteUpdate", buildVoteResponse(`${name} has been reset`));
  res.json({ success: true });
});

app.post("/rename-user", async (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false });
  const { userId, newName } = req.body;
  if (!userId || !newName || !newName.trim()) return res.status(400).json({ success: false });

  const trimmed = newName.trim();

  // update in connected users if online
  if (connectedUsers.has(userId)) {
    connectedUsers.set(userId, trimmed);
    // update their vote entry too if they've voted
    if (votes.has(userId)) votes.set(userId, trimmed);
  }

  // update in Supabase coins table
  await supabase.from("coins").update({ user_name: trimmed }).eq("user_id", userId);

  // push the new name to their browser so it updates live
  for (const [, socket] of io.of("/").sockets) {
    if (socket.userId === userId) {
      socket.emit("name_updated", { newName: trimmed });
      break;
    }
  }

  io.emit("voteUpdate", buildVoteResponse());
  res.json({ success: true });
});

/* ---------------- MINESWEEPER ---------------- */

app.get("/minesweeper-scores", async (req, res) => {
  const difficulty = req.query.difficulty || "expert";
  const { data } = await supabase
    .from("minesweeper_scores")
    .select("name, time, date, difficulty")
    .eq("difficulty", difficulty)
    .order("time", { ascending: true })
    .limit(20);
  res.json(data || []);
});

app.post("/minesweeper-score", async (req, res) => {
  const { name, time, difficulty } = req.body;
  if (!name || !time) return res.status(400).json({ success: false });
  await supabase.from("minesweeper_scores").insert({
    name,
    time,
    difficulty: difficulty || "expert",
    date: new Date().toLocaleDateString()
  });
  res.json({ success: true });
});

app.get("/all-users", async (req, res) => {
  if (req.query.password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json([]);
  }
  const { data } = await supabase
    .from("coins")
    .select("user_id, user_name, balance")
    .order("user_name");
  res.json(data || []);
});

app.post("/admin-give-coins", async (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ success: false });
  }
  const { userId, userName, amount } = req.body;
  if (!userId || amount === undefined || amount === null) return res.status(400).json({ success: false });

  const balance = await checkAndResetCoins(userId, userName);
  const newBalance = Math.max(0, balance + parseInt(amount));
  await supabase.from("coins").update({ balance: newBalance }).eq("user_id", userId);

  // push update directly to the user's socket if they're online
  for (const [, socket] of io.of("/").sockets) {
    if (socket.userId === userId) {
      socket.emit("coinUpdate", { balance: newBalance });
      break;
    }
  }

  res.json({ success: true, newBalance });
});

/* ---------------- BLACKJACK COINS ---------------- */

app.post("/blackjack-result", async (req, res) => {
  const { userId, userName, delta } = req.body; // delta: positive = win, negative = loss
  const balance = await checkAndResetCoins(userId, userName);
  const newBalance = Math.max(0, balance + delta);
  await supabase.from("coins").update({ balance: newBalance }).eq("user_id", userId);
  res.json({ success: true, newBalance });
});

/* ---------------- DEVICE BAN ---------------- */

app.post("/ban-device", async (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false });
  const { userId, userName } = req.body;
  if (!userId) return res.status(400).json({ success: false });

  bannedDevices.add(userId);

  // kick them off if currently connected
  for (const [id, socket] of io.of("/").sockets) {
    if (socket.userId === userId) {
      socket.emit("device_banned");
      socket.disconnect(true);
    }
  }

  // remove from connected users and votes
  connectedUsers.delete(userId);
  votes.delete(userId);
  coinBoosts.delete(userId);
  io.emit("voteUpdate", buildVoteResponse());

  await supabase.from("banned_devices").upsert({ user_id: userId, user_name: userName, banned_at: new Date().toISOString() });

  res.json({ success: true });
});

app.post("/unban-device", async (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false });
  const { userId } = req.body;
  bannedDevices.delete(userId);
  await supabase.from("banned_devices").delete().eq("user_id", userId);
  res.json({ success: true });
});

app.get("/banned-devices", async (req, res) => {
  if (req.query.password !== process.env.ADMIN_PASSWORD) return res.status(403).json([]);
  const { data } = await supabase.from("banned_devices").select("*").order("banned_at", { ascending: false });
  res.json(data || []);
});

/* ---------------- POKER ---------------- */

const PK_SB = 1, PK_BB = 2;

let pk = {
  seated: [],
  deck: [],
  community: [],
  pot: 0,
  currentBet: 0,
  phase: 'waiting',
  activeIdx: 0,
  dealerIdx: -1,
  acted: new Set(),
  log: []
};

function pkLog(msg) { pk.log.unshift(msg); if (pk.log.length > 20) pk.log.pop(); }

function pkDeck() {
  const d = [];
  for (const s of ['s','h','d','c']) for (let r = 2; r <= 14; r++) d.push({r, s});
  for (let i = d.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}

function pkCardStr(c) {
  return ({11:'J',12:'Q',13:'K',14:'A'}[c.r]||c.r)+({s:'♠',h:'♥',d:'♦',c:'♣'}[c.s]);
}

function pkHandName(t) {
  return ['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'][t+1]||'?';
}

function pkEval5(cards) {
  const rs = cards.map(c=>c.r).sort((a,b)=>b-a);
  const ss = cards.map(c=>c.s);
  const rc = {}; rs.forEach(r => rc[r]=(rc[r]||0)+1);
  const grps = Object.entries(rc).sort(([r1,c1],[r2,c2])=>c2-c1||r2-r1);
  const cnts = grps.map(([,c])=>c);
  const tb = grps.map(([r])=>+r);
  const flush = ss.every(s=>s===ss[0]);
  const uniq = [...new Set(rs)];
  const str = uniq.length===5 && rs[0]-rs[4]===4;
  const aceLow = uniq.length===5 && JSON.stringify(rs)==='[14,5,4,3,2]';
  if (flush&&str&&rs[0]===14) return {t:8,tb};
  if (flush&&(str||aceLow)) return {t:7,tb:aceLow?[5,4,3,2,1]:tb};
  if (cnts[0]===4) return {t:6,tb};
  if (cnts[0]===3&&cnts[1]===2) return {t:5,tb};
  if (flush) return {t:4,tb};
  if (str) return {t:3,tb};
  if (aceLow) return {t:3,tb:[5,4,3,2,1]};
  if (cnts[0]===3) return {t:2,tb};
  if (cnts[0]===2&&cnts[1]===2) return {t:1,tb};
  if (cnts[0]===2) return {t:0,tb};
  return {t:-1,tb};
}

function pkBest(cards) {
  if (cards.length===5) return pkEval5(cards);
  let best=null;
  function pick(start,cur){
    if(cur.length===5){const r=pkEval5(cur);if(!best||pkCmp(r,best)>0)best={...r,cards:[...cur]};return;}
    for(let i=start;i<cards.length;i++) if(cards.length-i>=5-cur.length) pick(i+1,[...cur,cards[i]]);
  }
  pick(0,[]);
  return best;
}

function pkCmp(a,b) {
  if (a.t!==b.t) return a.t-b.t;
  for(let i=0;i<Math.max(a.tb.length,b.tb.length);i++){const d=(a.tb[i]||0)-(b.tb[i]||0);if(d!==0)return d;}
  return 0;
}

function pkBroadcast() {
  const base = {
    phase:pk.phase, community:pk.community, pot:pk.pot,
    currentBet:pk.currentBet, activeIdx:pk.activeIdx, log:pk.log,
    seated:pk.seated.map(p=>({
      userId:p.userId,userName:p.userName,chips:p.chips,
      bet:p.bet,folded:p.folded,allIn:p.allIn,
      isDealer:p.isDealer,isSB:p.isSB,isBB:p.isBB
    }))
  };
  for(const[,sock] of io.of('/').sockets){
    const me=pk.seated.find(p=>p.userId===sock.userId);
    sock.emit('poker:state',{...base, myHand:me?me.hand:[], myUserId:sock.userId});
  }
}

function pkNotFolded(){ return pk.seated.filter(p=>!p.folded); }
function pkCanAct(){ return pk.seated.filter(p=>!p.folded&&!p.allIn); }

function pkNextActive(from){
  const n=pk.seated.length; let idx=(from+1)%n,tries=0;
  while((pk.seated[idx].folded||pk.seated[idx].allIn)&&tries<n){idx=(idx+1)%n;tries++;}
  return idx;
}

async function pkEndHand(winners){
  pk.phase='showdown';
  const share=Math.floor(pk.pot/winners.length);
  const rem=pk.pot%winners.length;
  winners.forEach((w,i)=>{w.chips+=share+(i===0?rem:0);});
  pkLog('🏆 '+winners.map(w=>w.userName+' (🪙'+w.chips+')').join(' & ')+' win '+pk.pot+' chips!');
  pkBroadcast();
  for(const p of pk.seated){
    try{await supabase.from('coins').update({balance:p.chips}).eq('user_id',p.userId);}catch(e){}
  }
  setTimeout(()=>{
    pk.seated=pk.seated.filter(p=>p.chips>0);
    pk.seated.forEach(p=>{p.hand=[];p.bet=0;p.folded=false;p.allIn=false;p.isDealer=false;p.isSB=false;p.isBB=false;});
    pk.community=[];pk.pot=0;pk.currentBet=0;pk.phase='waiting';pk.acted=new Set();
    pkBroadcast();
  }, 6000);
}

async function pkNextPhase(){
  const nf=pkNotFolded();
  if(nf.length<=1){await pkEndHand(nf);return;}

  pk.seated.forEach(p=>p.bet=0);
  pk.currentBet=0; pk.acted=new Set();

  if(pk.phase==='preflop'){
    pk.phase='flop';
    pk.community=[pk.deck.pop(),pk.deck.pop(),pk.deck.pop()];
    pkLog('🃏 Flop: '+pk.community.map(pkCardStr).join(' '));
  } else if(pk.phase==='flop'){
    pk.phase='turn'; pk.community.push(pk.deck.pop());
    pkLog('🃏 Turn: '+pkCardStr(pk.community[3]));
  } else if(pk.phase==='turn'){
    pk.phase='river'; pk.community.push(pk.deck.pop());
    pkLog('🃏 River: '+pkCardStr(pk.community[4]));
  } else if(pk.phase==='river'){
    const contenders=pkNotFolded();
    let best=null,winners=[];
    for(const p of contenders){
      const h=pkBest([...p.hand,...pk.community]);
      if(!best||pkCmp(h,best)>0){best=h;winners=[p];}
      else if(pkCmp(h,best)===0)winners.push(p);
    }
    pkLog('Showdown! '+contenders.map(p=>{
      const h=pkBest([...p.hand,...pk.community]);
      return p.userName+': '+pkHandName(h.t)+' ['+p.hand.map(pkCardStr).join(' ')+']';
    }).join(' | '));
    await pkEndHand(winners); return;
  }

  pkBroadcast();

  // KEY FIX: if nobody can act (all all-in or folded), auto-advance after delay
  if(pkCanAct().length === 0){
    setTimeout(()=>pkNextPhase(), 2500);
    return;
  }

  // find first active player after dealer
  let si=(pk.dealerIdx+1)%pk.seated.length,t=0;
  while((pk.seated[si].folded||pk.seated[si].allIn)&&t<pk.seated.length){si=(si+1)%pk.seated.length;t++;}
  pk.activeIdx=si;
  pkBroadcast();
}

async function pkDoAction(userId,action,amount){
  const pi=pk.seated.findIndex(p=>p.userId===userId);
  if(pi<0||pk.seated[pk.activeIdx].userId!==userId)return;
  if(pk.phase==='waiting'||pk.phase==='showdown')return;
  const p=pk.seated[pi];
  if(p.folded||p.allIn)return;
  if(action==='fold'){
    p.folded=true; pk.acted.add(userId); pkLog(p.userName+' folds');
  } else if(action==='check'){
    if(pk.currentBet>p.bet)return;
    pk.acted.add(userId); pkLog(p.userName+' checks');
  } else if(action==='call'){
    const need=Math.min(pk.currentBet-p.bet,p.chips);
    if(need<=0){pk.acted.add(userId);pkLog(p.userName+' checks');}
    else{p.chips-=need;p.bet+=need;pk.pot+=need;if(p.chips===0)p.allIn=true;pk.acted.add(userId);pkLog(p.userName+' calls '+need);}
  } else if(action==='raise'){
    const total=parseInt(amount)||0;
    if(total<=pk.currentBet)return;
    const toAdd=Math.min(total-p.bet,p.chips);
    p.chips-=toAdd;p.bet+=toAdd;pk.pot+=toAdd;pk.currentBet=p.bet;
    if(p.chips===0)p.allIn=true;
    pk.acted=new Set([userId]);
    pkLog(p.userName+' raises to '+p.bet);
  } else if(action==='allin'){
    const toAdd=p.chips; p.chips=0; p.bet+=toAdd; pk.pot+=toAdd;
    if(p.bet>pk.currentBet){pk.currentBet=p.bet;pk.acted=new Set([userId]);}
    else pk.acted.add(userId);
    p.allIn=true; pkLog(p.userName+' goes ALL IN ('+toAdd+')');
  }
  const nf=pkNotFolded(); if(nf.length<=1){await pkNextPhase();return;}
  const ca=pkCanAct(); if(ca.length===0){await pkNextPhase();return;}
  if(ca.every(x=>pk.acted.has(x.userId))&&ca.every(x=>x.bet===pk.currentBet)){await pkNextPhase();return;}
  pk.activeIdx=pkNextActive(pi);
  pkBroadcast();
}

io.on('connection', socket => {
  socket.on('poker:join', async()=>{
    if(pk.seated.find(p=>p.userId===socket.userId))return;
    if(pk.phase!=='waiting'){socket.emit('poker:error','Hand in progress — join after this hand');return;}
    if(pk.seated.length>=6){socket.emit('poker:error','Table is full (max 6)');return;}
    const name=connectedUsers.get(socket.userId)||'Player';
    const bal=await checkAndResetCoins(socket.userId,name);
    if(bal<PK_BB){socket.emit('poker:error','Need at least '+PK_BB+' coins to join');return;}
    await supabase.from('coins').update({balance:0}).eq('user_id',socket.userId);
    pk.seated.push({userId:socket.userId,userName:name,chips:bal,hand:[],bet:0,folded:false,allIn:false,isDealer:false,isSB:false,isBB:false});
    pkLog(name+' joined with 🪙'+bal);
    pkBroadcast();
  });
  socket.on('poker:leave', async()=>{
    const idx=pk.seated.findIndex(p=>p.userId===socket.userId);
    if(idx<0)return;
    const chips=pk.seated[idx].chips,name=pk.seated[idx].userName;
    if(pk.phase!=='waiting'&&pk.phase!=='showdown')pk.seated[idx].folded=true;
    pk.seated.splice(idx,1);
    await supabase.from('coins').update({balance:chips}).eq('user_id',socket.userId);
    pkLog(name+' left (cashed out 🪙'+chips+')');
    pkBroadcast();
  });
  socket.on('poker:start',()=>{
    if(pk.phase!=='waiting'||pk.seated.length<2)return;
    pk.deck=pkDeck();pk.community=[];pk.pot=0;pk.currentBet=0;pk.acted=new Set();
    pk.dealerIdx=(pk.dealerIdx+1)%pk.seated.length;
    pk.seated.forEach(p=>{p.hand=[];p.bet=0;p.folded=false;p.allIn=false;p.isDealer=false;p.isSB=false;p.isBB=false;});
    const n=pk.seated.length,di=pk.dealerIdx%n,sbi=(di+1)%n,bbi=(di+2)%n;
    pk.seated[di].isDealer=true;
    const sbp=pk.seated[sbi],bbp=pk.seated[bbi];
    sbp.isSB=true;bbp.isBB=true;
    const sbA=Math.min(PK_SB,sbp.chips);sbp.chips-=sbA;sbp.bet=sbA;pk.pot+=sbA;if(sbp.chips===0)sbp.allIn=true;
    const bbA=Math.min(PK_BB,bbp.chips);bbp.chips-=bbA;bbp.bet=bbA;pk.pot+=bbA;if(bbp.chips===0)bbp.allIn=true;
    pk.currentBet=bbA;
    pk.seated.forEach(p=>{p.hand=[pk.deck.pop(),pk.deck.pop()];});
    let ai=(bbi+1)%n,t=0;
    while((pk.seated[ai].folded||pk.seated[ai].allIn)&&t<n){ai=(ai+1)%n;t++;}
    pk.activeIdx=ai;pk.phase='preflop';
    pkLog('--- New Hand ---');
    pkLog('Dealer: '+pk.seated[di].userName+' | SB: '+sbp.userName+' ('+sbA+') | BB: '+bbp.userName+' ('+bbA+')');
    pkBroadcast();
  });
  socket.on('poker:act',({action,amount})=>pkDoAction(socket.userId,action,amount));
});

/* ---------------- START SERVER ---------------- */

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
