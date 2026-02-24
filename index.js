console.log("CLIENT_ID:", process.env.CLIENT_ID);
const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());
app.use(express.static("public"));

let votes = new Map();
let cooldown = false;
let votingEnabled = true;
let totalPeople = process.env.TOTAL_PEOPLE || 5;
let lastSongId = null;
let lastSkipInfo = null;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

/* ================= UTIL ================= */

function majority() {
  return Math.floor(totalPeople / 2) + 1;
}

function buildVoteResponse(message = "") {
  return {
    count: votes.size,
    needed: majority(),
    voters: Array.from(votes.values()),
    cooldown,
    votingEnabled,
    message
  };
}

async function getAccessToken() {
  const response = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    }),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
      },
    }
  );
  return response.data.access_token;
}

async function skipTrack() {
  const token = await getAccessToken();
  await axios.post(
    "https://api.spotify.com/v1/me/player/next",
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

/* ================= VOTE ================= */

app.post("/vote", async (req, res) => {

  if (!votingEnabled) {
    return res.json(buildVoteResponse("Voting disabled"));
  }

  const { userId, name } = req.body;

  if (cooldown) {
    return res.json(buildVoteResponse("Cooldown active"));
  }

  votes.set(userId, name);

  if (votes.size >= majority()) {

    const token = await getAccessToken();
    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    let songName = "Unknown";
    if (response.data?.item) {
      songName =
        response.data.item.name +
        " - " +
        response.data.item.artists.map(a => a.name).join(", ");
    }

    lastSkipInfo = {
      song: songName,
      skippedBy: Array.from(votes.values()),
      time: new Date().toLocaleTimeString()
    };

    await skipTrack();
    votes.clear();
    cooldown = true;
    setTimeout(() => (cooldown = false), 60000);

    return res.json(buildVoteResponse("Song skipped!"));
  }

  res.json(buildVoteResponse("Vote registered"));
});

/* ================= SONG ================= */

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

    const songId = response.data.item.id;

    if (lastSongId && lastSongId !== songId) {
      votes.clear();
      cooldown = false;
    }

    lastSongId = songId;

    const song = response.data.item.name;
    const artist = response.data.item.artists.map(a => a.name).join(", ");
    const albumImage = response.data.item.album.images[0]?.url || null;

    res.json({
      title: `${song} - ${artist}`,
      image: albumImage
    });

  } catch {
    res.json({ title: "Error getting song", image: null });
  }
});

/* ================= STATUS ================= */

app.get("/votes", (req, res) => {
  res.json(buildVoteResponse());
});

app.get("/last-skip", (req, res) => {
  res.json(lastSkipInfo);
});

/* ================= ADMIN ================= */

app.post("/admin-auth", (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(403).json({ success: false });
});

app.post("/set-total", (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ success: false });
  }

  const newTotal = parseInt(req.body.total);
  if (!isNaN(newTotal) && newTotal > 0) {
    totalPeople = newTotal;
    votes.clear();
    return res.json({ success: true });
  }

  res.json({ success: false });
});

app.post("/toggle-voting", (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ success: false });
  }

  votingEnabled = !votingEnabled;
  res.json({ success: true, votingEnabled });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server started")
);


