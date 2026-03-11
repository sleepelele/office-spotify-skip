const express = require("express");
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* ---------------- AIS STREAM SERVER ---------------- */

const wss = new WebSocket.Server({ server, path: "/ais" });

const aisStream = new WebSocket("wss://stream.aisstream.io/v0/stream");

aisStream.on("open", () => {

 aisStream.send(JSON.stringify({
  APIKey: process.env.AISSTREAM_KEY,
  BoundingBoxes: [[[-90,-180],[90,180]]]
 }));

});

aisStream.on("message", (data) => {

 try{

 const msg = JSON.parse(data);

 if(!msg.Message || !msg.Message.PositionReport) return;

 const ship = msg.Message.PositionReport;

 const vessel = {
  mmsi: ship.UserID,
  lat: ship.Latitude,
  lon: ship.Longitude,
  speed: ship.Sog,
  course: ship.Cog
 };

 wss.clients.forEach(client=>{
  if(client.readyState === WebSocket.OPEN){
   client.send(JSON.stringify(vessel));
  }
 });

 }catch{}

});

/* ---------------- EXPRESS ---------------- */

app.use(express.json());
app.use(express.static("public"));

let votes = new Map();
let bannedNames = new Set();
let connectedUsers = new Map();
let cooldown = false;
let votingEnabled = true;
let soundEnabled = true;
let totalPeople = parseInt(process.env.TOTAL_PEOPLE) || 5;
let lastSongId = null;
let lastSkipInfo = null;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

/* ---------------- SOCKET CONNECTION ---------------- */

io.on("connection", (socket) => {

 socket.on("registerUser", (name) => {

socket.userId = null;

socket.on("registerUser", ({userId,name}) => {

 socket.userId = userId;

 connectedUsers.set(userId,name);

 io.emit("voteUpdate", buildVoteResponse());

});

  io.emit("voteUpdate", buildVoteResponse());

 });

 socket.on("disconnect", () => {

if(socket.userId){
 connectedUsers.delete(socket.userId);
}

  io.emit("voteUpdate", buildVoteResponse());

 });

});

/* ---------------- UTIL ---------------- */

function majority() {
 return Math.floor(totalPeople / 2) + 1;
}

function buildVoteResponse(message = "") {
 return {
  count: votes.size,
  needed: majority(),
  voters: Array.from(votes.values()),
  users: Array.from(connectedUsers.values()),
  cooldown,
  votingEnabled,
  soundEnabled,
  message
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
    Authorization:
     "Basic " +
     Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64")
   }
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

/* ---------------- VOTE ---------------- */

app.post("/vote", async (req, res) => {

 if (!votingEnabled) {
  return res.json(buildVoteResponse("Voting disabled"));
 }

 const { userId, name } = req.body;
 connectedUsers.set(userId, name);

 if (bannedNames.has(name)) {
  return res.json(buildVoteResponse(`User ${name} is banned`));
 }

 if (cooldown) {
  return res.json(buildVoteResponse("Cooldown active"));
 }

 votes.set(userId, name);

 io.emit("voteUpdate", buildVoteResponse());

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

  io.emit("voteUpdate", buildVoteResponse("Song skipped"));

  setTimeout(() => {
   cooldown = false;
   io.emit("voteUpdate", buildVoteResponse());
  }, 60000);

  return res.json(buildVoteResponse("Song skipped"));
 }

 res.json(buildVoteResponse("Vote registered"));

});

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

  const songId = response.data.item.id;

  if (lastSongId && lastSongId !== songId) {
   votes.clear();
   cooldown = false;
   io.emit("voteUpdate", buildVoteResponse());
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

/* ---------------- STATUS ---------------- */

app.get("/votes", (req, res) => {
 res.json(buildVoteResponse());
});

app.get("/last-skip", (req, res) => {
 res.json(lastSkipInfo);
});

app.get("/weather", async (req,res)=>{

 try{

 const response=await axios.get(
"https://api.open-meteo.com/v1/forecast?latitude=56.95&longitude=24.1&current_weather=true&hourly=precipitation_probability&daily=temperature_2m_max&timezone=auto"
);

 const w=response.data;

 const forecast = w.daily.time.slice(1,4).map((d,i)=>({
 date:d,
 temp:w.daily.temperature_2m_max[i+1]
}));

 res.json({
 city:"Riga, Latvia",
 temp:w.current_weather.temperature,
 wind:w.current_weather.windspeed,
 rain:w.hourly.precipitation_probability[0] || 0,
 forecast
});

 }catch{

 res.json({city:"Weather error",temp:"?",wind:"?",forecast:[]});

 }

});

app.get("/currency", async (req,res)=>{

 try{

 const response=await axios.get(
 "https://open.er-api.com/v6/latest/EUR"
 );

 const r=response.data.rates;

 res.json({
  GBP:(1/r.GBP).toFixed(3),
  PLN:(1/r.PLN).toFixed(3),
  USD:(1/r.USD).toFixed(3),
  NOK:(1/r.NOK).toFixed(3),
  SEK:(1/r.SEK).toFixed(3),
  DKK:(1/r.DKK).toFixed(3)
 });

 }catch{

 res.json({
  GBP:null,
  PLN:null,
  USD:null,
  NOK:null,
  SEK:null,
  DKK:null
 });

 }

});

/* ---------------- ADMIN ---------------- */

app.post("/admin-auth", (req, res) => {

 if (req.body.password === process.env.ADMIN_PASSWORD) {
  return res.json({ success: true });
 }

 res.status(403).json({ success: false });

});

/* ---------------- START SERVER ---------------- */

server.listen(process.env.PORT || 3000, () => {
 console.log("Server running");
});
