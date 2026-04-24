import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { processAudioBuffer } from './pipeline.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e8 // Increase max payload size to 100MB to allow long audio files
});

const sessions = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join_session', ({ sessionId, role, language }) => {
    socket.join(sessionId);
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { users: {} });
    }
    
    const session = sessions.get(sessionId);
    
    // Find if there is an existing user before adding the new one
    const existingUsers = Object.values(session.users);
    
    session.users[socket.id] = { role, language };
    
    console.log(`Socket ${socket.id} joined session ${sessionId} as ${role} (${language})`);
    
    // Notify the room that a new user joined
    io.to(sessionId).emit('user_joined', { role, language, id: socket.id });
    
    // If there is already an existing user in the room, tell the new user about them
    if (existingUsers.length > 0) {
      const existingUser = existingUsers[0];
      socket.emit('user_joined', { role: existingUser.role, language: existingUser.language, id: socket.id });
    }
  });

  socket.on('audio_chunk', async ({ sessionId, language, audioData }) => {
    try {
      console.log(`Received complete audio from ${socket.id} for session ${sessionId}, size: ${audioData.length} bytes`);
      
      const session = sessions.get(sessionId);
      if (!session) return;
      
      const currentUser = session.users[socket.id];
      if (!currentUser) return;
      
      const users = Object.entries(session.users);
      // Find the user with the OPPOSITE role (Doctor -> Patient, or Patient -> Doctor)
      const otherUserEntry = users.find(([id, user]) => user.role !== currentUser.role);
      
      if (!otherUserEntry) {
         console.log('No other user in session to translate for.');
         socket.emit('transcription_error');
         return;
      }
      
      const [otherUserId, otherUser] = otherUserEntry;
      const targetLanguage = otherUser.language;
      const sourceLanguage = language;
      
      console.log(`Translating from ${sourceLanguage} to ${targetLanguage}`);
      
      // Process the combined streaming audio through STT -> LLM -> TTS
      const { audioBase64, translatedText, originalText } = await processAudioBuffer(
        audioData, 
        sourceLanguage, 
        targetLanguage
      );
      
      if (audioBase64) {
        // Send the translated audio and text to the recipient
        io.to(otherUserId).emit('translated_audio', {
           audioBase64,
           translatedText,
           originalText
        });
        
        // Send the original text back to the sender so their "..." bubble updates
        socket.emit('transcription_success', {
           originalText
        });
      } else {
        io.to(otherUserId).emit('processing_status', { status: 'Failed to process' });
        socket.emit('transcription_error');
      }
      
    } catch (err) {
      console.error('Error processing audio chunk:', err);
      // Fallback: emit generic error to the sender so they aren't stuck on "Processing"
      socket.emit('transcription_error');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    for (const [sessionId, session] of sessions.entries()) {
      if (session.users[socket.id]) {
        delete session.users[socket.id];
        if (Object.keys(session.users).length === 0) {
          sessions.delete(sessionId);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
