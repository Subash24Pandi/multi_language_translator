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
LANGUAGE STYLE: Spoken Colloquial Tamil (as spoken in Tamil Nadu hospitals)
SCRIPT: Tamil script ONLY. Never write Tamil words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "சொன்னார்" → USE "சொன்னாங்க" 
- "வந்தார்" → USE "வந்தாங்க"
- "சாப்பிட்டீர்களா" → USE "சாப்பிட்டீங்களா" or "சாப்டீங்களா"
- "இருக்கிறீர்களா" → USE "இருக்கீங்களா"
- "வணக்கம்" for "Hi/Hello" → USE "ஹாய்" or "வாங்க"
- "செய்கிறீர்கள்" → USE "பண்றீங்க"
- "சந்திக்கலாம்" for "meet" → USE "மீட் பண்ணலாம்" or "சந்திக்கலாம்"
- "நோய்" → USE "pain" or "வலி"
- "உண்டீர்களா" → USE "சாப்டீங்களா"
- "கூறுங்கள்" → USE "சொல்லுங்க"

English words that are OK to keep as-is (people use these in Tamil naturally):
Doctor, Hospital, Medicine, Tablet, Injection, BP, Sugar, Checkup, Test, Report, Scan`;
    } else if (targetLang === 'te') {
      targetSpecificRules = `
LANGUAGE STYLE: Spoken Colloquial Telugu (as spoken in Andhra/Telangana hospitals)
SCRIPT: Telugu script ONLY. Never write Telugu words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "చేస్తున్నారు" → USE "చేస్తున్నారా"
- "వచ్చారు" → USE "వచ్చారా"
- "తిన్నారా" → USE "తిన్నారా" (OK)
- "అన్నారు" → USE "అన్నారు" or "చెప్పారు"
- "ఏమి చేస్తున్నారు" → USE "ఏం చేస్తున్నారు"
- "నమస్కారం" for Hi → USE "హాయ్" or "నమస్కారం"
- Formal "మీరు చేయాలి" → USE "మీరు చేయండి"

English words OK to keep: Doctor, Hospital, Medicine, Tablet, BP, Sugar, Scan, Report, Injection`;

    } else if (targetLang === 'hi') {
      targetSpecificRules = `
LANGUAGE STYLE: Spoken Colloquial Hindi (as spoken in North India hospitals)
SCRIPT: Devanagari script ONLY. Never write Hindi words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "आपने भोजन किया" → USE "खाना खाया?"
- "आप क्या कर रहे हैं" → USE "क्या कर रहे हो?"
- "नमस्ते" for Hi → USE "हाय" or "नमस्ते"
- "मैं आपसे पूछना चाहता हूं" → USE "एक बात पूछनी थी"
- "आप कैसे हैं" → USE "कैसे हो?" or "ठीक हो?"
- "कृपया बताइए" → USE "बताओ" or "बताइए"
- Formal "आपको जाना चाहिए" → USE "जाओ" or "जाइए"

English words OK to keep: Doctor, Hospital, Medicine, Tablet, BP, Sugar, Test, Report, Injection`;

    } else if (targetLang === 'kn') {
      targetSpecificRules = `
LANGUAGE STYLE: Spoken Colloquial Kannada (as spoken in Karnataka hospitals)
SCRIPT: Kannada script ONLY. Never write Kannada words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "ನೀವು ಏನು ಮಾಡುತ್ತಿದ್ದೀರಿ" → USE "ಏನ್ ಮಾಡ್ತಿದ್ದೀರಾ?"
- "ಊಟ ಮಾಡಿದ್ದೀರಾ" → USE "ಊಟ ಆಯ್ತಾ?"
- "ನಮಸ್ಕಾರ" for Hi → USE "ಹಾಯ್" or "ನಮಸ್ಕಾರ"
- "ಅವರು ಹೇಳಿದರು" → USE "ಅವ್ರು ಏನ್ ಹೇಳಿದ್ರು?"
- Formal "ನೀವು ಹೋಗಬೇಕು" → USE "ನೀವ್ ಹೋಗ್ಬೇಕು"

English words OK to keep: Doctor, Hospital, Medicine, Tablet, BP, Sugar, Test, Report, Scan`;

    } else if (targetLang === 'ml') {
      targetSpecificRules = `
