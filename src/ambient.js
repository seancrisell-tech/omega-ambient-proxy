/**
 * Ambient Noise Generator
 *
 * Generates realistic office ambient noise and mixes it
 * into µ-law 8kHz audio streams for Twilio.
 *
 * The noise is procedurally generated (no audio files needed):
 * - Low-frequency HVAC hum (air conditioning)
 * - Gentle random background murmur
 * - Occasional subtle keyboard/activity sounds
 *
 * This creates a convincing "busy office" atmosphere
 * without needing to ship large audio files.
 */

// µ-law encoding tables (ITU-T G.711)
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/**
 * Encode a single 16-bit PCM sample to µ-law
 */
function encodeMulaw(sample) {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  const expMask = 0x4000;
  for (let i = 0; i < 8; i++) {
    if (sample & expMask) break;
    exponent--;
    sample <<= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

/**
 * Decode a single µ-law byte to 16-bit PCM
 */
function decodeMulaw(mulawByte) {
  mulawByte = ~mulawByte & 0xff;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0f;

  let sample = (mantissa << (exponent + 3)) + MULAW_BIAS;
  sample >>= (exponent + 3 - exponent); // Simplify
  // Proper decode:
  sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;

  return sign ? -sample : sample;
}

class AmbientNoiseGenerator {
  constructor(volume = 0.15) {
    this.volume = volume; // 0.0 to 1.0
    this.running = false;
    this.phase = 0; // For HVAC hum oscillator
    this.murmurState = 0; // Low-pass filter state for murmur
    this.activityTimer = 0; // Timer for occasional activity sounds
    this.activityIntensity = 0; // Current activity sound level
  }

  start() {
    this.running = true;
    this.phase = 0;
    this.murmurState = 0;
    this.activityTimer = Math.random() * 8000; // Random initial delay
    console.log(`[Ambient] Started - volume: ${this.volume * 100}%`);
  }

  stop() {
    this.running = false;
    console.log("[Ambient] Stopped");
  }

  /**
   * Generate one sample of ambient office noise (16-bit PCM at 8kHz)
   */
  generateSample() {
    if (!this.running) return 0;

    // 1. HVAC hum - low frequency sine wave (50-60Hz range)
    //    Amplitudes are set high so they register in µ-law at low volume settings
    const hvacFreq = 55; // Hz - mains hum frequency
    this.phase += (2 * Math.PI * hvacFreq) / 8000;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    const hvac = Math.sin(this.phase) * 2000;

    // 2. Background murmur - filtered random noise (distant chatter)
    const rawNoise = (Math.random() - 0.5) * 3000;
    // Simple low-pass filter to make it sound like distant voices
    this.murmurState = this.murmurState * 0.93 + rawNoise * 0.07;
    const murmur = this.murmurState;

    // 3. Occasional activity sounds (keyboard clicks, movement, papers)
    this.activityTimer--;
    if (this.activityTimer <= 0) {
      // Trigger a new activity burst
      this.activityIntensity = 1500 + Math.random() * 2500;
      this.activityTimer = 3000 + Math.random() * 15000; // 0.4s to 2.25s gap
    }
    // Decay the activity sound quickly (short burst)
    this.activityIntensity *= 0.994;
    const activity = this.activityIntensity > 50
      ? (Math.random() - 0.5) * this.activityIntensity * 0.3
      : 0;

    // Combine all layers and apply volume
    const combined = (hvac + murmur + activity) * this.volume;

    // Clamp to 16-bit range
    return Math.max(-32768, Math.min(32767, Math.round(combined)));
  }

  /**
   * Generate a buffer of ambient noise samples (µ-law encoded)
   * @param {number} numSamples - Number of samples to generate
   * @returns {Buffer} µ-law encoded audio buffer
   */
  generateMulawBuffer(numSamples) {
    const buffer = Buffer.alloc(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const pcmSample = this.generateSample();
      buffer[i] = encodeMulaw(pcmSample);
    }
    return buffer;
  }

  /**
   * Mix ambient noise into an existing µ-law audio buffer.
   * Decodes the input µ-law, adds noise, re-encodes to µ-law.
   *
   * @param {Buffer} mulawBuffer - Input µ-law audio (e.g., from ElevenLabs)
   * @returns {Buffer} Mixed µ-law audio buffer
   */
  mixWithMulaw(mulawBuffer) {
    const output = Buffer.alloc(mulawBuffer.length);

    for (let i = 0; i < mulawBuffer.length; i++) {
      // Decode the original audio
      const originalSample = decodeMulaw(mulawBuffer[i]);

      // Generate ambient noise sample
      const noiseSample = this.generateSample();

      // Mix: original audio dominates, noise is background
      const mixed = originalSample + noiseSample;

      // Clamp and re-encode
      const clamped = Math.max(-32768, Math.min(32767, mixed));
      output[i] = encodeMulaw(clamped);
    }

    return output;
  }

  /**
   * Generate a standalone chunk of ambient noise for sending
   * to Twilio when there's no ElevenLabs audio to mix with.
   * Useful for filling silence with ambient noise.
   *
   * @param {number} durationMs - Duration in milliseconds
   * @returns {Buffer} µ-law encoded ambient noise
   */
  generateChunk(durationMs = 20) {
    const numSamples = Math.floor((8000 * durationMs) / 1000); // 8kHz
    return this.generateMulawBuffer(numSamples);
  }
}

module.exports = { AmbientNoiseGenerator, encodeMulaw, decodeMulaw };
