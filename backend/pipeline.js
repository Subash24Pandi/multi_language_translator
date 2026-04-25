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

try {
  if (ffmpeg) fs.chmodSync(ffmpeg, 0o755);
} catch (e) {}

export async function processAudioBuffer(audioBuffer, sourceLang, targetLang) {
  try {
    let sttText = await transcribeAudio(audioBuffer, sourceLang);
    
    if (!sttText || sttText.trim() === '') {
      return { audioBase64: null, translatedText: '', originalText: '' };
    }
    
    sttText = sttText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();
    console.log(`[STT] Final Transcription: ${sttText}`);

    let translatedText = sttText;
    if (sourceLang !== targetLang) {
      translatedText = await translateText(sttText, sourceLang, targetLang);
      console.log(`[LLM] Translated: ${translatedText}`);
    }

    translatedText = translatedText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();

    // TTS: Cartesia
    const audioBase64 = await synthesizeSpeech(translatedText, targetLang);
    
    // CRITICAL: Even if TTS fails, we must return the translated text!
    return { audioBase64, translatedText, originalText: sttText };
  } catch (error) {
    console.error('Pipeline Critical Failure:', error.message);
    throw error;
  }
}

async function transcribeAudio(audioBuffer, lang) {
  try {
    return await transcribeSarvam(audioBuffer, lang);
  } catch (err) {
    try {
      return await transcribeGroq(audioBuffer, lang);
    } catch (groqErr) {
      return await transcribeDeepgram(audioBuffer, lang);
    }
  }
}

async function transcribeSarvam(audioBuffer, lang) {
  let webmPath = '';
  let wavPath = '';
  try {
    const tempId = `audio_${Date.now()}`;
    webmPath = path.join(os.tmpdir(), `${tempId}.webm`);
    wavPath = path.join(os.tmpdir(), `${tempId}.wav`);
    fs.writeFileSync(webmPath, Buffer.from(audioBuffer));
    
    execSync(`"${ffmpeg}" -y -f matroska -fflags +genpts+igndts+ignidx -i "${webmPath}" -preset ultrafast -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}"`, { stdio: 'pipe' });
    
    const wavBuffer = fs.readFileSync(wavPath);
    const formData = new FormData();
    formData.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
    formData.append('model', 'saaras:v3');
    if (SARVAM_LANG_MAP[lang]) formData.append('language_code', SARVAM_LANG_MAP[lang]);

    const response = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
      headers: { ...formData.getHeaders(), 'api-subscription-key': process.env.SARVAM_API_KEY }
    });

    if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    return response.data.transcript || '';
  } catch (error) {
    if (webmPath && fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    if (wavPath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    throw error;
  }
}

async function transcribeGroq(audioBuffer, lang) {
  let tempPath = '';
  try {
    tempPath = path.join(os.tmpdir(), `audio_${Date.now()}.webm`);
    fs.writeFileSync(tempPath, Buffer.from(audioBuffer));
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-large-v3',
      language: lang,
    });
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return transcription.text || '';
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw err;
  }
}

async function transcribeDeepgram(audioBuffer, lang) {
  try {
    const response = await axios.post(
      'https://api.deepgram.com/v1/listen?smart_format=true&language=' + (lang === 'en' ? 'en' : lang),
      Buffer.from(audioBuffer),
      {
        headers: {
          'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'audio/webm'
        }
      }
    );
    return response.data.results?.channels[0]?.alternatives[0]?.transcript || '';
  } catch (error) {
    throw new Error('ALL_STT_ENGINES_FAILED');
  }
}

async function translateText(text, sourceLang, targetLang) {
  try {
    const sourceName = FULL_LANG_NAMES[sourceLang] || sourceLang;
    const targetName = FULL_LANG_NAMES[targetLang] || targetLang;

    const systemPrompt = `You are a hyper-colloquial medical translator. Your goal is to translate ${sourceName} to ${targetName} so it sounds like a REAL PERSON speaking in 2024.

STRICT RULES:
1. BAN FORMAL LANGUAGE: Never use "bookish" or "textbook" words. 
   - For Tamil: NEVER use "Neengal", "Seigireerkal", "Saapiteergala", or "Vanakkan" (unless it's a very formal greeting).
   - Use: "Neenga", "Pannreenga", "Saaptteengala", "Hi/Hello".
2. ACCURACY: Keep the medical meaning 100% exact.
3. SUFFIXES: Use spoken suffixes like "-nga", "-teengala", "-reenga", "-nna".
4. ENGLISH LOAN WORDS: Use common English words like "Doctor", "BP", "Sugar", "Tablet", "Hospital", "Report" as they are naturally used in spoken ${targetName}.
5. NO EXPLANATIONS: Output ONLY the translated text.

EXAMPLES:
Formal: நீங்கள் உணவு உண்டீர்களா?
Colloquial: Neenga saaptteengala? (நீங்க சாப்ட்டீங்களா?)

Formal: உங்கள் இரத்த அழுத்தம் அதிகமாக உள்ளது.
Colloquial: Unga BP konjam adhigaama irukku. (உங்க BP கொஞ்சம் அதிகமா இருக்கு.)`;

    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        // Expanded Few-shots
        { role: 'user', content: 'Hi sir, how are you? Did you take your medicine?' },
        { role: 'assistant', content: 'ஹாய் சார், எப்படி இருக்கீங்க? டேப்லெட் போட்டீங்களா?' },
        { role: 'user', content: 'What did the doctor say about the report?' },
        { role: 'assistant', content: 'ரிப்போர்ட் பத்தி டாக்டர் என்ன சொன்னாங்க?' },
        { role: 'user', content: 'Are you feeling any pain now?' },
        { role: 'assistant', content: 'இப்போ ஏதாச்சும் வலி இருக்கா?' },
        { role: 'user', content: text }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    });
    return response.choices[0]?.message?.content?.trim() || '';
  } catch (error) {
    return text;
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
        timeout: 5000 // Add timeout to prevent hanging
      }
    );
    return Buffer.from(response.data).toString('base64');
  } catch (error) {
    console.error('TTS Synthesis Failed:', error.message);
    return null;
  }
}
