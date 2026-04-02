const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { AmbientNoiseGenerator } = require("./ambient");

// ─── Config ────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "agent_1101kn04e4bqep7t71p8hek4gfbx";
const AMBIENT_VOLUME = parseFloat(process.env.AMBIENT_VOLUME || "0.15"); // 0.0 to 1.0
// Request µ-law 8kHz output to match Twilio's audio format
const ELEVENLABS_WS_URL = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}&output_format=ulaw_8000`;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ─── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "OMEGA Ambient Noise Proxy",
    ambientVolume: AMBIENT_VOLUME
  });
});

// ─── TwiML endpoint for outbound calls ─────────────────────────
app.post("/twiml", (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
  const streamUrl = `${protocol}://${host}/stream`;

  console.log(`[TwiML] Generating stream URL: ${streamUrl}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="callerNumber" value="${req.body.From || ''}" />
      <Parameter name="calledNumber" value="${req.body.To || ''}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ─── TwiML endpoint for inbound calls ──────────────────────────
app.post("/twiml-inbound", (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
  const streamUrl = `${protocol}://${host}/stream`;

  console.log(`[TwiML-Inbound] Generating stream URL: ${streamUrl}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="callerNumber" value="${req.body.From || ''}" />
      <Parameter name="calledNumber" value="${req.body.To || ''}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ─── WebSocket upgrade handler ─────────────────────────────────
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

// ─── Main WebSocket connection handler ─────────────────────────
wss.on("connection", (twilioWs) => {
  console.log("[Proxy] Twilio WebSocket connected");

  let streamSid = null;
  let elevenLabsWs = null;
  const ambientNoise = new AmbientNoiseGenerator(AMBIENT_VOLUME);
  let outboundChunkCounter = 0;
  let silenceInterval = null;

  // Connect to ElevenLabs
  function connectToElevenLabs() {
    console.log("[Proxy] Connecting to ElevenLabs...");

    elevenLabsWs = new WebSocket(ELEVENLABS_WS_URL);

    elevenLabsWs.on("open", () => {
      console.log("[Proxy] ElevenLabs WebSocket connected");
    });

    elevenLabsWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // ElevenLabs Conversational AI sends audio as:
        // {"type": "audio", "audio_event": {"audio_base_64": "...", "event_id": ...}}
        if (msg.type === "audio" && msg.audio_event && msg.audio_event.audio_base_64) {
          const audioBuffer = Buffer.from(msg.audio_event.audio_base_64, "base64");
          const mixedAudio = ambientNoise.mixWithMulaw(audioBuffer);

          const mediaMessage = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: mixedAudio.toString("base64"),
            },
          };

          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify(mediaMessage));
          }
        } else if (msg.type === "conversation_initiation_metadata") {
          console.log("[ElevenLabs] Conversation initiated");
          // Start sending ambient noise during silence
          startSilenceFill();
        } else if (msg.type === "agent_response") {
          console.log(`[ElevenLabs] Agent response: ${msg.agent_response_event?.agent_response?.substring(0, 80) || 'unknown'}`);
        } else if (msg.type === "user_transcript") {
          console.log(`[ElevenLabs] User said: ${msg.user_transcription_event?.user_transcript?.substring(0, 80) || 'unknown'}`);
        } else if (msg.type === "interruption") {
          console.log("[ElevenLabs] Interruption detected");
        } else if (msg.type === "ping") {
          // Respond to pings to keep connection alive
          if (elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: msg.event_id }));
          }
        } else {
          console.log(`[ElevenLabs] Event: ${msg.type || 'unknown'}`);
        }
      } catch (e) {
        console.error("[Proxy] Error processing ElevenLabs message:", e.message);
      }
    });

    elevenLabsWs.on("close", (code, reason) => {
      console.log(`[ElevenLabs] WebSocket closed: ${code} ${reason}`);
      stopSilenceFill();
    });

    elevenLabsWs.on("error", (err) => {
      console.error("[ElevenLabs] WebSocket error:", err.message);
    });
  }

  // Send ambient noise during silence (when agent is listening)
  function startSilenceFill() {
    if (silenceInterval) return;
    silenceInterval = setInterval(() => {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;

      // Generate 20ms of ambient noise to fill silence
      const ambientChunk = ambientNoise.generateChunk(20);
      const mediaMessage = {
        event: "media",
        streamSid: streamSid,
        media: {
          payload: ambientChunk.toString("base64"),
        },
      };
      twilioWs.send(JSON.stringify(mediaMessage));
    }, 20);
  }

  function stopSilenceFill() {
    if (silenceInterval) {
      clearInterval(silenceInterval);
      silenceInterval = null;
    }
  }

  // Handle messages from Twilio
  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.event) {
        case "connected":
          console.log("[Twilio] Stream connected");
          break;

        case "start":
          streamSid = msg.start.streamSid;
          console.log(`[Twilio] Stream started - SID: ${streamSid}`);

          // Start ambient noise generation
          ambientNoise.start();

          // Connect to ElevenLabs when stream starts
          connectToElevenLabs();
          break;

        case "media":
          // Forward caller audio to ElevenLabs
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            const audioPayload = msg.media.payload;
            elevenLabsWs.send(JSON.stringify({
              user_audio_chunk: audioPayload
            }));
          }
          break;

        case "stop":
          console.log("[Twilio] Stream stopped");
          ambientNoise.stop();
          stopSilenceFill();
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error("[Proxy] Error processing Twilio message:", err.message);
    }
  });

  twilioWs.on("close", () => {
    console.log("[Proxy] Twilio WebSocket closed");
    ambientNoise.stop();
    stopSilenceFill();
    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
      elevenLabsWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("[Proxy] Twilio WebSocket error:", err.message);
  });
});

// ─── Start server ──────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🏢 OMEGA Ambient Noise Proxy`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Agent: ${ELEVENLABS_AGENT_ID}`);
  console.log(`   Ambient Volume: ${AMBIENT_VOLUME * 100}%`);
  console.log(`   ElevenLabs URL: ${ELEVENLABS_WS_URL}`);
  console.log(`   Ready for connections\n`);
});
