const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { AmbientNoiseGenerator, decodeMulaw, encodeMulaw } = require("./ambient");

// ─── Config ────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "agent_1101kn04e4bqep7t71p8hek4gfbx";
const AMBIENT_VOLUME = parseFloat(process.env.AMBIENT_VOLUME || "0.15");
// Base URL - format params added via conversation_initiation_client_data
const ELEVENLABS_WS_URL = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ─── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "OMEGA Ambient Noise Proxy", ambientVolume: AMBIENT_VOLUME });
});

// ─── TwiML endpoint ────────────────────────────────────────────
app.post("/twiml", (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
  const streamUrl = `${protocol}://${host}/stream`;
  console.log(`[TwiML] Stream URL: ${streamUrl}`);

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

app.post("/twiml-inbound", (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
  const streamUrl = `${protocol}://${host}/stream`;
  console.log(`[TwiML-Inbound] Stream URL: ${streamUrl}`);

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

// ─── WebSocket upgrade ─────────────────────────────────────────
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

// ─── Main WebSocket handler ────────────────────────────────────
wss.on("connection", (twilioWs) => {
  console.log("[Proxy] Twilio WebSocket connected");

  let streamSid = null;
  let elevenLabsWs = null;
  const ambientNoise = new AmbientNoiseGenerator(AMBIENT_VOLUME);
  let silenceInterval = null;

  function connectToElevenLabs() {
    console.log("[Proxy] Connecting to ElevenLabs...");
    elevenLabsWs = new WebSocket(ELEVENLABS_WS_URL);

    elevenLabsWs.on("open", () => {
      console.log("[Proxy] ElevenLabs WebSocket connected");

      // Tell ElevenLabs to use ulaw 8kHz for both input and output
      // This matches Twilio's native audio format - no conversion needed
      const initConfig = {
        type: "conversation_initiation_client_data",
        conversation_config_override: {
          agent: {
            prompt: { prompt: "" },
          },
          tts: {
            output_format: "ulaw_8000"
          }
        },
        custom_llm_extra_body: {},
      };
      elevenLabsWs.send(JSON.stringify(initConfig));
      console.log("[Proxy] Sent ulaw_8000 output format config to ElevenLabs");
    });

    elevenLabsWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "audio" && msg.audio_event && msg.audio_event.audio_base_64) {
          // ElevenLabs audio (ulaw) - mix with ambient noise and send to Twilio
          const audioBuffer = Buffer.from(msg.audio_event.audio_base_64, "base64");
          const mixedAudio = ambientNoise.mixWithMulaw(audioBuffer);

          if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: { payload: mixedAudio.toString("base64") }
            }));
          }
        } else if (msg.type === "conversation_initiation_metadata") {
          console.log("[ElevenLabs] Conversation initiated - agent ready to speak");
          startSilenceFill();
        } else if (msg.type === "agent_response") {
          const text = msg.agent_response_event?.agent_response || "";
          console.log("[ElevenLabs] Agent:", text.substring(0, 100));
        } else if (msg.type === "user_transcript") {
          const text = msg.user_transcription_event?.user_transcript || "";
          console.log("[ElevenLabs] User:", text.substring(0, 100));
        } else if (msg.type === "ping") {
          if (elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: msg.event_id }));
          }
        } else if (msg.type === "interruption") {
          console.log("[ElevenLabs] Interruption");
        } else if (msg.type !== "audio") {
          console.log("[ElevenLabs] Event:", msg.type);
        }
      } catch (e) {
        console.error("[Proxy] Error processing ElevenLabs msg:", e.message);
      }
    });

    elevenLabsWs.on("close", (code, reason) => {
      console.log(`[ElevenLabs] Closed: ${code} ${reason}`);
      stopSilenceFill();
    });

    elevenLabsWs.on("error", (err) => {
      console.error("[ElevenLabs] Error:", err.message);
    });
  }

  // Send ambient noise during silence
  function startSilenceFill() {
    if (silenceInterval) return;
    silenceInterval = setInterval(() => {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
      const chunk = ambientNoise.generateChunk(20);
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: streamSid,
        media: { payload: chunk.toString("base64") }
      }));
    }, 20);
  }

  function stopSilenceFill() {
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
  }

  // Handle Twilio messages
  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.event) {
        case "connected":
          console.log("[Twilio] Stream connected");
          break;

        case "start":
          streamSid = msg.start.streamSid;
          console.log("[Twilio] Stream started - SID:", streamSid);
          ambientNoise.start();
          connectToElevenLabs();
          break;

        case "media":
          // Forward caller's audio to ElevenLabs
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
              user_audio_chunk: msg.media.payload
            }));
          }
          break;

        case "stop":
          console.log("[Twilio] Stream stopped");
          ambientNoise.stop();
          stopSilenceFill();
          if (elevenLabsWs) elevenLabsWs.close();
          break;
      }
    } catch (err) {
      console.error("[Proxy] Twilio msg error:", err.message);
    }
  });

  twilioWs.on("close", () => {
    console.log("[Proxy] Twilio closed");
    ambientNoise.stop();
    stopSilenceFill();
    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
  });

  twilioWs.on("error", (err) => {
    console.error("[Proxy] Twilio error:", err.message);
  });
});

// ─── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🏢 OMEGA Ambient Noise Proxy`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Agent: ${ELEVENLABS_AGENT_ID}`);
  console.log(`   Volume: ${AMBIENT_VOLUME * 100}%`);
  console.log(`   Ready\n`);
});
