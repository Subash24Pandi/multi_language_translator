import axios from 'axios';
import Groq from 'groq-sdk';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import dotenv from 'dotenv';
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
  or: 'faf0731e-dfb9-4cfc-8119-259a79b27e12', // Fallback to Hindi voice for Odia script
};

const SARVAM_LANG_MAP = {
  en: 'en-IN',
  hi: 'hi-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  kn: 'kn-IN',
  bn: 'bn-IN',
  gu: 'gu-IN',
  mr: 'mr-IN',
  ml: 'ml-IN',
  or: 'or-IN'
};

const FULL_LANG_NAMES = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  kn: 'Kannada',
  bn: 'Bengali',
  gu: 'Gujarati',
  mr: 'Marathi',
  ml: 'Malayalam',
  or: 'Odia'
};

export async function processAudioBuffer(audioBuffer, sourceLang, targetLang, statusCallback) {
  try {
    // 1. STT: Sarvam Saaras v3
    if (statusCallback) statusCallback('Transcribing...');
    let sttText = await transcribeAudio(audioBuffer, sourceLang);
    if (!sttText || sttText.trim() === '') {
      return { audioBase64: null, translatedText: '', originalText: '' };
    }
    
    // Strip annoying "Speaker 1:" or "Speaker:" labels from Sarvam STT
    sttText = sttText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();
    console.log(`[STT] Transcribed: ${sttText}`);

    // 2. LLM: Groq Translation (Only if languages are different)
    if (statusCallback) statusCallback('Translating...');
    let translatedText = sttText;
    if (sourceLang !== targetLang) {
      translatedText = await translateText(sttText, sourceLang, targetLang);
      console.log(`[LLM] Translated: ${translatedText}`);
    } else {
      console.log(`[LLM] Skipped translation (source and target language are the same)`);
    }

    // Strip labels again just in case the LLM added them
    translatedText = translatedText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();

    // 3. TTS: Cartesia
    if (statusCallback) statusCallback('Generating voice...');
    const audioBase64 = await synthesizeSpeech(translatedText, targetLang);
    console.log(`[TTS] Audio generated for ${targetLang}`);

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
    // 1. Decode base64 to binary
    let base64Data = audioBuffer;
    if (typeof audioBuffer === 'string' && audioBuffer.includes(';base64,')) {
      base64Data = audioBuffer.split(';base64,').pop();
    }
    const binaryBuffer = Buffer.from(base64Data, 'base64');
    
    // 2. Convert WebM to WAV (Sarvam requires WAV format - MP3 causes broken transcription)
    const tempId = `audio_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    webmPath = path.join(os.tmpdir(), `${tempId}.webm`);
    const wavPath = path.join(os.tmpdir(), `${tempId}.wav`);
    
    fs.writeFileSync(webmPath, binaryBuffer);
    
    // WAV at 16kHz mono - exactly what Sarvam saaras:v3 requires
    execSync(`ffmpeg -y -i ${webmPath} -ar 16000 -ac 1 -sample_fmt s16 ${wavPath}`, { stdio: 'ignore' });
    
    const wavBuffer = fs.readFileSync(wavPath);
    
    // 3. Upload to Sarvam
    const formData = new globalThis.FormData();
    const audioBlob = new globalThis.Blob([wavBuffer], { type: 'audio/wav' });
    formData.append('file', audioBlob, 'audio.wav');
    
    formData.append('model', 'saaras:v3');
    if (SARVAM_LANG_MAP[lang]) {
      formData.append('language_code', SARVAM_LANG_MAP[lang]);
    }
    formData.append('with_timestamps', 'false');
    formData.append('with_disfluencies', 'false');

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY
      },
      body: formData
    });

    if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.transcript || '';
  } catch (error) {
    if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    const tempWavPath = webmPath ? webmPath.replace('.webm', '.wav') : '';
    if (tempWavPath && fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
    console.error('Sarvam STT Error:', error.message);
    throw new Error('STT Failed');
  }
}

async function translateText(text, sourceLang, targetLang) {
  try {
    const sourceName = FULL_LANG_NAMES[sourceLang];
    const targetName = FULL_LANG_NAMES[targetLang];
    
    let targetSpecificRules = '';
    if (targetLang === 'ta') {
      targetSpecificRules = `
- Use Colloquial Spoken Tamil. NEVER use Thuya/formal Tamil.
- Use spoken suffixes like '-ீங்க', '-ீங்களா'. NEVER use '-ீர்கள்', '-கிறீர்கள்'.
- Use common Tamil words people say in daily life (e.g., "வாங்க", "சாப்டீங்களா", "எப்படி இருக்கீங்க").
- Write ONLY in Tamil script (தமிழ்). No English letters.`;
    } else if (targetLang === 'te') {
      targetSpecificRules = `
- Use natural spoken Telugu. NEVER use formal/bookish Telugu.
- Write ONLY in Telugu script. No English letters.`;
    } else if (targetLang === 'hi') {
      targetSpecificRules = `
- Use casual everyday spoken Hindi. NEVER use formal Shuddh Hindi.
- Write ONLY in Devanagari script. No English letters.`;
    } else if (targetLang === 'kn') {
      targetSpecificRules = `
- Use natural spoken Kannada. NEVER use formal/bookish Kannada.
- Write ONLY in Kannada script. No English letters.`;
    } else if (targetLang === 'ml') {
      targetSpecificRules = `
- Use natural spoken Malayalam. NEVER use formal Malayalam.
- Write ONLY in Malayalam script. No English letters.`;
    } else if (targetLang === 'bn') {
      targetSpecificRules = `
- Use natural spoken Bengali. NEVER use formal Bengali.
- Write ONLY in Bengali script. No English letters.`;
    } else if (targetLang === 'mr') {
      targetSpecificRules = `
- Use natural spoken Marathi. NEVER use formal Marathi.
- Write ONLY in Devanagari script. No English letters.`;
    } else if (targetLang === 'gu') {
      targetSpecificRules = `
- Use natural spoken Gujarati. NEVER use formal Gujarati.
- Write ONLY in Gujarati script. No English letters.`;
    } else if (targetLang === 'or') {
      targetSpecificRules = `
- Use natural spoken Odia. NEVER use formal Odia.
- Write ONLY in Odia script. No English letters.`;
    } else if (targetLang === 'en') {
      targetSpecificRules = `
- Use clear, natural, polite conversational English.
- DO NOT use American slang, hip-hop slang, or abbreviations (No 'whassup', 'dude', 'ya', 'u', 'chill pill').
- Sound like a normal, educated person speaking kindly to a patient.`;
    }

    const systemPrompt = `You are a professional interpreter translating from ${sourceName} to ${targetName}.

RULES:
1. CRITICAL: Translate the EXACT words spoken. Do NOT change, add, or infer meaning.
   - Example: If someone says "Can you hear me?", translate it as "Can you hear me?" — NOT as "Are you feeling okay?"
   - Example: If someone says "What are you doing?", translate it as "What are you doing?" — NOT as "What's wrong?"
2. ${targetSpecificRules}
3. Output ONLY the translated text. No explanations or extra words.`;

    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 1024,
    });
    
    return response.choices[0]?.message?.content?.trim() || '';
  } catch (error) {
    console.error('Groq LLM Error:', error.message);
    throw new Error('Translation Failed');
  }
}

async function synthesizeSpeech(text, lang) {
  try {
    const voiceId = VOICE_MAP[lang] || VOICE_MAP['or'];
    
    const response = await axios.post(
      'https://api.cartesia.ai/tts/bytes',
      {
        model_id: 'sonic-3',
        transcript: text,
        voice: { mode: 'id', id: voiceId },
        output_format: {
          container: 'wav',
          encoding: 'pcm_s16le',
          sample_rate: 22050
        },
        // Fallback: Cartesia doesn't support 'or' code yet, use 'en' or 'hi' for the engine
        language: lang === 'or' ? 'hi' : lang
      },
      {
        headers: {
          'Cartesia-Version': '2024-06-10',
          'X-API-Key': process.env.CARTESIA_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );
    
    // Convert arraybuffer to base64
    return Buffer.from(response.data).toString('base64');
  } catch (error) {
    console.error('Cartesia TTS Error:', error.response?.data?.toString() || error.message);
    throw new Error('TTS Failed');
  }
}
