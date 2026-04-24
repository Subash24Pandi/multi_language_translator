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

const DEEPGRAM_LANG_MAP = {
  en: 'en-IN',
  hi: 'hi',
  ta: 'ta',
  te: 'te',
  kn: 'kn',
  ml: 'ml',
  bn: 'bn',
  mr: 'mr',
  gu: 'gu',
  or: 'or',
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
    
    // Strip annoying "Speaker 1:" or "Speaker:" labels from Sarvam STT
    sttText = sttText.replace(/^(Speaker\s*\d*\s*:|Doctor\s*:|Patient\s*:)\s*/i, '').trim();
    console.log(`[STT] Transcribed: ${sttText}`);

    // 2. LLM: Groq Translation (Only if languages are different)
    let translatedText = sttText;
    if (sourceLang !== targetLang) {
      translatedText = await translateText(sttText, sourceLang, targetLang);
      console.log(`[LLM] Translated: ${translatedText}`);
    }

    // Strip labels again
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
    // 1. Decode base64 to binary
    let base64Data = audioBuffer;
    if (typeof audioBuffer === 'string' && audioBuffer.includes(';base64,')) {
      base64Data = audioBuffer.split(';base64,').pop();
    }
    const binaryBuffer = Buffer.from(base64Data, 'base64');
    
    // 2. Convert WebM to WAV (Sarvam requires WAV format)
    const tempId = `audio_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    webmPath = path.join(os.tmpdir(), `${tempId}.webm`);
    wavPath = path.join(os.tmpdir(), `${tempId}.wav`);
    
    fs.writeFileSync(webmPath, binaryBuffer);
    
    // WAV at 16kHz mono - exactly what Sarvam saaras:v3 requires
    // Use ultrafast preset for minimum latency
    execSync(`ffmpeg -y -i "${webmPath}" -preset ultrafast -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}"`, { stdio: 'ignore' });
    
    const wavBuffer = fs.readFileSync(wavPath);
    
    // 3. Upload to Sarvam
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
    const sourceName = FULL_LANG_NAMES[sourceLang];
    const targetName = FULL_LANG_NAMES[targetLang];
    
    let langStyleRule = '';
    if (targetLang === 'ta') {
      langStyleRule = `Output language: MODERN Colloquial Tamil. Use Tamil script.
STYLE: How people speak in 2024. Use spoken suffixes like -ஈங்க, -ஆச்சு.
VOCAB: "Did you eat?" -> "சாப்ட்டீங்களா?", "Can you hear?" -> "கேக்குதா?", "What are you doing?" -> "என்ன பண்றீங்க?"
NEVER use bookish Tamil (-ீர்கள், -கிறீர்கள்).`;
    } else if (targetLang === 'te') {
      langStyleRule = `Output language: Spoken Colloquial Telugu. Use Telugu script ONLY.
VOCABULARY: "Did you eat?" -> "తిన్నారా?", "Are you sleeping?" -> "నిద్రపోతున్నారా?"`;
    } else if (targetLang === 'hi') {
      langStyleRule = `Output language: Spoken Colloquial Hindi. Use Devanagari script ONLY.
VOCABULARY: "Did you eat?" -> "खाना खाया?", "Are you sleeping?" -> "सो रहे हो?"`;
    } else if (targetLang === 'kn') {
      langStyleRule = `Output language: Spoken Colloquial Kannada. Use Kannada script ONLY.
VOCABULARY: "Did you eat?" -> "ಊಟ ಆಯ್ತಾ?", "Are you sleeping?" -> "ಮಲಗಿದ್ದೀರಾ?"`;
    } else if (targetLang === 'ml') {
      langStyleRule = `Output language: Spoken Colloquial Malayalam. Use Malayalam script ONLY.
VOCABULARY: "Did you eat?" -> "ഭക്ഷണം കഴിച്ചോ?", "Are you sleeping?" -> "ഉറങ്ങുകയാണോ?"`;
    } else if (targetLang === 'bn') {
      langStyleRule = `Output language: Spoken Colloquial Bengali. Use Bengali script ONLY.
VOCABULARY: "Did you eat?" -> "খেয়েছেন?", "Are you sleeping?" -> "ঘুমাচ্ছেন?"`;
    } else if (targetLang === 'mr') {
      langStyleRule = `Output language: Spoken Colloquial Marathi. Use Devanagari script ONLY.
VOCABULARY: "Did you eat?" -> "जेवलात का?", "Are you sleeping?" -> "झोपला आहात का?"`;
    } else if (targetLang === 'gu') {
      langStyleRule = `Output language: Spoken Colloquial Gujarati. Use Gujarati script ONLY.
VOCABULARY: "Did you eat?" -> "જમ્યા?", "Are you sleeping?" -> "ઊંઘો છો?"`;
    } else if (targetLang === 'or') {
      langStyleRule = `Output language: Spoken Colloquial Odia. Use Odia script ONLY.
VOCABULARY: "Did you eat?" -> "ଖାଇଛ?", "Are you sleeping?" -> "ଶୋଇଛ?"`;
    } else if (targetLang === 'en') {
      langStyleRule = `Output language: Clear natural conversational English.
Use simple, polite sentences. No American slang.
IMPORTANT: ALWAYS output in English. NEVER use Indian regional scripts.`;
    }

    const systemPrompt = `You are a world-class medical translator. 
Task: Translate from ${sourceName} to ${targetName}.

RULES:
1. TARGET ONLY: You MUST output in ${targetName} language and script. 
2. NO SOURCE: NEVER output in the source language ${sourceName} or its script.
3. ZERO INJECTION: Translate ONLY what was said. Do NOT add times, dates, or details.
4. MEDICAL FIDELITY: Keep terms like Doctor, Hospital, BP, Sugar, Tablet in English.
5. STYLE: ${langStyleRule}
6. CLEAN: No labels. No explanations. ONLY translation.`;

    // Build messages array with few-shot examples for Tamil to lock in spoken style
    const messages = [{ role: 'system', content: systemPrompt }];
    
    if (targetLang === 'ta') {
      // Modern 2024 Spoken Tamil examples
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'ஹலோ, எப்படி இருக்கீங்க சார்?' });
      messages.push({ role: 'user', content: 'Hi, can you hear me?' });
      messages.push({ role: 'assistant', content: 'ஹாய், நான் பேசுறது கேக்குதா?' });
      messages.push({ role: 'user', content: 'What are you doing?' });
      messages.push({ role: 'assistant', content: 'என்ன பண்றீங்க?' });
      messages.push({ role: 'user', content: 'Did you eat?' });
      messages.push({ role: 'assistant', content: 'சாப்ட்டீங்களா?' });
      messages.push({ role: 'user', content: 'I have a headache and chest pain.' });
      messages.push({ role: 'assistant', content: 'தலை வலிக்குது, நெஞ்சுல வலிக்குது.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor என்ன சொன்னாங்க?' });
      messages.push({ role: 'user', content: 'Please take rest and drink water.' });
      messages.push({ role: 'assistant', content: 'ரெஸ்ட் எடுங்க, தண்ணி குடிங்க.' });
      messages.push({ role: 'user', content: 'I finished my lunch, let\'s go.' });
      messages.push({ role: 'assistant', content: 'லஞ்ச் சாப்ட்டு முடிச்சுட்டேன், போலாம் வாங்க.' });
    } else if (targetLang === 'hi') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'हेलो, कैसे हो सर?' });
      messages.push({ role: 'user', content: 'I have a headache, did you eat?' });
      messages.push({ role: 'assistant', content: 'सिर दर्द हो रहा है, खाना खाया?' });
      messages.push({ role: 'user', content: 'My chest is paining and I feel dizzy.' });
      messages.push({ role: 'assistant', content: 'मेरे सीने में दर्द है और चक्कर आ रहे हैं।' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor ने क्या कहा?' });
      messages.push({ role: 'user', content: 'Take this medicine after food and come back tomorrow.' });
      messages.push({ role: 'assistant', content: 'खाना खाने के बाद यह दवा लें और कल वापस आएं।' });
    } else if (targetLang === 'te') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'హలో, ఎలా ఉన్నారు సార్?' });
      messages.push({ role: 'user', content: 'I have a headache, did you eat?' });
      messages.push({ role: 'assistant', content: 'తలనొప్పిగా ఉంది, తిన్నారా?' });
      messages.push({ role: 'user', content: 'I have severe stomach pain since morning.' });
      messages.push({ role: 'assistant', content: 'ఉదయం నుండి కడుపులో చాలా నొప్పిగా ఉంది.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor ఏం చెప్పారు?' });
      messages.push({ role: 'user', content: 'Please rest and drink plenty of water.' });
      messages.push({ role: 'assistant', content: 'దయచేసి విశ్రాంతి తీసుకోండి మరియు నీళ్లు ఎక్కువగా తాగండి.' });
    } else if (targetLang === 'kn') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'ಹಲೋ, ಹೇಗಿದ್ದೀರಾ ಸಾರ್?' });
      messages.push({ role: 'user', content: 'I have a headache, did you eat?' });
      messages.push({ role: 'assistant', content: 'ತಲೆ ನೋವಾಗ್ತಿದೆ, ಊಟ ಆಯ್ತಾ?' });
      messages.push({ role: 'user', content: 'I feel very weak and have fever.' });
      messages.push({ role: 'assistant', content: 'ತುಂಬಾ ಸುಸ್ತಾಗ್ತಿದೆ ಮತ್ತೆ ಜ್ವರ ಕೂಡ ಇದೆ.' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor ಏನ್ ಹೇಳಿದ್ರು?' });
      messages.push({ role: 'user', content: 'Don\'t worry, you will be fine after taking these tablets.' });
      messages.push({ role: 'assistant', content: 'ಚಿಂತೆ ಮಾಡ್ಬೇಡಿ, ಈ ಮಾತ್ರೆ ತಗೊಂಡ ಮೇಲೆ ಗುಣ ಆಗ್ತೀರಾ.' });
    } else if (targetLang === 'ml') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'ഹലോ, എന്താ സുഖം സർ?' });
      messages.push({ role: 'user', content: 'I have a headache, did you eat?' });
      messages.push({ role: 'assistant', content: 'തലവേദനയുണ്ട്, ഭക്ഷണം കഴിച്ചോ?' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor എന്ത് പറഞ്ഞു?' });
    } else if (targetLang === 'bn') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'হ্যালো, কেমন আছেন স্যার?' });
      messages.push({ role: 'user', content: 'I have a headache, did you eat?' });
      messages.push({ role: 'assistant', content: 'মাথা ব্যথা করছে, খেয়েছেন?' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor কী বললেন?' });
    } else if (targetLang === 'mr') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'हेलो, कसे आहात सर?' });
      messages.push({ role: 'user', content: 'I have a headache, did you eat?' });
      messages.push({ role: 'assistant', content: 'डोकं दुखतंय, जेवलात का?' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor नी काय सांगितलं?' });
    } else if (targetLang === 'gu') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'હેલો, કેમ છો સર?' });
      messages.push({ role: 'user', content: 'I have a headache, did you eat?' });
      messages.push({ role: 'assistant', content: 'માથું દુખે છે, જમ્યા?' });
      messages.push({ role: 'user', content: 'What did the doctor say?' });
      messages.push({ role: 'assistant', content: 'Doctor એ શું કીધું?' });
    } else if (targetLang === 'or') {
      messages.push({ role: 'user', content: 'Hello, how are you sir?' });
      messages.push({ role: 'assistant', content: 'ହେଲୋ, କେମିତି ଅଛନ୍ତି ସାର୍?' });
      messages.push({ role: 'user', content: 'I have a headache, did you eat?' });
      messages.push({ role: 'assistant', content: 'ମୁଣ୍ଡ ଯନ୍ତ୍ରଣା ହେଉଛି, ଖାଇଛ?' });
    } else if (targetLang === 'en') {
      messages.push({ role: 'user', content: 'ஹாய் சார், உங்களுக்கு கேட்குதா சார்? என்ன பண்றீங்க?' });
      messages.push({ role: 'assistant', content: 'Hi sir, can you hear me sir? What are you doing?' });
      messages.push({ role: 'user', content: 'சாப்பிட்டீங்களா? தூங்குறீங்களா?' });
      messages.push({ role: 'assistant', content: 'Did you eat? Are you sleeping?' });
      messages.push({ role: 'user', content: 'தலை வலிக்குது, சாப்பிடல, Doctor என்ன சொன்னாங்க?' });
      messages.push({ role: 'assistant', content: 'I have a headache, I have not eaten. What did the doctor say?' });
      messages.push({ role: 'user', content: 'ரெஸ்ட் எடுங்க, தண்ணி குடிங்க.' });
      messages.push({ role: 'assistant', content: 'Please rest and drink water.' });
    }
    
    messages.push({ role: 'user', content: text });

    const response = await groq.chat.completions.create({
      messages,
      model: 'llama-3.1-8b-instant',
      temperature: 0,
      max_tokens: 2048,
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
