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
    
    // 2. Perform ultra-fast server-side conversion from WebM to lightweight MP3 for Sarvam
    const tempId = `audio_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    webmPath = path.join(os.tmpdir(), `${tempId}.webm`);
    const mp3Path = path.join(os.tmpdir(), `${tempId}.mp3`);
    
    fs.writeFileSync(webmPath, binaryBuffer);
    
    // Use ffmpeg to convert to high-quality MP3 (128k is clear for STT)
    execSync(`ffmpeg -y -i ${webmPath} -ar 16000 -ac 1 -b:a 128k ${mp3Path}`, { stdio: 'ignore' });
    
    const mp3Buffer = fs.readFileSync(mp3Path);
    
    // 3. Upload to Sarvam
    const formData = new globalThis.FormData();
    const audioBlob = new globalThis.Blob([mp3Buffer], { type: 'audio/mp3' });
    formData.append('file', audioBlob, 'audio.mp3');
    
    formData.append('model', 'saaras:v3');
    if (SARVAM_LANG_MAP[lang]) {
      formData.append('language_code', SARVAM_LANG_MAP[lang]);
    }

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY
      },
      body: formData
    });

    if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.transcript || '';
  } catch (error) {
    if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    const tempMp3Path = webmPath ? webmPath.replace('.webm', '.mp3') : '';
    if (tempMp3Path && fs.existsSync(tempMp3Path)) fs.unlinkSync(tempMp3Path);
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
- CRITICAL: Use "Spoken Tamil" (Colloquial). 
- FORBIDDEN: Do not use bookish/formal/pure Tamil (No 'Thuya Tamil').
- STYLE: Use natural spoken grammar and phonetic spellings (e.g., use "Vanga", "Sapteengala", "Erukkeenga"). 
- POLITE: Use spoken respectful suffixes like '-eenga' ALWAYS.`;
    }

    const systemPrompt = `You are a helpful translator. Translate the user's message from ${sourceName} to ${targetName}.
RULES:
- CRITICAL: Translate naturally like people speak on the street in ${targetName}. 
- STRLICTLY FORBIDDEN: Do not use bookish, formal, or dictionary-style language.
- ${targetSpecificRules}
- ONLY output the translated text. Do not explain anything.`;

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
          container: 'mp3',
          encoding: 'pcm_f32le',
          sample_rate: 44100
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
