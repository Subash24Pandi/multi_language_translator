import axios from 'axios';
import Groq from 'groq-sdk';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import dotenv from 'dotenv';
import ffmpeg from 'ffmpeg-static';
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const VOICE_MAP = {
  en: 'e8e5fffb-252c-436d-b842-8879b84445b6',
  hi: 'faf0731e-dfb9-4cfc-8119-259a79b27e12',
  ta: '25d2c432-139c-4035-bfd6-9baaabcdd006',
  te: 'cf061d8b-a752-4865-81a2-57570a6e0565',
  kn: '6baae46d-1226-45b5-a976-c7f9b797aae2',
  bn: '2ba861ea-7cdc-43d1-8608-4045b5a41de5',
  gu: '4590a461-bc68-4a50-8d14-ac04f5923d22',
  mr: '5c32dce6-936a-4892-b131-bafe474afe5f',
  ml: '374b80da-e622-4dfc-90f6-1eeb13d331c9',
  or: 'faf0731e-dfb9-4cfc-8119-259a79b27e12', 
};

const SARVAM_LANG_MAP = {
  en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', 
  bn: 'bn-IN', gu: 'gu-IN', mr: 'mr-IN', ml: 'ml-IN', or: 'or-IN'
};

const FULL_LANG_NAMES = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', kn: 'Kannada',
  bn: 'Bengali', gu: 'Gujarati', mr: 'Marathi', ml: 'Malayalam', or: 'Odia'
};

// Set execution permissions for ffmpeg on startup
try {
  if (ffmpeg) fs.chmodSync(ffmpeg, 0o755);
} catch (e) {}

export async function processAudioBuffer(audioBuffer, sourceLang, targetLang) {
  try {
    // 1. STT: Sarvam AI (Requested)
    let sttText = await transcribeAudio(audioBuffer, sourceLang);
    if (!sttText || sttText.trim() === '') {
      return { audioBase64: null, translatedText: '', originalText: '' };
    }
    
    sttText = sttText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();
    console.log(`[STT] Transcribed: ${sttText}`);

    // 2. LLM: Groq Translation (Llama 3.3 70B - Colloquial First)
    let translatedText = sttText;
    if (sourceLang !== targetLang) {
      translatedText = await translateText(sttText, sourceLang, targetLang);
      console.log(`[LLM] Translated: ${translatedText}`);
    }

    translatedText = translatedText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();

    // 3. TTS: Cartesia
    const audioBase64 = await synthesizeSpeech(translatedText, targetLang);
    return { audioBase64, translatedText, originalText: sttText };
  } catch (error) {
    console.error('Pipeline error:', error.message);
    throw error;
  }
}

async function transcribeAudio(audioBuffer, lang) {
  let webmPath = '';
  let wavPath = '';
  try {
    const tempId = `audio_${Date.now()}`;
    webmPath = path.join(os.tmpdir(), `${tempId}.webm`);
    wavPath = path.join(os.tmpdir(), `${tempId}.wav`);
    
    const binaryBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    fs.writeFileSync(webmPath, binaryBuffer);
    
    // FIX: Using advanced ffmpeg flags to recover from "EBML header parsing failed" errors.
    // -fflags +genpts+igndts+ignidx: Force generation of timestamps and ignore corrupted index/dts.
    // -f matroska: Force input format as webm/matroska even if header is slightly off.
    try {
      execSync(`"${ffmpeg}" -y -f matroska -fflags +genpts+igndts+ignidx -i "${webmPath}" -preset ultrafast -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}"`, { stdio: 'pipe' });
    } catch (ffmpegErr) {
      // Fallback: try without the force flags if that fails
      execSync(`"${ffmpeg}" -y -i "${webmPath}" -preset ultrafast -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}"`, { stdio: 'ignore' });
    }
    
    const wavBuffer = fs.readFileSync(wavPath);
    const formData = new FormData();
    formData.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
    formData.append('model', 'saaras:v3');
    if (SARVAM_LANG_MAP[lang]) formData.append('language_code', SARVAM_LANG_MAP[lang]);

    const response = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
      headers: {
        ...formData.getHeaders(),
        'api-subscription-key': process.env.SARVAM_API_KEY
      }
    });

    if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

    return response.data.transcript || '';
  } catch (error) {
    if (webmPath && fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    if (wavPath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    console.error('STT Failed Detail:', error.message);
    throw new Error('STT Failed');
  }
}

async function translateText(text, sourceLang, targetLang) {
  try {
    const sourceName = FULL_LANG_NAMES[sourceLang] || sourceLang;
    const targetName = FULL_LANG_NAMES[targetLang] || targetLang;

    const systemPrompt = `You are a medical interpreter. Translate from ${sourceName} to ${targetName}.
RULES: Use natural spoken dialect (COLLOQUIAL). NO bookish words. 
Keep Doctor, Hospital, BP, Sugar, Tablet, Scan, ECG, Operation in English.
Output ONLY translation.`;

    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'ஹாய் சார், என்ன பண்றீங்க? சாப்டீங்களா? டாக்டர் என்ன சொன்னாங்க?' },
        { role: 'assistant', content: 'Hi sir, what are you doing? Did you eat? What did the doctor say?' },
        { role: 'user', content: text }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    });
    return response.choices[0]?.message?.content?.trim() || '';
  } catch (error) {
    console.error('Groq Translation Error:', error.message);
    throw new Error('Translation Failed');
  }
}

async function synthesizeSpeech(text, targetLang) {
  try {
    const voiceId = VOICE_MAP[targetLang] || VOICE_MAP['hi'];
    const response = await axios.post(
      'https://api.cartesia.ai/tts/bytes',
      {
        model_id: 'sonic-multilingual',
        transcript: text,
        voice: { mode: 'id', id: voiceId },
        output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 16000 },
      },
      {
        headers: {
          'Cartesia-Version': '2024-06-10',
          'X-API-Key': process.env.CARTESIA_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      }
    );
    return Buffer.from(response.data).toString('base64');
  } catch (error) {
    console.error('Cartesia TTS Error:', error.message);
    throw new Error('TTS Failed');
  }
}
