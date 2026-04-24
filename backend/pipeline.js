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
    
    let langStyleRule = '';
    if (targetLang === 'ta') {
      langStyleRule = `Output language: Spoken Colloquial Tamil (தமிழ்). Use Tamil script ONLY.
Use natural everyday spoken suffixes like -ஈங்க, -ஈங்களா, -ஆச்சு. NEVER use formal written Tamil (-ீர்கள், -கிறீர்கள்).`;
    } else if (targetLang === 'te') {
      langStyleRule = `Output language: Spoken Colloquial Telugu. Use Telugu script ONLY.
Use natural everyday spoken Telugu. NEVER use formal bookish Telugu.`;
    } else if (targetLang === 'hi') {
      langStyleRule = `Output language: Spoken Colloquial Hindi. Use Devanagari script ONLY.
Use natural everyday spoken Hindi. NEVER use formal Shuddh Hindi.`;
    } else if (targetLang === 'kn') {
      langStyleRule = `Output language: Spoken Colloquial Kannada. Use Kannada script ONLY.
Use natural everyday spoken Kannada. NEVER use formal bookish Kannada.`;
    } else if (targetLang === 'ml') {
      langStyleRule = `Output language: Spoken Colloquial Malayalam. Use Malayalam script ONLY.
Use natural everyday spoken Malayalam. NEVER use formal Malayalam.`;
    } else if (targetLang === 'bn') {
      langStyleRule = `Output language: Spoken Colloquial Bengali. Use Bengali script ONLY.
Use natural everyday spoken Bengali. NEVER use formal Bengali.`;
    } else if (targetLang === 'mr') {
      langStyleRule = `Output language: Spoken Colloquial Marathi. Use Devanagari script ONLY.
Use natural everyday spoken Marathi. NEVER use formal Marathi.`;
    } else if (targetLang === 'gu') {
      langStyleRule = `Output language: Spoken Colloquial Gujarati. Use Gujarati script ONLY.
Use natural everyday spoken Gujarati. NEVER use formal Gujarati.`;
    } else if (targetLang === 'or') {
      langStyleRule = `Output language: Spoken Colloquial Odia. Use Odia script ONLY.
Use natural everyday spoken Odia. NEVER use formal Odia.`;
    } else if (targetLang === 'en') {
      langStyleRule = `Output language: Clear natural conversational English.
Use simple, polite sentences like a kind Indian doctor/nurse would speak. No American slang.`;
    }

    const systemPrompt = `You are a medical interpreter. Translate the message from ${sourceName} to ${targetName}.

RULE 1 — ACCURACY: Translate EVERY sentence EXACTLY as spoken. Do NOT summarize, shorten, or skip any part.
RULE 2 — COMPLETENESS: If the input has 5 sentences, the output MUST also have 5 sentences worth of meaning.
RULE 3 — STYLE: ${langStyleRule}
RULE 4 — OUTPUT: Print ONLY the translated text. Nothing else.`;

    // Build messages array with few-shot examples for Tamil to lock in spoken style
    const messages = [{ role: 'system', content: systemPrompt }];
    
    if (targetLang === 'ta') {
      // Few-shot examples: show the model EXACTLY what spoken Tamil looks like
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'ஹலோ, எப்படி இருக்கீங்க சார்?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'என்ன பண்றீங்க?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'சாப்பிட்டீங்களா?' });
      messages.push({ role: 'user', content: 'I have a headache and chest pain.' });
      messages.push({ role: 'assistant', content: 'தலை வலிக்குது, நெஞ்சுல வலிக்குது.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor என்ன சொன்னாங்க?' });
      messages.push({ role: 'user', content: 'Please take rest and drink water.' });
      messages.push({ role: 'assistant', content: 'ரெஸ்ட் எடுங்க, தண்ணி குடிங்க.' });
      // Long multi-sentence example to prevent summarization
      messages.push({ role: 'user', content: 'Sir, you told me yesterday that we could meet tomorrow morning. Can you tell me what time I should come? The doctor also told me that we need to meet. I will go see the doctor and buy my tablets. If you tell me the time, we can meet at your place.' });
      messages.push({ role: 'assistant', content: 'சார், நேத்து நாளைக்கு காலையிலே மீட் பண்ணலாம்னு சொன்னீங்க. நான் எத்தனை மணிக்கு வரணும்னு சொல்லுங்க சார். Doctor-உம் நாம் மீட் பண்ணணும்னு சொன்னாங்க. நான் Doctor-கிட்ட போய் பாத்துட்டு மருந்து வாங்கிட்டு வருவேன். நீங்க டைம் சொன்னா, உங்க வீட்ல மீட் பண்ணலாம்.' });
    } else if (targetLang === 'hi') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'हेलो, कैसे हो सर?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'क्या कर रहे हो?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'खाना खाया?' });
      messages.push({ role: 'user', content: 'I have a headache.' });
      messages.push({ role: 'assistant', content: 'सिर में दर्द हो रहा है।' });
    } else if (targetLang === 'te') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'హలో, ఎలా ఉన్నారు సార్?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'ఏం చేస్తున్నారు?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'తిన్నారా?' });
      messages.push({ role: 'user', content: 'I have a headache and chest pain.' });
      messages.push({ role: 'assistant', content: 'తలనొప్పిగా ఉంది, గుండె నొప్పిగా ఉంది.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor ఏం చెప్పారు?' });
    } else if (targetLang === 'kn') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'ಹಲೋ, ಹೇಗಿದ್ದೀರಾ ಸಾರ್?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'ಏನ್ ಮಾಡ್ತಿದ್ದೀರಾ?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'ಊಟ ಆಯ್ತಾ?' });
      messages.push({ role: 'user', content: 'I have a headache.' });
      messages.push({ role: 'assistant', content: 'ತಲೆ ನೋವಾಗ್ತಿದೆ.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor ಏನ್ ಹೇಳಿದ್ರು?' });
    } else if (targetLang === 'ml') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'ഹലോ, എന്താ സുഖം സർ?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'എന്ത് ചെയ്യുന്നു?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'ഭക്ഷണം കഴിച്ചോ?' });
      messages.push({ role: 'user', content: 'I have a headache.' });
      messages.push({ role: 'assistant', content: 'തലവേദനയുണ്ട്.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor എന്ത് പറഞ്ഞു?' });
    } else if (targetLang === 'bn') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'হ্যালো, কেমন আছেন স্যার?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'কী করছেন?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'খেয়েছেন?' });
      messages.push({ role: 'user', content: 'I have a headache.' });
      messages.push({ role: 'assistant', content: 'মাথা ব্যথা করছে।' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor কী বললেন?' });
    } else if (targetLang === 'mr') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'हेलो, कसे आहात सर?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'काय करतोय?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'जेवलात का?' });
      messages.push({ role: 'user', content: 'I have a headache.' });
      messages.push({ role: 'assistant', content: 'डोकं दुखतंय.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor नी काय सांगितलं?' });
    } else if (targetLang === 'gu') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'હેલો, કેમ છો સર?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'શું કરો છો?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'જમ્યા?' });
      messages.push({ role: 'user', content: 'I have a headache.' });
      messages.push({ role: 'assistant', content: 'માથું દુખે છે.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor એ શું કીધું?' });
    } else if (targetLang === 'or') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'ହେଲୋ, କେମିତି ଅଛନ୍ତି ସାର୍?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'କ\'ଣ କରୁଛ?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'ଖାଇଛ?' });
      messages.push({ role: 'user', content: 'I have a headache.' });
      messages.push({ role: 'assistant', content: 'ମୁଣ୍ଡ ଯନ୍ତ୍ରଣା ହେଉଛି।' });
    } else if (targetLang === 'en') {
      messages.push({ role: 'user', content: 'ஹலோ, எப்படி இருக்கீங்க சார்?' });
      messages.push({ role: 'assistant', content: 'Hello, how are you sir?' });
      messages.push({ role: 'user', content: 'என்ன பண்றீங்க?' });
      messages.push({ role: 'assistant', content: 'What are you doing?' });
      // CRITICAL: These are the most mistranslated Tamil phrases - teach the model explicitly
      messages.push({ role: 'user', content: 'ஹாய் சார், உங்களுக்கு கேட்குதா சார்? என்ன பண்றீங்க?' });
      messages.push({ role: 'assistant', content: 'Hi sir, can you hear me sir? What are you doing?' });
      messages.push({ role: 'user', content: 'நான் உங்களுக்கு கேக்குதா என்ன பண்றீங்க?' });
      messages.push({ role: 'assistant', content: 'Can you hear me? What are you doing?' });
      messages.push({ role: 'user', content: 'தலை வலிக்குது, சாப்பிடல.' });
      messages.push({ role: 'assistant', content: 'I have a headache and I have not eaten.' });
      messages.push({ role: 'user', content: 'Doctor என்ன சொன்னாங்க?' });
      messages.push({ role: 'assistant', content: 'What did the doctor say?' });
      messages.push({ role: 'user', content: 'ரெஸ்ட் எடுக்கணும்னு சொன்னாங்க.' });
      messages.push({ role: 'assistant', content: 'They said you need to rest.' });
      messages.push({ role: 'user', content: 'சாப்பிட்டீங்களா? வலி குறைஞ்சதா?' });
      messages.push({ role: 'assistant', content: 'Did you eat? Has the pain reduced?' });
    }
    
    messages.push({ role: 'user', content: text });

    const response = await groq.chat.completions.create({
      messages,
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
