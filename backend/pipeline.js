import axios from 'axios';
import Groq from 'groq-sdk';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  or: '7c6219d2-e8d2-462c-89d8-7ecba7c75d65', // default as fallback
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
  let tempFilePath = '';
  try {
    // Write buffer to a physical temporary file to ensure flawless form-data boundary parsing on Render
    tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}_${Math.floor(Math.random()*1000)}.wav`);
    fs.writeFileSync(tempFilePath, audioBuffer);

    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempFilePath), {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    
    // Use Sarvam saaras:v3 model as requested
    formData.append('model', 'saaras:v3');
    if (SARVAM_LANG_MAP[lang]) {
      formData.append('language_code', SARVAM_LANG_MAP[lang]);
    }
    
    const response = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        ...formData.getHeaders()
      },
      timeout: 10000 
    });
    
    // Clean up temp file immediately after successful upload
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    
    return response.data.transcript || '';
  } catch (error) {
    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    console.error('Sarvam STT Error:', error.response?.data || error.message);
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
- STRICTLY FORBIDDEN: Do not use "Thuya" (pure/formal/bookish) Tamil. 
- HOW TO BE POLITE: Use spoken respectful suffixes. For Tamil, use the spoken '-eenga' suffix (e.g., "பண்றீங்க", "சாப்பிட்டீங்களா", "சொல்லுங்க"). NEVER use the formal written '-eerkal' suffix (e.g., do NOT use "செய்கிறீர்கள்", "சாப்பிட்டீர்களா", "கூறுங்கள்").`;
    } else if (targetLang === 'hi') {
      targetSpecificRules = `
- STRICTLY FORBIDDEN: Do not use formal/pure Hindi (Shuddh Hindi). Use casual everyday spoken Hindi.`;
    }

    const systemPrompt = `You are a medical translator strictly translating from ${sourceName} to ${targetName}.
RULES:
- You MUST translate the EXACT meaning accurately, but using natural conversational grammar. DO NOT change the original message's intent or hallucinate different greetings.
- CRITICAL: You MUST use colloquial, spoken regional language. ${targetSpecificRules}
- DO NOT use English slang like 'dude' or 'what's up doc'. Just use normal respectful spoken street language.
- CRITICAL SCRIPT RULE: You MUST write the translation ONLY in the native alphabet/script of ${targetName}. NEVER output the source language.
- PACING RULE: Break long sentences into shorter chunks and use commas (,) generously.
- DO NOT add extra words, summarize, or explain. Output ONLY the translated text.`;

    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 256,
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
          container: 'raw',
          encoding: 'pcm_f32le',
          sample_rate: 22050
        },
        language: lang
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
