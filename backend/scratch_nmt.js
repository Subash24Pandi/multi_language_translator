import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: 'd:\\multi-language-translator\\backend\\.env' });

async function testNMT() {
  try {
    const response = await axios.post('https://api.sarvam.ai/translate', {
      input: "What are you doing? Did you eat?",
      source_language_code: "en-IN",
      target_language_code: "ta-IN",
      speaker_gender: "Male",
      mode: "formal",
      model: "mayura:v1",
      enable_preprocessing: true
    }, {
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    console.log(response.data);
  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
  }
}

testNMT();
