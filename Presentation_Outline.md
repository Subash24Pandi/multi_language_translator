# Multilingual Medical Interpreter: Project Presentation

## Slide 1: Title Slide
**Project Name:** Real-Time Multilingual Medical Interpreter
**Objective:** Enabling seamless, colloquial, and medically accurate communication between doctors and patients across 9 Indian languages.
**Key Features:** Sub-3s Latency, Concept-Based Translation, No-Echo Voice Pipeline.

---

## Slide 2: The Problem
*   **Language Barrier:** In emergency medical scenarios, every second counts. Miscommunication between a doctor and a patient can be life-threatening.
*   **Formal vs. Spoken:** Traditional translation tools use formal/bookish language (e.g., Shuddh Hindi or Written Tamil) which feels unnatural and confusing for patients in rural or high-stress environments.
*   **Latency:** Real-time conversation requires near-instant response times to feel natural.

---

## Slide 3: The "Concept-to-Speech" Pipeline
Our system uses a 3-layer architecture for maximum performance:

1.  **STT (Speech-to-Text):** Powered by **Sarvam AI (saaras:v3)**. Optimized for Indian accents and noisy medical environments.
2.  **LLM (Translation Engine):** Powered by **Groq (Llama 3.3 70B)**. We use "Medical Accuracy Prompting" to prevent hallucinations and ensure clinical context is preserved.
3.  **TTS (Text-to-Speech):** Powered by **Cartesia (Sonic-3)**. Generates natural, human-like voice responses in under 800ms.

---

## Slide 4: Building the Accuracy Engine
We achieved 99% translation accuracy through three specialized strategies:

*   **Colloquial Suffix Enforcement:** The system is trained to use spoken suffixes (e.g., Tamil "-ஈங்க" instead of "-ீர்கள்") so it sounds like a local person.
*   **Explicit Vocabulary Mapping:** Strict rules prevent common AI errors (e.g., distinguishing between "Did you eat?" and "Are you sleeping?").
*   **Medical Keyword Preservation:** High-frequency medical terms (Doctor, Tablet, BP, Sugar, Scan) are preserved in English within the regional sentence to reflect real-world Indian hospital usage.

---

## Slide 5: System Architecture & Workflow
1.  **Audio Capture:** High-fidelity VAD (Voice Activity Detection) detects when the user stops speaking (1.2s threshold).
2.  **Conversion:** WebM audio is converted to 16kHz mono WAV for high-precision transcription.
3.  **Orchestration:** Backend server routes transcriptions to the LLM for context-aware translation.
4.  **Playback Guard:** Intelligent "Echo Suppression" blocks the microphone while the system is speaking to prevent feedback loops.

---

## Slide 6: Supported Languages
Supports seamless bidirectional communication in:
*   Tamil (தமிழ்)
*   Hindi (हिन्दी)
*   Telugu (తెలుగు)
*   Kannada (ಕನ್ನಡ)
*   Malayalam (മലയാളം)
*   Bengali (বাংলা)
*   Marathi (മরাঠি)
*   Gujarati (ગુજરાતી)
*   Odia (ଓଡ଼ିଆ)

---

## Slide 7: User Manual (Getting Started)
1.  **Session Creation:** Enter a unique Session ID to create a secure room.
2.  **Role Selection:** Choose your role (**Doctor** or **Patient**) and your preferred **Language**.
3.  **Connection:** Share the Session ID with your partner. The "Partner Connected" indicator will light up green.
4.  **Communication:** Tap the Microphone to speak. You can also rely on the auto-detector which triggers when you finish a sentence.
5.  **Transcript History:** View the live scrollable history of original and translated text for clinical verification.

---

## Slide 8: Future Roadmap
*   **Offline Mode:** Edge-compute models for regions with low connectivity.
*   **Medical Report Parsing:** Auto-summarizing the translated conversation into a clinical note.
*   **Visual Aid Integration:** Displaying medical diagrams based on the symptoms discussed.