LANGUAGE STYLE: Spoken Colloquial Malayalam (as spoken in Kerala hospitals)
SCRIPT: Malayalam script ONLY. Never write Malayalam words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "നിങ്ങൾ എന്ത് ചെയ്യുന്നു" → USE "എന്ത് ചെയ്യുന്നു?"
- "ഭക്ഷണം കഴിച്ചോ" → USE "ഭക്ഷണം കഴിച്ചോ?" (OK)
- "നമസ്കാരം" for Hi → USE "ഹായ്" or "നമസ്കാരം"
- "ഡോക്ടർ എന്ത് പറഞ്ഞു" → USE "Doctor എന്ത് പറഞ്ഞു?"
- Formal "താങ്കൾ" → USE "നിങ്ങൾ"

English words OK to keep: Doctor, Hospital, Medicine, Tablet, BP, Sugar, Test, Report, Scan`;

    } else if (targetLang === 'bn') {
      targetSpecificRules = `
LANGUAGE STYLE: Spoken Colloquial Bengali (as spoken in West Bengal hospitals)
SCRIPT: Bengali script ONLY. Never write Bengali words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "আপনি কী করছেন" → USE "কী করছেন?"
- "আপনি খেয়েছেন কি" → USE "খেয়েছেন?"
- "নমস্কার" for Hi → USE "হ্যালো" or "নমস্কার"
- "ডাক্তার কী বললেন" → USE "Doctor কী বললেন?"
- Formal → USE simpler everyday spoken forms

English words OK to keep: Doctor, Hospital, Medicine, Tablet, BP, Sugar, Test, Report`;

    } else if (targetLang === 'mr') {
      targetSpecificRules = `
LANGUAGE STYLE: Spoken Colloquial Marathi (as spoken in Maharashtra hospitals)
SCRIPT: Devanagari script ONLY. Never write Marathi words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "तुम्ही काय करत आहात" → USE "काय करतोय?"
- "तुम्ही जेवलात का" → USE "जेवलात का?"
- "नमस्कार" for Hi → USE "हाय" or "नमस्कार"
- "डॉक्टरांनी काय सांगितले" → USE "Doctor नी काय सांगितलं?"
- Formal → USE simpler everyday spoken forms

English words OK to keep: Doctor, Hospital, Medicine, Tablet, BP, Sugar, Test, Report`;

    } else if (targetLang === 'gu') {
      targetSpecificRules = `
LANGUAGE STYLE: Spoken Colloquial Gujarati (as spoken in Gujarat hospitals)
SCRIPT: Gujarati script ONLY. Never write Gujarati words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "તમે શું કરી રહ્યા છો" → USE "શું કરો છો?"
- "તમે જમ્યા" → USE "જમ્યા?"
- "નમસ્તે" for Hi → USE "હાય" or "નમસ્તે"
- "ડૉક્ટરે શું કહ્યું" → USE "Doctor એ શું કીધું?"
- Formal → USE simpler everyday spoken forms

English words OK to keep: Doctor, Hospital, Medicine, Tablet, BP, Sugar, Test, Report`;

    } else if (targetLang === 'or') {
      targetSpecificRules = `
LANGUAGE STYLE: Spoken Colloquial Odia (as spoken in Odisha hospitals)
SCRIPT: Odia script ONLY. Never write Odia words in English letters.

COLLOQUIAL WORD REPLACEMENTS (MANDATORY):
- "ଆପଣ କ'ଣ କରୁଛନ୍ତି" → USE "କ'ଣ କରୁଛ?"
- "ଆପଣ ଖାଇଛନ୍ତି" → USE "ଖାଇଛ?"
- "ନମସ୍କାର" for Hi → USE "ହାୟ" or "ନମସ୍କାର"
- Formal → USE simpler everyday spoken forms

English words OK to keep: Doctor, Hospital, Medicine, Tablet, BP, Sugar, Test, Report`;

    } else if (targetLang === 'en') {
      targetSpecificRules = `
LANGUAGE STYLE: Clear, natural, polite conversational Indian English (as spoken in Indian hospitals).
Use simple sentences. No American slang. No abbreviations.
Sound like a kind, educated Indian doctor or nurse speaking to a patient.
Examples:
- "வாங்க சார்" → "Please come, sir"
- "என்ன ஆச்சு?" → "What happened?"
- "சாப்பிட்டீங்களா?" → "Did you eat?"
- "வலி இருக்கா?" → "Are you in pain?"
- "Doctor என்ன சொன்னாங்க?" → "What did the doctor say?"`;
    }

    const systemPrompt = `You are a highly accurate medical interpreter for Indian hospitals. 
Your job is to translate spoken conversation between doctors and patients from ${sourceName} to ${targetName}.

CRITICAL RULES:
1. Translate the EXACT meaning of every word. Do NOT add, remove, or change any part of the message.
2. ${targetSpecificRules}
3. Output ONLY the translated text. No explanations, no notes, nothing else.`;

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
