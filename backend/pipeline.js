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
  or: 'faf0731e-dfb9-4cfc-8119-259a79b27e12', 
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

export async function processAudioBuffer(audioBuffer, sourceLang, targetLang) {
  try {
    // 1. STT: Sarvam Saaras v3
    let sttText = await transcribeAudio(audioBuffer, sourceLang);
    if (!sttText || sttText.trim() === '') {
      return { audioBase64: null, translatedText: '', originalText: '' };
    }
    
    sttText = sttText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();
    console.log(`[STT] Transcribed: ${sttText}`);

    // 2. LLM: Groq Translation
    let translatedText = sttText;
    if (sourceLang !== targetLang) {
      translatedText = await translateText(sttText, sourceLang, targetLang);
      console.log(`[LLM] Translated: ${translatedText}`);
    }

    translatedText = translatedText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();

    // 3. TTS: Cartesia
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
    const tempId = `audio_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    webmPath = path.join(os.tmpdir(), `${tempId}.webm`);
    wavPath = path.join(os.tmpdir(), `${tempId}.wav`);
    
    const binaryBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    fs.writeFileSync(webmPath, binaryBuffer);
    
    // High-speed conversion to 16kHz WAV for Sarvam
    execSync(`ffmpeg -y -i "${webmPath}" -preset ultrafast -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}"`, { stdio: 'ignore' });
    
    const wavBuffer = fs.readFileSync(wavPath);
    const formData = new FormData();
    formData.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
    formData.append('model', 'saaras:v3');
    if (SARVAM_LANG_MAP[lang]) {
      formData.append('language_code', SARVAM_LANG_MAP[lang]);
    }

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
    console.error('Sarvam STT Error:', error.response?.data || error.message);
    throw new Error('STT Failed');
  }
}

async function translateText(text, sourceLang, targetLang) {
  try {
    const sourceName = FULL_LANG_NAMES[sourceLang] || sourceLang;
    const targetName = FULL_LANG_NAMES[targetLang] || targetLang;

    const systemPrompt = `You are a professional medical interpreter translating from ${sourceName} to ${targetName}.

STRICT DIALECT RULES:
1. USE COLLOQUIAL SPEECH ONLY: Your output MUST be in natural, modern, 2024 spoken dialect.
2. NO FORMAL LANGUAGE: Strictly avoid "Thuya" Tamil, "Shuddh" Hindi, or any "bookish" / formal written grammar.
3. SPOKEN STYLE: Translate using words people actually use in a clinic (e.g., "Pannreenga", "Saptteengala", "Eppadi irukkeenga").
4. MEDICAL FIDELITY: Maintain 100% meaning accuracy while using casual/natural tones.
5. ENGLISH TERMS: Keep clinical terms like Doctor, Hospital, BP, Sugar, Tablet, Scan, ECG, Operation in English.
6. PRONOUNS: Use "You" for direct address. Use "They" for doctors/staff.
7. CLEAN OUTPUT: Output ONLY the translation. No labels or explanations.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'ஹாய் சார், என்ன பண்றீங்க? சாப்டீங்களா? டாக்டர் என்ன சொன்னாங்க?' },
      { role: 'assistant', content: 'Hi sir, what are you doing? Did you eat? What did the doctor say?' },
      { role: 'user', content: 'Did you take the tablet?' },
      { role: 'assistant', content: 'மாத்திரை சாப்டீங்களா?' },
      { role: 'user', content: text }
    ];

    const response = await groq.chat.completions.create({
      messages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
      max_tokens: 1024,
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
        voice: {
          mode: 'id',
          id: voiceId,
        },
        output_format: {
          container: 'wav',
          encoding: 'pcm_s16le',
          sample_rate: 16000,
        },
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
    console.error('Cartesia TTS Error:', error.response?.data || error.message);
    throw new Error('TTS Failed');
  }
}
