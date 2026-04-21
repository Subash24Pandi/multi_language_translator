import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStore } from '../utils/store';
import socket from '../utils/socket';
import { useAudioRecorder } from '../utils/useAudioRecorder';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Volume2, Users, ArrowLeft } from 'lucide-react';
import { convertBlobToWav } from '../utils/wavConverter';

const FULL_LANG_NAMES = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu',
  kn: 'Kannada', bn: 'Bengali', gu: 'Gujarati', mr: 'Marathi',
  ml: 'Malayalam', or: 'Odia'
};

export default function Session() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { sessionId, role, language, partnerJoined, partnerLanguage, partnerRole, setSessionData, resetSession } = useStore();
  
  const [status, setStatus] = useState('Waiting for partner...');
  const [transcripts, setTranscripts] = useState([]); // { text, isSelf, originalText }
  
  useEffect(() => {
    if (!sessionId) {
      navigate('/');
      return;
    }

    socket.emit('join_session', { sessionId: id, role, language });

    socket.on('user_joined', (data) => {
      if (data.role !== role) {
        setSessionData({ 
          partnerJoined: true, 
          partnerLanguage: data.language,
          partnerRole: data.role
        });
        setStatus('Ready');
      }
    });

    socket.on('processing_status', (data) => {
      setStatus(data.status);
    });

    socket.on('translated_audio', async (data) => {
      setStatus('Playing...');
      
      setTranscripts(prev => [...prev, { 
        text: data.translatedText, 
        originalText: data.originalText,
        isSelf: false 
      }]);

      try {
        const audioSrc = `data:audio/mp3;base64,${data.audioBase64}`;
        const audio = new Audio(audioSrc);
        audio.playbackRate = 0.85; // Slow down Cartesia's naturally fast speech
        audio.onended = () => {
          setStatus('Ready');
        };
        audio.play();
      } catch (err) {
        console.error('Error playing audio:', err);
        setStatus('Ready');
      }
    });

    socket.on('transcription_success', (data) => {
      setStatus('Ready');
      setTranscripts(prev => {
        const newTranscripts = prev.filter(t => !t.pending);
        return [...newTranscripts, {
          text: data.originalText,
          isSelf: true
        }];
      });
    });

    socket.on('transcription_error', () => {
      setStatus('Ready');
      setTranscripts(prev => prev.filter(t => !t.pending));
    });

    return () => {
      socket.off('user_joined');
      socket.off('processing_status');
      socket.off('translated_audio');
      socket.off('transcription_success');
      socket.off('transcription_error');
    };
  }, [id, sessionId, role, language, navigate, setSessionData]);

  const handleAudioComplete = async (blob) => {
    setStatus('Processing...');
    
    try {
      // CRITICAL SPEED FIX: We no longer convert the audio to WAV on the phone!
      // This completely removes the brutal 5-second freezing delay on mobile devices.
      // We send the highly-compressed raw WebM directly to the backend.
      const reader = new FileReader();
      reader.onloadend = () => {
        const buffer = reader.result;
        socket.emit('audio_chunk', {
          sessionId: id,
          language,
          audioData: buffer
        });
        
        setTranscripts(prev => [...prev, { 
          text: '...', 
          isSelf: true,
          pending: true
        }]);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      console.error('Failed to send audio:', err);
      setStatus('Ready');
    }
  };

  const { isRecording, startRecording, stopRecording } = useAudioRecorder(handleAudioComplete);

  const toggleMic = () => {
    if (!partnerJoined) return;
    
    if (isRecording) {
      stopRecording();
      setStatus('Processing...');
    } else {
      startRecording();
      setStatus('Listening...');
      
      // Update the last pending self-transcript if it exists
      setTranscripts(prev => prev.filter(t => !t.pending));
    }
  };

  const handleLeave = () => {
    stopRecording();
    resetSession();
    navigate('/');
  };

  return (
    <div className="w-full max-w-4xl h-[90vh] flex flex-col glass-panel rounded-3xl overflow-hidden relative">
      {/* Header */}
      <div className="bg-white/5 border-b border-white/10 p-6 flex justify-between items-center">
        <div className="flex items-center space-x-4">
          <button onClick={handleLeave} className="p-2 hover:bg-white/10 rounded-full transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-300" />
          </button>
          <div>
            <h2 className="text-xl font-bold text-white flex items-center">
              Session <span className="text-primary ml-2 uppercase">#{id}</span>
            </h2>
            <div className="flex items-center text-sm text-gray-400 mt-1">
              <span className="capitalize text-primary mr-1">{role}</span> ({FULL_LANG_NAMES[language]})
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-6">
          <div className="flex flex-col items-end">
            <div className="flex items-center space-x-2">
              <div className={`w-2 h-2 rounded-full ${partnerJoined ? 'bg-secondary animate-pulse' : 'bg-gray-500'}`} />
              <span className="text-sm font-medium text-gray-300">
                {partnerJoined ? `Partner Connected` : 'Waiting...'}
              </span>
            </div>
            {partnerJoined && (
              <span className="text-xs text-gray-500 mt-1 capitalize">
                {partnerRole} • {FULL_LANG_NAMES[partnerLanguage]}
              </span>
            )}
          </div>
          <div className="bg-dark/50 p-3 rounded-xl border border-white/5 flex items-center space-x-2">
            <Users className="w-5 h-5 text-gray-400" />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {!partnerJoined ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
              <Users className="w-8 h-8 text-gray-500" />
            </div>
            <p className="text-lg">Waiting for the other person to join...</p>
            <p className="text-sm mt-2">Share the Session ID: <span className="text-white font-mono">{id}</span></p>
          </div>
        ) : transcripts.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 opacity-50">
            <p>Start speaking to begin the conversation</p>
          </div>
        ) : (
          <AnimatePresence>
            {transcripts.map((msg, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex w-full ${msg.isSelf ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[75%] rounded-2xl p-4 ${
                  msg.isSelf 
                    ? 'bg-primary/20 border border-primary/30 rounded-tr-sm' 
                    : 'bg-white/5 border border-white/10 rounded-tl-sm'
                }`}>
                  <div className="text-sm text-gray-400 mb-1 flex justify-between items-center">
                    <span>{msg.isSelf ? 'You' : partnerRole}</span>
                    {!msg.isSelf && <Volume2 className="w-3 h-3 ml-2 text-secondary" />}
                  </div>
                  <p className={`text-lg ${msg.pending ? 'animate-pulse text-gray-400' : 'text-white'}`}>
                    {msg.text}
                  </p>
                  {!msg.isSelf && msg.originalText && (
                    <p className="text-xs text-gray-500 mt-2 pt-2 border-t border-white/5">
                      Original: {msg.originalText}
                    </p>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Controls */}
      <div className="p-6 bg-dark/40 backdrop-blur-md border-t border-white/10 flex flex-col items-center justify-center relative">
        <AnimatePresence mode="wait">
          <motion.div 
            key={status}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className={`absolute top-0 -translate-y-full mb-4 px-4 py-1.5 rounded-full text-xs font-semibold tracking-wider uppercase border ${
              status === 'Listening...' ? 'bg-red-500/20 text-red-400 border-red-500/30' :
              status === 'Translating...' || status === 'Processing...' ? 'bg-primary/20 text-primary border-primary/30' :
              status === 'Playing...' ? 'bg-secondary/20 text-secondary border-secondary/30' :
              'bg-white/5 text-gray-400 border-white/10'
            }`}
          >
            {status}
          </motion.div>
        </AnimatePresence>

        <button
          onClick={toggleMic}
          disabled={!partnerJoined}
          className={`relative group flex items-center justify-center w-20 h-20 rounded-full transition-all duration-300 ${
            !partnerJoined ? 'opacity-50 cursor-not-allowed bg-gray-800' :
            isRecording ? 'bg-red-500 shadow-[0_0_30px_rgba(239,68,68,0.5)] scale-110' : 
            'bg-primary hover:bg-indigo-500 shadow-lg'
          }`}
        >
          {isRecording ? (
            <Mic className="w-8 h-8 text-white" />
          ) : (
            <MicOff className="w-8 h-8 text-white" />
          )}
          
          {isRecording && (
            <span className="absolute inset-0 rounded-full border-2 border-red-500 animate-ping opacity-75" />
          )}
        </button>
        <p className="mt-4 text-sm text-gray-400 font-medium">
          {isRecording ? 'Tap to stop or wait for auto-detect' : 'Tap to speak'}
        </p>
      </div>
    </div>
  );
}
