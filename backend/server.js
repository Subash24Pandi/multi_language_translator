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
      
      // 3. Find the recipient
      const users = Object.entries(session.users);
      // Recipient is the person with the OTHER role
      const recipientEntry = users.find(([id, user]) => id !== socket.id && user.role !== currentUser.role);
      
      if (!recipientEntry) {
         console.log('No recipient found in session.');
         socket.emit('transcription_error');
         return;
      }
      
      const [recipientId, recipient] = recipientEntry;
      const targetLanguage = recipient.language;
      const sourceLanguage = language;
      
      console.log(`Pipeline: ${currentUser.role}(${sourceLanguage}) -> ${recipient.role}(${targetLanguage})`);
      
      // 4. Process through AI Pipeline
      const result = await processAudioBuffer(audioData, sourceLanguage, targetLanguage);
      
      if (result.translatedText || result.originalText) {
        // Send translation to the recipient
        io.to(recipientId).emit('translated_audio', {
           audioBase64: result.audioBase64,
           translatedText: result.translatedText,
           originalText: result.originalText
        });
        
        // Send original back to sender for their UI
        socket.emit('transcription_success', {
           originalText: result.originalText
        });
      } else {
        socket.emit('transcription_error');
      }
    } catch (err) {
      console.error('Socket Audio Error:', err.message);
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
