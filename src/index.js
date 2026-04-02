/**
 * OMEGA Ambient Noise Proxy
 *
 * WebSocket proxy that sits between Twilio and ElevenLabs,
 * mixing ambient office noise into the audio stream
 * so Amy sounds like she's calling from a real office.
 *
 * Architecture:
 *   Caller <-- Twilio <-- [This Proxy + Ambient Noise] <-- ElevenLabs
 *
 * Key features:
 *   - Mixes ambient office noise into Amy's speech
 *   - Sends ambient noise during silence (when Amy is listening)
 *   - Handles ElevenLabs Conversational AI WebSocket protocol
 *   - Zero-config deployment on Fly.io
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { AmbientNoiseGenerator } = require("./ambient");

const PORT = process.env.PORT || 8080;
const ELEVENLABS_AGENT_ID =
  process.env.ELEVENLABS_AGENT_ID || "agent_1101kn04e4bqep7t71p8hek4gfbx";
const AMBIENT_VOLUME = parseFloat(process.env.AMBIENT_VOLUME || "0.15");
const ELEVENLABS_WS_URL = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`;

const SILENCE_FILL_INTERVAL_MS = 20;
const SAMPLES_PER_CHUNK = Math.floor((8000 * SILENCE_FILL_INTERVAL_MS) / 1000);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

let activeCalls = 0;

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "OMEGA Ambient Noise Proxy",
    ambientVolume: AMBIENT_VOLUME,
    activeCalls,
    uptime: Math.floor(process.uptime()),
  });
});

app.post("/twiml", (req, res) => {
  const host = req.headers.host;
  const streamUrl = `wss://${host}/stream`;
  console.log(`[TwiML] Generating stream URL: ${streamUrl}`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="${streamUrl}">\n      <Parameter name="callerNumber" value="${req.body.From || ""}" />\n      <Parameter name="calledNumber" value="${req.body.To || ""}" />\n    </Stream>\n  </Connect>\n</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/twiml-inbound", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Dial>+447405277823</Dial>\n</Response>`;
  res.type("text/xml").send(twiml);
});

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === "/stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  console.log("[Proxy] Twilio WebSocket connected");
  activeCalls++;

  let streamSid = null;
  let elevenLabsWs = null;
  const ambientNoise = new AmbientNoiseGenerator(AMBIENT_VOLUME);
  let silenceInterval = null;
  let lastAudioSentAt = 0;
  let isAgentSpeaking = false;

  function startSilenceFiller() {
    silenceInterval = setInterval(() => {
      if (isAgentSpeaking) return;
      if (!streamSid) return;
      if (twilioWs.readyState !== WebSocket.OPEN) return;
      const noiseChunk = ambientNoise.generateMulawBuffer(SAMPLES_PER_CHUNK);
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: streamSid,
        media: { payload: noiseChunk.toString("base64") },
      }));
    }, SILENCE_FILL_INTERVAL_MS);
  }

  function stopSilenceFiller() {
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
  }

  function connectToElevenLabs() {
    console.log("[Proxy] Connecting to ElevenLabs...");
    elevenLabsWs = new WebSocket(ELEVENLABS_WS_URL);

    elevenLabsWs.on("open", () => { console.log("[Proxy] ElevenLabs WebSocket connected"); });

    elevenLabsWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case "conversation_initiation_metadata":
            console.log("[ElevenLabs] Conversation initiated");
            break;
          case "audio":
            if (msg.audio_event && msg.audio_event.audio_base_64) {
              isAgentSpeaking = true;
              lastAudioSentAt = Date.now();
              const audioBuffer = Buffer.from(msg.audio_event.audio_base_64, "base64");
              const mixedAudio = ambientNoise.mixWithMulaw(audioBuffer);
              if (twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(JSON.stringify({
                  event: "media", streamSid: streamSid,
                  media: { payload: mixedAudio.toString("base64") },
                }));
              }
            }
            break;
          case "agent_response":
            console.log(`[ElevenLabs] Agent response: ${(msg.agent_response_event?.agent_response || "").substring(0, 80)}...`);
            break;
          case "user_transcript":
            console.log(`[ElevenLabs] User said: ${(msg.user_transcription_event?.user_transcript || "").substring(0, 80)}`);
            break;
          case "interruption":
            console.log("[ElevenLabs] User interrupted agent");
            isAgentSpeaking = false;
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({ event: "clear", streamSid: streamSid }));
            }
            break;
          case "ping":
            if (msg.ping_event && elevenLabsWs.readyState === WebSocket.OPEN) {
              elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
            }
            break;
          case "agent_response_correction": break;
          default: console.log(`[ElevenLabs] Event: ${msg.type}`);
        }
        if (isAgentSpeaking && msg.type !== "audio") {
          setTimeout(() => { if (Date.now() - lastAudioSentAt > 150) isAgentSpeaking = false; }, 200);
        }
      } catch (e) { console.error("[ElevenLabs] Parse error:", e.message); }
    });

    elevenLabsWs.on("close", (code, reason) => { console.log(`[ElevenLabs] WebSocket closed: ${code} ${reason}`); isAgentSpeaking = false; });
    elevenLabsWs.on("error", (err) => { console.error("[ElevenLabs] WebSocket error:", err.message); });
  }

  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());
      switch (msg.event) {
        case "connected": console.log("[Twilio] Stream connected"); break;
        case "start":
          streamSid = msg.start.streamSid;
          console.log(`[Twilio] Stream started - SID: ${streamSid}`);
          ambientNoise.start();
          startSilenceFiller();
          connectToElevenLabs();
          break;
        case "media":
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
          }
          break;
        case "stop": console.log("[Twilio] Stream stopped"); cleanup(); break;
        default: break;
      }
    } catch (err) { console.error("[Proxy] Error:", err.message); }
  });

  function cleanup() {
    stopSilenceFiller();
    ambientNoise.stop();
    isAgentSpeaking = false;
    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    activeCalls = Math.max(0, activeCalls - 1);
  }

  twilioWs.on("close", () => { console.log("[Proxy] Twilio WebSocket closed"); cleanup(); });
  twilioWs.on("error", (err) => { console.error("[Proxy] Twilio WebSocket error:", err.message); });
});

process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM received, shutting down...");
  server.close(() => { process.exit(0); });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  OMEGA Ambient Noise Proxy`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Agent: ${ELEVENLABS_AGENT_ID}`);
  console.log(`  Ambient Volume: ${AMBIENT_VOLUME * 100}%`);
  console.log(`  Ready for connections\n`);
});
