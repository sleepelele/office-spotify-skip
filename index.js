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

  if (data.last_reset !== today) {
    // new day — reset to 5
    await supabase.from("coins").update({
      balance: 5,
      last_reset: today,
      user_name: userName
    }).eq("user_id", userId);
    return 5;
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
        ? Math.min(100, current + 10)
        : Math.max(0, current - 10);

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
  if (!userId || !amount || amount < 1) return res.status(400).json({ success: false });

  const balance = await checkAndResetCoins(userId, userName);
  const newBalance = balance + parseInt(amount);
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

/* ---------------- START SERVER ---------------- */

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
