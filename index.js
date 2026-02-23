console.log("CLIENT_ID:", process.env.CLIENT_ID);
const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());
app.use(express.static("public"));

let votes = new Map();
let cooldown = false;

let totalPeople = process.env.TOTAL_PEOPLE || 5;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
let lastSongId = null;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

function majority() {
  return Math.floor(totalPeople / 2) + 1;
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
          Buffer.from(process.env.CLIENT_ID + ":" + process.env.CLIENT_SECRET).toString("base64"),
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
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
}

app.post("/vote", async (req, res) => {
  const userId = req.body.userId;
const name = req.body.name;

  if (cooldown) {
    return res.json({
      message: "Cooldown active.",
      voters: Array.from(votes.values())
    });
  }

votes.set(userId, name);

  if (votes.size >= majority()) {
    await skipTrack();
    votes.clear();
    cooldown = true;
    setTimeout(() => (cooldown = false), 60000); // 1 min cooldown
    return res.json({
      message: "Song skipped!",
      voters: []
    });
  }

  res.json({
    message: `Votes: ${votes.size}/${majority()}`,
    voters: Array.from(votes.values())
  });
});
app.get("/current-song", async (req, res) => {
  try {
    const token = await getAccessToken();

    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (!response.data || !response.data.item) {
      return res.json({ title: "Nothing playing" });
    }
const songId = response.data.item.id;
    if (lastSongId && lastSongId !== songId) {
  votes.clear();
  cooldown = false;
}

lastSongId = songId;
const song = response.data.item.name;
const artist = response.data.item.artists
  .map(a => a.name)
  .join(", ");

const albumImage = response.data.item.album.images[0]?.url || null;

res.json({
  title: `${song} - ${artist}`,
  image: albumImage
});

  } catch (err) {
    res.json({ title: "Error getting song" });
  }
});
app.get("/votes", (req, res) => {
  res.json({
    count: votes.size,
    needed: majority(),
    voters: Array.from(votes.values()),
    cooldown
  });
});
app.post("/set-total", (req, res) => {
  const newTotal = parseInt(req.body.total);

  if (!isNaN(newTotal) && newTotal > 0) {
    totalPeople = newTotal;
    votes.clear();
    return res.json({ success: true });
  }

  res.json({ success: false });
});
app.listen(process.env.PORT || 3000, () =>
  console.log("Server started")

);









