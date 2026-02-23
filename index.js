console.log("CLIENT_ID:", process.env.CLIENT_ID);
const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());
app.use(express.static("public"));

let votes = new Set();
let cooldown = false;

const TOTAL_PEOPLE = process.env.TOTAL_PEOPLE || 5;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

function majority() {
  return Math.floor(TOTAL_PEOPLE / 2) + 1;
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
  const user = req.body.user;

  if (cooldown) return res.json({ message: "Cooldown active." });

  votes.add(user);

  if (votes.size >= majority()) {
    await skipTrack();
    votes.clear();
    cooldown = true;
    setTimeout(() => (cooldown = false), 180000);
    return res.json({ message: "Song skipped!" });
  }

  res.json({ message: `Votes: ${votes.size}/${majority()}` });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server started")

);
const querystring = require("querystring");

app.get("/login", (req, res) => {
  const scope = "user-modify-playback-state user-read-playback-state";
  const redirect_uri = "https://office-spotify-skip-production.up.railway.app/callback";

  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    querystring.stringify({
      response_type: "code",
      client_id: process.env.CLIENT_ID,
      scope: scope,
      redirect_uri: redirect_uri,
    });

  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;

  const response = await axios.post(
    "https://accounts.spotify.com/api/token",
    querystring.stringify({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: "https://office-spotify-skip-production.up.railway.app/callback",
    }),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  res.send("Your Refresh Token is: " + response.data.refresh_token);
});


